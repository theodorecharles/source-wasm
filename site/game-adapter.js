(function () {
  'use strict';

  const EXPECTED_BOUNDARY = 0x000701;
  let engineState = 'launcher';
  let ownerData;
  let manifest;

  function filePolicies(value) {
    return value.files.map(file => ({
      ...file,
      mountName: file.path,
      validateCached: false
    }));
  }

  function drawBoundary(context, entries) {
    const canvas = context.elements.canvas;
    const drawing = canvas.getContext('2d');
    drawing.fillStyle = '#101214';
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    drawing.fillStyle = '#dc5c24';
    drawing.font = '700 42px system-ui, sans-serif';
    drawing.fillText('Source WASM boundary verified', 72, 110);
    drawing.fillStyle = '#f4efe8';
    drawing.font = '26px system-ui, sans-serif';
    drawing.fillText(`${entries.length} exact owner files loaded from /data and cached privately.`, 72, 175);
    drawing.fillText('No redistributable Source engine runtime is available in the official SDK.', 72, 222);
    drawing.fillStyle = '#b7b0a7';
    drawing.font = '22px ui-monospace, monospace';
    drawing.fillText('Status: Still in development', 72, 300);
    drawing.fillText('Engine present: no', 72, 340);
    drawing.fillText('Counter-Strike: Source: not included', 72, 380);
  }

  globalThis.WasmGameAdapter = {
    async init(context) {
      const root = await fetch('/wasm-game-data.json', { cache: 'no-store' }).then(response => {
        if (!response.ok) throw new Error(`Owner-data policy failed with HTTP ${response.status}.`);
        return response.json();
      });
      manifest = root.variants[context.variant];
      if (!manifest) throw new Error(`No owner-data policy exists for ${context.variant}.`);
      ownerData = context.framework.createOwnerDataSet({
        namespace: manifest.namespace,
        version: manifest.version,
        files: filePolicies(manifest)
      });
      context.log('[source-wasm] Legal boundary: official Source SDK 2013 has no Source engine runtime.');
      context.log('[source-wasm] This adapter will validate owner data and execute only an original diagnostic module.');
    },

    async start(context) {
      engineState = 'loading';
      context.setEngineState('loading');
      context.setLoading('Loading exact owner files…', 'Container data will be restored from this browser cache after the first load.', 5);
      const loaded = await ownerData.load(
        policy => context.dataClient.load(policy.key),
        {
          onProgress(detail) {
            const index = Math.max(0, Number(detail.index) || 0);
            const total = Math.max(1, Number(detail.total) || manifest.files.length);
            const progress = 5 + Math.round(((index + (detail.phase === 'cached' || detail.phase === 'restored' ? 1 : 0.4)) / total) * 80);
            context.setLoading(`Checking ${detail.key || 'owner data'}…`, detail.phase || '', progress);
          }
        }
      );
      context.setLoading('Executing the source boundary module…', 'This module deliberately contains no Valve engine code.', 90);
      const response = await fetch('/source-boundary.wasm', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Boundary module failed with HTTP ${response.status}.`);
      const result = await WebAssembly.instantiateStreaming(response, {});
      const exports = result.instance.exports;
      if (exports.source_wasm_boundary_version() !== EXPECTED_BOUNDARY) throw new Error('Unexpected Source WASM boundary ABI.');
      if (exports.source_wasm_has_engine() !== 0) throw new Error('The diagnostic module falsely reported an engine.');
      engineState = 'crashed';
      context.showRuntime('crashed');
      drawBoundary(context, loaded.entries);
      context.log(`[source-wasm] Verified ${loaded.entries.length} owner files and diagnostic WASM ABI 0x${EXPECTED_BOUNDARY.toString(16)}.`);
      context.log('[source-wasm] Half-Life 2 cannot launch: Valve does not publish a redistributable full Source 1 engine.');
    },

    readEngineState() {
      return engineState;
    }
  };
})();

