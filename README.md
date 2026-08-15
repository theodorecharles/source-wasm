# Source WASM

Source WASM is a Source 1 engine-family browser project using
wasm-game-framework 0.9.1 at immutable commit `68bfbd1`. Builds create an
isolated framework checkout at that exact release. Current status:
**Still in development**.

The current checkpoint runs a small diagnostic WebAssembly module and verifies
the shared container-to-browser data path. It does **not** run Half-Life 2.
Because no game engine starts, controller input and save/config persistence are
explicitly disabled for this diagnostic variant.

The official Valve Source SDK 2013 publishes game/mod code but depends on the
installed Source SDK Base 2013 runtime. It does not publish a complete Source
engine. Counter-Strike: Source is therefore not included. See
[PROVENANCE.md](PROVENANCE.md).

## Build

Requirements are Docker, Node.js, and Emscripten. The local default Emscripten
checkout is `/home/ted/emsdk`; override it with `SOURCE_WASM_EMSDK`.

```bash
./scripts/build-web.sh
./scripts/audit-game-data.sh
./scripts/build-docker.sh
./scripts/test-http.sh
```

The Docker build emits a suite image and an HL2-locked image:

```text
local/source-wasm:dev
local/source-wasm:hl2-dev
```

The suite currently has one variant. It preserves the deployment contract for
future Source-family titles.

## Run

```bash
docker run --rm -p 8088:8088 -v "$PWD/data:/data" local/source-wasm:hl2-dev
```

Open `http://localhost:8088`. On first setup, select the required files from a
current Steam Half-Life 2 installation. The container stores validated files
beneath `/data`, and each browser keeps a versioned IndexedDB cache for faster
subsequent loads. Cached entries are rechecked for size and file signature
before use.

This repository authors no `index.html`, CSS, service worker, or web manifest.
Those are supplied by wasm-game-framework.

No changes are submitted upstream.
