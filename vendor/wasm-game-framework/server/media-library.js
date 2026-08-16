'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  normalizeDataValidatorDeclaration,
  normalizeMediaRelativeName,
  runMediaBundleValidator
} = require('../dist/wasm-game-framework.js');

const ENTRY_FILE = '.media-entry.json';
const ENTRY_ID = /^[a-f0-9]{32}$/;
const UPLOAD_ID = /^[a-f0-9]{32}$/;
const FILE_ID = /^[a-z0-9][a-z0-9._-]*$/;

function safeKey(value, label) {
  const key = String(value || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) throw new Error(`Invalid ${label || 'media-library'} key: ${value}`);
  return key;
}

function safeRelative(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  const normalized = path.posix.normalize(raw).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid media-library storage path: ${value}`);
  }
  return normalized;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return number;
}

function cleanLabel(value, fallback) {
  const label = String(value || fallback || '').trim().replace(/[\u0000-\u001f\u007f]+/g, ' ');
  if (!label || label.length > 256) throw new Error('Media label must contain 1 through 256 printable characters.');
  return label;
}

function normalizeMediaTransformer(value) {
  if (value === undefined || value === null || value === false) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('mediaLibrary.transformer must be false or an object.');
  }
  const module = String(value.module || '');
  const exportName = String(value.export || 'transformMediaBundle');
  const version = String(value.version || '1');
  if (!module.startsWith('/') || !module.endsWith('.mjs') || module.includes('\\') || module.includes('\u0000')) {
    throw new Error('Media transformer module must be an absolute site-root .mjs path.');
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)) throw new Error('Media transformer export is invalid.');
  if (!version || version.length > 128 || /[\u0000-\u001f]/.test(version)) throw new Error('Media transformer version is invalid.');
  let policy;
  try {
    const encoded = JSON.stringify(value.policy || {});
    if (encoded.length > 65536) throw new Error('too large');
    policy = JSON.parse(encoded);
  } catch (_) {
    throw new Error('Media transformer policy must be bounded JSON data.');
  }
  return Object.freeze({ module, export: exportName, version, policy: Object.freeze(policy) });
}

function normalizeMediaLibrary(value, defaults) {
  if (value === undefined || value === null || value === false) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mediaLibrary must be false or an object.');
  const inherited = defaults || {};
  const namespace = safeKey(value.namespace || `${inherited.namespace || 'game'}-media`, 'media-library namespace');
  const version = String(value.version || inherited.version || '1');
  if (!version || version.length > 128 || /[\u0000-\u001f]/.test(version)) throw new Error('Media-library version is invalid.');
  const validator = normalizeDataValidatorDeclaration(value.validator);
  if (!validator) throw new Error('A media library requires a downstream bundle validator.');
  const transformer = normalizeMediaTransformer(value.transformer);
  const publicMetadata = Array.from(new Set(value.publicMetadata || [])).map(key => {
    const field = String(key || '');
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(field)) throw new Error(`Invalid public media metadata field: ${key}`);
    return field;
  });
  return Object.freeze({
    namespace,
    version,
    path: safeRelative(value.path || `media/${namespace}`),
    minimumEntries: boundedInteger(value.minimumEntries, 0, 0, 100000, 'minimumEntries'),
    launcherVisibleWhenReady: value.launcherVisibleWhenReady !== false,
    maxEntries: boundedInteger(value.maxEntries, 512, 1, 100000, 'maxEntries'),
    maxFilesPerEntry: boundedInteger(value.maxFilesPerEntry, 256, 1, 4096, 'maxFilesPerEntry'),
    maxFileBytes: boundedInteger(value.maxFileBytes, 16 * 1024 * 1024 * 1024, 1, 64 * 1024 * 1024 * 1024, 'maxFileBytes'),
    maxEntryBytes: boundedInteger(value.maxEntryBytes, 32 * 1024 * 1024 * 1024, 1, 128 * 1024 * 1024 * 1024, 'maxEntryBytes'),
    maxBrowserCacheBytes: boundedInteger(
      value.maxBrowserCacheBytes,
      4 * 1024 * 1024 * 1024,
      0,
      32 * 1024 * 1024 * 1024,
      'maxBrowserCacheBytes'
    ),
    publicMetadata: Object.freeze(publicMetadata),
    validator,
    transformer
  });
}

function createModuleLoader(validatorRoot) {
  const root = path.resolve(validatorRoot);
  const rootReal = fsp.realpath(root);
  const cache = new Map();
  return function loadModule(modulePath) {
    if (!cache.has(modulePath)) {
      const target = path.resolve(root, `.${modulePath}`);
      if (target === root || !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Data-validator module escapes the site root: ${modulePath}`);
      }
      const pending = Promise.all([rootReal, fsp.realpath(target)]).then(async ([resolvedRoot, resolvedTarget]) => {
        if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
          throw new Error(`Data-validator module escapes the site root: ${modulePath}`);
        }
        const stat = await fsp.stat(resolvedTarget);
        if (!stat.isFile()) throw new Error(`Data-validator module is not a file: ${modulePath}`);
        return import(pathToFileURL(resolvedTarget).href);
      }).catch(() => {
        throw new Error(`Data-validator module could not be loaded: ${modulePath}`);
      });
      cache.set(modulePath, pending);
      pending.catch(() => cache.delete(modulePath));
    }
    return cache.get(modulePath);
  };
}

