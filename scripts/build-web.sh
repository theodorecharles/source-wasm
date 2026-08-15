#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
framework_source_dir="${SOURCE_WASM_FRAMEWORK_DIR:-${repo_root}/../wasm-game-framework}"
web_dir="${SOURCE_WASM_WEB_DIR:-${repo_root}/build/web}"
expected_version="0.9.1"
expected_commit="68bfbd1dbc0104084c7760e486b7437d4c7bb90e"

actual_version="$(git -C "${framework_source_dir}" show "${expected_commit}:package.json" | node -pe 'JSON.parse(fs.readFileSync(0)).version')"
actual_commit="$(git -C "${framework_source_dir}" rev-parse 'v0.9.1^{}')"
[[ "${actual_version}" == "${expected_version}" ]] || { echo "expected framework ${expected_version}, found ${actual_version}" >&2; exit 1; }
[[ "${actual_commit}" == "${expected_commit}" ]] || { echo "framework v0.9.1 resolves to ${actual_commit}, expected ${expected_commit}" >&2; exit 1; }

framework_parent="$(mktemp -d -t source-wasm-framework-checkout.XXXXXX)"
framework_dir="${framework_parent}/framework"
git -C "${framework_source_dir}" worktree add --quiet --detach "${framework_dir}" "${expected_commit}"
cleanup() {
  git -C "${framework_source_dir}" worktree remove --force "${framework_dir}" >/dev/null 2>&1 || true
  rm -rf -- "${framework_parent}" "${metadata_dir:-}"
}
trap cleanup EXIT

if ! command -v emcc >/dev/null 2>&1; then
  emsdk_root="${SOURCE_WASM_EMSDK:-${EMSDK_DIR:-/home/ted/emsdk}}"
  [[ -f "${emsdk_root}/emsdk_env.sh" ]] || { echo "activate Emscripten or set SOURCE_WASM_EMSDK" >&2; exit 1; }
  export EMSDK_QUIET=1
  source "${emsdk_root}/emsdk_env.sh"
fi

rm -rf -- "${web_dir}"
mkdir -p "${web_dir}"

object_file="${web_dir}/source-boundary.o"
wasm_linker="$(cd "$(dirname "$(command -v emcc)")/../bin" && pwd)/wasm-ld"
[[ -x "${wasm_linker}" ]] || { echo "wasm-ld was not found beside the active Emscripten toolchain" >&2; exit 1; }
emcc -c "${repo_root}/src/source_boundary.c" -Oz -nostdlib -o "${object_file}"
"${wasm_linker}" "${object_file}" --no-entry \
  --export=source_wasm_boundary_version \
  --export=source_wasm_has_engine \
  --strip-all \
  -o "${web_dir}/source-boundary.wasm"
rm -f -- "${object_file}"

install -m 0644 \
  "${repo_root}/site/game-adapter.js" \
  "${repo_root}/site/source-family.svg" \
  "${repo_root}/site/wasm-game-data.json" \
  "${repo_root}/site/wasm-game.json" \
  "${repo_root}/site/SOURCE-NOTICES.txt" \
  "${web_dir}/"

metadata_dir="$(mktemp -d -t source-wasm-framework.XXXXXX)"
"${framework_dir}/scripts/install-browser-package.sh" "${metadata_dir}" copy >/dev/null
install -m 0644 "${metadata_dir}/wasm-game-framework.json" "${web_dir}/wasm-game-framework.json"

node "${framework_dir}/scripts/check-game-package.js" "${web_dir}"
"${repo_root}/scripts/test-static.sh" "${web_dir}"
printf 'Built Source WASM development checkpoint at %s\n' "${web_dir}"
