#!/usr/bin/env node
'use strict';

// Dumps the canonical name strip from each expected template
// for visual comparison against the screen strips.

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));

const STRIP_RECT = {
  sect:     { x: 0.0988, y: 0, width: 0.1412, height: 0.6 },
  dream:    { x: 0.0608, y: 0, width: 0.1392, height: 0.6 },
  personal: { x: 0.109,  y: 0, width: 0.1398, height: 0.6 },
};

const TEMPLATES = [
  { tag: 'slot0_dream',    file: 'images/seasonal/five-element/梦•混元碎击1.png',     cls: 'dream'    },
  { tag: 'slot1_personal', file: 'images/personal/HuaQinrui/木灵•桃花印1.png',         cls: 'personal' },
  { tag: 'slot2_sect',     file: 'images/sect/five-element/1/木灵•芽1.png',           cls: 'sect'     },
  { tag: 'slot3_sect',     file: 'images/sect/five-element/1/金灵•针1.png',           cls: 'sect'     },
];

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function cropRGBA(rgba, w, rx, ry, rw, rh) {
  const out = Buffer.alloc(rw * rh * 4);
  for (let y = 0; y < rh; y++) {
    const srcStart = ((ry + y) * w + rx) * 4;
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

const outDir = path.join(__dirname, 'crops');
fs.mkdirSync(outDir, { recursive: true });

for (const t of TEMPLATES) {
  const full = path.join(ROOT, t.file);
  const tmpl = decodePng(full);
  const rect = STRIP_RECT[t.cls];
  const cx = clamp(Math.round(rect.x * tmpl.width),  0, tmpl.width  - 1);
  const cy = clamp(Math.round(rect.y * tmpl.height), 0, tmpl.height - 1);
  const cw = Math.max(1, Math.min(tmpl.width  - cx, Math.round(rect.width  * tmpl.width)));
  const ch = Math.max(1, Math.min(tmpl.height - cy, Math.round(rect.height * tmpl.height)));
  const crop = cropRGBA(tmpl.data, tmpl.width, cx, cy, cw, ch);
  fs.writeFileSync(path.join(outDir, `${t.tag}_TEMPLATE_strip.png`), encodePNG(crop, cw, ch));
  console.log(`${t.tag}: ${t.file}  ${tmpl.width}x${tmpl.height} → strip ${cw}x${ch} (AR=${(cw/ch).toFixed(4)})`);
}
