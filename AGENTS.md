# Source-family repository rules

- Never import leaked, reverse-engineered from leaked code, or proprietary Source engine code.
- Never commit or image retail Valve data. Owner files are accepted only into `/data` and cached privately by the framework in the browser.
- Do not contact or submit changes upstream.
- Pin the browser contract to wasm-game-framework 0.9.1 and its `v0.9.1` commit.
- Downstream public files are declarative manifests, an adapter, source-derived artifacts, and redistributable title assets. Do not author downstream HTML, CSS, service workers, or web manifests.
- Product status labels are exactly `Live` or `Still in development`.
- Do not describe the diagnostic boundary module as the Source engine or as a playable game.
