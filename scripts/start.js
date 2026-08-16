#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const steamRoot = '/home/ted/.steam/debian-installation/steamapps/common/Half-Life 2';
const combinedRoot = process.env.HL2_COMBINED_ROOT || '/home/ted/.local/share/source-wasm/hl2-combined';
const gotyRoot = process.env.HL2_GOTY_ROOT || '/home/ted/.local/share/source-wasm/hl2-dvd';
process.env.WASM_GAME_SITE_ROOT = path.join(root, 'web');
process.env.WASM_GAME_SHELL_ROOT = path.join(root, 'vendor', 'wasm-game-framework', 'dist');
process.env.WASM_GAME_DATA_ROOT = process.env.WASM_GAME_DATA_ROOT
  || process.env.HL2_OWNER_ROOT
  || (fs.existsSync(path.join(combinedRoot, 'hl2', 'gameinfo.txt')) ? combinedRoot : '')
  || (fs.existsSync(path.join(gotyRoot, 'hl2', 'gameinfo.txt')) ? gotyRoot : '')
  || (fs.existsSync(path.join(steamRoot, 'hl2', 'gameinfo.txt')) ? steamRoot : path.join(root, '.data'));
process.env.WASM_GAME_HTTP_PORT = process.env.WASM_GAME_HTTP_PORT || '8088';

const child = spawn(process.execPath, [
  path.join(root, 'vendor', 'wasm-game-framework', 'server', 'static-server.js')
], { stdio: 'inherit' });
child.on('exit', code => process.exit(code || 0));
