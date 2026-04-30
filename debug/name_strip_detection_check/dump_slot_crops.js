#!/usr/bin/env node
'use strict';

// Dumps each predicted slot rect (full card) and the predicted name strip
// from check1.png to PNG files so we can visually verify alignment.

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));
const { computeLayoutTransform } = require(path.join(ROOT, 'rect_scale'));

const STRIP_RECT = {
  sect:     { x: 0.0988, y: 0, width: 0.1412, height: 0.6 },
  dream:    { x: 0.0608, y: 0, width: 0.1392, height: 0.6 },
  personal: { x: 0.109,  y: 0, width: 0.1398, height: 0.6 },
};
const CALIBRATION_TOP_CORRECTION = 0.079;
const DEFAULT_DREAM_RATIO    = { width: 0.925, height: 0.977 };
const DEFAULT_DREAM_X_OFFSET = 8;

const SLOTS = [
  { slot: 0, cls: 'dream'    },
  { slot: 1, cls: 'personal' },
  { slot: 2, cls: 'sect'     },
  { slot: 3, cls: 'sect'     },
];

const SS_PATH = path.join(__dirname, 'check1.png');
const CAL_PATH = path.join(process.env.HOME, 'Library', 'Application Support', 'yixian-overlay', 'calibration.json');

function getScaledSlotRect(slotIndex, ssSize, geom) {
  const t = computeLayoutTransform({ width: geom.baseScreenWidth, height: geom.baseScreenHeight }, ssSize);
  return {
    x:      Math.round(geom.slotXPositions[slotIndex] * t.scaleX),
    y:      Math.round(geom.slotY                     * t.scaleY),
    width:  Math.max(1, Math.round(geom.slotWidth  * t.sizeScaleX)),
    height: Math.max(1, Math.round(geom.slotHeight * t.sizeScaleY)),
  };
}

function dreamGeometry(active) {
  const ratio = (active.dreamSlotRatio && (active.dreamSlotRatio.width !== 1 || active.dreamSlotRatio.height !== 1))
    ? active.dreamSlotRatio
    : DEFAULT_DREAM_RATIO;
  const xOff = typeof active.dreamXOffset === 'number' ? active.dreamXOffset : DEFAULT_DREAM_X_OFFSET;
  return {
    ...active,
    slotXPositions: active.slotXPositions.map((x) => x + xOff),
    slotWidth:      Math.max(1, Math.round(active.slotWidth  * ratio.width)),
    slotHeight:     Math.max(1, Math.round(active.slotHeight * ratio.height)),
  };
}

// Minimal PNG encoder (RGBA, no filters)
function encodePNG(rgba, width, height) {
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    let crc = 0xffffffff;
    const tab = encodePNG._crcTab || (encodePNG._crcTab = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
      }
      return t;
    })());
    const buf = Buffer.concat([typeBuf, data]);
    for (let i = 0; i < buf.length; i++) crc = tab[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // Add filter byte 0 per scanline
  const stride = width * 4;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    rgba.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(filtered);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function cropRGBA(rgba, w, h, rx, ry, rw, rh) {
  const x0 = Math.max(0, Math.min(w - 1, rx));
  const y0 = Math.max(0, Math.min(h - 1, ry));
  const x1 = Math.max(x0 + 1, Math.min(w, rx + rw));
  const y1 = Math.max(y0 + 1, Math.min(h, ry + rh));
  const cw = x1 - x0, ch = y1 - y0;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const srcStart = ((y0 + y) * w + x0) * 4;
    out.set(rgba.subarray(srcStart, srcStart + cw * 4), y * cw * 4);
  }
  return { rgba: out, w: cw, h: ch };
}

function main() {
  const cal = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
  const ss  = decodePng(SS_PATH);
  const ssSize = { width: ss.width, height: ss.height };
  console.log(`Screenshot: ${ss.width}x${ss.height}`);
  const dreamGeom = dreamGeometry(cal.slots);

  const outDir = path.join(__dirname, 'crops');
  fs.mkdirSync(outDir, { recursive: true });

  for (const s of SLOTS) {
    const geom = s.cls === 'dream' ? dreamGeom : cal.slots;
    const slotRect = getScaledSlotRect(s.slot, ssSize, geom);
    const stripRect = STRIP_RECT[s.cls];

    // Dump full slot rect
    const slotCrop = cropRGBA(ss.data, ss.width, ss.height, slotRect.x, slotRect.y, slotRect.width, slotRect.height);
    fs.writeFileSync(path.join(outDir, `slot${s.slot}_${s.cls}_card.png`), encodePNG(slotCrop.rgba, slotCrop.w, slotCrop.h));

    // Dump predicted name strip (with top correction)
    const correctedH = slotRect.height / (1 - CALIBRATION_TOP_CORRECTION);
    const correctedY = slotRect.y - CALIBRATION_TOP_CORRECTION * correctedH;
    const sx = Math.round(slotRect.x + stripRect.x * slotRect.width);
    const sy = Math.round(correctedY + stripRect.y * correctedH);
    const sw = Math.max(1, Math.round(stripRect.width  * slotRect.width));
    const sh = Math.max(1, Math.round(stripRect.height * correctedH));
    const stripCrop = cropRGBA(ss.data, ss.width, ss.height, sx, sy, sw, sh);
    fs.writeFileSync(path.join(outDir, `slot${s.slot}_${s.cls}_strip.png`), encodePNG(stripCrop.rgba, stripCrop.w, stripCrop.h));

    console.log(`slot ${s.slot} (${s.cls}): card=(${slotRect.x},${slotRect.y} ${slotRect.width}x${slotRect.height})  strip=(${sx},${sy} ${sw}x${sh})`);
  }
  console.log(`\nWrote crops to ${outDir}`);
}

main();
