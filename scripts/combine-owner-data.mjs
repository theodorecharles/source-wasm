#!/usr/bin/env node
// Build the owner-data tree: 2014 GOTY/Collectors loose files + steam_legacy shaders.
// Never copies Windows DLLs or Steam's glshaders.cfg.
import { copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const STEAM = process.env.HL2_STEAM_ROOT
  || '/home/ted/.steam/debian-installation/steamapps/common/Half-Life 2';
const GOTY = process.env.HL2_GOTY_ROOT
  || '/home/ted/.local/share/source-wasm/hl2-dvd';
const DEST = process.env.HL2_COMBINED_ROOT
  || '/home/ted/.local/share/source-wasm/hl2-combined';

const VPK_SIGNATURE = 0x55aa1234;
const EMBEDDED = 0x7fff;

function walk(root, rel = '') {
  const abs = path.join(root, rel);
  const out = [];
  for (const name of readdirSync(abs)) {
    if (name === '.' || name === '..') continue;
    const child = rel ? `${rel}/${name}` : name;
    const st = statSync(path.join(root, child));
    if (st.isDirectory()) out.push(...walk(root, child));
    else if (st.isFile()) out.push(child.replace(/\\/g, '/'));
  }
  return out;
}

function blocked(rel) {
  const base = path.posix.basename(rel).toLowerCase();
  if (base === 'glshaders.cfg') return true;
  if (base.endsWith('.dll')) return true;
  if (/(^|\/)bin\//.test(rel) && /\.(so|dylib|exe)$/i.test(base)) return true;
  return false;
}

function parseVpkDir(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== VPK_SIGNATURE) throw new Error('not a VPK');
  const version = view.getUint32(4, true);
  const treeSize = view.getUint32(8, true);
  const headerSize = version === 1 ? 12 : 28;
  let offset = headerSize;
  const end = Math.min(buf.length, headerSize + treeSize);
  const readCString = () => {
    const start = offset;
    while (offset < buf.length && buf[offset] !== 0) offset += 1;
    const text = Buffer.from(buf.subarray(start, offset)).toString('utf8');
    offset += 1;
    return text;
  };
  const entries = [];
  while (offset < end) {
    const ext = readCString();
    if (!ext) break;
    while (offset < end) {
      const dir = readCString();
      if (!dir) break;
      while (offset < end) {
        const name = readCString();
        if (!name) break;
        if (offset + 18 > buf.length) return { headerSize, treeSize, entries };
        offset += 4;
        const preload = view.getUint16(offset, true); offset += 2;
        const archive = view.getUint16(offset, true); offset += 2;
        const entryOff = view.getUint32(offset, true); offset += 4;
        const entryLen = view.getUint32(offset, true); offset += 4;
        offset += 2;
        const preloadBytes = Buffer.from(buf.subarray(offset, offset + preload));
        offset += preload;
        const rel = dir === ' ' ? `${name}.${ext}` : `${dir}/${name}.${ext}`;
        entries.push({ path: rel.replace(/\\/g, '/'), archive, offset: entryOff, length: entryLen, preloadBytes });
      }
    }
  }
  return { headerSize, treeSize, entries };
}

function listDirVpks(root) {
  return walk(root).filter((rel) => rel.endsWith('_dir.vpk'));
}

const fds = new Map();
function readSlice(abs, offset, length) {
  if (length <= 0) return Buffer.alloc(0);
  let fd = fds.get(abs);
  if (fd == null) {
    fd = openSync(abs, 'r');
    fds.set(abs, fd);
  }
  const out = Buffer.alloc(length);
  const n = readSync(fd, out, 0, length, offset);
  return n === length ? out : out.subarray(0, n);
}

function wantedShader(vpkPath) {
  const lower = vpkPath.toLowerCase();
  return /(^|\/)shaders\//.test(lower) || lower.endsWith('/flashlight_border.vtf');
}

function destRel(dirRel, vpkPath) {
  const prefix = dirRel.split('/')[0] || '';
  const cleaned = vpkPath.replace(/^\/+/, '');
  if (prefix && (cleaned === prefix || cleaned.startsWith(`${prefix}/`))) return cleaned;
  return prefix ? `${prefix}/${cleaned}` : cleaned;
}

if (!existsSync(path.join(GOTY, 'hl2', 'gameinfo.txt'))) {
  throw new Error(`2014 GOTY extract missing at ${GOTY}. Mount the ISO and run scripts/extract-goty-iso.sh first.`);
}
if (!existsSync(path.join(STEAM, 'hl2'))) {
  throw new Error(`steam_legacy HL2 missing at ${STEAM}`);
}

mkdirSync(DEST, { recursive: true });
let copied = 0;
let skipped = 0;
for (const rel of walk(GOTY)) {
  if (blocked(rel)) {
    skipped += 1;
    continue;
  }
  const dest = path.join(DEST, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(path.join(GOTY, rel), dest);
  copied += 1;
}

const extracted = [];
for (const dirRel of listDirVpks(STEAM)) {
  const dirAbs = path.join(STEAM, dirRel);
  const dirBuf = readFileSync(dirAbs);
  const parsed = parseVpkDir(dirBuf);
  const dataBase = parsed.headerSize + parsed.treeSize;
  for (const entry of parsed.entries) {
    if (!wantedShader(entry.path)) continue;
    const relative = destRel(dirRel, entry.path);
    let payload = entry.preloadBytes;
    if (entry.length > 0) {
      const chunk = entry.archive === EMBEDDED
        ? dirBuf.subarray(dataBase + entry.offset, dataBase + entry.offset + entry.length)
        : readSlice(path.join(STEAM, dirRel.replace(/_dir\.vpk$/i, `_${String(entry.archive).padStart(3, '0')}.vpk`)), entry.offset, entry.length);
      payload = payload.length ? Buffer.concat([payload, Buffer.from(chunk)]) : Buffer.from(chunk);
    }
    const abs = path.join(DEST, relative);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, payload);
    extracted.push(relative);
  }
}
for (const fd of fds.values()) closeSync(fd);

const gl = path.join(DEST, 'hl2', 'glshaders.cfg');
if (existsSync(gl)) rmSync(gl);

const vs20 = path.join(DEST, 'hl2', 'shaders', 'fxc', 'vertexlit_and_unlit_generic_vs20.vcs');
if (!existsSync(vs20)) throw new Error('steam_legacy overlay did not produce vertexlit_and_unlit_generic_vs20.vcs');
const ver = readFileSync(vs20).readUInt32LE(0);
if (![4, 5, 6].includes(ver)) {
  throw new Error(`vs20.vcs is version ${ver}, engine needs 4/5/6`);
}

console.log(JSON.stringify({
  goty: GOTY,
  steam: STEAM,
  dest: DEST,
  copiedFromGoty: copied,
  skippedBlocked: skipped,
  shadersFromLegacy: extracted.length,
  vs20Version: ver
}, null, 2));
