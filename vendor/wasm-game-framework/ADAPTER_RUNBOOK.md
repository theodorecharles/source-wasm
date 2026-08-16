# Game adapter runbook

This is the implementation and acceptance contract for connecting a native
game runtime to WASM Game Framework. Follow it for every title and profile.
Compiling, linking, serving a canvas, or reaching a menu does not by itself
prove that an adapter is complete.

## 1. Keep the boundary clean

The framework owns the document, launcher, loading surface, setup gate,
responsive canvas CSS, preferences, fullscreen request, PWA metadata,
pointer-lock lifecycle, and browser cache. A downstream game publishes:

```text
wasm-game.json
wasm-game-data.json
game-adapter.js
engine JavaScript/WebAssembly
game-specific public icons and backgrounds
```

Do not add downstream `index.html`, CSS, service workers, web manifests,
launcher markup, pointer-lock managers, or viewport styling. If several games
share an engine, put native and JavaScript seams in the engine-family adapter
and keep title adapters declarative.

Run the static package gate against the staged public directory:

```bash
node /path/to/wasm-game-framework/scripts/check-game-package.js build/site
```

The browser checks later in this runbook are still required.

## 2. Declare the browser contract

Every merged suite variant must resolve to an explicit browser policy. This is
a representative dynamic renderer:

```json
{
  "id": "example",
  "title": "Example Game",
  "icon": "/example.ico",
  "background": "/example-background.jpg",
  "pwa": {
    "shortName": "Example",
    "themeColor": "#402010",
    "backgroundColor": "#000000",
    "icons": [
      { "src": "/example-192.png", "sizes": "192x192", "type": "image/png" },
      { "src": "/example-512.png", "sizes": "512x512", "type": "image/png" }
    ]
  },
  "displayMode": "dynamic",
  "nativeManaged": true,
  "syncBackbuffer": false,
  "resizeTransition": "immediate",
  "pointerWidth": 640,
  "pointerHeight": 480,
  "pointerFit": "contain",
  "menuCursor": "native",
  "pointerLock": true,
  "fullscreen": true,
  "controller": {
    "mode": "wasdMouse",
    "moveDeadzone": 0.18,
    "lookDeadzone": 0.14
  },
  "persistence": {
    "root": "/save/{variant}",
    "debounceMs": 750,
    "intervalMs": 5000,
    "requestDurability": true
  },
  "identity": true,
  "graphics": true,
  "adapter": "/game-adapter.js"
}
```

Use `4:3` or `16:9` when the renderer must retain that aspect. Use `dynamic`
only when the native renderer can change its actual backbuffer and projection.
`pointerWidth` and `pointerHeight` describe the native menu coordinate system,
not the render target. A 640×480 menu can live over a 1720×900 backbuffer.
Declare `menuCursor: "native"` when the runtime visibly renders its own
pointer in loading/menu/pause/debrief UI. Use `"browser"` when those screens
need mapped pointer callbacks but depend on the host pointer. Use `"none"` for
pointer-free menus; the framework hides the host pointer and suppresses their
released pointer move/button callbacks. The property defaults to `"native"`
only so older manifests keep their existing behavior. New and audited
manifests should always declare it.

Launcher `description` is optional. Normal launcher and PWA copy describes the
game, not setup, file placement, storage, or caching. Put file instructions in
`provisioningText`; the framework shows them only while required data is
missing.

## 3. Implement the adapter seam

Register one object:

```js
globalThis.WasmGameAdapter = Object.freeze({
  async init(context) {},
  async start(context) {},
  readEngineState(context) { return 'menu'; },
  readCaptureIntent(context) { return false; },
  resize(detail, context) {},
  pointerMove(detail, event, context) {},
  pointerButton(detail, event, context) {},
  controllerFrame(detail, context) {},
  controllerChanged(detail, context) {},
  preferencesChanged(values, context) {},
  inputCaptureChanged(captured, context) {},
  captureLost(detail, context) {},
  contextLost(event, context) {},
  contextRestored(event, context) {}
});
```

Only `start()` is unconditional. The framework contract validator also
requires:

- `resize()` when `nativeManaged` is true;
- `pointerMove()` and `pointerButton()` when a native pointer space is declared;
- `readEngineState()` and `captureLost()` when pointer lock is enabled.
- `controllerFrame()` and `controllerChanged()` when controller mode is
  `wasdMouse` or `custom`.

`init()` loads policy and installs native callbacks without starting the game.
`start()` consumes the already-saved preferences, restores validated data,
starts the engine once, and reports loading progress. Starting a second time
must either resume the existing runtime safely or perform a deliberate clean
restart; it must never create a second main loop.

