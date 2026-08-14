(function () {
  'use strict';

  const EXPECTED_BOUNDARY = 0x000701;
  let engineState = 'launcher';
  let ownerData;
  let manifest;

  function filePolicies(value) {
    return value.files.map(file => ({
      ...file,
      mountName: file.path
    }));
  }

  function drawBoundary(context) {
    const canvas = context.elements.canvas;
    const drawing = canvas.getContext('2d');
    drawing.fillStyle = '#101214';
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    drawing.fillStyle = '#dc5c24';
    drawing.font = '700 42px system-ui, sans-serif';
    drawing.fillText('Source WASM boundary verified', 72, 110);
    drawing.fillStyle = '#f4efe8';
    drawing.font = '26px system-ui, sans-serif';
    drawing.fillText('The diagnostic module completed successfully.', 72, 175);
    drawing.fillText('The published SDK does not contain the Source engine runtime.', 72, 222);
    drawing.fillStyle = '#b7b0a7';
    drawing.font = '22px ui-monospace, monospace';
    drawing.fillText('Status: Still in development', 72, 300);
    drawing.fillText('Engine present: no', 72, 340);
    drawing.fillText('Counter-Strike: Source: not included', 72, 380);
  }

  globalThis.WasmGameAdapter = {
    async init(context) {
      const root = await fetch('/wasm-game-data.json', { cache: 'no-store' }).then(response => {
        if (!response.ok) throw new Error(`Game-data policy failed with HTTP ${response.status}.`);
        return response.json();
      });
      manifest = root.variants[context.variant];
      if (!manifest) throw new Error(`No game-data policy exists for ${context.variant}.`);
      ownerData = context.framework.createOwnerDataSet({
        namespace: manifest.namespace,
        version: manifest.version,
        files: filePolicies(manifest)
      });
      context.log('[source-wasm] Published-source boundary: Source SDK 2013 has no Source engine runtime.');
      context.log('[source-wasm] This adapter validates required game data and executes an original diagnostic module.');
    },

    async start(context) {
      engineState = 'loading';
      context.setEngineState('loading');
      try {
        context.setLoading('Preparing Half-Life 2 status…', '', 5);
        const loaded = await context.dataClient.load(ownerData, {
          onProgress(detail) {
            const index = Math.max(0, Number(detail.index) || 0);
            const total = Math.max(1, Number(detail.total) || manifest.files.length);
            const progress = 5 + Math.round(((index + (detail.phase === 'cached' || detail.phase === 'restored' ? 1 : 0.4)) / total) * 80);
            context.setLoading('Preparing Half-Life 2 status…', '', progress);
          }
        });
        context.setLoading('Preparing Half-Life 2 status…', '', 90);
        const response = await fetch('/source-boundary.wasm', { cache: 'no-cache' });
        if (!response.ok) throw new Error(`Boundary module failed with HTTP ${response.status}.`);
        const result = await WebAssembly.instantiateStreaming(response, {});
        const exports = result.instance.exports;
        if (exports.source_wasm_boundary_version() !== EXPECTED_BOUNDARY) throw new Error('Unexpected Source WASM boundary ABI.');
        if (exports.source_wasm_has_engine() !== 0) throw new Error('The diagnostic module falsely reported an engine.');
        engineState = 'crashed';
        context.showRuntime('crashed');
        drawBoundary(context);
        context.log(`[source-wasm] Verified ${loaded.entries.length} game files and diagnostic WASM ABI 0x${EXPECTED_BOUNDARY.toString(16)}.`);
        context.log('[source-wasm] Half-Life 2 cannot launch: the published SDK does not contain a full Source 1 engine.');
      } catch (error) {
        engineState = 'crashed';
        throw error;
      }
    },

    readEngineState() {
      return engineState;
    }
  };
})();
