#!/usr/bin/env node
'use strict';

// test_check1.js
//
// Standalone test of name_strip_detector.js logic against
// debug/name_strip_detection_check/check1.png (2880x1794 retina capture).
//
// Known cards in this screenshot (slots 0-3 only; 4-7 are locked):
//   slot 0: 梦•混元碎击   (dream / seasonal)
//   slot 1: 木灵•桃花印   (personal — HuaQinrui)
//   slot 2: 木灵•芽       (sect)
//   slot 3: 金灵•针       (sect)

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));
const { computeLayoutTransform } = require(path.join(ROOT, 'rect_scale'));

const CALIBRATION_PATH = path.join(
  process.env.HOME, 'Library', 'Application Support', 'yixian-overlay', 'calibration.json'
);
const SS_PATH    = path.join(__dirname, 'check1.png');
const IMAGES_DIR = path.join(ROOT, 'images');

// ── Must mirror name_strip_detector.js ────────────────────────────────────────
const STRIP_RECT = {
  sect:     { x: 0.0988, y: 0, width: 0.1412, height: 0.6 },
  dream:    { x: 0.0608, y: 0, width: 0.1392, height: 0.6 },
  personal: { x: 0.109,  y: 0, width: 0.1398, height: 0.6 },
};
const STRIP_CANONICAL_H        = 192;
const CALIBRATION_TOP_CORRECTION = 0.079;
const Y_SEARCH_RANGE           = 4;
const X_SEARCH_RANGE           = 2;
const NCC_THRESHOLD            = 0.70;

const DEFAULT_DREAM_RATIO    = { width: 0.925, height: 0.977 };
const DEFAULT_DREAM_X_OFFSET = 8;

// HuaQinrui has no override in name_strip_detector.js → identity geometry
const PERSONAL_OVERRIDES = {
  FengXu: { ratio: { width: 1.104, height: 1.102 }, xOffset: -10, yOffset: -16 },
};

const SLOT_CARDS = [
  { slot: 0, name: '梦•混元碎击', cls: 'dream',    family: 'five-element' },
  { slot: 1, name: '木灵•桃花印', cls: 'personal', char:   'HuaQinrui'    },
  { slot: 2, name: '木灵•芽',     cls: 'sect'                              },
  { slot: 3, name: '金灵•针',     cls: 'sect'                              },
];

// ── Image utils ───────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function bilinearSample(src, sw, sh, x, y) {
  const x0 = clamp(Math.floor(x), 0, sw - 1);
  const y0 = clamp(Math.floor(y), 0, sh - 1);
  const x1 = Math.min(x0 + 1, sw - 1);
  const y1 = Math.min(y0 + 1, sh - 1);
  const wx = x - x0, wy = y - y0;
  return (1-wx)*(1-wy)*src[y0*sw+x0] + wx*(1-wy)*src[y0*sw+x1]
       + (1-wx)*wy*src[y1*sw+x0]    + wx*wy*src[y1*sw+x1];
}

function resizeGray(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++)
      out[y*dw+x] = bilinearSample(src, sw, sh, (x+0.5)*sw/dw - 0.5, (y+0.5)*sh/dh - 0.5);
  return out;
}

function rgbaToGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++)
    g[i] = 0.299*rgba[i*4] + 0.587*rgba[i*4+1] + 0.114*rgba[i*4+2];
  return g;
}

function zncc(a, b, n) {
  let sA = 0, sB = 0;
  for (let i = 0; i < n; i++) { sA += a[i]; sB += b[i]; }
  const mA = sA/n, mB = sB/n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]-mA, db = b[i]-mB;
    num += da*db; dA += da*da; dB += db*db;
  }
  const d = Math.sqrt(dA * dB);
  return d < 1 ? 0 : num / d;
}

// ── Template strip extraction ─────────────────────────────────────────────────
function extractCanonicalStripFromPng(imgPath, rect) {
  const { data: rgba, width, height } = decodePng(imgPath);
  const gray = rgbaToGray(rgba, width, height);
  const cx = clamp(Math.round(rect.x * width),  0, width  - 1);
  const cy = clamp(Math.round(rect.y * height), 0, height - 1);
  const cw = Math.max(1, Math.min(width  - cx, Math.round(rect.width  * width)));
  const ch = Math.max(1, Math.min(height - cy, Math.round(rect.height * height)));

  const crop = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++)
      crop[y*cw+x] = gray[(cy+y)*width + (cx+x)];

  const canonH = STRIP_CANONICAL_H;
  const canonW = Math.max(24, Math.round((cw / ch) * canonH));
  return { gray: resizeGray(crop, cw, ch, canonW, canonH), w: canonW, h: canonH, srcW: width, srcH: height };
}

