#!/usr/bin/env node
'use strict';

// Dumps just the slot crop (no templates, no overlays) for inspection.
// Saves as `crop_<screenshot>_slot<N>.png` in this folder.

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));

const DEFAULT_DREAM_RATIO    = { width: 0.925, height: 0.977 };
const DEFAULT_DREAM_X_OFFSET = 8;

const CASES = [
  { ss: 'fengxuround6.png',  slot: 6, label: 'r6_slot6_轰雷掣电_truthP2',     calLocal: true  },
  { ss: 'fengxuround7.png',  slot: 3, label: 'r7_slot3_星轨推衍_truthP2',     calLocal: true  },
  { ss: 'fengxuround7.png',  slot: 0, label: 'r7_slot0_乾卦_truthP3',         calLocal: true  },
  { ss: 'fengxuround7.png',  slot: 2, label: 'r7_slot2_轰雷掣电_truthP3',     calLocal: true  },
  { ss: 'fengxuround15.png', slot: 0, label: 'r15_slot0_两仪阵_truthP5',      calLocal: true  },
  { ss: 'fengxuround15.png', slot: 5, label: 'r15_slot5_星轨推衍_truthP5',    calLocal: true  },
];

const CAL_LOCAL = path.join(__dirname, 'calibration.json');

function encodePng(rgba, width, height) {
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const tb = Buffer.from(type, 'ascii');
    const tab = encodePng._t || (encodePng._t = (() => {
      const t = new Uint32Array(256);
      for (let n=0; n<256; n++) {
        let c=n; for (let k=0; k<8; k++) c = c & 1 ? 0xedb88320 ^ (c>>>1) : c>>>1;
        t[n]=c;
      }
      return t;
    })());
    let crc = 0xffffffff;
    const buf = Buffer.concat([tb, data]);
    for (let i=0; i<buf.length; i++) crc = tab[(crc ^ buf[i]) & 0xff] ^ (crc>>>8);
    const cb = Buffer.alloc(4); cb.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, tb, data, cb]);
  }
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,0); ihdr.writeUInt32BE(height,4); ihdr[8]=8; ihdr[9]=6;
  const stride = width * 4;
  const filt = Buffer.alloc(height * (stride + 1));
  for (let y=0; y<height; y++) {
    filt[y*(stride+1)] = 0;
    Buffer.from(rgba).copy(filt, y*(stride+1)+1, y*stride, y*stride+stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(filt)), chunk('IEND', Buffer.alloc(0))]);
}

const cal = JSON.parse(fs.readFileSync(CAL_LOCAL, 'utf8'));
const normal = cal.slots;
const ratio = (normal.dreamSlotRatio && (normal.dreamSlotRatio.width !== 1 || normal.dreamSlotRatio.height !== 1))
  ? normal.dreamSlotRatio : DEFAULT_DREAM_RATIO;
const xOff = typeof normal.dreamXOffset === 'number' ? normal.dreamXOffset : DEFAULT_DREAM_X_OFFSET;
const dreamGeo = {
  ...normal,
  slotXPositions: normal.slotXPositions.map(x => x + xOff),
  slotWidth:  Math.max(1, Math.round(normal.slotWidth  * ratio.width)),
  slotHeight: Math.max(1, Math.round(normal.slotHeight * ratio.height))
};

for (const c of CASES) {
  const ssPath = path.join(__dirname, c.ss);
  if (!fs.existsSync(ssPath)) { console.log(`skip: ${ssPath} missing`); continue; }
  const ss = decodePng(ssPath);
  const sx = ss.width / dreamGeo.baseScreenWidth;
  const sy = ss.height / dreamGeo.baseScreenHeight;
  const rect = {
    x: Math.round(dreamGeo.slotXPositions[c.slot] * sx),
    y: Math.round(dreamGeo.slotY * sy),
    width:  Math.max(1, Math.round(dreamGeo.slotWidth  * sx)),
    height: Math.max(1, Math.round(dreamGeo.slotHeight * sy)),
  };
  const out = new Uint8Array(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const sxi = rect.x + x;
      const syi = rect.y + y;
      if (sxi < 0 || sxi >= ss.width || syi < 0 || syi >= ss.height) continue;
      const si = (syi * ss.width + sxi) * 4;
      const di = (y * rect.width + x) * 4;
      out[di]   = ss.data[si];
      out[di+1] = ss.data[si+1];
      out[di+2] = ss.data[si+2];
      out[di+3] = 255;
    }
  }
  const file = path.join(__dirname, `crop_${c.label}.png`);
  fs.writeFileSync(file, encodePng(out, rect.width, rect.height));
  console.log(`${c.label}: ${rect.width}x${rect.height} → ${file}`);
}
