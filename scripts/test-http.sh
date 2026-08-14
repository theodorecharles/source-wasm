#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repository="${SOURCE_WASM_IMAGE_REPO:-local/source-wasm}"
tag="${SOURCE_WASM_IMAGE_TAG:-dev}"

test_image() {
  local image="$1" expected_variant="$2" port cid body headers
  port="$(node -e "const n=require('node:net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
  cid="$(docker run -d --rm -p "127.0.0.1:${port}:8088" "${image}")"
  trap 'docker rm -f "${cid}" >/dev/null 2>&1 || true' RETURN
  for _ in $(seq 1 80); do curl -fsS "http://127.0.0.1:${port}/" >/dev/null 2>&1 && break; sleep 0.1; done
  body="$(curl -fsS "http://127.0.0.1:${port}/")"
  grep -q '/shared-shell/wasm-game-framework.css' <<<"${body}"
  grep -q '/shared-shell/wasm-game-bootstrap.js' <<<"${body}"
  ! grep -qi 'wolfwasm' <<<"${body}"
  [[ "$(curl -fsS "http://127.0.0.1:${port}/wasm-game-framework.json" | node -pe 'JSON.parse(fs.readFileSync(0)).version')" == "0.7.1" ]]
  [[ "$(curl -fsS "http://127.0.0.1:${port}/wasm-game-config.js" | sed -n 's/.*= "\([^"]*\)";.*/\1/p')" == "${expected_variant}" ]]
  [[ "$(curl -fsS "http://127.0.0.1:${port}/app.webmanifest?variant=hl2" | node -pe 'JSON.parse(fs.readFileSync(0)).short_name')" == "HL2 WASM" ]]
  headers="$(curl -fsSI "http://127.0.0.1:${port}/source-boundary.wasm")"
  grep -qi '^Cross-Origin-Opener-Policy: same-origin' <<<"${headers}"
  grep -qi '^Cross-Origin-Embedder-Policy: require-corp' <<<"${headers}"
  grep -qi '^X-Content-Type-Options: nosniff' <<<"${headers}"
  [[ "$(curl -fsS -H 'Range: bytes=0-3' "http://127.0.0.1:${port}/source-boundary.wasm" | od -An -tx1 | tr -d ' \n')" == "0061736d" ]]
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/data")" == "404" ]]
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/data/hl2/gameinfo.txt")" == "404" ]]
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/local-data/hl2")" == "404" ]]
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${port}/wasm-game.json")" == "405" ]]
  if [[ "${expected_variant}" == suite ]]; then
    [[ "$(curl -fsS "http://127.0.0.1:${port}/game-data/status" | node -pe 'JSON.parse(fs.readFileSync(0)).variantRequired')" == "true" ]]
  else
    [[ "$(curl -fsS "http://127.0.0.1:${port}/game-data/status" | node -pe 'const x=JSON.parse(fs.readFileSync(0)); `${x.variant}:${x.ready}`')" == "hl2:false" ]]
  fi
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/game-data/files/gameinfo?variant=hl2")" == "409" ]]
  docker rm -f "${cid}" >/dev/null
  trap - RETURN
}

test_image "${repository}:${tag}" suite
test_image "${repository}:hl2-${tag}" hl2
echo "HTTP, suite/locked, PWA, range, and /data security contracts passed"

