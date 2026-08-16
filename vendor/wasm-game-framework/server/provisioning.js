'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  dataValidatorCacheTag,
  normalizeDataValidatorDeclaration,
  runDataValidator
} = require('../dist/wasm-game-framework.js');
const { normalizeMediaLibrary } = require('./media-library');

function safeKey(value) {
  const key = String(value || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) throw new Error(`Invalid game-data key: ${value}`);
  return key;
}

function safeName(value) {
  const raw = String(value || '').toLowerCase();
  const name = path.basename(raw);
  if (!name || name === '.' || name === '..' || name !== raw) throw new Error(`Invalid game-data filename: ${value}`);
  return name;
}

function safeRelative(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  const normalized = path.posix.normalize(raw).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid game-data path: ${value}`);
  }
  return normalized;
}

function mergeValidator(base, override) {
  if (override === false) return null;
  if (!base && !override) return null;
  const local = override && typeof override === 'object' ? override : {};
  const merged = {
    ...(base || {}),
    ...local,
    policy: { ...((base && base.policy) || {}), ...(local.policy || {}) }
  };
  return normalizeDataValidatorDeclaration(merged);
}

function mergeMediaLibrary(base, override) {
  if (override === false) return false;
  if (override === undefined) return base;
  if (!base) return override;
  const local = override && typeof override === 'object' ? override : {};
  const baseValidator = base.validator && typeof base.validator === 'object' ? base.validator : {};
  const localValidator = local.validator && typeof local.validator === 'object' ? local.validator : {};
  return {
    ...base,
    ...local,
    validator: {
      ...baseValidator,
      ...localValidator,
      policy: { ...(baseValidator.policy || {}), ...(localValidator.policy || {}) }
    }
  };
}

function normalizeManifest(input) {
  const manifest = input || {};
  const namespace = safeKey(manifest.namespace || 'game');
  const version = String(manifest.version || '1');
  const manifestValidator = manifest.validator ? normalizeDataValidatorDeclaration(manifest.validator) : null;
  const files = (manifest.files || []).map((entry, index) => {
    const key = safeKey(entry.key || entry.name || `file-${index}`);
    const name = safeName(entry.name || key);
    const relativePath = safeRelative(entry.path || name);
    const names = Array.from(new Set([name, ...(entry.names || []).map(safeName)]));
    const sizes = (entry.sizes || (entry.size === undefined ? [] : [entry.size])).map(Number);
    if (sizes.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error(`Invalid size policy for ${key}.`);
    const sha256 = (entry.sha256 ? (Array.isArray(entry.sha256) ? entry.sha256 : [entry.sha256]) : [])
      .map(value => String(value).toLowerCase());
    if (sha256.some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error(`Invalid SHA-256 policy for ${key}.`);
    const validator = mergeValidator(manifestValidator, entry.validator);
    const minSize = entry.minSize === undefined ? undefined : Number(entry.minSize);
    const maxSize = entry.maxSize === undefined ? undefined : Number(entry.maxSize);
    if (minSize !== undefined && (!Number.isSafeInteger(minSize) || minSize < 0)) throw new Error(`Invalid minimum size for ${key}.`);
    if (maxSize !== undefined && (!Number.isSafeInteger(maxSize) || maxSize < 0)) throw new Error(`Invalid maximum size for ${key}.`);
    if (minSize !== undefined && maxSize !== undefined && minSize > maxSize) throw new Error(`Minimum size exceeds maximum size for ${key}.`);
    if (validator && !sizes.length && maxSize === undefined) {
      throw new Error(`Data validator for ${key} requires sizes or maxSize as an upload envelope.`);
    }
    return Object.freeze({
      ...entry, key, name, path: relativePath, names, sizes, sha256, minSize, maxSize, validator,
      required: entry.required !== false
    });
  });
  const mediaLibrary = normalizeMediaLibrary(manifest.mediaLibrary, { namespace, version });
  if (!files.length && !mediaLibrary) throw new Error('A game-data manifest must contain a fixed file or media library.');
  return Object.freeze({
    namespace,
    version,
    files: Object.freeze(files),
    mediaLibrary
  });
}

function normalizeManifestCollection(input) {
  const manifest = input || {};
  if (!manifest.variants || typeof manifest.variants !== 'object' || Array.isArray(manifest.variants)) {
    return new Map([['default', normalizeManifest(manifest)]]);
  }
  const rootNamespace = safeKey(manifest.namespace || 'game-suite');
  const rootVersion = String(manifest.version || '1');
  const variants = new Map();
  for (const [rawKey, value] of Object.entries(manifest.variants)) {
    const key = safeKey(rawKey);
    const definition = value || {};
    variants.set(key, normalizeManifest({
      ...definition,
      namespace: definition.namespace || `${rootNamespace}-${key}`,
      version: definition.version || rootVersion,
      validator: definition.validator === undefined ? manifest.validator : definition.validator,
      mediaLibrary: mergeMediaLibrary(manifest.mediaLibrary, definition.mediaLibrary)
    }));
  }
  if (!variants.size) throw new Error('A suite game-data manifest must contain at least one variant.');
  return variants;
}

function magicSpecifications(rule) {
  if (rule.magic === undefined) return [];
  const values = Array.isArray(rule.magic) && rule.magic.length && typeof rule.magic[0] === 'object' ? rule.magic : [rule.magic];
  return values.map(value => {
    const spec = value && value.bytes !== undefined ? value : { bytes: value, offset: 0 };
    return {
      offset: Number(spec.offset) || 0,
      bytes: typeof spec.bytes === 'string' ? Buffer.from(spec.bytes, 'latin1') : Buffer.from(spec.bytes)
    };
  });
}

function createProvisioningStore(options) {
  const config = options || {};
  const dataRoot = path.resolve(config.dataRoot || '/data');
  const validatorRoot = path.resolve(config.validatorRoot || process.cwd());
  const manifest = normalizeManifest(config.manifest);
  const validationCache = new Map();
  const moduleCache = new Map();
  const validatorRootReal = fsp.realpath(validatorRoot);

  function filePath(policy) { return path.join(dataRoot, policy.path); }

  function validatorPath(modulePath) {
    const target = path.resolve(validatorRoot, `.${modulePath}`);
    if (target === validatorRoot || !target.startsWith(`${validatorRoot}${path.sep}`)) {
      throw new Error(`Data-validator module escapes the site root: ${modulePath}`);
    }
    return target;
  }

  function loadValidatorModule(modulePath) {
    if (!moduleCache.has(modulePath)) {
      const target = validatorPath(modulePath);
      const pending = Promise.all([validatorRootReal, fsp.realpath(target)]).then(async ([rootReal, targetReal]) => {
        if (targetReal === rootReal || !targetReal.startsWith(`${rootReal}${path.sep}`)) {
          throw new Error(`Data-validator module escapes the site root: ${modulePath}`);
        }
        const stat = await fsp.stat(targetReal);
        if (!stat.isFile()) throw new Error(`Data-validator module is not a file: ${modulePath}`);
        return import(pathToFileURL(targetReal).href);
      }).catch(() => {
        throw new Error(`Data-validator module could not be loaded: ${modulePath}`);
      });
      moduleCache.set(modulePath, pending);
      pending.catch(() => moduleCache.delete(modulePath));
    }
    return moduleCache.get(modulePath);
  }

  function streamDigest(target, algorithm) {
    const nodeAlgorithm = String(algorithm).toLowerCase().replace(/-/g, '');
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(nodeAlgorithm);
      const stream = fs.createReadStream(target);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  function safeValidatorError(error) {
    let message = String(error && error.message || 'data validator failed');
    for (const sensitive of [dataRoot, validatorRoot]) {
      if (sensitive) message = message.split(sensitive).join('[path]');
    }
    return message.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 1024) || 'data validator failed';
  }

  async function validatePath(policy, target, cacheable) {
    let stat;
    try { stat = await fsp.stat(target); } catch (_) { return { valid: false, error: 'missing' }; }
    if (!stat.isFile()) return { valid: false, error: 'not a regular file' };
    if (policy.sizes.length && !policy.sizes.includes(stat.size)) return { valid: false, error: `wrong size (${stat.size})` };
    if (policy.minSize !== undefined && stat.size < Number(policy.minSize)) return { valid: false, error: 'too small' };
    if (policy.maxSize !== undefined && stat.size > Number(policy.maxSize)) return { valid: false, error: 'too large' };
    const validatorTag = policy.validator ? dataValidatorCacheTag(policy.validator) : '';
    const cacheKey = `${target}:${stat.size}:${stat.mtimeMs}:${manifest.version}:${validatorTag}`;
    if (cacheable && validationCache.has(cacheKey)) return validationCache.get(cacheKey);
    const handle = await fsp.open(target, 'r');
    let dataValidation = null;
    try {
      for (const specification of magicSpecifications(policy)) {
        const actual = Buffer.alloc(specification.bytes.length);
        const result = await handle.read(actual, 0, actual.length, specification.offset);
        if (result.bytesRead !== actual.length || !actual.equals(specification.bytes)) {
          return { valid: false, error: `wrong signature at byte ${specification.offset}` };
        }
      }
      if (policy.validator) {
        try {
          dataValidation = await runDataValidator({
            size: stat.size,
            async read(offset, length) {
              const bytes = Buffer.alloc(length);
              const result = await handle.read(bytes, 0, length, offset);
              return bytes.subarray(0, result.bytesRead);
            },
            digest: algorithm => streamDigest(target, algorithm)
          }, policy.validator, { name: policy.name, loadModule: loadValidatorModule });
        } catch (error) {
          return { valid: false, error: safeValidatorError(error) };
        }
        if (!dataValidation.accepted) return { valid: false, error: dataValidation.error, validation: dataValidation };
      }
    } finally { await handle.close(); }
    let digest = null;
    if (policy.sha256.length) {
      digest = await streamDigest(target, 'SHA-256');
      if (!policy.sha256.includes(digest)) return { valid: false, error: 'wrong SHA-256' };
    }
    const result = Object.freeze({ valid: true, path: target, size: stat.size, sha256: digest, validation: dataValidation });
    if (cacheable) validationCache.set(cacheKey, result);
    return result;
  }

  async function validate(policy) {
    return validatePath(policy, filePath(policy), true);
  }

  async function status() {
    const results = await Promise.all(manifest.files.map(validate));
    const files = manifest.files.map((policy, index) => Object.freeze({
      key: policy.key,
      name: policy.name,
      path: policy.path,
      names: policy.names,
      sizes: policy.sizes,
      ...(policy.validator ? {
        validator: Object.freeze({
          module: policy.validator.module,
          export: policy.validator.export,
          version: policy.validator.version,
          policy: policy.validator.policy
        }),
        validation: results[index].validation || null
      } : {}),
      required: policy.required,
      valid: Boolean(results[index].valid),
      error: results[index].valid ? null : results[index].error
    }));
    return Object.freeze({
      configured: true,
      namespace: manifest.namespace,
      version: manifest.version,
      ready: files.every(file => !file.required || file.valid),
      files: Object.freeze(files)
    });
  }

  function policyFor(key) {
    const normalized = safeKey(key);
    return manifest.files.find(policy => policy.key === normalized) || null;
  }

  async function acceptUpload(key, readable) {
    const policy = policyFor(key);
    if (!policy) { const error = new Error('Unknown game-data file.'); error.statusCode = 404; throw error; }
    if ((await validate(policy)).valid) { const error = new Error(`${policy.name} is already valid.`); error.statusCode = 409; throw error; }
    const target = filePath(policy);
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    const temporary = path.join(path.dirname(target), `.${policy.name}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.upload`);
    const maximum = policy.sizes.length ? Math.max(...policy.sizes) :
      policy.maxSize === undefined ? 8 * 1024 * 1024 * 1024 : Number(policy.maxSize);
    let received = 0;
    const destination = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    try {
      await new Promise((resolve, reject) => {
        let failed = false;
        const fail = error => { if (!failed) { failed = true; reject(error); } };
        readable.on('data', chunk => {
          received += chunk.length;
          if (received > maximum) {
            const error = new Error(`${policy.name} exceeds its allowed size.`);
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
      const result = await validatePath(policy, temporary, false);
      if (!result.valid) {
        const error = new Error(`${policy.name} was rejected: ${result.error}.`);
        error.statusCode = 422;
        throw error;
      }
      await fsp.chmod(temporary, 0o644);
      await fsp.rename(temporary, target);
      validationCache.clear();
      const targetStat = await fsp.stat(target);
      const validatorTag = policy.validator ? dataValidatorCacheTag(policy.validator) : '';
      const cacheKey = `${target}:${targetStat.size}:${targetStat.mtimeMs}:${manifest.version}:${validatorTag}`;
      const accepted = Object.freeze({ ...result, path: target });
      validationCache.set(cacheKey, accepted);
      return accepted;
    } catch (error) {
      await fsp.rm(temporary, { force: true });
      throw error;
    }
  }

  return Object.freeze({ manifest, dataRoot, status, validate, policyFor, acceptUpload, filePath });
}

module.exports = { normalizeManifest, normalizeManifestCollection, createProvisioningStore };
