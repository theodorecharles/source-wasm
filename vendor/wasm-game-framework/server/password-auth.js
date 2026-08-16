'use strict';

const crypto = require('node:crypto');
const { parseDuration } = require('./lifecycle');

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_BODY_LIMIT = 8192;

function passwordOptions(environment) {
  const env = environment || process.env;
  return Object.freeze({
    password: String(env.WASM_GAME_PASSWORD || ''),
    ttlMs: parseDuration(env.WASM_GAME_PASSWORD_TTL || '12h', DEFAULT_TTL_MS),
    trustProxy: /^(1|true|yes|on)$/i.test(String(env.WASM_GAME_TRUST_PROXY || 'false')),
    secret: env.WASM_GAME_SESSION_SECRET ? String(env.WASM_GAME_SESSION_SECRET) : null
  });
}

function cookies(request) {
  const result = new Map();
  for (const part of String(request?.headers?.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) result.set(key, value);
  }
  return result;
}

function json(response, statusCode, value, headers) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...(typeof headers === 'function' ? headers() : headers || {})
  });
  response.end(body);
}

function requestIsSecure(request, trustProxy) {
  if (request?.socket?.encrypted) return true;
  if (!trustProxy) return false;
  return String(request?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function sameOrigin(request) {
  const origin = request?.headers?.origin;
  if (!origin) return true;
  try { return new URL(origin).host === String(request.headers.host || ''); } catch (_) { return false; }
}

async function readJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
  return value && typeof value === 'object' ? value : {};
}

function createPasswordGate(options) {
  const config = { ...passwordOptions(options?.environment), ...(options || {}) };
  const password = String(config.password || '');
  const required = password.length > 0;
  const passwordDigest = crypto.createHash('sha256').update(password).digest();
  const secret = config.secret
    ? (Buffer.isBuffer(config.secret) ? Buffer.from(config.secret) : Buffer.from(String(config.secret), 'base64url'))
    : crypto.randomBytes(32);
  if (required && secret.length < 32) {
    throw new Error('WASM_GAME_SESSION_SECRET must contain at least 32 random bytes.');
  }
  const ttlMs = Math.max(1000, Number(config.ttlMs) || DEFAULT_TTL_MS);
  const cookieName = String(config.cookieName || 'wasm_game_session').replace(/[^A-Za-z0-9_-]/g, '_');
  const bodyLimit = Math.max(256, Number(config.bodyLimit) || DEFAULT_BODY_LIMIT);
  const responseHeaders = config.headers;
  const failures = new Map();
  const failureWindowMs = Math.max(1000, Number(config.failureWindowMs) || 60000);
  const maximumFailures = Math.max(1, Number(config.maximumFailures) || 8);

  function signature(payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  }

  function token() {
    const payload = `${Date.now() + ttlMs}.${crypto.randomBytes(18).toString('base64url')}`;
    return `${payload}.${signature(payload)}`;
  }

  function validToken(value) {
    if (!required) return true;
    const match = /^(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(value || ''));
    if (!match || Number(match[1]) < Date.now()) return false;
    const expected = Buffer.from(signature(`${match[1]}.${match[2]}`));
    const supplied = Buffer.from(match[3]);
    return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  }

  function authenticated(request) {
    return !required || validToken(cookies(request).get(cookieName));
  }

  function cookie(request, value, maxAge) {
    return [
      `${cookieName}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
      ...(requestIsSecure(request, config.trustProxy) ? ['Secure'] : [])
    ].join('; ');
  }

  function status(request) {
    return Object.freeze({ required, authenticated: authenticated(request) });
  }

  function reject(request, response) {
    json(response, 401, { error: 'A game password is required.', ...status(request) }, responseHeaders);
    return false;
  }

  function requirePassword(request, response) {
    return authenticated(request) || reject(request, response);
  }

  function failureKey(request) {
    return String(request?.socket?.remoteAddress || 'unknown');
  }

  function failureState(request) {
    const key = failureKey(request);
    const now = Date.now();
    let state = failures.get(key);
    if (!state || now - state.startedAt >= failureWindowMs) {
      state = { startedAt: now, count: 0 };
      failures.set(key, state);
    }
    return { key, state, now };
  }

  function passwordMatches(value) {
    const supplied = crypto.createHash('sha256').update(String(value || '')).digest();
    return supplied.length === passwordDigest.length && crypto.timingSafeEqual(supplied, passwordDigest);
  }

  async function handle(request, response, urlValue) {
    const url = urlValue instanceof URL ? urlValue : new URL(request.url, 'http://localhost');
    if (url.pathname === '/auth/status') {
      if (request.method !== 'GET') return json(response, 405, { error: 'Method not allowed.' }, responseHeaders), true;
      json(response, 200, status(request), responseHeaders);
      return true;
    }
    if (url.pathname === '/auth/login') {
      if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed.' }, responseHeaders), true;
      if (!sameOrigin(request)) return json(response, 403, { error: 'Cross-origin login is not allowed.' }, responseHeaders), true;
      const attempt = failureState(request);
      if (attempt.state.count >= maximumFailures) {
        const retryAfter = Math.max(1, Math.ceil((failureWindowMs - (attempt.now - attempt.state.startedAt)) / 1000));
        response.setHeader('Retry-After', String(retryAfter));
        json(response, 429, { error: 'Too many password attempts. Try again shortly.' }, responseHeaders);
        return true;
      }
      let body;
      try { body = await readJson(request, bodyLimit); } catch (error) {
        json(response, error.statusCode || 400, { error: error.message }, responseHeaders);
        return true;
      }
      if (required && !passwordMatches(body.password)) {
        attempt.state.count += 1;
        json(response, 401, { error: 'Incorrect game password.', required: true, authenticated: false }, responseHeaders);
        return true;
      }
      failures.delete(attempt.key);
      if (required) response.setHeader('Set-Cookie', cookie(request, token(), ttlMs / 1000));
      json(response, 200, { required, authenticated: true }, responseHeaders);
      return true;
    }
    if (url.pathname === '/auth/logout') {
      if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed.' }, responseHeaders), true;
      if (!sameOrigin(request)) return json(response, 403, { error: 'Cross-origin logout is not allowed.' }, responseHeaders), true;
      response.setHeader('Set-Cookie', cookie(request, '', 0));
      json(response, 200, { required, authenticated: !required }, responseHeaders);
      return true;
    }
    return false;
  }

  return Object.freeze({
    required,
    cookieName,
    status,
    authenticated,
    require: requirePassword,
    handle
  });
}

module.exports = Object.freeze({ createPasswordGate, passwordOptions });
