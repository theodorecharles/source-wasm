#!/bin/sh
set -eu

echo "Source Wasm: Still in development. This image ships patches and the browser shell only."

missing=""
if [ ! -f "${SOURCE_ENGINE_ROOT:-/inputs/source}/wscript" ]; then
  missing="${missing} leaked-source"
fi
if [ ! -d "${HL2_STEAM_ROOT:-/inputs/steam}/hl2" ]; then
  missing="${missing} steam_legacy"
fi
goty_ok=0
if [ -f "${HL2_GOTY_ROOT:-/data-goty}/hl2/gameinfo.txt" ]; then goty_ok=1; fi
if [ -n "${HL2_GOTY_ISO:-}" ] && [ -f "${HL2_GOTY_ISO}" ]; then goty_ok=1; fi
if find /inputs/iso -name '*.iso' 2>/dev/null | grep -q .; then goty_ok=1; fi
if [ "${goty_ok}" -eq 0 ]; then
  missing="${missing} goty-2014-iso"
fi

if [ -n "${missing}" ]; then
  echo "Waiting for owner inputs:${missing}" >&2
  echo "Mount:" >&2
  echo "  -v /path/to/leaked-source:/inputs/source:ro" >&2
  echo "  -v \"\$HOME/.steam/.../Half-Life 2\":/inputs/steam:ro" >&2
  echo "  -v /path/to/hl2-goty-2014.iso:/inputs/iso/hl2.iso:ro" >&2
  echo "The image will not compile or claim a playable game until those are present." >&2
fi

if [ -z "${missing}" ]; then
  export SOURCE_ENGINE_ROOT="${SOURCE_ENGINE_ROOT:-/inputs/source}"
  export HL2_STEAM_ROOT="${HL2_STEAM_ROOT:-/inputs/steam}"
  export HL2_GOTY_ISO="${HL2_GOTY_ISO:-}"
  if [ -z "${HL2_GOTY_ISO}" ]; then
    iso="$(find /inputs/iso -name '*.iso' 2>/dev/null | head -n 1 || true)"
    if [ -n "${iso}" ]; then export HL2_GOTY_ISO="${iso}"; fi
  fi
  export HL2_GOTY_ROOT="${HL2_GOTY_ROOT:-/var/lib/source-wasm/goty}"
  export HL2_COMBINED_ROOT="${HL2_COMBINED_ROOT:-/data}"
  export HL2_OWNER_ROOT="${HL2_COMBINED_ROOT}"
  export WASM_GAME_DATA_ROOT="${HL2_COMBINED_ROOT}"
  /opt/source-wasm/scripts/prepare.sh
  if [ "${SOURCE_WASM_SKIP_COMPILE:-}" != "1" ] && [ ! -f /opt/game-site/source-engine.wasm ]; then
    echo "Compiling the user-provided engine tree (this takes a long time)…"
    SOURCE_ENGINE_ROOT="${SOURCE_ENGINE_ROOT}" /opt/source-wasm/scripts/build-web.sh || {
      echo "Engine compile failed. The site will stay on Still in development." >&2
    }
  fi
fi

export WASM_GAME_SITE_ROOT="${WASM_GAME_SITE_ROOT:-/opt/game-site}"
export WASM_GAME_SHELL_ROOT="${WASM_GAME_SHELL_ROOT:-/opt/wasm-game-framework/dist}"
export WASM_GAME_DATA_ROOT="${WASM_GAME_DATA_ROOT:-/data}"
export WASM_GAME_HTTP_PORT="${WASM_GAME_HTTP_PORT:-8088}"

if [ -n "${WASM_GAME_PASSWORD:-}" ] && [ -z "${WASM_GAME_SESSION_SECRET:-}" ]; then
  WASM_GAME_SESSION_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
  export WASM_GAME_SESSION_SECRET
fi

exec node /opt/wasm-game-framework/server/static-server.js