## 4. Report authoritative runtime state

Use native cvars, exported functions, QVM/module callbacks, snapshots, or
equivalent engine truth. Do not infer state from a timeout, canvas visibility,
pointer lock, or the last button the browser clicked.

| State | Meaning | Pointer capture |
|---|---|---|
| `launcher` | Framework options are visible | Released |
| `loading` | Engine, map, or connection is not player-controllable | Released unless launch capture intent is active |
| `menu` | Native main/menu UI owns absolute pointer input | Released |
| `gameplay` | A valid player snapshot/world is controllable | Captured |
| `paused` | In-game menu or pause UI is active | Released |
| `debrief` | Score/intermission UI is active | Released |
| `crashed` | Native runtime cannot continue | Released |

Do not mark gameplay at engine initialization. For network games, wait for the
first valid active snapshot. For single-player games, wait until the world and
player controller are active. Emit menu/paused/debrief immediately when native
UI opens so pointer lock is released on that same frame.

## 5. Capture and release input correctly

The framework is the only code that calls `requestPointerLock()` or
`exitPointerLock()`. Adapters report state and translate native events; they do
not compete with the framework for browser capture.

Browsers require a trusted click for the first pointer-lock request. Async
JOIN, New Game, and Resume actions therefore need a native capture-intent bit:

1. `pointerButton(detail, event)` delivers the native menu action while the
   browser's trusted pointer event is still active.
2. At pointerdown, the framework snapshots `readCaptureIntent()` and tracks the
   pointer ID and button. Intent already true at this point is stale and cannot
   authorize this gesture.
3. Native dispatch may raise intent while handling pointerdown, between events
   on a native frame, or while handling the matching pointerup. Alternatively,
   the adapter exposes a predeclared capture target for that exact JOIN/New
   Game/Resume control. Do not infer intent from an arbitrary click.
4. At matching pointerup, a false-to-true intent edge lets the framework call
   `requestPointerLock()` on the same trusted event stack. Queued SDL work may
   honestly leave `readEngineState()` at `menu` or `paused` for this callback.
5. On the following native tick, state reports `loading` and then `gameplay`,
   allowing the ordinary persistent capture rules to retain lock. The bit
   clears on success, failure, disconnect, cancellation, or Escape. A failed
   transition reports `menu`/`paused` again so capture is released.

Pointer ID/button mismatch, `pointercancel`, and `lostpointercapture` clear the
gesture without authorization. The event-scoped exception never changes
`captureDesired()`: outside the matching trusted pointerup, only `loading` with
current intent or authoritative `gameplay` may capture or retain lock.

The framework also checks again on the next animation frame for engines whose
native transition becomes visible late. That is a compatibility fallback, not
the primary request: Chrome may reject it because transient activation has
already ended. Acceptance must prove the synchronous path. A delayed-only
intent is not considered a working JOIN or Resume capture implementation.

Never fake `gameplay` merely to obtain capture. Apart from the exact rising
JOIN/New Game/Resume gesture above, never capture while a main, pause, limbo,
chat, console, scoreboard, or debrief cursor is active.

When capture is lost during gameplay, `captureLost()` must invoke exactly one
native pause/menu action. Avoid a second legacy `pointerlockchange` listener
that injects another Escape. `inputCaptureChanged()` updates native relative
mouse mode when the engine needs an explicit signal. Browser shortcuts remain
available whenever capture is released.

Acceptance sequence:

```text
launcher: released
native-cursor menu: released, host cursor hidden over canvas
browser-cursor menu: released, browser cursor visible
pointer-free menu: released, host cursor hidden and pointer callbacks suppressed
JOIN/New Game click: trusted capture intent
loading: honest loading state, intent retained; cursor follows menuCursor policy when released
first controllable frame: gameplay + captured
Escape: paused/menu + released
Resume click: captured again
disconnect/debrief/crash: released
```

## 6. Map menu pointer coordinates

The framework maps browser client coordinates through the live CSS canvas
rectangle into the declared virtual menu size. The adapter forwards the
resulting absolute `detail.x`/`detail.y` and button state to the native input
queue.

- For `menuCursor: "native"`, initialize each native main-menu cursor to a known
  virtual point, normally the center.
- Reset the adapter's previous absolute point only on an actual transition into
  that menu.
- Preserve independent in-game menu initialization when the engine has one.
- Use `pointerFit: "contain"` when a fixed-aspect UI is centered inside a
  dynamic render target.
