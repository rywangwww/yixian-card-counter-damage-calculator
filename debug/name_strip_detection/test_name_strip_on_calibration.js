#!/usr/bin/env node
'use strict';

// test_name_strip_on_calibration.js
//
// DEPRECATED — hardcodes CALIBRATION_TOP_CORRECTION=0.079 which was removed
// from name_strip_detector.js. Re-run via Electron with the live detector
// instead (see debug/name_strip_detection_check/test_phase_resolution.js).
// Kept for git-history reference only.
//
// Standalone test (no Electron) that verifies name_strip_detector.js logic
// against debug/calibration/calibration_capture.png using the known card list.
//
// Run from repo root:
//   node debug/name_strip_detection/test_name_strip_on_calibration.js

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));

const CALIBRATION_PATH = path.join(
  process.env.HOME, 'Library', 'Application Support', 'yixian-overlay', 'calibration.json'
);
const SS_PATH = path.join(__dirname, '..', 'calibration', 'calibration_capture.png');
const IMAGES_DIR = path.join(ROOT, 'images');

// ── Must match name_strip_detector.js ─────────────────────────────────────────
const STRIP_RECT = {
  sect:     { x: 0.0988, y: 0, width: 0.1412, height: 0.6 },
  dream:    { x: 0.0608, y: 0, width: 0.1392, height: 0.6 },
  personal: { x: 0.109,  y: 0, width: 0.1398, height: 0.6 },
};
const STRIP_CANONICAL_H      = 192;
const CALIBRATION_TOP_CORRECTION = 0.079;
const Y_SEARCH_RANGE         = 4;
const X_SEARCH_RANGE         = 2;
const NCC_THRESHOLD          = 0.70;

const DEFAULT_DREAM_RATIO  = { width: 0.925, height: 0.977 };
const DEFAULT_DREAM_XOFF   = 8;

// Known cards in calibration_capture.png (all sect / side-job)
const SLOT_CARDS = [
  '云剑•闪风1', '云剑•飞刺3', '运笔如飞1', '云剑•汇灵2',
  '破气剑1',   '巨鹏灵剑2', '水月剑阵2', '镜花剑阵2',
];

// ── Image helpers (mirror name_strip_detector.js / calibrator.js) ─────────────
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function bilinearSample(src, sw, sh, x, y) {
  const x0 = clamp(Math.floor(x), 0, sw - 1);
  const y0 = clamp(Math.floor(y), 0, sh - 1);
  const x1 = Math.min(x0 + 1, sw - 1);
  const y1 = Math.min(y0 + 1, sh - 1);
  const wx = x - x0, wy = y - y0;
  return (1-wx)*(1-wy)*src[y0*sw+x0] + wx*(1-wy)*src[y0*sw+x1]
       + (1-wx)*wy   *src[y1*sw+x0] + wx*wy    *src[y1*sw+x1];
}

function resizeGray(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++)
      out[y*dw+x] = bilinearSample(src, sw, sh, (x+0.5)*sw/dw - 0.5, (y+0.5)*sh/dh - 0.5);
  return out;
}

function rgbaToGray(rgba, w, h) {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++)
    gray[i] = 0.299*rgba[i*4] + 0.587*rgba[i*4+1] + 0.114*rgba[i*4+2];
  return gray;
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
  const denom = Math.sqrt(dA * dB);
  return denom < 1 ? 0 : num / denom;
}

// ── Template canonical strip extraction (mirrors extractCanonicalStrip) ────────
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
  // Use ACTUAL pixel AR (cw/ch) — not rect.width/rect.height — to avoid
  // aspect-ratio distortion for non-square cards.
  const canonW = Math.max(24, Math.round((cw / ch) * canonH));
  return { gray: resizeGray(crop, cw, ch, canonW, canonH), w: canonW, h: canonH };
}

// ── Screenshot strip extraction (mirrors extractScreenStripCrop) ───────────────
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
  return { gray: crop, w: aw, h: ah };
}

