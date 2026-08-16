#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeControllerMode,
  normalizeMenuCursor,
  resolvePersistenceRoot,
  validateAdapterContract
} = require('../dist/wasm-game-framework.js');
const { normalizeManifestCollection } = require('../server/provisioning.js');

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function publicFile(root, url) {
  const pathname = String(url || '').split(/[?#]/, 1)[0].replace(/^\/+/, '');
  return path.join(root, pathname);
}

function isRuntimeAsset(url) {
  return /^\/game-data\/files\//.test(String(url || ''));
}

function methodStub(source, name) {
  const pattern = new RegExp(`(?:^|[,{])\\s*(?:async\\s+)?${name}\\s*(?:\\(|:|[,}])`, 'm');
  return pattern.test(source) ? function adapterMethod() {} : undefined;
}

function mergedVariants(rootConfig) {
  if (!rootConfig.variants) return [{ key: rootConfig.id || 'game', config: rootConfig }];
  return Object.entries(rootConfig.variants).map(([key, value]) => {
    const base = { ...rootConfig };
    delete base.variants;
    return { key, config: { ...base, ...value, id: key } };
  });
}

function assertNeutralReadyCopy(config, key) {
  const normal = [config.description, config.loadingTitle, config.pwa?.description].filter(Boolean).join('\n');
  if (/\b(?:legal(?:ly)?|illegal|piracy|entitlement|owner[- ]?(?:supplied|provided|data)|game data|files?|cache[ds]?|container|directory|folder|upload(?:ed|ing)?|download(?:ed|ing)?)\b/i.test(normal)) {
    fail(`${key}: normal launcher/PWA copy contains provisioning or storage language`);
  }
}

function checkConfig(siteRoot, key, config, adapterSource, rootConfig) {
  let resolvedPersistenceRoot = null;
  if (!['4:3', '16:9', 'dynamic'].includes(config.displayMode)) {
    fail(`${key}: displayMode must be exactly 4:3, 16:9, or dynamic`);
  }
  if ((config.pointerWidth == null) !== (config.pointerHeight == null)) {
    fail(`${key}: pointerWidth and pointerHeight must be declared together`);
  }
  if (config.pointerFit != null && !['contain', 'fill'].includes(config.pointerFit)) {
    fail(`${key}: pointerFit must be contain or fill`);
  }
  if (!normalizeMenuCursor(config.menuCursor)) {
    fail(`${key}: menuCursor must be native, browser, or none`);
  }
  if (config.resizeTransition != null && !['immediate', 'native'].includes(config.resizeTransition)) {
    fail(`${key}: resizeTransition must be immediate or native`);
  }
  if (config.fullscreen !== true && config.fullscreen !== false) {
    fail(`${key}: fullscreen capability must be explicit`);
  }
  if (!Object.prototype.hasOwnProperty.call(config, 'controller')) {
    fail(`${key}: controller capability must be explicit`);
  }
  const controllerMode = normalizeControllerMode(config.controller);
  if (!controllerMode) {
    fail(`${key}: controller.mode must be disabled, wasdMouse, or custom`);
  }
  if (!Object.prototype.hasOwnProperty.call(config, 'persistence')) {
    fail(`${key}: save/config persistence capability must be explicit`);
  }
  if (config.persistence !== false) {
    if (!config.persistence || typeof config.persistence !== 'object' || Array.isArray(config.persistence)) {
      fail(`${key}: persistence must be false or an object`);
    }
    const root = String(config.persistence.root || '');
    if (!root.startsWith('/') || root.includes('..') || /[\\\0]/.test(root)) {
      fail(`${key}: persistence.root must be an absolute traversal-free virtual filesystem path`);
    }
    try {
      resolvedPersistenceRoot = resolvePersistenceRoot(root, {
        namespace: config.persistence.namespace || `${rootConfig.id || 'wasm-game'}-${key}`,
        variant: key
      });
    } catch (error) {
      fail(`${key}: ${error.message}`);
    }
    for (const [name, minimum, maximum] of [['debounceMs', 0, 60000], ['intervalMs', 0, 600000]]) {
      if (config.persistence[name] != null) {
        const value = Number(config.persistence[name]);
        if (!Number.isFinite(value) || value < minimum || value > maximum) {
          fail(`${key}: persistence.${name} must be between ${minimum} and ${maximum}`);
        }
      }
    }
    if (config.persistence.requestDurability != null && typeof config.persistence.requestDurability !== 'boolean') {
      fail(`${key}: persistence.requestDurability must be boolean`);
    }
  }
  if (!config.icon || (!isRuntimeAsset(config.icon) && !fs.existsSync(publicFile(siteRoot, config.icon)))) {
    fail(`${key}: launcher icon is missing`);
  }
  if (!(config.pwa?.name || config.title) || !config.pwa?.shortName || !Array.isArray(config.pwa?.icons) || !config.pwa.icons.length) {
    fail(`${key}: complete PWA title, shortName, and icons are required`);
  }
  for (const icon of config.pwa.icons) {
    if (!icon.src || !icon.sizes || !icon.type || (!isRuntimeAsset(icon.src) && !fs.existsSync(publicFile(siteRoot, icon.src)))) {
      fail(`${key}: invalid or missing PWA icon ${icon.src || '<unnamed>'}`);
    }
  }
  assertNeutralReadyCopy(config, key);

  const names = [
    'start', 'resize', 'pointerMove', 'pointerButton', 'readEngineState', 'captureLost',
    'inputCaptureChanged', 'preferencesChanged', 'controllerFrame', 'controllerChanged',
    'persistenceChanged', 'contextLost', 'contextRestored'
  ];
  const adapter = Object.fromEntries(names.map(name => [name, methodStub(adapterSource, name)]).filter(([, value]) => value));
  try {
    validateAdapterContract(config, adapter);
  } catch (error) {
    fail(`${key}: ${error.message}`);
  }
  return config.persistence === false ? null : resolvedPersistenceRoot;
}

function main() {
  const siteRoot = path.resolve(process.argv[2] || 'site');
  const manifestPath = path.join(siteRoot, 'wasm-game.json');
  if (!fs.existsSync(manifestPath)) fail(`Missing ${manifestPath}`);
  const rootConfig = readJson(manifestPath);
  const adapterPath = publicFile(siteRoot, rootConfig.adapter || '/game-adapter.js');
  if (!fs.existsSync(adapterPath)) fail(`Missing ${adapterPath}`);
  const adapterSource = fs.readFileSync(adapterPath, 'utf8');

  const resolvedPersistenceRoots = new Map();
  for (const { key, config } of mergedVariants(rootConfig)) {
    const persistenceRoot = checkConfig(siteRoot, key, config, adapterSource, rootConfig);
    if (persistenceRoot && resolvedPersistenceRoots.has(persistenceRoot)) {
      fail(`${key}: persistence root ${persistenceRoot} collides with ${resolvedPersistenceRoots.get(persistenceRoot)}`);
    }
    if (persistenceRoot) resolvedPersistenceRoots.set(persistenceRoot, key);
  }
  const dataManifestPath = path.join(siteRoot, 'wasm-game-data.json');
  if (fs.existsSync(dataManifestPath)) {
    const manifests = normalizeManifestCollection(readJson(dataManifestPath));
    for (const [variant, manifest] of manifests) {
      for (const policy of manifest.files) {
        if (policy.validator && !fs.existsSync(publicFile(siteRoot, policy.validator.module))) {
          fail(`${variant}/${policy.key}: data-validator module is missing: ${policy.validator.module}`);
        }
      }
    }
  }
  console.log(`adapter package contract passed for ${mergedVariants(rootConfig).length} variant(s) in ${siteRoot}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
