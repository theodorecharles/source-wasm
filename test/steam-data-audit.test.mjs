import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { HL2_STEAM_ROOT } from '../scripts/source-data-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(readFileSync(path.join(root, 'web', 'wasm-game-data.json'), 'utf8'));

assert.equal(policy.version, 'steam-legacy-hl2-v1');
assert.ok(policy.variants.hl2);
assert.ok(policy.variants.hl2.files.length > 20);

for (const [variant, pack] of Object.entries(policy.variants)) {
  for (const file of pack.files) {
    assert.doesNotMatch(file.path, /glshaders\.cfg/i, `${variant} mounts glshaders.cfg`);
    assert.doesNotMatch(file.path, /\.dll$/i, `${variant} mounts a Windows DLL`);
    assert.doesNotMatch(file.name, /\.dll$/i);
    const abs = path.join(HL2_STEAM_ROOT, file.path);
    assert.ok(existsSync(abs), `missing owner file ${file.path}`);
  }
}

const probe = policy.variants.hl2.files.find((file) => file.path === 'hl2/gameinfo.txt');
assert.ok(probe);
const bytes = readFileSync(path.join(HL2_STEAM_ROOT, probe.path));
assert.equal(createHash('sha256').update(bytes).digest('hex'), probe.sha256);
assert.match(bytes.toString('utf8'), /GameInfo/);

assert.equal(existsSync(path.join(root, 'vendor', 'source-engine', 'wscript')), false);
assert.ok(existsSync(path.join(root, 'patches', 'series')));

console.log(`steam-data-audit: ${policy.variants.hl2.files.length} hl2 files against ${HL2_STEAM_ROOT}`);
