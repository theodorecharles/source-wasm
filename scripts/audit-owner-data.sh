#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
owner_root="${HL2_OWNER_ROOT:-/home/ted/.steam/debian-installation/steamapps/common/Half-Life 2}"

node - "${repo_root}/site/wasm-game-data.json" "${owner_root}" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const manifest = JSON.parse(fs.readFileSync(process.argv[2])).variants.hl2;
const root = process.argv[3];
for (const rule of manifest.files) {
  const filename = path.join(root, rule.path);
  const bytes = fs.readFileSync(filename);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== rule.size || digest !== rule.sha256) throw new Error(`${rule.path} does not match Steam build 19307283`);
  console.log(`${rule.path}: ${bytes.length} bytes ${digest}`);
}
NODE

echo "owner-data audit passed; no file was copied"

