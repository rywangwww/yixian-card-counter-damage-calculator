#!/usr/bin/env node
'use strict';

// Focused diagnostic for 金灵•针 (sect/five-element).
//
// Stage 3 showed L1/L2 are essentially indistinguishable for this card at any
// bottom-fraction. Stage 2's within_family JSONs already confirmed this is a
// template-vs-template issue (no screenshot involved), but we want to know:
//   1. Is the WHOLE strip indistinguishable, or just the bottom?
//   2. Where on the strip does the L1↔L2 distinction live, if anywhere?
//
// This script:
//   - Decodes 金灵•针1/2/3 templates.
//   - Crops the sect name strip.
//   - Slides a horizontal band (10% tall) from top to bottom of the strip,
//     computing pairwise NCC at each band position.
//   - Writes a single side-by-side PNG (full strip + bottom 10/20/30 slices
//     for L1, L2, L3) into bottom10_dump/diagnose_金灵•针/.
//
// Run: node debug/name_strip_detection_check/diagnose_jinling_zhen.js

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));

const STRIP_RECT_SECT = { x: 0.0988, y: 0, width: 0.1412, height: 0.6 };
const CANON_W = 60;
const CANON_H = 192;

const TEMPLATES = [
  { level: 1, file: 'images/sect/five-element/1/金灵•针1.png' },
  { level: 2, file: 'images/sect/five-element/1/金灵•针2.png' },
  { level: 3, file: 'images/sect/five-element/1/金灵•针3.png' },
];

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function bilinearSample(g, w, h, x, y) {
  const x0 = clamp(Math.floor(x), 0, w - 1);
  const y0 = clamp(Math.floor(y), 0, h - 1);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const wx = x - x0, wy = y - y0;
  return (1-wx)*(1-wy)*g[y0*w+x0] + wx*(1-wy)*g[y0*w+x1] + (1-wx)*wy*g[y1*w+x0] + wx*wy*g[y1*w+x1];
}
function resizeGray(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    out[y*dw+x] = bilinearSample(src, sw, sh, (x+0.5)*sw/dw - 0.5, (y+0.5)*sh/dh - 0.5);
  }
  return out;
}
function zncc(a, b, n) {
  let sA = 0, sB = 0;
  for (let i = 0; i < n; i++) { sA += a[i]; sB += b[i]; }
  const mA = sA/n, mB = sB/n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - mA, db = b[i] - mB;
    num += da*db; dA += da*da; dB += db*db;
  }
  const denom = Math.sqrt(dA * dB);
  return denom < 1 ? 0 : num / denom;
}

function rgbaToGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, px = 0; px < w * h; i += 4, px += 1) {
    g[px] = 0.299*rgba[i] + 0.587*rgba[i+1] + 0.114*rgba[i+2];
  }
  return g;
}

function buildCanonStrip(filePath) {
  const tmpl = decodePng(path.join(ROOT, filePath));
  const { width: W, height: H, data } = tmpl;
  const cx = clamp(Math.round(STRIP_RECT_SECT.x * W), 0, W-1);
  const cy = clamp(Math.round(STRIP_RECT_SECT.y * H), 0, H-1);
  const cw = Math.max(1, Math.min(W-cx, Math.round(STRIP_RECT_SECT.width  * W)));
  const ch = Math.max(1, Math.min(H-cy, Math.round(STRIP_RECT_SECT.height * H)));
  const fullGray = rgbaToGray(data, W, H);
  const stripGray = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    stripGray[y*cw+x] = fullGray[(cy+y)*W + (cx+x)];
  }
  // Also keep the RGBA crop for visualization.
  const stripRGBA = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const srcStart = ((cy+y)*W + cx) * 4;
    stripRGBA.set(data.subarray(srcStart, srcStart + cw * 4), y * cw * 4);
  }
  const canon = resizeGray(stripGray, cw, ch, CANON_W, CANON_H);
  return { canon, stripRGBA, stripW: cw, stripH: ch };
}

const strips = TEMPLATES.map(t => ({ ...t, ...buildCanonStrip(t.file) }));

