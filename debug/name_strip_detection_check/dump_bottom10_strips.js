#!/usr/bin/env node
'use strict';

// Stage 1 of the bottom-10% level-disambiguation test plan.
//
// Walks images/{sect,personal,side-jobs}, groups templates by (class, baseName),
// keeps families with ≥ 2 distinct levels, and writes the bottom 10% of each
// template's name strip to bottom10_dump/<class>/<family>_L<n>_bottom.png so
// the strips can be eyeballed side-by-side per family.
//
// If different levels of the same family look distinct here, proceed to
// stage 2 (test_bottom10_ncc.js). If they look identical, the bottom-10%
// hypothesis is dead.
//
// Run: node debug/name_strip_detection_check/dump_bottom10_strips.js

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));

// Mirrors STRIP_RECT in name_strip_detector.js. Side-jobs share the sect rect.
const STRIP_RECT = {
  sect:     { x: 0.0988, y: 0, width: 0.1412, height: 0.6 },
  personal: { x: 0.109,  y: 0, width: 0.1398, height: 0.6 },
};

// Bottom-fraction slices to dump per template. Each fraction gets its own PNG
// (e.g. L1_bottom10.png, L1_bottom20.png, L1_bottom30.png) so they can be
// eyeballed side by side per family.
const BOTTOM_FRACTIONS = [0.10, 0.20, 0.30];

// Each entry: { dir: relative dir under images/, classKey: which STRIP_RECT to use, label: dump subfolder }
const SCAN = [
  { dir: 'sect',      classKey: 'sect',     label: 'sect'     },
  { dir: 'personal',  classKey: 'personal', label: 'personal' },
  { dir: 'side-jobs', classKey: 'sect',     label: 'side-jobs' },
];

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function walkDir(dirPath) {
  const out = [];
  if (!fs.existsSync(dirPath)) return out;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) out.push(...walkDir(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) out.push(full);
  }
  return out;
}

// Same regex as parseTemplateFilename in slot_detector.js.
function parseLevel(filePath) {
  const fileName = path.basename(filePath, '.png');
  const match = fileName.match(/^(.*?)(\d+)$/u);
  if (!match) return null;
  return { baseName: match[1], level: Number.parseInt(match[2], 10) };
}

function cropRGBA(rgba, srcW, rx, ry, rw, rh) {
  const out = Buffer.alloc(rw * rh * 4);
  for (let y = 0; y < rh; y++) {
    const srcStart = ((ry + y) * srcW + rx) * 4;
    out.set(rgba.subarray(srcStart, srcStart + rw * 4), y * rw * 4);
  }
  return out;
}

function encodePNG(rgba, width, height) {
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const tab = encodePNG._crcTab || (encodePNG._crcTab = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
      }
      return t;
    })());
    let crc = 0xffffffff;
    const buf = Buffer.concat([typeBuf, data]);
    for (let i = 0; i < buf.length; i++) crc = tab[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = width * 4;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    Buffer.from(rgba).copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(filtered);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function safeFamilyKey(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_');
}

const outRoot = path.join(__dirname, 'bottom10_dump');
fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });

let totalScanned = 0;
let totalEmitted = 0;
let totalFamilies = 0;
let totalSkippedSingleLevel = 0;

for (const scan of SCAN) {
  const baseDir = path.join(ROOT, 'images', scan.dir);
  if (!fs.existsSync(baseDir)) {
    console.log(`[skip] ${baseDir} does not exist`);
    continue;
  }

  // Group templates by (class, baseName). For personal cards, prepend the
  // character folder so two characters with the same card name don't collide.
  const families = new Map();
  for (const filePath of walkDir(baseDir)) {
    totalScanned += 1;
    const parsed = parseLevel(filePath);
    if (!parsed) continue;

    let familyKey = parsed.baseName;
    if (scan.classKey === 'personal') {
      const m = filePath.match(/[\\/]personal[\\/]([^\\/]+)[\\/]/);
      if (m) familyKey = `${m[1]}__${parsed.baseName}`;
    } else if (scan.dir === 'side-jobs') {
      const m = filePath.match(/[\\/]side-jobs[\\/]([^\\/]+)[\\/]/);
      if (m) familyKey = `${m[1]}__${parsed.baseName}`;
    } else if (scan.dir === 'sect') {
      const m = filePath.match(/[\\/]sect[\\/]([^\\/]+)[\\/]/);
      if (m) familyKey = `${m[1]}__${parsed.baseName}`;
    }

    if (!families.has(familyKey)) families.set(familyKey, new Map());
    const byLevel = families.get(familyKey);
    if (!byLevel.has(parsed.level)) byLevel.set(parsed.level, filePath);
  }

  for (const [familyKey, byLevel] of families) {
    if (byLevel.size < 2) { totalSkippedSingleLevel += 1; continue; }
    totalFamilies += 1;

    const familyDirName = safeFamilyKey(familyKey);
    const outDir = path.join(outRoot, scan.label, familyDirName);
    fs.mkdirSync(outDir, { recursive: true });

    const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
    for (const level of sortedLevels) {
      const filePath = byLevel.get(level);
      const tmpl = decodePng(filePath);
      const rect = STRIP_RECT[scan.classKey];

      const cx = clamp(Math.round(rect.x * tmpl.width),  0, tmpl.width  - 1);
      const cy = clamp(Math.round(rect.y * tmpl.height), 0, tmpl.height - 1);
      const cw = Math.max(1, Math.min(tmpl.width  - cx, Math.round(rect.width  * tmpl.width)));
      const stripH = Math.max(1, Math.min(tmpl.height - cy, Math.round(rect.height * tmpl.height)));

      for (const frac of BOTTOM_FRACTIONS) {
        const bottomH = Math.max(1, Math.round(stripH * frac));
        const bottomY = cy + (stripH - bottomH);
        const bottom = cropRGBA(tmpl.data, tmpl.width, cx, bottomY, cw, bottomH);

        const pct = Math.round(frac * 100);
        const outFile = path.join(outDir, `L${level}_bottom${pct}.png`);
        fs.writeFileSync(outFile, encodePNG(bottom, cw, bottomH));
        totalEmitted += 1;
      }
    }

    console.log(`[${scan.label}] ${familyKey}: levels ${sortedLevels.join(',')} → ${outDir}`);
  }
}

console.log('\n=== Summary ===');
console.log(`Scanned PNGs:                 ${totalScanned}`);
console.log(`Multi-level families emitted: ${totalFamilies}`);
console.log(`Bottom slices written:        ${totalEmitted} `
          + `(${BOTTOM_FRACTIONS.map(f => (f*100).toFixed(0)+'%').join(', ')} per template)`);
console.log(`Single-level families skipped: ${totalSkippedSingleLevel}`);
console.log(`\nDump root: ${outRoot}`);
console.log('Open per-family folders side-by-side to compare L1/L2/L3 bottoms.');
