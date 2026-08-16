# Public image: patches, adapter, and framework only.
# The leaked engine tree, steam_legacy depot, and 2014 GOTY ISO are
# provided at run time by the person who runs the container.
FROM emscripten/emsdk:3.1.64

ARG GAME_VARIANT=hl2

RUN apt-get update \
  && apt-get install -y --no-install-recommends cabextract p7zip-full rsync python3 \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY vendor/wasm-game-framework/ /opt/wasm-game-framework/
COPY web/ /opt/game-site/
COPY scripts/ /opt/source-wasm/scripts/
COPY patches/ /opt/source-wasm/patches/
COPY package.json framework-lock.json source-lock.json /opt/source-wasm/

RUN chmod +x /opt/source-wasm/scripts/*.sh /opt/source-wasm/scripts/*.mjs \
  && mkdir -p /inputs/source /inputs/steam /inputs/iso /data /var/lib/source-wasm

ENV WASM_GAME_VARIANT=${GAME_VARIANT} \
    WASM_GAME_SITE_ROOT=/opt/game-site \
    WASM_GAME_SHELL_ROOT=/opt/wasm-game-framework/dist \
    WASM_GAME_DATA_ROOT=/data \
    WASM_GAME_HTTP_PORT=8088 \
    SOURCE_ENGINE_ROOT=/inputs/source \
    HL2_STEAM_ROOT=/inputs/steam \
    HL2_GOTY_ROOT=/var/lib/source-wasm/goty \
    HL2_COMBINED_ROOT=/data \
    SOURCE_WASM_WEB_DIR=/opt/game-site

VOLUME ["/inputs/source", "/inputs/steam", "/inputs/iso", "/data"]
EXPOSE 8088
ENTRYPOINT ["/opt/source-wasm/scripts/docker-entrypoint.sh"]