- Do not add browser offsets, widescreen bias, DPR, or CSS compensation in the
  adapter; the framework already removed those.
- Relative gameplay mouse movement uses `movementX`/`movementY` only while
  captured. The frozen detail is `{ movementX, movementY, state, canvas,
  captured: true }`; it deliberately contains no `x`/`y` fields. Released
  details retain the absolute mapping fields and add `captured: false`.
  Adapters branch on `detail.captured` and must not reuse absolute menu
  coordinates for gameplay look.

For `menuCursor: "native"`, verify the native and hidden host cursor at the
center and four near-corner points, before and after both a narrow and wide
resize. For `menuCursor: "browser"`, verify the browser cursor remains visible
and pointer callbacks still reach the menu. For `menuCursor: "none"`, verify
both that the host cursor is hidden and that pointer callbacks are suppressed.
Verify the main menu and in-game menu separately. Under every policy, captured
gameplay must hide the browser cursor, deliver relative pointer deltas, and
restore the declared released-state policy immediately after capture loss.

## 7. Resize the real backbuffer

There are three different sizes:

1. CSS viewport size, owned by the framework;
2. physical canvas/backbuffer size, owned according to the manifest policy;
3. virtual menu coordinates, fixed by the native UI and unrelated to 1 or 2.

For a fixed software renderer, declare `4:3` (or `16:9`) and usually
`syncBackbuffer: true`. For a dynamic native renderer, declare
`nativeManaged: true`, `syncBackbuffer: false`, and implement `resize(detail)`:

```js
resize(detail) {
  const width = Math.max(2, detail.requestedWidth);
  const height = Math.max(2, detail.requestedHeight);
  nativeSetResolution(width, height);
  module.setCanvasSize(width, height);
}
```

The adapter must update the drawing buffer, native viewport, projection, and
resolution cvars in the same animation frame when the engine permits it. Do not
leave a one-second desktop debounce in the browser build. Do not clamp the
physical render target to the virtual 640×480 menu size. If the engine has a
real lower limit, document and test the smallest accepted native resolution
while allowing CSS containment below it without distortion.

Publish forced/native resolution state before changing a canvas whose resize
listeners can feed its dimensions back into the engine. Do not pass a runtime's
`noUpdates`/`suppressResize` flag unless the adapter has a separately tested
native callback that updates the viewport and projection; suppressing the SDL
resize event while changing only the browser canvas produces a stretched or
stale renderer.

Use `resizeTransition: "immediate"` only when the adapter follows that rule.
The framework resamples viewport geometry across multiple frames after Chrome
enters or exits fullscreen, then sends the settled dimensions. The adapter must
accept every callback, including fullscreen exit, browser chrome changes, and
portrait/narrow windows.

At each test size prove:

- CSS canvas equals the intended contained/filled rectangle;
- canvas width/height and native resolution cvars agree;
- WebGL viewport matches the drawing buffer;
- circles, faces, HUD elements, and menu pointers are not stretched;
- no stale black strip remains after two animation frames for an immediate
  renderer.

## 8. Apply identity and quality at the correct time

Sanitize the framework player name for the engine's command/cvar syntax. Apply
it in initial arguments and again after native configuration files load but
before the first connection. Configuration execution commonly overwrites the
startup value with `Player`; a launcher-only assertion will miss that bug.
Verify the actual server/scoreboard name.

Read initial profile, FPS, and dynamic-quality preferences in `start()`. Apply
later changes through `preferencesChanged()`. Profiles must change the native
renderer settings they claim to change. FPS targets must be measured, not only
written to a cvar. A profile that changes aspect policy calls
`context.shell.setDisplay()` or `setDisplayMode()` and immediately resizes the
native backbuffer.

WASD and mouse defaults must be installed after any native config that can
overwrite them. Do not make vertical mouse look available in games whose
original gameplay has no vertical aiming unless that profile explicitly adds
it.

## 9. Map controllers through the native input seam

The manifest explicitly declares `controller.mode` as `disabled`, `wasdMouse`,
or `custom`. Omitted controller policy is a package error. Disabled games hide
the launch-card field and do not poll. The other modes let the user select
Disabled, Auto-detect, or a connected USB/Bluetooth controller on the launch
card. The framework remembers a stable device identity; never persist a raw
Gamepad index because indices change after reconnect and reload.

