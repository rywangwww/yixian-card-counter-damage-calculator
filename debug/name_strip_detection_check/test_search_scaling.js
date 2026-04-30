'use strict';

// Unit-style test: confirm name_strip_detector's search-range scaling
// computes the right (xSearchRange, ySearchRange) at multiple capture sizes
// against a fixed calibration base. End-to-end coverage at non-1x scales
// requires a screenshot captured under a matching calibration session;
// check1.png covers the 1.66x case end-to-end already.
//
// Run from project root:
//   npx --no-install electron debug/name_strip_detection_check/test_search_scaling.js

const { app, nativeImage } = require('electron');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { detectSlotsNameStrip, setCalibration } = require(path.join(ROOT, 'name_strip_detector'));

const CAL_PATH   = path.join(process.env.HOME, 'Library', 'Application Support', 'yixian-overlay', 'calibration.json');
const IMAGES_DIR = path.join(ROOT, 'images');

// Reproduce the formula from name_strip_detector.js so the expected values
// here are independent of that file (catches accidental regressions).
const X_BASE = 2;
const Y_BASE = 4;
function expectedRange(base, scale) {
  return Math.max(base, Math.ceil(base * scale));
}

const cases = [
  { label: '1x (calibration native)',     w: 1728, h: 1080 },
  { label: '1.111x wide-only',             w: 1920, h: 1080 },
  { label: '1.667x retina (check1.png)',   w: 2880, h: 1794 },
  { label: '2x clean',                     w: 3456, h: 2160 },
  { label: '0.5x downscale (floor)',       w: 864,  h: 540  },
];

app.whenReady().then(() => {
  const cal = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
  setCalibration(cal);
  console.log(`Calibration base: ${cal.slots.baseScreenWidth}x${cal.slots.baseScreenHeight}`);
  console.log();

  let pass = 0;
  for (const c of cases) {
    // Build a synthetic blank nativeImage at the target size.
    const img = nativeImage.createEmpty().resize({ width: c.w, height: c.h, quality: 'best' });
    // createEmpty/resize gives a 0x0 image; build an actual buffer instead.
    const rgba = Buffer.alloc(c.w * c.h * 4, 0);
    const fake = nativeImage.createFromBuffer(rgba, { width: c.w, height: c.h });
    if (fake.isEmpty() || fake.getSize().width !== c.w) {
      console.log(`  ${c.label}: SKIP (could not synthesize ${c.w}x${c.h} buffer)`);
      continue;
    }
    const res = detectSlotsNameStrip(fake, ['梦•混元碎击'], IMAGES_DIR);
    if (!res.debug?.searchRange) {
      console.log(`  ${c.label}: ERROR (no searchRange in debug; reason=${res.debug?.reason})`);
      continue;
    }
    const sx = c.w / cal.slots.baseScreenWidth;
    const sy = c.h / cal.slots.baseScreenHeight;
    const expX = expectedRange(X_BASE, sx);
    const expY = expectedRange(Y_BASE, sy);
    const got = res.debug.searchRange;
    const ok = got.x === expX && got.y === expY;
    if (ok) pass++;
    console.log(
      `  ${c.label.padEnd(36)} ${c.w}x${c.h}  scale=(${sx.toFixed(3)}, ${sy.toFixed(3)})  ` +
      `searchRange=(${got.x},${got.y}) expected=(${expX},${expY}) ${ok ? '✓' : '✗'}`
    );
  }
  console.log(`\n${pass}/${cases.length} cases passed`);
  process.exit(pass === cases.length ? 0 : 1);
});
