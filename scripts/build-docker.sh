#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
framework_source_dir="${SOURCE_WASM_FRAMEWORK_DIR:-${repo_root}/../wasm-game-framework}"
repository="${SOURCE_WASM_IMAGE_REPO:-local/source-wasm}"
tag="${SOURCE_WASM_IMAGE_TAG:-dev}"
framework_image="${SOURCE_WASM_FRAMEWORK_IMAGE:-wasm-game-framework:0.7.5}"
revision="$(git -C "${repo_root}" rev-parse --verify HEAD 2>/dev/null || printf local)"

"${repo_root}/scripts/build-web.sh"
framework_parent="$(mktemp -d -t source-wasm-framework-image.XXXXXX)"
framework_dir="${framework_parent}/framework"
git -C "${framework_source_dir}" worktree add --quiet --detach "${framework_dir}" 11b9af479e40927336d18f5ddfc41d9cc2b224c7
cleanup() {
  git -C "${framework_source_dir}" worktree remove --force "${framework_dir}" >/dev/null 2>&1 || true
  rm -rf -- "${framework_parent}"
}
trap cleanup EXIT
"${framework_dir}/scripts/build-base-image.sh" "${framework_image}"
docker build --build-arg "FRAMEWORK_IMAGE=${framework_image}" --build-arg GAME_VARIANT=suite --build-arg "VCS_REF=${revision}" -t "${repository}:${tag}" "${repo_root}"
docker build --build-arg "FRAMEWORK_IMAGE=${framework_image}" --build-arg GAME_VARIANT=hl2 --build-arg "VCS_REF=${revision}" -t "${repository}:hl2-${tag}" "${repo_root}"

for image in "${repository}:${tag}" "${repository}:hl2-${tag}"; do
  [[ "$(docker run --rm --entrypoint node "${image}" -p "require('/opt/wasm-game-framework/package.json').version")" == "0.7.5" ]]
  [[ "$(docker run --rm --entrypoint sh "${image}" -c 'find /opt/game-site -type f | sort | sha256sum' | wc -l)" -eq 1 ]]
done

echo "built ${repository}:${tag} and ${repository}:hl2-${tag}"