`controllerFrame(detail, context)` receives one immutable frame per animation
frame while a selected device is active. `detail.gamepad` contains normalized
raw axes and button values; `detail.timestamp` and bounded `detail.deltaMs`
allow frame-rate-independent analog look. In `wasdMouse` mode `detail.actions` additionally
contains movement, look, attack, alt-attack, jump, crouch, reload, weapon,
shoulder, scoreboard, menu, sprint, and melee values. In `custom` mode actions
are null and the adapter maps raw controls itself.

The mapping belongs in the engine/game adapter. Write controller values into
the same native input queue used by real keyboard/mouse or emulator pad state.
Do not dispatch synthetic DOM keyboard/mouse events; they are untrusted, lose
held-state semantics, and frequently bypass Emscripten/SDL listeners. For a
Quake-style adapter, translate left-stick actions into its WASD key state and
right-stick values into native relative mouse deltas. A console adapter maps
the same raw frame into its virtual d-pad, face buttons, shoulders, triggers,
and sticks.

Apply deadzones and look sensitivity once. The framework supplies declared
common deadzones for `wasdMouse`; do not apply a second radial/axial deadzone in
the adapter. Custom adapters own their complete transform. Release all native
held actions when the controller is disabled or disconnected. Use
`controllerChanged()` for that edge, and call
`context.shell.controller.rumble()` only when the native game requests an
effect.

Acceptance must cover USB or Bluetooth connection on the launch card,
hot-unplug with no stuck actions, remembered Auto/device selection, analog
movement and look, every declared button, pause/menu navigation, returning to
gameplay, and disabled mode. Controller input does not alter the framework's
authoritative menu/gameplay capture rules.

## 10. Data, persistence, audio, and recovery

Use `context.dataClient.load()` with a versioned
`createOwnerDataSet()`/game-data set and mount only validated entries. The
container remains the source; IndexedDB is the browser fast path. Once required
data is ready, the normal launcher contains no setup or storage commentary.

Put format and title recognition in a downstream `.mjs` validator referenced by
`wasm-game-data.json`, never in the framework. The same pure module must run in
Node and the browser. It receives `{ name, size, policy, read, digest }` and
returns `{ accepted: true, identity?, version?, fingerprint?, metadata? }` or
`{ accepted: false, error }`. Declare a finite `sizes` list or `maxSize`, an
explicit validator `version`, and bounded read budgets. Root/variant validator
defaults may be overridden per file; set `validator: false` for files that use
only filename/size/magic/hash checks. Bump the validator version whenever its
semantics change.

For a variable media collection, declare `mediaLibrary` instead of encoding
titles as fixed files. The same downstream module exports a bundle validator
receiving `{ files, totalSize, policy, file(name) }`. Each file exposes only
`{ name, size, read, digest }`. Return the normal validation fields plus an
optional display `label` and relative `primary` filename. Validate every
descriptor/reference against the complete set so descriptor-plus-track and
other multi-file inputs are accepted or rejected atomically. The framework is
format-neutral and must not parse extensions, disc descriptors, cartridges, or
archives.

Before native startup, load only the selected entry:

```js
const selected = await context.dataClient.media.load(undefined, {
  onProgress: updateLoadingProgress
});
for (const item of selected.entries) {
  mountReadOnly(item.file, item.mountName);
}
startNativeMain(selected.primary);
```

Media restoration uses 12 concurrent cache/network operations by default so a
directory-style installation does not incur one serialized HTTP and IndexedDB
round trip per file. Pass `concurrency: 1..32` only when a measured device or
entry layout needs a different bounded value. Returned entries always retain
manifest order, progress indices remain completion-monotonic, and any worker
failure is drained before the selected-entry cache is cleared.

Treat `MEDIA_SELECTION_REQUIRED` as a launcher state. Treat
`MEDIA_RANDOM_ACCESS_REQUIRED` as a fail-closed adapter milestone: implement a
reviewed range-backed native filesystem before enabling media above the browser
cache envelope. Do not pretend that a runtime capable only of whole-file MEMFS
loading supports multi-gigabyte media.

Every manifest explicitly declares `persistence: false` or a persistence
object with an absolute traversal-free `root`. Omitted persistence policy is a
package error. `false` is reserved for a runtime that genuinely has no writable
state; it is not a shortcut for an unfinished adapter.

Use `{variant}` or `{namespace}` in suite roots. The canonical bootstrap
resolves the template and exposes the final path as `context.persistence.root`.
Because Emscripten IDBFS keys storage by mount point, the package checker rejects
two suite variants that resolve to the same root.

Create the native Module with `noInitialRun`, then restore persistence before
`callMain()` or any native config/save lookup:

```js
const module = await createModule({ noInitialRun: true });
const persistent = await context.persistence.attach(module.FS, {
  root: context.persistence.root
});
module.callMain(nativeArgumentsUsing(persistent.root));
```