// ── Slot geometry (mirrors name_strip_detector.js) ────────────────────────────
function getScaledSlotRect(slotIndex, ssW, ssH, cal) {
  const n = cal.slots;
  const scaleX = ssW / n.baseScreenWidth;
  const scaleY = ssH / n.baseScreenHeight;
  return {
    x:      Math.round(n.slotXPositions[slotIndex] * scaleX),
    y:      Math.round(n.slotY  * scaleY),
    width:  Math.max(1, Math.round(n.slotWidth  * scaleX)),
    height: Math.max(1, Math.round(n.slotHeight * scaleY)),
  };
}

// ── Template file finder ───────────────────────────────────────────────────────
function walkDir(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walkDir(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) out.push(full);
  }
  return out;
}

function normalizeCardName(name) {
  return (name || '').replace(/[·•]/g, '•').trim();
}

// Directories that contain game card templates (not sigils or artwork).
const CARD_DIRS = ['sect', 'side-jobs', 'seasonal', 'personal'];

function findTemplatesForCard(cardName, imagesDir) {
  const norm = normalizeCardName(cardName);
  const base = norm.replace(/\d+$/, '');  // strip trailing level digit
  // Search card template directories; exclude raw artwork (no trailing digit).
  const searchDirs = CARD_DIRS.map((d) => path.join(imagesDir, d)).filter(fs.existsSync);
  const files = searchDirs.flatMap(walkDir);
  return files.filter((f) => {
    const fileName = path.basename(f, '.png');
    const m = fileName.match(/^(.*?)(\d+)$/u);
    if (!m) return false;
    const bn = normalizeCardName(m[1]);
    return bn === norm || bn === base;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(CALIBRATION_PATH)) {
    console.error('calibration.json not found at', CALIBRATION_PATH);
    process.exit(1);
  }
  if (!fs.existsSync(SS_PATH)) {
    console.error('calibration_capture.png not found at', SS_PATH);
    process.exit(1);
  }

  const cal = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));
  const ss  = decodePng(SS_PATH);
  const { data: ssRgba, width: ssW, height: ssH } = ss;
  const ssGray = rgbaToGray(ssRgba, ssW, ssH);

  console.log(`Screenshot: ${ssW}x${ssH}`);
  console.log(`Calibration base: ${cal.slots.baseScreenWidth}x${cal.slots.baseScreenHeight}\n`);

  let passed = 0;
  for (let slot = 0; slot < SLOT_CARDS.length; slot++) {
    const cardName = SLOT_CARDS[slot];
    const slotRect = getScaledSlotRect(slot, ssW, ssH, cal);

    // All calibration cards are sect/side-job (no dream, no personal)
    const stripRect = STRIP_RECT.sect;

    // Find all template files for this card
    const tmplFiles = findTemplatesForCard(cardName, IMAGES_DIR);
    if (tmplFiles.length === 0) {
      console.log(`slot${slot+1}: ${cardName} — template NOT FOUND`);
      continue;
    }

    // Score each template against this slot (with y-search)
    let bestNcc = -Infinity, bestFile = null;
    for (const tmplFile of tmplFiles) {
      const canon = extractCanonicalStripFromPng(tmplFile, stripRect);
      for (let dy = -Y_SEARCH_RANGE; dy <= Y_SEARCH_RANGE; dy++) {
        for (let dx = -X_SEARCH_RANGE; dx <= X_SEARCH_RANGE; dx++) {
          const searchRect = (dy === 0 && dx === 0)
            ? slotRect
            : { ...slotRect, x: slotRect.x + dx, y: slotRect.y + dy };
          const crop = extractScreenStripCrop(ssGray, ssW, ssH, searchRect, stripRect);
          if (!crop) continue;
          const screenResized = resizeGray(crop.gray, crop.w, crop.h, canon.w, canon.h);
          const score = zncc(screenResized, canon.gray, canon.w * canon.h);
          if (score > bestNcc) { bestNcc = score; bestFile = path.basename(tmplFile); }
        }
      }
    }

    const ok = bestNcc >= NCC_THRESHOLD;
    if (ok) passed++;
    const mark = ok ? '✓' : '✗';
    console.log(`slot${slot+1}: ${mark} NCC=${bestNcc.toFixed(4)} (${ok ? 'PASS' : 'FAIL'}) — ${cardName}  [best: ${bestFile}]`);
  }

  console.log(`\n${passed}/${SLOT_CARDS.length} slots passed (threshold=${NCC_THRESHOLD})`);
}

main();