function createMediaLibraryStore(options) {
  const config = options || {};
  const dataRoot = path.resolve(config.dataRoot || '/data');
  const validatorRoot = path.resolve(config.validatorRoot || process.cwd());
  const manifest = normalizeMediaLibrary(config.manifest, config.defaults);
  if (!manifest) throw new Error('A media-library manifest is required.');
  const libraryRoot = path.resolve(dataRoot, manifest.path);
  if (libraryRoot === dataRoot || !libraryRoot.startsWith(`${dataRoot}${path.sep}`)) {
    throw new Error('Media-library storage path escapes the data root.');
  }
  const entriesRoot = path.join(libraryRoot, 'entries');
  const incomingRoot = path.join(libraryRoot, '.incoming');
  const uploads = new Map();
  const loadModule = createModuleLoader(validatorRoot);

  function safeError(error) {
    let message = String(error && error.message || 'media validator failed');
    for (const sensitive of [dataRoot, validatorRoot]) message = message.split(sensitive).join('[path]');
    return message.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 1024) || 'media validator failed';
  }

  async function ensureRoots() {
    await fsp.mkdir(entriesRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(incomingRoot, { recursive: true, mode: 0o700 });
  }

  function entryDirectory(id) {
    if (!ENTRY_ID.test(String(id || ''))) { const error = new Error('Unknown media entry.'); error.statusCode = 404; throw error; }
    return path.join(entriesRoot, id);
  }

  function upload(id) {
    if (!UPLOAD_ID.test(String(id || '')) || !uploads.has(id)) {
      const error = new Error('Unknown or expired media upload.');
      error.statusCode = 404;
      throw error;
    }
    return uploads.get(id);
  }

  function metadataProjection(metadata) {
    const selected = {};
    for (const key of manifest.publicMetadata) {
      const value = metadata && metadata[key];
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) selected[key] = value;
    }
    return Object.freeze(selected);
  }

  function publicSummary(metadata) {
    return Object.freeze({
      id: metadata.id,
      label: metadata.label,
      fileCount: metadata.files.length,
      totalSize: metadata.totalSize,
      createdAt: metadata.createdAt,
      metadata: Object.freeze({ ...(metadata.publicMetadata || {}) })
    });
  }

  function normalizeStoredMetadata(value, expectedId) {
    if (!value || value.schemaVersion !== 1 || value.id !== expectedId || !ENTRY_ID.test(value.id)) throw new Error('Invalid media entry metadata.');
    const files = Array.from(value.files || []).map(file => {
      const id = safeKey(file.id, 'media file');
      const name = normalizeMediaRelativeName(file.name);
      const size = Number(file.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > manifest.maxFileBytes) throw new Error('Invalid media entry file size.');
      return Object.freeze({ id, name, size });
    });
    if (!files.length || new Set(files.map(file => file.id)).size !== files.length ||
        new Set(files.map(file => file.name.toLowerCase())).size !== files.length) {
      throw new Error('Invalid media entry file set.');
    }
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (totalSize !== value.totalSize || totalSize > manifest.maxEntryBytes) throw new Error('Invalid media entry total size.');
    const primary = normalizeMediaRelativeName(value.primary || files[0].name);
    if (!files.some(file => file.name === primary)) throw new Error('Invalid media entry primary file.');
    const createdAt = String(value.createdAt || '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) {
      throw new Error('Invalid media entry creation time.');
    }
    return Object.freeze({
      schemaVersion: 1,
      id: value.id,
      label: cleanLabel(value.label, value.id),
      createdAt,
      totalSize,
      primary,
      files: Object.freeze(files),
      publicMetadata: metadataProjection(value.publicMetadata),
      validation: value.validation || null
    });
  }

  async function readEntry(id) {
    const directory = entryDirectory(id);
    let encoded;
    try { encoded = await fsp.readFile(path.join(directory, ENTRY_FILE), 'utf8'); } catch (_) {
      const error = new Error('Unknown media entry.'); error.statusCode = 404; throw error;
    }
    try { return normalizeStoredMetadata(JSON.parse(encoded), id); } catch (_) {
      const error = new Error('Media entry metadata is invalid.'); error.statusCode = 409; throw error;
    }
  }

  async function listEntries() {
    await ensureRoots();
    const names = await fsp.readdir(entriesRoot, { withFileTypes: true });
    const entries = [];
    for (const item of names) {
      if (!item.isDirectory() || !ENTRY_ID.test(item.name)) continue;
      try { entries.push(publicSummary(await readEntry(item.name))); } catch (_) {}
    }
    entries.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
    return Object.freeze(entries);
  }

  async function status() {
    const entries = await listEntries();
    return Object.freeze({
      configured: true,
      namespace: manifest.namespace,
      version: manifest.version,
      ready: entries.length >= manifest.minimumEntries,
      minimumEntries: manifest.minimumEntries,
      launcherVisibleWhenReady: manifest.launcherVisibleWhenReady,
      entries,
      limits: Object.freeze({
        maxEntries: manifest.maxEntries,
        maxFilesPerEntry: manifest.maxFilesPerEntry,
        maxFileBytes: manifest.maxFileBytes,
        maxEntryBytes: manifest.maxEntryBytes,
        maxBrowserCacheBytes: manifest.maxBrowserCacheBytes
      })
    });
  }

  async function beginUpload(request) {
    const value = request || {};
    const files = Array.from(value.files || []);
    if (!files.length || files.length > manifest.maxFilesPerEntry) {
      const error = new Error(`A media bundle must contain 1 through ${manifest.maxFilesPerEntry} files.`);
      error.statusCode = 422;
      throw error;
    }
    if ((await listEntries()).length + uploads.size >= manifest.maxEntries) {
      const error = new Error('The media library has reached its entry limit.'); error.statusCode = 409; throw error;
    }
    let totalSize = 0;
    const names = new Set();
    const descriptors = files.map((file, index) => {
      const name = normalizeMediaRelativeName(file && file.name);
      const folded = name.toLowerCase();
      if (names.has(folded)) { const error = new Error(`Duplicate media-bundle path: ${name}`); error.statusCode = 422; throw error; }
      names.add(folded);
      const size = Number(file && file.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > manifest.maxFileBytes) {
        const error = new Error(`Media file ${name} is outside the upload envelope.`); error.statusCode = 413; throw error;
      }
      totalSize += size;
      if (!Number.isSafeInteger(totalSize) || totalSize > manifest.maxEntryBytes) {
        const error = new Error('Media bundle exceeds its upload envelope.'); error.statusCode = 413; throw error;
      }
      return Object.freeze({ id: `file-${index.toString(36)}`, name, size });
    });
    await ensureRoots();
    const id = crypto.randomBytes(16).toString('hex');
    const directory = path.join(incomingRoot, id);
    await fsp.mkdir(path.join(directory, 'files'), { recursive: true, mode: 0o700 });
    const session = {
      id, directory, descriptors: Object.freeze(descriptors), totalSize,
      label: value.label ? cleanLabel(value.label) : null,
      completed: new Set(), active: new Set()
    };
    uploads.set(id, session);
    return Object.freeze({ id, files: session.descriptors, totalSize });
  }

  async function acceptUploadFile(uploadId, fileId, readable) {
    const session = upload(uploadId);
    if (!FILE_ID.test(String(fileId || ''))) { const error = new Error('Unknown media upload file.'); error.statusCode = 404; throw error; }
    const descriptor = session.descriptors.find(file => file.id === fileId);
    if (!descriptor) { const error = new Error('Unknown media upload file.'); error.statusCode = 404; throw error; }
    if (session.completed.has(fileId) || session.active.has(fileId)) {
      const error = new Error(`${descriptor.name} has already been uploaded.`); error.statusCode = 409; throw error;
    }
    session.active.add(fileId);
    const target = path.join(session.directory, 'files', ...descriptor.name.split('/'));
    const temporary = `${target}.part`;
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    let received = 0;
    const destination = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    try {
      await new Promise((resolve, reject) => {
        let failed = false;
        const fail = error => { if (!failed) { failed = true; reject(error); } };
        readable.on('data', chunk => {
          received += chunk.length;
          if (received > descriptor.size) {
            const error = new Error(`${descriptor.name} exceeds its declared size.`);
            error.statusCode = 413;
            fail(error);
            readable.unpipe(destination);
            destination.destroy();
          }
        });
        readable.on('error', fail);
        destination.on('error', fail);
        destination.on('finish', () => { if (!failed) resolve(); });
        readable.pipe(destination);
      });
      if (received !== descriptor.size) {
        const error = new Error(`${descriptor.name} did not match its declared size.`); error.statusCode = 422; throw error;
      }
      await fsp.rename(temporary, target);
      session.completed.add(fileId);
      return Object.freeze({ id: fileId, size: received });
    } catch (error) {
      await fsp.rm(temporary, { force: true });
      throw error;
    } finally {
      session.active.delete(fileId);
    }
  }

  function digestFile(target, algorithm) {
    const name = String(algorithm).toLowerCase().replace(/-/g, '');
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(name);
      const stream = fs.createReadStream(target);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  function validationSource(session, descriptor) {
    const target = path.join(session.directory, 'files', ...descriptor.name.split('/'));
    return Object.freeze({
      name: descriptor.name,
      size: descriptor.size,
      async read(offset, length) {
        const handle = await fsp.open(target, 'r');
        try {
          const bytes = Buffer.alloc(length);
          const result = await handle.read(bytes, 0, length, offset);
          return bytes.subarray(0, result.bytesRead);
        } finally { await handle.close(); }
      },
      digest: algorithm => digestFile(target, algorithm)
    });
  }

  async function transformedInventory(root) {
    const files = [];
    let totalSize = 0;
    async function walk(directory, relative) {
      const items = (await fsp.readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name, 'en'));
      for (const item of items) {
        const target = path.join(directory, item.name);
        const name = normalizeMediaRelativeName(relative ? `${relative}/${item.name}` : item.name);
        if (item.isSymbolicLink()) throw new Error(`Transformed media contains a symbolic link: ${name}`);
        if (item.isDirectory()) {
          await walk(target, name);
          continue;
        }
        if (!item.isFile()) throw new Error(`Transformed media contains an unsupported entry: ${name}`);
        const stat = await fsp.stat(target);
        if (stat.size > manifest.maxFileBytes) throw new Error(`Transformed media file exceeds its envelope: ${name}`);
        totalSize += stat.size;
        if (!Number.isSafeInteger(totalSize) || totalSize > manifest.maxEntryBytes) {
          throw new Error('Transformed media exceeds its total-size envelope.');
        }
        files.push({ id: `file-${files.length.toString(36)}`, name, size: stat.size });
        if (files.length > manifest.maxFilesPerEntry) throw new Error('Transformed media exceeds its file-count envelope.');
      }
    }
    await walk(root, '');
    if (!files.length) throw new Error('Media transformer produced no files.');
    return Object.freeze({ files: Object.freeze(files.map(file => Object.freeze(file))), totalSize });
  }

  async function transformUpload(session) {
    const rule = manifest.transformer;
    if (!rule) return null;
    let module;
    try { module = await loadModule(rule.module); } catch (_) {
      throw new Error(`Media transformer module ${rule.module} could not be loaded.`);
    }
    const transform = module && module[rule.export];
    if (typeof transform !== 'function') {
      throw new Error(`Media transformer module ${rule.module} does not export ${rule.export}().`);
    }
    const inputDirectory = path.join(session.directory, 'files');
    const outputDirectory = path.join(session.directory, 'transformed');
    await fsp.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const sourceFiles = Object.freeze(session.descriptors.map(file => Object.freeze({
      name: file.name,
      size: file.size,
      path: path.join(inputDirectory, ...file.name.split('/'))
    })));
    const result = await transform(Object.freeze({
      files: sourceFiles,
      inputDirectory,
      outputDirectory,
      policy: rule.policy
    }));
    if (!result || result.transformed !== true) {
      await fsp.rm(outputDirectory, { recursive: true, force: true });
      return Object.freeze({ transformed: false });
    }
    const inventory = await transformedInventory(outputDirectory);
    await fsp.rm(inputDirectory, { recursive: true, force: true });
    await fsp.rename(outputDirectory, inputDirectory);
    session.descriptors = inventory.files;
    session.totalSize = inventory.totalSize;
    session.completed = new Set(inventory.files.map(file => file.id));
    return Object.freeze({
      transformed: true,
      label: result.label ? cleanLabel(result.label) : null,
      version: rule.version
    });
  }

  async function commitUpload(uploadId) {
    const session = upload(uploadId);
    if (session.active.size) { const error = new Error('Media files are still uploading.'); error.statusCode = 409; throw error; }
    const missing = session.descriptors.filter(file => !session.completed.has(file.id));
    if (missing.length) { const error = new Error(`Media bundle is missing ${missing[0].name}.`); error.statusCode = 409; throw error; }
    let validation;
    let transformation;
    try {
      transformation = await transformUpload(session);
      validation = await runMediaBundleValidator(
        session.descriptors.map(file => validationSource(session, file)),
        manifest.validator,
        { loadModule }
      );
      if (!validation.accepted) { const error = new Error(validation.error); error.statusCode = 422; throw error; }
    } catch (error) {
      await fsp.rm(session.directory, { recursive: true, force: true });
      uploads.delete(uploadId);
      if (!error.statusCode) error.statusCode = 422;
      error.message = `Media bundle was rejected: ${safeError(error)}`;
      throw error;
    }
    const primary = validation.primary || session.descriptors[0].name;
    const label = cleanLabel(validation.label || transformation?.label || session.label, path.basename(primary, path.extname(primary)));
    const metadata = {
      schemaVersion: 1,
      id: session.id,
      label,
      createdAt: new Date().toISOString(),
      totalSize: session.totalSize,
      primary,
      files: session.descriptors,
      publicMetadata: metadataProjection(validation.metadata),
      validation: {
        identity: validation.identity,
        version: validation.version,
        fingerprint: validation.fingerprint,
        validatorVersion: validation.validatorVersion,
        ...(transformation?.transformed ? { transformerVersion: transformation.version } : {})
      }
    };
    await fsp.writeFile(path.join(session.directory, ENTRY_FILE), `${JSON.stringify(metadata)}\n`, { mode: 0o600, flag: 'wx' });
    const target = entryDirectory(session.id);
    await fsp.rename(session.directory, target);
    uploads.delete(uploadId);
    return publicSummary(normalizeStoredMetadata(metadata, session.id));
  }

  async function abortUpload(uploadId) {
    const session = upload(uploadId);
    if (session.active.size) { const error = new Error('Media files are still uploading.'); error.statusCode = 409; throw error; }
    uploads.delete(uploadId);
    await fsp.rm(session.directory, { recursive: true, force: true });
    return Object.freeze({ ok: true });
  }

  async function detail(entryId) {
    const metadata = await readEntry(entryId);
    return Object.freeze({
      ...publicSummary(metadata),
      primary: metadata.primary,
      files: metadata.files,
      validator: Object.freeze({
        module: manifest.validator.module,
        export: manifest.validator.export,
        version: manifest.validator.version,
        policy: manifest.validator.policy,
        maxReadBytes: manifest.validator.maxReadBytes,
        maxTotalReadBytes: manifest.validator.maxTotalReadBytes
      }),
      cacheVersion: `${manifest.version}:${metadata.id}`
    });
  }

  async function entryFilePath(entryId, fileId) {
    const metadata = await readEntry(entryId);
    const descriptor = metadata.files.find(file => file.id === fileId);
    if (!descriptor) { const error = new Error('Unknown media file.'); error.statusCode = 404; throw error; }
    const root = path.join(entryDirectory(entryId), 'files');
    const target = path.join(root, ...descriptor.name.split('/'));
    const [rootReal, targetReal, stat] = await Promise.all([fsp.realpath(root), fsp.realpath(target), fsp.stat(target)]).catch(() => {
      const error = new Error('Media file is unavailable.'); error.statusCode = 404; throw error;
    });
    if (!stat.isFile() || stat.size !== descriptor.size || targetReal === rootReal || !targetReal.startsWith(`${rootReal}${path.sep}`)) {
      const error = new Error('Media file is unavailable.'); error.statusCode = 404; throw error;
    }
    return Object.freeze({ path: targetReal, descriptor });
  }

  return Object.freeze({
    manifest,
    status,
    listEntries,
    beginUpload,
    acceptUploadFile,
    commitUpload,
    abortUpload,
    detail,
    entryFilePath
  });
}

module.exports = { normalizeMediaLibrary, createMediaLibraryStore };