// ── Screenshot strip extraction ───────────────────────────────────────────────
function extractScreenStripCrop(srcGray, srcW, srcH, slotRect, rect) {
  const correctedH = slotRect.height / (1 - CALIBRATION_TOP_CORRECTION);
  const correctedY = slotRect.y - CALIBRATION_TOP_CORRECTION * correctedH;
  const sx = Math.round(slotRect.x + rect.x * slotRect.width);
  const sy = Math.round(correctedY + rect.y * correctedH);
  const sw = Math.max(1, Math.round(rect.width  * slotRect.width));
  const sh = Math.max(1, Math.round(rect.height * correctedH));
  const x0 = Math.max(0, sx),         y0 = Math.max(0, sy);
  const x1 = Math.min(srcW, sx + sw), y1 = Math.min(srcH, sy + sh);
  const aw = x1-x0, ah = y1-y0;
  if (aw <= 0 || ah <= 0) return null;
  const crop = new Float32Array(aw * ah);
  for (let y = 0; y < ah; y++)
    for (let x = 0; x < aw; x++)
      crop[y*aw+x] = srcGray[(y0+y)*srcW + (x0+x)];
  return { gray: crop, w: aw, h: ah, sx: x0, sy: y0 };
}

// ── Geometry helpers ──────────────────────────────────────────────────────────
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

function personalGeometry(active, charName) {
  const cfg = PERSONAL_OVERRIDES[charName];
  if (!cfg) return active;
  return {
    ...active,
    slotXPositions: active.slotXPositions.map((x) => x + cfg.xOffset),
    slotY:          active.slotY + cfg.yOffset,
    slotWidth:      Math.max(1, Math.round(active.slotWidth  * cfg.ratio.width)),
    slotHeight:     Math.max(1, Math.round(active.slotHeight * cfg.ratio.height)),
  };
}

// ── Template lookup ───────────────────────────────────────────────────────────
function walkDir(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkDir(full));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.png')) out.push(full);
  }
  return out;
}

function normalizeName(name) { return (name || '').replace(/[·•]/g, '•').trim(); }

// Mirrors name_strip_detector candidate filters.
function findTemplatesForCard(cardName, cls, charName) {
  const norm = normalizeName(cardName);
  const base = norm.replace(/\d+$/, '');

  let dirs;
  if (cls === 'dream')         dirs = ['seasonal'];
  else if (cls === 'personal') dirs = ['personal'];
  else                          dirs = ['sect', 'side-jobs'];

  const all = dirs.map((d) => path.join(IMAGES_DIR, d)).filter(fs.existsSync).flatMap(walkDir);
  return all.filter((f) => {
    const fn = path.basename(f, '.png');
    const m  = fn.match(/^(.*?)(\d+)$/u);
    if (!m) return false;
    const bn = normalizeName(m[1]);
    if (bn !== norm && bn !== base) return false;
    if (cls === 'personal' && charName) {
      // Restrict to character folder
      return f.includes(path.sep + 'personal' + path.sep + charName + path.sep);
    }
    return true;
  });
}