If the native filesystem and main function live in an Emscripten worker, the
main thread must pass only the resolved `namespace`, `root`, and the exact
framework script URL. The worker imports that script, creates its own
`createPersistenceManager({ namespace, root })`, awaits
`manager.attach(Module.FS)`/the initial `syncfs(true)`, and only then enters
native main. All dirty notifications and flushes use that same worker-local
manager. A main-thread manager cannot attach to a worker-only `FS`, and copying
the persistence implementation into an adapter breaks the versioned contract.

For an engine whose Emscripten FS exists in a dedicated worker, post the
resolved `context.persistence.namespace` and `.root` to that worker. Import
the identical released framework there, construct a worker-local persistence
manager, attach the worker Module FS, await restore, and then call native main.
Do not attempt to structured-clone an FS object or claim main-thread
persistence for a worker-only filesystem.

Point the engine's home/config/save directory at that exact mount. Save files,
configuration, keybindings, screenshots, demos, save RAM, and memory cards are
writable state. Game archives remain on their separate read-only mount. Call
`context.persistence.markDirty()` after native save/config events and
`await context.persistence.save()` after high-value operations. The framework
also performs serialized periodic, visibility-hidden, pagehide, and unload
flushes, but periodic fallback does not excuse a missing native save hook.

Hard-refresh acceptance must prove the engine restores an actual changed
keybinding/config value and a real save or memory-card state before its native
main reads them. Verify variant namespaces do not collide and that clearing
the game-data cache does not erase saves (or vice versa).

Resume audio from framework user-gesture events. Verify music, positional
effects, weapons, enemies, UI sounds, focus loss, and resume independently;
hearing one category does not prove the backend is correct.

On WebGL context loss report `paused`, stop native rendering safely, and show a
recoverable diagnostic. `contextRestored()` must rebuild renderer resources or
perform a native renderer restart. A fatal native error reports `crashed` and
must not leave capture active.

## 11. Required acceptance pass

Run static tests, a production Docker image, and a real Chromium-family browser.
Firefox is a useful second implementation check but does not replace Chromium.
Test one game at a time.

For every runnable variant record evidence for:

1. missing-data setup and ready-state launcher;
2. second load from browser cache without setup UI;
3. player name/profile/FPS handoff;
4. declared native/browser main-menu pointer policy, including center and corners;
5. narrow, wide, fullscreen-enter, and fullscreen-exit native resolution;
6. New Game/JOIN loading state and first controllable frame;
7. automatic capture, WASD, relative mouse, Escape release, and Resume capture;
8. console/chat/debrief input where the game provides it;
9. representative level rendering and audio categories;
10. controller connect/select, movement/look/buttons, disconnect release, and
    disabled mode when controller support is declared;
11. a real save plus changed config/keybinding surviving hard refresh;
12. PWA manifest, icons, service worker, and install metadata;
13. `/data` and `/local-data` inaccessible while allowlisted game-data routes
    work;
14. no downstream-authored document, CSS, service worker, or web manifest;
15. no game archives or generated WASM/data artifacts tracked in Git.

For an engine that cannot yet reach gameplay, execute every item reachable at
its honest milestone and document the exact native blocker. Do not mark an
unreached behavior as passed because its adapter contains a plausible hook.

## 12. Common failure signatures

- **Name becomes Player:** native config loaded after startup arguments; reapply
  identity immediately before connection.
- **Main cursor offset but pause cursor works:** main-menu native cursor was not
  initialized or its virtual origin differs; do not change framework mapping.
- **No cursor in a released menu:** the game has no rendered menu pointer but
  still declares (or defaults to) `menuCursor: "native"`; use `"browser"` if
  the menu accepts pointer input, or `"none"` if it does not.
- **Two cursors in a released menu:** the runtime renders a pointer but declares
  `menuCursor: "browser"`; set it to `"native"`.
- **One-second black area during resize:** desktop video-restart debounce remains
  in the browser path.
- **Canvas stretches:** CSS resized but native backbuffer/projection did not, or
  fixed and dynamic aspect policies were mixed.
- **No automatic capture after JOIN:** loading was confused with gameplay, or
  capture intent was not emitted during the trusted click.
- **Escape injects twice:** framework `captureLost()` and a legacy
  `pointerlockchange` handler both opened the menu.
- **Some sounds work:** the music and effects paths use different mixers or
  asset lookups; test categories independently.
- **Second launch freezes:** a second main loop was created or native shutdown
  did not complete.
