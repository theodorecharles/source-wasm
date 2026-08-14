# syntax=docker/dockerfile:1.7

ARG FRAMEWORK_IMAGE=wasm-game-framework:0.7.1
FROM ${FRAMEWORK_IMAGE}

ARG GAME_VARIANT=suite
ARG VCS_REF=local
LABEL org.opencontainers.image.title="Source WASM published-source checkpoint" \
      org.opencontainers.image.description="Retail-free Half-Life 2 data loader and diagnostic WASM boundary; not a playable Source engine" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.licenses="MIT"

COPY build/web/ /opt/game-site/

ENV WASM_GAME_VARIANT=${GAME_VARIANT}
VOLUME ["/data"]
EXPOSE 8088/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8088/ >/dev/null
