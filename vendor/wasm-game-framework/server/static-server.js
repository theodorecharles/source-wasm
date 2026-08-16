#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createProvisioningStore, normalizeManifestCollection } = require('./provisioning');
const { createMediaLibraryStore } = require('./media-library');
const { createPasswordGate } = require('./password-auth');
const frameworkPackage = require('../package.json');

const siteRoot = path.resolve(process.env.WASM_GAME_SITE_ROOT || '/opt/game-site');
const shellRoot = path.resolve(process.env.WASM_GAME_SHELL_ROOT || '/opt/shared-shell');
const dataRoot = path.resolve(process.env.WASM_GAME_DATA_ROOT || '/data');
const port = Number(process.env.WASM_GAME_HTTP_PORT || 8088);
const variant = String(process.env.WASM_GAME_VARIANT || 'suite');
const media = String(process.env.WASM_GAME_MEDIA || '').trim().toLowerCase();
if (media && !/^[a-f0-9]{32}$/.test(media)) {
  throw new Error('WASM_GAME_MEDIA must contain exactly 32 hexadecimal characters.');
}
const setupToken = String(process.env.WASM_SETUP_TOKEN || '');
const manifestPath = path.resolve(process.env.WASM_GAME_DATA_MANIFEST || path.join(siteRoot, 'wasm-game-data.json'));
const canonicalDocument = fs.existsSync(path.join(siteRoot, 'wasm-game.json'));

