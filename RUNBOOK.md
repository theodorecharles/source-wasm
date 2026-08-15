# Source-family continuation runbook

Status: **Still in development**

## What exists

- A canonical wasm-game-framework 0.7.5 suite/locked deployment contract.
- Exact required-file validation into `/data` and browser IndexedDB caching.
- A visible original diagnostic WASM module proving the toolchain and boundary.
- Static, Docker, HTTP range, PWA, security-header, and inaccessible-`/data`
  tests.
- No downstream HTML, CSS, service worker, or web manifest.

## Exact blocker

Valve's official Source SDK 2013 contains game/mod code and expects a separately
installed Source SDK Base 2013 runtime. It is not the full Source engine. The
audited hl2-webxr reference is leak-derived and cannot be reused. Accordingly,
the audited sources do not provide a complete engine to compile into an HL2
browser client. Counter-Strike: Source also lacks published game code in Source
SDK 2013.

## Safe continuation

1. Keep `source-lock.json` immutable unless a source update is independently
   audited and pinned.
2. Accept a full engine only with documented redistribution permission and
   provenance that does not descend from leaked Source code.
3. Add the engine as a native-source Emscripten build; do not import another
   project's web shell or compiled binary.
4. Expand the exact game-data manifest to the complete runtime set only after
   the engine proves what it reads.
5. Preserve the framework data client and mount downloaded cached entries into
   Emscripten FS; never place retail files in public build output.
6. Add real HL2 SP/MP variants only when each launches. Add CS:S only when the
   engine and CS:S game-code provenance are documented.
7. Keep product status at **Still in development** until a repeatable browser
   runtime test justifies **Live**.

Do not submit any changes upstream.
