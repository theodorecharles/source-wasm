# Source WASM

Source WASM is a retail-free Source 1 engine-family research repository using
wasm-game-framework 0.7.1 at immutable commit `9359fb1`. Builds create an
isolated framework checkout at that exact release. Current status:
**Still in development**.

The current executable milestone is intentionally narrow and honest: a small
original WebAssembly diagnostic runs after the container validates nine exact
files from a Half-Life 2 Steam installation and the browser restores
or creates its private IndexedDB cache. It does **not** run Half-Life 2.

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
future titles whose engine and game-code sources pass the provenance audit.

## Run

```bash
docker run --rm -p 8088:8088 -v "$PWD/data:/data" local/source-wasm:hl2-dev
```

Open `http://localhost:8088`. On first setup, select the exact audited files
from a current Steam Half-Life 2 installation. The server writes only validated
files beneath `/data`. It never exposes `/data` as a static directory; the
framework makes allowlisted same-origin file endpoints available only after the
whole manifest is ready. Each browser then keeps its own validated, versioned
IndexedDB cache.

This repository authors no `index.html`, CSS, service worker, or web manifest.
Those are supplied by wasm-game-framework. Its only public icon is original
project artwork, not Valve branding.

No changes are submitted upstream.
