(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const elements = Object.freeze({
    launcher: byId('launcher'), form: byId('launcher-form'), icon: byId('game-icon'),
    kicker: byId('game-kicker'), title: byId('game-title'), description: byId('game-description'),
    variantRow: byId('variant-row'), variant: byId('game-variant'), provisioning: byId('data-provisioning'),
    instructions: byId('data-instructions'), chooseDirectory: byId('choose-directory'),
    chooseFiles: byId('choose-files'), fileInput: byId('game-files'), directoryInput: byId('game-directory'),
    mediaLibrary: byId('media-library'), mediaEntryRow: byId('media-entry-row'),
    mediaEntry: byId('media-entry'), mediaStatus: byId('media-status'),
    addMediaDirectory: byId('add-media-directory'), addMediaFiles: byId('add-media-files'),
    mediaFiles: byId('media-files'), mediaDirectory: byId('media-directory'),
    setupTokenRow: byId('setup-token-row'), setupToken: byId('setup-token'),
    passwordRow: byId('password-row'), password: byId('game-password'), unlock: byId('unlock'),
    identityRow: byId('identity-row'),
    playerName: byId('player-name'), advanced: byId('advanced-settings'), graphicsRow: byId('graphics-row'),
    controllerRow: byId('controller-row'), controllerSelect: byId('game-controller'),
    controllerMode: byId('controller-mode'), controllerStatus: byId('controller-status'),
    graphicsProfile: byId('graphics-profile'), fpsRow: byId('fps-row'), fpsTarget: byId('fps-target'),
    dynamicRow: byId('dynamic-row'), dynamicQuality: byId('dynamic-quality'), play: byId('play'),
    fullscreenRow: byId('fullscreen-row'), launchFullscreen: byId('launch-fullscreen'),
    status: byId('status'), error: byId('error'), loading: byId('loading'), loadingKicker: byId('loading-kicker'),
    loadingTitle: byId('loading-title'), loadingStatus: byId('loading-status'),
    loadingProgress: byId('loading-progress'), loadingDetail: byId('loading-detail'),
    console: byId('loading-console'), runtime: byId('runtime'), canvas: byId('game-canvas')
  });

  let rootConfig;
  let config;
  let variant;
  let shell;
  let dataClient;
  let mediaDeployment;
  let persistence;
  let passwordClient;
  let adapter;
  let initialized = false;
  let runtimeInitialization;

  function text(node, value) {
    if (!node) return;
    node.textContent = String(value || '');
    node.hidden = !value;
  }

  function options(select, values, selected) {
    select.textContent = '';
    for (const value of values || []) {
      const option = document.createElement('option');
      option.value = String(value.value);
      option.textContent = String(value.label || value.value);
      option.selected = String(value.value) === String(selected);
      select.appendChild(option);
    }
  }

  function selectedVariant() {
    const variants = rootConfig.variants || {};
    const keys = Object.keys(variants);
    const injected = String(globalThis.WASM_GAME_VARIANT || '').toLowerCase();
    const locked = injected && injected !== 'suite';
    const query = String(new URLSearchParams(location.search).get('game') || '').toLowerCase();
    const requested = locked ? injected : (elements.variant.value || query);
    const fallback = keys.includes(rootConfig.defaultVariant) ? rootConfig.defaultVariant : keys[0];
    if (locked && !keys.includes(requested)) throw new Error(`Unknown locked game variant: ${injected}`);
    const key = keys.includes(requested) ? requested : fallback;
    return { key, locked, value: variants[key] };
  }

  function selectedMediaDeployment() {
    const injected = String(globalThis.WASM_GAME_MEDIA || '').trim();
    const params = new URLSearchParams(location.search);
    if (injected) return Object.freeze({ value: injected, explicit: true, locked: true, source: 'deployment' });
    return Object.freeze({
      value: params.get('media') || '', explicit: params.has('media'), locked: false, source: 'query'
    });
  }

  function updateManifestLink(mediaId) {
    const manifestLink = document.querySelector('link[rel="manifest"]');
    if (!manifestLink) return;
    const params = new URLSearchParams({ variant });
    const id = WasmGameFramework.normalizeMediaEntryId(mediaId);
    if (id) params.set('media', id);
    manifestLink.href = `/app.webmanifest?${params}`;
  }

  function updateMediaUrl(mediaId) {
    if (mediaDeployment.locked) return;
    const id = WasmGameFramework.normalizeMediaEntryId(mediaId);
    const url = new URL(location.href);
    if (id) url.searchParams.set('media', id);
    else url.searchParams.delete('media');
    history.replaceState(history.state, '', url.href);
    updateManifestLink(id);
  }

  function mergedConfig(selection) {
    const base = { ...rootConfig };
    delete base.variants;
    const merged = { ...base, ...(selection.value || {}), id: selection.key || base.id };
    const menuCursor = WasmGameFramework.normalizeMenuCursor(merged.menuCursor);
    if (!menuCursor) throw new Error('menuCursor must be native, browser, or none.');
    return Object.freeze({ ...merged, menuCursor });
  }

  function applyConfig() {
    const selection = rootConfig.variants ? selectedVariant() : {
      key: String(rootConfig.id || globalThis.WASM_GAME_VARIANT || 'game').toLowerCase(), locked: true, value: rootConfig
    };
    variant = selection.key;
    config = mergedConfig(selection);
    document.documentElement.dataset.wasmGameVariant = variant;
    document.documentElement.dataset.wasmGameMode = selection.locked ? 'single' : 'suite';
    document.title = config.title || 'WASM Game';
    updateManifestLink(mediaDeployment.value);
    const themeColor = config.pwa?.themeColor || config.theme?.accent || '#111827';
    let themeMeta = document.querySelector('meta[name="theme-color"]');
    if (!themeMeta) {
      themeMeta = document.createElement('meta');
      themeMeta.name = 'theme-color';
      document.head.appendChild(themeMeta);
    }
    themeMeta.content = String(themeColor);
    text(elements.kicker, config.kicker || config.engine);
    text(elements.title, config.title || variant);
    text(elements.description, config.description);
    text(elements.loadingKicker, config.kicker || config.engine);
    elements.loadingTitle.textContent = config.loadingTitle || `Starting ${config.title || variant}…`;
    elements.icon.hidden = !config.icon;
    if (config.icon) {
      const iconUrl = new URL(String(config.icon), location.href).href;
      elements.icon.src = iconUrl;
      elements.icon.alt = config.title || variant;
      elements.icon.setAttribute('data-shell-pixelated', config.iconPixelated ? 'true' : 'false');
      let favicon = document.querySelector('link[rel="icon"]');
      if (!favicon) {
        favicon = document.createElement('link');
        favicon.rel = 'icon';
        document.head.appendChild(favicon);
      }
      favicon.href = iconUrl;
    }
    elements.identityRow.hidden = config.identity === false;
    const controllerMode = WasmGameFramework.normalizeControllerMode(config.controller);
    if (!controllerMode) throw new Error('Controller mode must be disabled, wasdMouse, or custom.');
    elements.controllerRow.hidden = controllerMode === 'disabled';
    if (controllerMode !== 'disabled') {
      options(elements.controllerSelect, [
        { value: 'disabled', label: 'Disabled' },
        { value: 'auto', label: 'Auto-detect' }
      ], config.defaultController || 'auto');
      text(elements.controllerMode, config.controller?.label ||
        (controllerMode === 'wasdMouse' ? 'WASD + mouse mapping' : 'Game-specific mapping'));
      text(elements.controllerStatus, 'Connect a USB or Bluetooth controller, then press any button.');
    }
    elements.advanced.hidden = config.advanced === false || config.graphics === false;
    elements.graphicsRow.hidden = config.graphics === false;
    elements.fpsRow.hidden = config.graphics === false || config.fps === false;
    elements.dynamicRow.hidden = config.graphics === false || config.dynamicQuality === false;
    elements.fullscreenRow.hidden = config.fullscreen === false || !document.documentElement.requestFullscreen;
    options(elements.graphicsProfile, config.profiles || [{ value: 'default', label: 'Default' }], config.defaultProfile || 'default');
    options(elements.fpsTarget, (config.fpsTargets || [60]).map(value => ({ value, label: `${value} FPS` })), config.defaultFps || 60);
    elements.dynamicQuality.checked = config.defaultDynamicQuality !== false;
    elements.canvas.width = Math.max(2, Number(config.canvasWidth) || 640);
    elements.canvas.height = Math.max(2, Number(config.canvasHeight) || 480);
    elements.canvas.setAttribute('data-shell-pixelated', config.pixelated ? 'true' : 'false');
    if (config.theme) for (const [name, value] of Object.entries(config.theme)) {
      document.documentElement.style.setProperty(`--wasm-game-framework-${name}`, String(value));
    }
    if (config.background) {
      const backgroundUrl = new URL(String(config.background), location.href).href;
      document.documentElement.style.setProperty('--wasm-game-framework-background-image', `url(${JSON.stringify(backgroundUrl)})`);
      document.documentElement.style.setProperty('--wasm-game-framework-background-position', String(config.backgroundPosition || 'center'));
      document.documentElement.style.setProperty('--wasm-game-framework-background-size', String(config.backgroundSize || 'cover'));
    } else {
      document.documentElement.style.setProperty('--wasm-game-framework-background-image', 'none');
    }
    dataClient = WasmGameFramework.createContainerDataClient({
      variant: rootConfig.variants ? variant : '',
      media: mediaDeployment.value,
      mediaExplicit: mediaDeployment.explicit,
      mediaLocked: mediaDeployment.locked,
      mediaSource: mediaDeployment.source
    });
    const persistenceConfig = config.persistence === false ? null : (config.persistence || {});
    const persistenceNamespace = persistenceConfig &&
      (persistenceConfig.namespace || `${rootConfig.persistenceNamespace || rootConfig.id || 'wasm-game'}-${variant}`);
    persistence = persistenceConfig && WasmGameFramework.createPersistenceManager({
      namespace: persistenceNamespace,
      root: WasmGameFramework.resolvePersistenceRoot(persistenceConfig.root, {
        namespace: persistenceNamespace,
        variant
      }),
      debounceMs: persistenceConfig.debounceMs,
      intervalMs: persistenceConfig.intervalMs,
      requestDurability: persistenceConfig.requestDurability !== false,
      onStatus: detail => adapter?.persistenceChanged?.(detail, context()),
      onError: error => log(`[wasm-game-framework] save/config persistence failed: ${error?.message || error}`)
    });
  }

  function setStatus(message, error) {
    const value = String(message || '');
    elements.status.textContent = error ? '' : value;
    elements.error.textContent = error ? value : '';
    elements.status.hidden = Boolean(error) || !value;
    elements.error.hidden = !error || !value;
  }

  function setLoading(message, detail, progress) {
    if (message !== undefined) elements.loadingStatus.textContent = String(message || '');
    if (detail !== undefined) elements.loadingDetail.textContent = String(detail || '');
    if (progress !== undefined) elements.loadingProgress.value = Math.max(0, Math.min(100, Number(progress) || 0));
  }

  function log(value) {
    const line = String(value == null ? '' : value).replace(/\x1b\[[0-9;]*m/g, '');
    elements.console.textContent += `${line}\n`;
    if (elements.console.textContent.length > 80000) elements.console.textContent = elements.console.textContent.slice(-60000);
    elements.console.scrollTop = elements.console.scrollHeight;
  }

  function context() {
    return Object.freeze({
      framework: WasmGameFramework, shell, dataClient, persistence, config, rootConfig, variant, elements,
      preferences: shell.preferences, setStatus, setLoading, log,
      setEngineState: (state, options) => shell.setEngineState(state, options),
      showLauncher: () => shell.showLauncher(), showLoading: () => shell.showLoading(),
      showRuntime: state => { shell.showRuntime(); if (state) shell.setEngineState(state); }
    });
  }

  async function loadAdapter() {
    const source = String(config.adapter || '/game-adapter.js');
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = source;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load game adapter ${source}.`));
      document.head.appendChild(script);
    });
    adapter = globalThis.WasmGameAdapter;
    if (!adapter || typeof adapter.start !== 'function') throw new Error(`${source} did not register WasmGameAdapter.start().`);
    WasmGameFramework.validateAdapterContract(config, adapter);
  }

  async function refreshDataGate() {
    const state = await dataClient.applyGate();
    const library = state.mediaLibrary;
    const selection = library?.selection;
    const unavailableSelection = library ? Boolean(selection?.explicit && !selection.available) : mediaDeployment.explicit;
    elements.mediaLibrary.hidden = !library ||
      (!WasmGameFramework.mediaLibraryLauncherVisible(library) && !unavailableSelection);
    elements.mediaEntryRow.hidden = mediaDeployment.locked;
    if (library?.configured) {
      const entries = library.entries.map(entry => ({ value: entry.id, label: entry.label }));
      if (unavailableSelection) entries.unshift({ value: '', label: 'Requested media unavailable' });
      else if (!entries.length) entries.push({ value: '', label: 'No media installed' });
      options(elements.mediaEntry, entries, library.selectedId);
      elements.mediaEntry.disabled = mediaDeployment.locked || !library.entries.length;
      text(elements.mediaStatus, unavailableSelection ?
        (mediaDeployment.locked ? 'The configured media is unavailable.' : 'The requested media is unavailable.') :
        (library.entries.length ?
        `${library.entries.length} media ${library.entries.length === 1 ? 'entry' : 'entries'} available.` :
        (library.minimumEntries > 0 ? 'Add media to continue.' : 'No media installed.')));
    }
    elements.play.disabled = !state.ready || !adapter ||
      unavailableSelection || Boolean(library?.configured && library.minimumEntries > 0 && !library.selectedId);
    if (state.variantRequired) throw new Error('Select a game before provisioning its data.');
    const fixedReady = library ? state.fixedReady : state.ready;
    setStatus(unavailableSelection ?
      (library ? (mediaDeployment.locked ?
        'The configured media is unavailable. Add it to continue.' :
        'The requested media is unavailable. Choose another entry or add it to continue.') :
        'This deployment does not provide a media library for the requested selection.') :
      (state.ready ? '' : (!fixedReady ?
      (config.provisioningText || `Install ${config.title || variant} game data once to continue.`) :
      (config.mediaProvisioningText || 'Add media to continue.'))));
    return state;
  }

  function showPasswordGate(visible) {
    elements.passwordRow.hidden = !visible;
    elements.unlock.hidden = !visible;
    elements.provisioning.hidden = true;
    elements.mediaLibrary.hidden = true;
    elements.play.hidden = true;
    elements.identityRow.hidden = visible || config.identity === false;
    elements.controllerRow.hidden = visible || WasmGameFramework.normalizeControllerMode(config.controller) === 'disabled';
    elements.advanced.hidden = visible || config.advanced === false || config.graphics === false;
    elements.fullscreenRow.hidden = visible || config.fullscreen === false || !document.documentElement.requestFullscreen;
    if (visible) {
      elements.play.disabled = true;
      setStatus('Enter the game password to continue.');
      queueMicrotask(() => elements.password.focus());
    }
  }

  async function initializeRuntime() {
    if (runtimeInitialization) return runtimeInitialization;
    runtimeInitialization = (async () => {
      showPasswordGate(false);
      await loadAdapter();
      await adapter.init?.(context());
      shell.resize();
      initialized = true;
      await refreshDataGate();
    })();
    try { return await runtimeInitialization; } catch (error) {
      runtimeInitialization = null;
      throw error;
    }
  }

  async function provision(files) {
    setStatus('Validating and installing game data…');
    await dataClient.provision(Array.from(files || []), {
      includeOptional: true,
      onProgress: detail => setStatus(`${detail.phase} ${detail.key || 'game data'}…`)
    });
    await refreshDataGate();
  }

  async function provisionMedia(files) {
    setStatus('Validating and installing media…');
    const result = await dataClient.media.upload(Array.from(files || []), {
      onProgress: detail => setStatus(`${detail.phase} ${detail.name || 'media'}…`)
    });
    if (!mediaDeployment.locked) updateMediaUrl(dataClient.media.selected(result.library));
    await refreshDataGate();
  }

  async function initialize() {
    rootConfig = Object.freeze(await fetch('/wasm-game.json', { cache: 'no-store' }).then(response => {
      if (!response.ok) throw new Error(`Game configuration failed with HTTP ${response.status}.`);
      return response.json();
    }));
    mediaDeployment = selectedMediaDeployment();
    if (rootConfig.variants) {
      const keys = Object.keys(rootConfig.variants);
      options(elements.variant, keys.map(key => ({ value: key, label: rootConfig.variants[key].title || key })),
        new URLSearchParams(location.search).get('game') || rootConfig.defaultVariant || keys[0]);
      elements.variantRow.hidden = String(globalThis.WASM_GAME_VARIANT || 'suite') !== 'suite';
    }
    applyConfig();
    passwordClient = WasmGameFramework.createPasswordClient();
    shell = WasmGameFramework.configure({
      launcher: elements.launcher, card: elements.form, loading: elements.loading,
      runtime: elements.runtime, canvas: elements.canvas,
      displayMode: config.displayMode || '4:3', pixelated: Boolean(config.pixelated),
      syncBackbuffer: config.syncBackbuffer === true, nativeManaged: config.nativeManaged === true,
      maxDpr: config.maxDpr || 1, pointerLock: config.pointerLock !== false,
      menuCursor: config.menuCursor,
      pointerWidth: config.pointerWidth, pointerHeight: config.pointerHeight,
      pointerFit: config.pointerFit,
      resizeTransition: config.resizeTransition,
      graphics: config.graphics !== false, identity: config.identity !== false,
      advanced: config.advanced !== false, engineState: 'launcher',
      readEngineState: () => adapter?.readEngineState?.(context()) || shell?.engineState() || 'launcher',
      readCaptureIntent: () => adapter?.readCaptureIntent?.(context()) === true,
      onNativeResizeRequest: detail => adapter?.resize?.(detail, context()),
      onCaptureLost: detail => adapter?.captureLost?.(detail, context()),
      onInputCaptureChange: captured => adapter?.inputCaptureChanged?.(captured, context()),
      onPointerMove: (detail, event) => adapter?.pointerMove?.(detail, event, context()),
      onPointerButton: (detail, event) => adapter?.pointerButton?.(detail, event, context()),
      controller: config.controller || { mode: 'disabled' },
      controllerRow: elements.controllerRow,
      controllerSelect: elements.controllerSelect,
      controllerStatus: elements.controllerStatus,
      onControllerFrame: detail => adapter?.controllerFrame?.(detail, context()),
      onControllerChange: detail => adapter?.controllerChanged?.(detail, context()),
      onContextLost: event => adapter?.contextLost?.(event, context()),
      onContextRestored: event => adapter?.contextRestored?.(event, context()),
      preferences: {
        namespace: rootConfig.preferencesNamespace || rootConfig.id || 'wasm-game',
        playerName: elements.playerName, qualityProfile: elements.graphicsProfile,
        targetFps: elements.fpsTarget, dynamicQuality: elements.dynamicQuality, fullscreen: elements.launchFullscreen,
        controller: elements.controllerSelect,
        defaults: {
          playerName: config.defaultPlayerName || 'Player', qualityProfile: config.defaultProfile || 'default',
          targetFps: config.defaultFps || 60, dynamicQuality: config.defaultDynamicQuality !== false,
          fullscreen: config.defaultFullscreen === true,
          controller: config.defaultController ||
            (WasmGameFramework.normalizeControllerMode(config.controller) === 'disabled' ? 'disabled' : 'auto')
        },
        onChange: values => adapter?.preferencesChanged?.(values, context())
      }
    });
    const auth = await passwordClient.status();
    if (auth.required && !auth.authenticated) showPasswordGate(true);
    else await initializeRuntime();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(error => {
        console.warn('[wasm-game-framework] PWA service worker registration failed:', error);
      });
    }
  }

  elements.chooseDirectory.addEventListener('click', () => elements.directoryInput.click());
  elements.chooseFiles.addEventListener('click', () => elements.fileInput.click());
  elements.directoryInput.addEventListener('change', () => provision(elements.directoryInput.files).catch(error => setStatus(error.message, true)));
  elements.fileInput.addEventListener('change', () => provision(elements.fileInput.files).catch(error => setStatus(error.message, true)));
  elements.addMediaDirectory.addEventListener('click', () => elements.mediaDirectory.click());
  elements.addMediaFiles.addEventListener('click', () => elements.mediaFiles.click());
  elements.mediaDirectory.addEventListener('change', () => provisionMedia(elements.mediaDirectory.files).catch(error => setStatus(error.message, true)));
  elements.mediaFiles.addEventListener('change', () => provisionMedia(elements.mediaFiles.files).catch(error => setStatus(error.message, true)));
  elements.mediaEntry.addEventListener('change', () => {
    dataClient.media.status().then(library => {
      const id = dataClient.media.select(elements.mediaEntry.value, library);
      updateMediaUrl(id);
      return refreshDataGate();
    }).catch(error => setStatus(error.message, true));
  });
  elements.unlock.addEventListener('click', () => {
    elements.unlock.disabled = true;
    setStatus('Checking password…');
    passwordClient.login(elements.password.value).then(() => {
      elements.password.value = '';
      return initializeRuntime();
    }).catch(error => {
      setStatus(error?.message || String(error), true);
      elements.password.select();
    }).finally(() => { elements.unlock.disabled = false; });
  });
  elements.password.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      elements.unlock.click();
    }
  });
  elements.variant.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('game', elements.variant.value);
    location.href = url.href;
  });
  elements.form.addEventListener('submit', event => {
    event.preventDefault();
    if (!initialized || elements.play.disabled) return;
    const preferences = shell.preferences?.save();
    if (preferences?.fullscreen && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(error => {
        console.warn('[wasm-game-framework] Fullscreen request was declined:', error);
      });
    }
    shell.showLoading();
    setLoading(`Starting ${config.title || variant}…`, '', 0);
    Promise.resolve(adapter.start(context())).catch(error => {
      log(error?.stack || error);
      setStatus(error?.message || String(error), true);
      shell.showLauncher();
    });
  });

  initialize().catch(error => setStatus(error?.message || String(error), true));
})();