// ── 1. Sliding-band NCC over the canonical strip ──────────────────────────
//    Scans a 10% tall band from y=0 to y=CANON_H-bandH and prints the
//    pairwise NCC at each position.
//
//    The "best" L1↔L2 separation is wherever the NCC is LOWEST.

const bandH = Math.max(1, Math.round(CANON_H * 0.10));
const bandN = CANON_W * bandH;
console.log(`Sliding ${bandH}-row (10% of canonical) band over the strip; CANON_H=${CANON_H}.`);
console.log('y_start  height%    L1↔L2     L1↔L3     L2↔L3');

function bandSlice(canon, yStart, h) {
  const out = new Float32Array(CANON_W * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < CANON_W; x++) {
    out[y*CANON_W+x] = canon[(yStart+y)*CANON_W+x];
  }
  return out;
}

const STEP = Math.max(1, Math.round(CANON_H * 0.05));
for (let yStart = 0; yStart + bandH <= CANON_H; yStart += STEP) {
  const a = bandSlice(strips[0].canon, yStart, bandH);
  const b = bandSlice(strips[1].canon, yStart, bandH);
  const c = bandSlice(strips[2].canon, yStart, bandH);
  const ab = zncc(a, b, bandN);
  const ac = zncc(a, c, bandN);
  const bc = zncc(b, c, bandN);
  const yPct = (yStart / CANON_H * 100).toFixed(0);
  console.log(`${String(yStart).padStart(4)}    ${String(yPct).padStart(3)}%       `
            + `${ab.toFixed(3).padStart(6)}    ${ac.toFixed(3).padStart(6)}    ${bc.toFixed(3).padStart(6)}`);
}

// ── 2. Whole-strip pairwise NCC ───────────────────────────────────────────

console.log('\nWhole-strip pairwise NCC (all CANON_H rows):');
const fullN = CANON_W * CANON_H;
const fullAB = zncc(strips[0].canon, strips[1].canon, fullN);
const fullAC = zncc(strips[0].canon, strips[2].canon, fullN);
const fullBC = zncc(strips[1].canon, strips[2].canon, fullN);
console.log(`  L1↔L2 = ${fullAB.toFixed(3)}`);
console.log(`  L1↔L3 = ${fullAC.toFixed(3)}`);
console.log(`  L2↔L3 = ${fullBC.toFixed(3)}`);

// ── 3. Visualization: stack the natural-resolution strips side-by-side ────

function encodePNG(rgba, width, height) {
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const tb = Buffer.from(type, 'ascii');
    const tab = encodePNG._t || (encodePNG._t = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
      }
      return t;
    })());
    let crc = 0xffffffff;
    const buf = Buffer.concat([tb, data]);
    for (let i = 0; i < buf.length; i++) crc = tab[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    const cb = Buffer.alloc(4); cb.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, tb, data, cb]);
  }
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = width * 4;
  const filt = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    filt[y*(stride+1)] = 0;
    Buffer.from(rgba).copy(filt, y*(stride+1)+1, y*stride, y*stride+stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(filt)), chunk('IEND', Buffer.alloc(0))]);
}

// All templates share the same source resolution → strips have the same w/h.
const sw = strips[0].stripW, sh = strips[0].stripH;
const GAP = 8;
const totalW = sw * 3 + GAP * 2;
const out = Buffer.alloc(totalW * sh * 4, 0);
for (let i = 0; i < 3; i++) {
  const xOff = i * (sw + GAP);
  for (let y = 0; y < sh; y++) {
    const srcStart = y * sw * 4;
    const dstStart = (y * totalW + xOff) * 4;
    strips[i].stripRGBA.copy(out, dstStart, srcStart, srcStart + sw * 4);
  }
}
const outDir = path.join(__dirname, 'bottom10_dump', 'diagnose_金灵•针');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'L1_L2_L3_full_strip.png');
fs.writeFileSync(outFile, encodePNG(out, totalW, sh));
console.log(`\nWrote side-by-side full strip: ${outFile}`);
console.log(`(${sw}×${sh} per strip, ordered L1 | L2 | L3)`);