let gameConfig = null;
try {
  gameConfig = JSON.parse(fs.readFileSync(path.join(siteRoot, 'wasm-game.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

let stores = new Map();
try {
  const manifests = normalizeManifestCollection(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  stores = new Map(Array.from(manifests, ([key, manifest]) => [key, Object.freeze({
    fixed: createProvisioningStore({ dataRoot, manifest, validatorRoot: siteRoot }),
    media: manifest.mediaLibrary ? createMediaLibraryStore({
      dataRoot, manifest: manifest.mediaLibrary, validatorRoot: siteRoot
    }) : null
  })]));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

async function deploymentStatus(deployment) {
  const fixed = await deployment.fixed.status();
  if (!deployment.media) return fixed;
  const mediaLibrary = await deployment.media.status();
  return Object.freeze({
    ...fixed,
    fixedReady: fixed.ready,
    ready: fixed.ready && mediaLibrary.ready,
    mediaLibrary
  });
}

function selectedStore(url) {
  if (!stores.size) return { key: null, store: null };
  if (stores.size === 1) {
    const entry = stores.entries().next().value;
    return { key: entry[0], store: entry[1] };
  }
  const requested = String(variant !== 'suite' ? variant : (url.searchParams.get('variant') || '')).toLowerCase();
  return { key: requested || null, store: stores.get(requested) || null };
}

function selectedGameConfig(url) {
  if (!gameConfig) return null;
  if (!gameConfig.variants || typeof gameConfig.variants !== 'object') return gameConfig;
  const keys = Object.keys(gameConfig.variants);
  const requested = String(variant !== 'suite' ? variant : (url.searchParams.get('variant') || gameConfig.defaultVariant || keys[0] || '')).toLowerCase();
  const selected = gameConfig.variants[requested];
  if (!selected) return null;
  const merged = { ...gameConfig, ...selected, id: requested };
  delete merged.variants;
  return merged;
}

function pwaManifest(url) {
  const selected = selectedGameConfig(url) || {};
  const pwa = selected.pwa && typeof selected.pwa === 'object' ? selected.pwa : {};
  const title = String(pwa.name || selected.title || 'WASM Game');
  const shortName = String(pwa.shortName || title).slice(0, 30);
  const selectedKey = String(selected.id || '').toLowerCase();
  const locked = variant !== 'suite' || !gameConfig?.variants;
  const selectedMedia = media || (/^[a-f0-9]{32}$/i.test(String(url.searchParams.get('media') || '')) ?
    String(url.searchParams.get('media')).toLowerCase() : '');
  const startParams = new URLSearchParams();
  if (!locked && selectedKey) startParams.set('game', selectedKey);
  if (selectedMedia) startParams.set('media', selectedMedia);
  const defaultStartUrl = startParams.size ? `/?${startParams}` : '/';
  const startUrl = String(pwa.startUrl || defaultStartUrl);
  const fallbackIcon = selected.icon ? [{ src: String(selected.icon), sizes: 'any' }] : [];
  const icons = Array.isArray(pwa.icons) && pwa.icons.length ? pwa.icons : fallbackIcon;
  return {
    id: String(pwa.id || startUrl),
    name: title,
    short_name: shortName,
    description: String(pwa.description || selected.description || ''),
    start_url: startUrl,
    scope: String(pwa.scope || '/'),
    display: String(pwa.display || 'standalone'),
    background_color: String(pwa.backgroundColor || '#000000'),
    theme_color: String(pwa.themeColor || selected.theme?.accent || '#111827'),
    orientation: String(pwa.orientation || 'landscape'),
    icons: icons.map(icon => ({
      src: String(icon.src),
      sizes: String(icon.sizes || 'any'),
      ...(icon.type ? { type: String(icon.type) } : {}),
      ...(icon.purpose ? { purpose: String(icon.purpose) } : {})
    }))
  };
}

function serviceWorkerSource() {
  const cacheName = `wasm-game-shell-${frameworkPackage.version}`;
  const shellPaths = ['/', '/shared-shell/wasm-game-framework.css', '/shared-shell/wasm-game-framework.js',
    '/shared-shell/wasm-game-bootstrap.js', '/wasm-game.json', '/game-adapter.js'];
  return `'use strict';\n` +
    `const CACHE = ${JSON.stringify(cacheName)};\n` +
    `const SHELL = ${JSON.stringify(shellPaths)};\n` +
    `self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => Promise.all(SHELL.map(path => fetch(path, { cache: 'no-cache' }).then(response => { if (response.ok) return cache.put(path, response); }).catch(() => undefined)))).then(() => self.skipWaiting())); });\n` +
    `self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('wasm-game-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });\n` +
    `self.addEventListener('fetch', event => { const url = new URL(event.request.url); if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return; event.respondWith(fetch(event.request).then(response => { if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(url.pathname, copy)); } return response; }).catch(() => caches.match(url.pathname).then(response => response || Response.error()))); });\n`;
}

const mime = new Map(Object.entries({
  '.bmp': 'image/bmp', '.css': 'text/css; charset=utf-8', '.data': 'application/octet-stream', '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json'
}));

function commonHeaders(extra) {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'X-Content-Type-Options': 'nosniff',
    ...extra
  };
}

const passwordGate = createPasswordGate({ headers: commonHeaders });

function json(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, commonHeaders({
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store'
  }));
  response.end(body);
}

function authorized(request) {
  return !setupToken || request.headers.authorization === `Bearer ${setupToken}` ||
    request.headers['x-wasm-setup-token'] === setupToken;
}

async function readJsonBody(request, maximum) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maximum) { const error = new Error('Request body is too large.'); error.statusCode = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {
    const error = new Error('Request body must be valid JSON.'); error.statusCode = 400; throw error;
  }
}

function safeStaticPath(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch (_) { return null; }
  const target = path.resolve(root, `.${decoded}`);
  return target === root || target.startsWith(`${root}${path.sep}`) ? target : null;
}

async function serveFile(request, response, filename, cacheControl) {
  let stat;
  try { stat = await fsp.stat(filename); } catch (_) { return false; }
  if (!stat.isFile()) return false;
  const etag = `W/\"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}\"`;
  if (!request.headers.range && request.headers['if-none-match'] === etag) {
    response.writeHead(304, commonHeaders({ 'Cache-Control': cacheControl || 'no-cache', ETag: etag }));
    response.end();
    return true;
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range || ''));
  let start = 0;
  let end = stat.size - 1;
  let statusCode = 200;
  if (range) {
    start = Number(range[1]);
    end = range[2] ? Math.min(Number(range[2]), end) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
      response.writeHead(416, commonHeaders({ 'Content-Range': `bytes */${stat.size}` }));
      response.end();
      return true;
    }
    statusCode = 206;
  }
  const responseHeaders = commonHeaders({
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl || 'public, max-age=3600',
    'Content-Length': end - start + 1,
    'Content-Type': mime.get(path.extname(filename).toLowerCase()) || 'application/octet-stream',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString()
  });
  if (statusCode === 206) responseHeaders['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  response.writeHead(statusCode, responseHeaders);
  if (request.method === 'HEAD') { response.end(); return true; }
  fs.createReadStream(filename, { start, end }).pipe(response);
  return true;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (await passwordGate.handle(request, response, url)) return;
    if (url.pathname.startsWith('/game-data/') && !passwordGate.require(request, response)) return;
    if (url.pathname === '/game-data/status' && request.method === 'GET') {
      const selected = selectedStore(url);
      if (!selected.store && stores.size) {
        return json(response, 200, {
          configured: true, ready: false, variantRequired: true,
          variants: Array.from(stores.keys()), setupTokenRequired: Boolean(setupToken)
        });
      }
      return json(response, 200, selected.store ? {
        ...(await deploymentStatus(selected.store)), variant: selected.key,
        variants: Array.from(stores.keys()), setupTokenRequired: Boolean(setupToken)
      } : { configured: false, ready: true, files: [], setupTokenRequired: false });
    }
    const setup = /^\/game-data\/setup\/([a-z0-9._-]+)$/.exec(url.pathname);
    if (setup && request.method === 'PUT') {
      const { store } = selectedStore(url);
      if (!store) return json(response, 404, { error: 'No game-data policy is installed.' });
      if (!authorized(request)) return json(response, 401, { error: 'The setup token is required.' });
      const result = await store.fixed.acceptUpload(setup[1], request);
      return json(response, 201, {
        ok: true, key: setup[1], size: result.size,
        ...(result.validation ? { validation: result.validation } : {})
      });
    }
    const data = /^\/game-data\/files\/([a-z0-9._-]+)$/.exec(url.pathname);
    if (data && (request.method === 'GET' || request.method === 'HEAD')) {
      const { store } = selectedStore(url);
      if (!store) return json(response, 404, { error: 'No game-data policy is installed.' });
      if (!(await store.fixed.status()).ready) return json(response, 409, { error: 'Game data is not ready.' });
      const policy = store.fixed.policyFor(data[1]);
      if (!policy) return json(response, 404, { error: 'Unknown game-data file.' });
      if (!(await store.fixed.validate(policy)).valid) {
        return json(response, 404, { error: `${policy.name} is not installed.` });
      }
      return serveFile(request, response, store.fixed.filePath(policy), 'private, max-age=31536000, immutable');
    }
    if (url.pathname === '/game-data/media/entries' && request.method === 'GET') {
      const { store } = selectedStore(url);
      if (!store?.media) return json(response, 404, { error: 'No media-library policy is installed.' });
      return json(response, 200, await store.media.status());
    }
    if (url.pathname === '/game-data/media/uploads' && request.method === 'POST') {
      const { store } = selectedStore(url);
      if (!store?.media) return json(response, 404, { error: 'No media-library policy is installed.' });
      if (!authorized(request)) return json(response, 401, { error: 'The setup token is required.' });
      return json(response, 201, await store.media.beginUpload(await readJsonBody(request, 1024 * 1024)));
    }
    const mediaUploadFile = /^\/game-data\/media\/uploads\/([a-f0-9]{32})\/files\/([a-z0-9._-]+)$/.exec(url.pathname);
    if (mediaUploadFile && request.method === 'PUT') {
      const { store } = selectedStore(url);
      if (!store?.media) return json(response, 404, { error: 'No media-library policy is installed.' });
      if (!authorized(request)) return json(response, 401, { error: 'The setup token is required.' });
      return json(response, 201, await store.media.acceptUploadFile(mediaUploadFile[1], mediaUploadFile[2], request));
    }
    const mediaUploadCommit = /^\/game-data\/media\/uploads\/([a-f0-9]{32})\/commit$/.exec(url.pathname);
    if (mediaUploadCommit && request.method === 'POST') {
      const { store } = selectedStore(url);
      if (!store?.media) return json(response, 404, { error: 'No media-library policy is installed.' });
      if (!authorized(request)) return json(response, 401, { error: 'The setup token is required.' });
      return json(response, 201, await store.media.commitUpload(mediaUploadCommit[1]));
    }
    const mediaUpload = /^\/game-data\/media\/uploads\/([a-f0-9]{32})$/.exec(url.pathname);
    if (mediaUpload && request.method === 'DELETE') {
      const { store } = selectedStore(url);
      if (!store?.media) return json(response, 404, { error: 'No media-library policy is installed.' });
      if (!authorized(request)) return json(response, 401, { error: 'The setup token is required.' });
      return json(response, 200, await store.media.abortUpload(mediaUpload[1]));
    }
    const mediaEntryFile = /^\/game-data\/media\/entries\/([a-f0-9]{32})\/files\/([a-z0-9._-]+)$/.exec(url.pathname);
    if (mediaEntryFile && (request.method === 'GET' || request.method === 'HEAD')) {
      const { store } = selectedStore(url);
      if (!store?.media) return json(response, 404, { error: 'No media-library policy is installed.' });
      const file = await store.media.entryFilePath(mediaEntryFile[1], mediaEntryFile[2]);
      return serveFile(request, response, file.path, 'private, max-age=31536000, immutable');
    }
    const mediaEntry = /^\/game-data\/media\/entries\/([a-f0-9]{32})$/.exec(url.pathname);
    if (mediaEntry && request.method === 'GET') {
      const { store } = selectedStore(url);
      if (!store?.media) return json(response, 404, { error: 'No media-library policy is installed.' });
      return json(response, 200, await store.media.detail(mediaEntry[1]));
    }
    if (url.pathname === '/wasm-game-config.js' && (request.method === 'GET' || request.method === 'HEAD')) {
      const body = Buffer.from(
        `globalThis.WASM_GAME_VARIANT = ${JSON.stringify(variant)};\n` +
        `globalThis.WASM_GAME_MEDIA = ${JSON.stringify(media)};\n`
      );
      response.writeHead(200, commonHeaders({
        'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store'
      }));
      return request.method === 'HEAD' ? response.end() : response.end(body);
    }
    if (url.pathname === '/app.webmanifest' && (request.method === 'GET' || request.method === 'HEAD')) {
      const body = Buffer.from(JSON.stringify(pwaManifest(url)));
      response.writeHead(200, commonHeaders({
        'Content-Type': 'application/manifest+json', 'Content-Length': body.length, 'Cache-Control': 'no-cache'
      }));
      return request.method === 'HEAD' ? response.end() : response.end(body);
    }
    if (url.pathname === '/service-worker.js' && (request.method === 'GET' || request.method === 'HEAD')) {
      const body = Buffer.from(serviceWorkerSource());
      response.writeHead(200, commonHeaders({
        'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': body.length,
        'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/'
      }));
      return request.method === 'HEAD' ? response.end() : response.end(body);
    }
    if (url.pathname === '/favicon.ico' && (request.method === 'GET' || request.method === 'HEAD')) {
      const icon = selectedGameConfig(url)?.icon;
      if (icon && String(icon).startsWith('/') && icon !== '/favicon.ico') {
        response.writeHead(302, commonHeaders({ Location: String(icon), 'Cache-Control': 'no-cache' }));
        return response.end();
      }
      response.writeHead(204, commonHeaders({ 'Cache-Control': 'no-cache' }));
      return response.end();
    }
    if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { error: 'Method not allowed.' });
    if (url.pathname === '/data' || url.pathname.startsWith('/data/') ||
        url.pathname === '/local-data' || url.pathname.startsWith('/local-data/')) {
      return json(response, 404, { error: 'Not found.' });
    }
    const shared = url.pathname.startsWith('/shared-shell/');
    const relative = shared ? url.pathname.slice('/shared-shell'.length) : url.pathname;
    if (!shared && canonicalDocument && (url.pathname === '/' || url.pathname === '/index.html')) {
      const documentPath = path.join(shellRoot, 'index.html');
      if (await serveFile(request, response, documentPath, 'no-cache')) return;
    }
    let target = safeStaticPath(shared ? shellRoot : siteRoot, relative === '/' ? '/index.html' : relative);
    if (target && await serveFile(request, response, target, 'no-cache')) return;
    if (!shared && !path.extname(url.pathname)) {
      target = canonicalDocument ? path.join(shellRoot, 'index.html') : path.join(siteRoot, 'index.html');
      if (await serveFile(request, response, target, 'no-cache')) return;
    }
    json(response, 404, { error: 'Not found.' });
  } catch (error) {
    if (!response.headersSent) json(response, error.statusCode || 500, { error: error.message || 'Internal server error.' });
    else response.destroy(error);
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`wasm-game-framework: serving ${variant} on tcp/${port}; owner data ${stores.size ? `${stores.size} policy variant(s) loaded` : 'not required'}`);
  if (stores.size && setupToken) console.log('wasm-game-framework: first-run game-data setup requires WASM_SETUP_TOKEN');
});
