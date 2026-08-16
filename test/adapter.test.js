'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'web', 'game-adapter.js'), 'utf8');
const dataManifest = JSON.parse(fs.readFileSync(path.join(root, 'web', 'wasm-game-data.json'), 'utf8'));

assert.doesNotMatch(source, /module\.exports|exports\.|require\(/);
assert.match(source, /createSourceEngineModule/);
assert.match(source, /noInitialRun:\s*true/);
assert.doesNotMatch(source, /requestPointerLock|exitPointerLock/);

const order = [];
let attachedRoot = null;
let callMainArgs = null;

function createFakeModule() {
  const native = { state: 2, intent: 0 };
  return {
    FS: {
      filesystems: { IDBFS: {} },
      mkdirTree() {},
      symlink() {},
      writeFile() {},
      createFile() {
        return { stream_ops: {}, contents: null };
      },
      createDataFile() {}
    },
    callMain(args) {
      order.push('callMain');
      callMainArgs = args;
    },
    source_wasm_read_engine_state() {
      return native.state;
    },
    source_wasm_read_capture_intent() {
      return native.intent;
    },
    source_wasm_pause() {
      order.push('pause');
      native.state = 4;
    },
    ccall() {}
  };
}

const sandbox = {
  console,
  fetch: async (url) => {
    const href = String(url);
    if (href.startsWith('/wasm-game-data.json')) {
      return { ok: true, json: async () => dataManifest };
    }
    if (href.includes('/game-data/files/')) {
      const body = new TextEncoder().encode('owner');
      return { ok: true, status: 200, arrayBuffer: async () => body.buffer };
    }
    throw new Error(`unexpected fetch ${url}`);
  },
  XMLHttpRequest: undefined,
  document: undefined
};
sandbox.globalThis = sandbox;
sandbox.createSourceEngineModule = async (options) => {
  assert.equal(options.noInitialRun, true);
  order.push('factory');
  return createFakeModule();
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'game-adapter.js' });

const adapter = sandbox.WasmGameAdapter;
const context = {
  variant: 'hl2',
  preferences: { playerName: 'Gordon' },
  framework: {
    createOwnerDataSet(policy) {
      assert.equal(policy.version, 'steam-legacy-hl2-v1');
      return policy;
    }
  },
  persistence: {
    root: '/save/hl2',
    async attach(_fs, opts) {
      order.push('persist');
      attachedRoot = opts.root;
    }
  },
  log() {},
  showLoading() {},
  setLoading() {},
  setEngineState() {},
  showRuntime() {}
};

(async () => {
  await adapter.init(context);
  assert.equal(adapter.readEngineState(), 'launcher');
  await adapter.start(context);
  assert.deepEqual(order, ['factory', 'persist', 'callMain']);
  assert.equal(attachedRoot, '/save/hl2');
  assert.ok(callMainArgs.includes('-game'));
  assert.ok(callMainArgs.includes('hl2'));
  assert.ok(callMainArgs.includes('-novid'));
  assert.equal(adapter.readEngineState(), 'menu');
  adapter.captureLost();
  assert.equal(adapter.readEngineState(), 'paused');
  process.stdout.write('adapter unit: persist-before-main, native factory, honest state\n');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