// ── Score one slot against templates with class-specific geometry ─────────────
function scoreSlot(slotInfo, ssGray, ssW, ssH, ssSize, calActive) {
  const stripRect = STRIP_RECT[slotInfo.cls];

  let geom;
  if      (slotInfo.cls === 'dream')    geom = dreamGeometry(calActive);
  else if (slotInfo.cls === 'personal') geom = personalGeometry(calActive, slotInfo.char);
  else                                    geom = calActive;

  const slotRect = getScaledSlotRect(slotInfo.slot, ssSize, geom);
  const tmplFiles = findTemplatesForCard(slotInfo.name, slotInfo.cls, slotInfo.char);

  if (tmplFiles.length === 0) {
    return { slotInfo, slotRect, error: 'NO_TEMPLATE_FOUND' };
  }

  const results = [];
  for (const tmplFile of tmplFiles) {
    const canon = extractCanonicalStripFromPng(tmplFile, stripRect);
    let bestNcc = -Infinity, bestDx = 0, bestDy = 0, bestSx = 0, bestSy = 0;
    for (let dy = -Y_SEARCH_RANGE; dy <= Y_SEARCH_RANGE; dy++) {
      for (let dx = -X_SEARCH_RANGE; dx <= X_SEARCH_RANGE; dx++) {
        const searchRect = { ...slotRect, x: slotRect.x + dx, y: slotRect.y + dy };
        const crop = extractScreenStripCrop(ssGray, ssW, ssH, searchRect, stripRect);
        if (!crop) continue;
        const sR = resizeGray(crop.gray, crop.w, crop.h, canon.w, canon.h);
        const score = zncc(sR, canon.gray, canon.w * canon.h);
        if (score > bestNcc) { bestNcc = score; bestDx = dx; bestDy = dy; bestSx = crop.sx; bestSy = crop.sy; }
      }
    }
    results.push({ tmpl: path.relative(ROOT, tmplFile), tmplSize: `${canon.srcW}x${canon.srcH}`, ncc: bestNcc, dx: bestDx, dy: bestDy, sx: bestSx, sy: bestSy });
  }
  results.sort((a, b) => b.ncc - a.ncc);
  return { slotInfo, slotRect, stripRect, results };
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(CALIBRATION_PATH)) {
    console.error('calibration.json not found at', CALIBRATION_PATH);
    process.exit(1);
  }
  if (!fs.existsSync(SS_PATH)) {
    console.error('check1.png not found at', SS_PATH);
    process.exit(1);
  }

  const cal = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));
  const ss  = decodePng(SS_PATH);
  const { data: ssRgba, width: ssW, height: ssH } = ss;
  const ssGray = rgbaToGray(ssRgba, ssW, ssH);
  const ssSize = { width: ssW, height: ssH };

  console.log(`Screenshot: ${ssW}x${ssH}`);
  console.log(`Calibration base: ${cal.slots.baseScreenWidth}x${cal.slots.baseScreenHeight}`);
  const t = computeLayoutTransform({ width: cal.slots.baseScreenWidth, height: cal.slots.baseScreenHeight }, ssSize);
  console.log(`Scale: x=${t.scaleX.toFixed(4)} y=${t.scaleY.toFixed(4)}`);
  console.log(`Slot Y (calibration): ${cal.slots.slotY} → screen ${Math.round(cal.slots.slotY * t.scaleY)}`);
  console.log(`Slot height (calibration): ${cal.slots.slotHeight} → screen ${Math.round(cal.slots.slotHeight * t.sizeScaleY)}`);
  console.log();

  let passed = 0;
  for (const slotInfo of SLOT_CARDS) {
    const out = scoreSlot(slotInfo, ssGray, ssW, ssH, ssSize, cal.slots);
    console.log(`── slot ${slotInfo.slot}: ${slotInfo.name} (${slotInfo.cls}${slotInfo.char ? '/'+slotInfo.char : ''}) ──`);
    if (out.error) {
      console.log(`  ERROR: ${out.error}`);
      continue;
    }
    console.log(`  slotRect: x=${out.slotRect.x} y=${out.slotRect.y} w=${out.slotRect.width} h=${out.slotRect.height}`);
    console.log(`  stripRect: x=${out.stripRect.x} y=${out.stripRect.y} w=${out.stripRect.width.toFixed(4)} h=${out.stripRect.height}`);
    console.log(`  templates tested: ${out.results.length}`);
    for (const r of out.results.slice(0, 5)) {
      const ok = r.ncc >= NCC_THRESHOLD ? '✓' : '✗';
      console.log(`    ${ok} ncc=${r.ncc.toFixed(4)}  best dx=${r.dx} dy=${r.dy}  ${r.tmpl}  (${r.tmplSize})`);
    }
    if (out.results[0].ncc >= NCC_THRESHOLD) passed++;
    console.log();
  }
  console.log(`${passed}/${SLOT_CARDS.length} slots passed (threshold=${NCC_THRESHOLD})`);
}

main();
