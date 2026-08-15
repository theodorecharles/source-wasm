#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
web_dir="${1:-${repo_root}/build/web}"

node --check "${web_dir}/game-adapter.js"
node "${repo_root}/scripts/test-adapter.js" "${web_dir}"
node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1]))" "${web_dir}/wasm-game.json"
node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1]))" "${web_dir}/wasm-game-data.json"
[[ "$(od -An -tx1 -N4 "${web_dir}/source-boundary.wasm" | tr -d ' \n')" == "0061736d" ]]

node - "${web_dir}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const expected = [
  'SOURCE-NOTICES.txt', 'game-adapter.js', 'source-boundary.wasm', 'source-family.svg',
  'wasm-game-data.json', 'wasm-game-framework.json', 'wasm-game.json'
];
const actual = fs.readdirSync(root).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`unexpected public files: ${actual.join(', ')}`);
const config = JSON.parse(fs.readFileSync(path.join(root, 'wasm-game.json')));
if (Object.keys(config.variants).join(',') !== 'hl2') throw new Error('only the honest HL2 boundary variant may be published');
if (config.identity !== false || config.graphics !== false || config.pointerLock !== false) throw new Error('diagnostic must not expose gameplay controls');
const framework = JSON.parse(fs.readFileSync(path.join(root, 'wasm-game-framework.json')));
if (framework.version !== '0.7.6') throw new Error(`framework ${framework.version}`);
const data = JSON.parse(fs.readFileSync(path.join(root, 'wasm-game-data.json')));
const hl2 = data.variants.hl2;
if (!hl2 || hl2.files.length !== 9) throw new Error('expected nine exact game-data audit files');
for (const file of hl2.files) {
  if (!file.sha256 || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size)) throw new Error(`weak policy ${file.key}`);
}
const bytes = fs.readFileSync(path.join(root, 'source-boundary.wasm'));
const adapter = fs.readFileSync(path.join(root, 'game-adapter.js'), 'utf8');
if (!adapter.includes('context.dataClient.load(ownerData')) throw new Error('adapter bypasses canonical container-to-IndexedDB loader');
if (adapter.includes('validateCached: false')) throw new Error('cached game data must retain browser-side validation');
WebAssembly.instantiate(bytes, {}).then(({ instance }) => {
  if (instance.exports.source_wasm_boundary_version() !== 0x000701) throw new Error('wrong boundary ABI');
  if (instance.exports.source_wasm_has_engine() !== 0) throw new Error('diagnostic falsely claims an engine');
}).catch(error => { console.error(error); process.exitCode = 1; });
NODE

if find "${web_dir}" -type f \( -iname '*.vpk' -o -iname '*.pak' -o -iname '*.dll' -o -iname '*.so' -o -iname '*.exe' -o -iname '*.bin' \) -print -quit | grep -q .; then
  echo "retail or native binary leaked into public output" >&2
  exit 1
fi
for forbidden in index.html '*.css' service-worker.js app.webmanifest; do
  if find "${web_dir}" -maxdepth 1 -name "${forbidden}" -print -quit | grep -q .; then
    echo "downstream may not author ${forbidden}" >&2
    exit 1
  fi
done
! rg -n -i 'nillerusr|weliveinhell|tf2 leak|source-engine-2007' "${web_dir}"
echo "static contract passed"
