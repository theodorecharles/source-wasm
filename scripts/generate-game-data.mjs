#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HL2_OWNER_ROOT, buildRootPolicy } from './source-data-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'web', 'wasm-game-data.json');
const policy = await buildRootPolicy(HL2_OWNER_ROOT);
writeFileSync(dest, `${JSON.stringify(policy, null, 2)}\n`);
const counts = Object.fromEntries(
  Object.entries(policy.variants).map(([key, value]) => [key, value.files.length])
);
console.log(`wrote ${dest}`);
console.log(JSON.stringify({ ownerRoot: HL2_OWNER_ROOT, version: policy.version, files: counts }, null, 2));
