#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const web = path.resolve(process.argv[2] || path.join(__dirname, '../build/web'));
const source = fs.readFileSync(path.join(web, 'game-adapter.js'), 'utf8');
const dataManifest = JSON.parse(fs.readFileSync(path.join(web, 'wasm-game-data.json'), 'utf8'));
const drawn = [];
const transitions = [];
const loading = [];
let createdPolicy;
let loadedPolicy;

const sandbox = {
  console,
  fetch: async request => {
    if (request === '/wasm-game-data.json') return { ok: true, json: async () => dataManifest };
    if (request === '/source-boundary.wasm') return { ok: true };
    throw new Error(`unexpected fetch ${request}`);
  },
  WebAssembly: {
    async instantiateStreaming() {
      return { instance: { exports: {
        source_wasm_boundary_version: () => 0x000701,
        source_wasm_has_engine: () => 0
      } } };
    }
  }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'game-adapter.js' });

const context = {
  variant: 'hl2',
  elements: { canvas: {
    width: 1280, height: 720,
    getContext(type) {
      assert.equal(type, '2d');
      return {
        fillStyle: '', font: '', fillRect() {},
        fillText(text) { drawn.push(String(text)); }
      };
    }
  } },
  framework: {
    createOwnerDataSet(policy) { createdPolicy = policy; return policy; }
  },
  dataClient: {
    async load(policy, options) {
      loadedPolicy = policy;
      options.onProgress({ phase: 'restored', key: policy.files[0].key, index: 0, total: policy.files.length });
      return { entries: policy.files.map(file => ({ policy: file })) };
    }
  },
  setEngineState(state) { transitions.push(state); },
  showRuntime(state) { transitions.push(state); },
  setLoading(...detail) { loading.push(detail); },
  log() {}
};

(async () => {
  const adapter = sandbox.WasmGameAdapter;
  assert.equal(adapter.readEngineState(), 'launcher');
  await adapter.init(context);
  assert.equal(createdPolicy.namespace, dataManifest.variants.hl2.namespace);
  const pending = adapter.start(context);
  assert.equal(adapter.readEngineState(), 'loading');
  await pending;
  assert.equal(loadedPolicy, createdPolicy);
  assert.equal(adapter.readEngineState(), 'crashed', 'the diagnostic must never claim menu or gameplay');
  assert.deepEqual(transitions, ['loading', 'crashed']);
  assert.ok(loading.some(detail => String(detail[0]).includes('Half-Life 2')));
  assert.doesNotMatch(loading.flat().join('\n'), /files?|data|cache|container|browser|mount|verif|directory|folder|path|module/i,
    'normal loading copy must remain title-focused');
  assert.ok(drawn.some(text => text === 'Engine present: no'));
  assert.ok(drawn.some(text => text.startsWith('Status: Still in development')));
  assert.doesNotMatch(drawn.join('\n'), /game[- ]data files|cached|container|directory|folder/i,
    'ready diagnostic copy must describe the engine boundary, not storage');
  console.log('Source boundary adapter loading, cache delegation, honest state, and runtime-copy contracts passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
