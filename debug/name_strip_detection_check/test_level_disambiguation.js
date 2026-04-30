'use strict';

// Stage 3 of the bottom-10% level-disambiguation test plan.
//
// For each existing check screenshot:
//   1. Run detectSlotsNameStrip to identify family per slot (current detector).
//   2. For each accepted, non-dream slot, crop its bottom-10% strip from the
//      screenshot and NCC it against the bottom-10% of every same-family
//      level template. Pick the highest-NCC level as the bottom-10 prediction.
//   3. Print per-slot: { family, currentDetectorLevel, bottom10ChosenLevel,
//      scoresByLevel } and (if level_ground_truth.json exists) accuracy
//      against ground truth.
//
// Run from project root:
//   npx --no-install electron debug/name_strip_detection_check/test_level_disambiguation.js
//
// Optional ground truth: place
//   debug/name_strip_detection_check/level_ground_truth.json
// with shape:
//   { "check1.png": { "0": 1, "1": 2, ... }, "check2.png": { ... } }
// (slotIndex → expected level). Slots not listed are skipped for accuracy.

const { app, nativeImage } = require('electron');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { detectSlotsNameStrip, setCalibration } = require(path.join(ROOT, 'name_strip_detector'));
const { getNativeImagePixelSize } = require(path.join(ROOT, 'native_image_pixels'));

const STRIP_RECT = {
  sect:     { x: 0.0988, y: 0, width: 0.1412, height: 0.6 },
  personal: { x: 0.109,  y: 0, width: 0.1398, height: 0.6 },
};
const CANON_W = 60;
const CANON_H = 192;
// Compare bottom 10/20/30% slices side by side to see which region size best
// disambiguates levels in real captures.
const BOTTOM_FRACTIONS = [0.10, 0.20, 0.30];

const CAL_PATH = path.join(process.env.HOME, 'Library', 'Application Support', 'yixian-overlay', 'calibration.json');
const IMAGES_DIR = path.join(ROOT, 'images');

const CHECKS = [
  {
    file: path.join(__dirname, 'check1.png'),
    hand: ['梦•混元碎击', '木灵•桃花印', '木灵•芽', '金灵•针'],
  },
  {
    file: path.join(__dirname, 'check2.png'),
    hand: ['梦•混元碎击', '木灵•桃花印', '木灵•芽', '金灵•针'],
  },
];

const GROUND_TRUTH_PATH = path.join(__dirname, 'level_ground_truth.json');

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function bilinearSample(gray, w, h, x, y) {
  const x0 = clamp(Math.floor(x), 0, w - 1);
  const y0 = clamp(Math.floor(y), 0, h - 1);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const wx = x - x0, wy = y - y0;
  return (
    (1 - wx) * (1 - wy) * gray[y0 * w + x0] +
    wx       * (1 - wy) * gray[y0 * w + x1] +
    (1 - wx) * wy       * gray[y1 * w + x0] +
    wx       * wy       * gray[y1 * w + x1]
  );
}
function resizeGray(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      out[y * dw + x] = bilinearSample(src, sw, sh, (x + 0.5) * sw / dw - 0.5, (y + 0.5) * sh / dh - 0.5);
    }
  }
  return out;
}
function zncc(a, b, n) {
  let sA = 0, sB = 0;
  for (let i = 0; i < n; i += 1) { sA += a[i]; sB += b[i]; }
  const mA = sA / n, mB = sB / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - mA, db = b[i] - mB;
    num += da * db; dA += da * da; dB += db * db;
  }
  const denom = Math.sqrt(dA * dB);
  return denom < 1 ? 0 : num / denom;
}

// nativeImage → grayscale Float32Array (BGRA).
function nativeImageToGray(image) {
  const bitmap = image.toBitmap();
  const { width, height } = getNativeImagePixelSize(image);
  const gray = new Float32Array(width * height);
  for (let i = 0, px = 0; i < bitmap.length; i += 4, px += 1) {
    gray[px] = 0.114 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.299 * bitmap[i + 2];
  }
  return { gray, width, height };
}

// Slice a precomputed CANON_W × CANON_H grayscale strip into one bottom-X%
// slice per configured fraction.
function bottomSlicesFromCanon(canon) {
  const slices = {};
  for (const frac of BOTTOM_FRACTIONS) {
    const bottomH = Math.max(1, Math.round(CANON_H * frac));
    const startRow = CANON_H - bottomH;
    const bottom = new Float32Array(CANON_W * bottomH);
    for (let y = 0; y < bottomH; y += 1) {
      for (let x = 0; x < CANON_W; x += 1) {
        bottom[y * CANON_W + x] = canon[(startRow + y) * CANON_W + x];
      }
    }
    slices[frac] = { gray: bottom, n: CANON_W * bottomH };
  }
  return slices;
}

// Build canonical strip (CANON_W × CANON_H) cropped from a larger gray image
// at slot rect + class strip rect, then return one bottom-X% slice per fraction.
function buildBottomSlicesFromGray(srcGray, srcW, srcH, slotRect, classKey) {
  const rect = STRIP_RECT[classKey];
  const sx = Math.round(slotRect.x + rect.x * slotRect.width);
  const sy = Math.round(slotRect.y + rect.y * slotRect.height);
  const sw = Math.max(1, Math.round(rect.width  * slotRect.width));
  const sh = Math.max(1, Math.round(rect.height * slotRect.height));
  const x0 = Math.max(0, sx),         y0 = Math.max(0, sy);
  const x1 = Math.min(srcW, sx + sw), y1 = Math.min(srcH, sy + sh);
  const aw = x1 - x0, ah = y1 - y0;
  if (aw <= 0 || ah <= 0) return null;

  const stripCrop = new Float32Array(aw * ah);
  for (let y = 0; y < ah; y += 1) {
    for (let x = 0; x < aw; x += 1) {
      stripCrop[y * aw + x] = srcGray[(y0 + y) * srcW + (x0 + x)];
    }
  }
  const canon = resizeGray(stripCrop, aw, ah, CANON_W, CANON_H);
  return bottomSlicesFromCanon(canon);
}

// Build canonical bottom-X% slices from a template PNG file (one per fraction).
function buildBottomSlicesFromTemplate(filePath, classKey) {
  const img = nativeImage.createFromPath(filePath);
  const { gray, width, height } = nativeImageToGray(img);
  const rect = STRIP_RECT[classKey];
  const cx = clamp(Math.round(rect.x * width),  0, width  - 1);
  const cy = clamp(Math.round(rect.y * height), 0, height - 1);
  const cw = Math.max(1, Math.min(width  - cx, Math.round(rect.width  * width)));
  const ch = Math.max(1, Math.min(height - cy, Math.round(rect.height * height)));
  const stripCrop = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      stripCrop[y * cw + x] = gray[(cy + y) * width + (cx + x)];
    }
  }
  const canon = resizeGray(stripCrop, cw, ch, CANON_W, CANON_H);
  return bottomSlicesFromCanon(canon);
}

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
function parseLevel(filePath) {
  const fileName = path.basename(filePath, '.png');
  const match = fileName.match(/^(.*?)(\d+)$/u);
  if (!match) return null;
  return { baseName: match[1], level: Number.parseInt(match[2], 10) };
}

// Find all level-suffixed templates that share the same baseName + class.
// For personal: must also share the same character folder. For sect/side-jobs:
// must also share the same sect/job folder.
function findFamilyLevelTemplates(card) {
  const isPersonal = !!card.isPersonal;
  const baseName   = card.name;
  const classKey   = isPersonal ? 'personal' : 'sect';
  const tier1Dirs  = isPersonal
    ? [path.join(IMAGES_DIR, 'personal')]
    : [path.join(IMAGES_DIR, 'sect'), path.join(IMAGES_DIR, 'side-jobs')];

  const out = []; // { level, filePath }
  for (const root of tier1Dirs) {
    for (const filePath of walkDir(root)) {
      const parsed = parseLevel(filePath);
      if (!parsed || parsed.baseName !== baseName) continue;
      out.push({ level: parsed.level, filePath, classKey });
    }
  }
  // Dedup by level — keep first encountered.
  const byLevel = new Map();
  for (const t of out) if (!byLevel.has(t.level)) byLevel.set(t.level, t);
  return [...byLevel.values()].sort((a, b) => a.level - b.level);
}

let groundTruth = null;
if (fs.existsSync(GROUND_TRUTH_PATH)) {
  try { groundTruth = JSON.parse(fs.readFileSync(GROUND_TRUTH_PATH, 'utf8')); }
  catch (e) { console.warn('Failed to parse ground truth:', e.message); }
}

app.whenReady().then(() => {
  try {
    const cal = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
    setCalibration(cal);
  } catch (err) {
    console.error('Failed to load calibration at', CAL_PATH, '\n', err);
    process.exit(1);
  }

  const allRows = [];
  let totalEvaluated = 0;
  let detectorCorrect = 0;
  const bottomCorrectByFrac = Object.fromEntries(BOTTOM_FRACTIONS.map(f => [f, 0]));
  const bottomMatchesDetectorByFrac = Object.fromEntries(BOTTOM_FRACTIONS.map(f => [f, 0]));

  for (const check of CHECKS) {
    if (!fs.existsSync(check.file)) {
      console.log(`[skip] ${check.file} not present`);
      continue;
    }
    const ssName = path.basename(check.file);
    console.log(`\n=== ${ssName} ===`);

    const ssImg = nativeImage.createFromPath(check.file);
    const ssGrayPack = nativeImageToGray(ssImg);

    const res = detectSlotsNameStrip(ssImg, check.hand, IMAGES_DIR);

    for (let i = 0; i < res.slotResults.length; i += 1) {
      const r = res.slotResults[i];
      const c = r.card;
      if (!c) {
        console.log(`  slot ${i}: empty (accepted=${r.accepted})`);
        continue;
      }
      if (c.isDream) {
        console.log(`  slot ${i}: dream ${c.name} phase=${c.phase} — skipping (no level)`);
        continue;
      }

      const family = findFamilyLevelTemplates(c);
      if (family.length === 0) {
        console.log(`  slot ${i}: ${c.name} L${c.level} — no level-suffixed templates found, can't disambiguate`);
        continue;
      }
      if (family.length === 1) {
        console.log(`  slot ${i}: ${c.name} L${c.level} — only one level (${family[0].level}) exists, nothing to disambiguate`);
        continue;
      }

      const slotSlices = buildBottomSlicesFromGray(
        ssGrayPack.gray, ssGrayPack.width, ssGrayPack.height, r.rect, family[0].classKey
      );
      if (!slotSlices) {
        console.log(`  slot ${i}: ${c.name} L${c.level} — slot rect out of bounds`);
        continue;
      }

      const tmplSlicesByLevel = new Map();
      for (const t of family) {
        tmplSlicesByLevel.set(t.level, buildBottomSlicesFromTemplate(t.filePath, t.classKey));
      }

      const truthLevel = groundTruth?.[ssName]?.[String(i)];

      // Per-fraction predictions.
      const perFraction = {};
      for (const frac of BOTTOM_FRACTIONS) {
        const slot = slotSlices[frac];
        const scores = family.map(t => ({
          level: t.level,
          ncc:   zncc(slot.gray, tmplSlicesByLevel.get(t.level)[frac].gray, slot.n),
        })).sort((a, b) => b.ncc - a.ncc);
        const chosenLevel = scores[0].level;
        const margin = scores[0].ncc - (scores[1]?.ncc ?? scores[0].ncc);
        perFraction[frac] = { chosenLevel, margin, scores };
        if (chosenLevel === c.level) bottomMatchesDetectorByFrac[frac] += 1;
      }

      let detectorOk = null;
      const bottomOkByFrac = Object.fromEntries(BOTTOM_FRACTIONS.map(f => [f, null]));
      if (typeof truthLevel === 'number') {
        totalEvaluated += 1;
        detectorOk = c.level === truthLevel;
        if (detectorOk) detectorCorrect += 1;
        for (const frac of BOTTOM_FRACTIONS) {
          const ok = perFraction[frac].chosenLevel === truthLevel;
          bottomOkByFrac[frac] = ok;
          if (ok) bottomCorrectByFrac[frac] += 1;
        }
      }

      const truthTag = typeof truthLevel === 'number' ? ` truth=L${truthLevel}` : '';
      console.log(
        `  slot ${i}: ${c.name} class=${family[0].classKey} detectorL=${c.level}` +
        `${typeof truthLevel === 'number' ? ` (detector=${detectorOk ? 'OK' : 'WRONG'})` : ''}${truthTag}`
      );
      for (const frac of BOTTOM_FRACTIONS) {
        const pf = perFraction[frac];
        const pct = Math.round(frac * 100);
        const scoreStr = pf.scores.map(s => `L${s.level}=${s.ncc.toFixed(3)}`).join(' ');
        const okTag = typeof truthLevel === 'number'
          ? ` (${bottomOkByFrac[frac] ? 'OK' : 'WRONG'})` : '';
        console.log(
          `    bottom${pct}%: chosen=L${pf.chosenLevel} margin=${pf.margin.toFixed(3)} [${scoreStr}]${okTag}`
        );
      }

      allRows.push({
        screenshot: ssName,
        slotIndex: i,
        family: c.name,
        classKey: family[0].classKey,
        currentDetectorLevel: c.level,
        groundTruthLevel: typeof truthLevel === 'number' ? truthLevel : null,
        detectorOk,
        perFraction: Object.fromEntries(BOTTOM_FRACTIONS.map(f => [
          `bottom${Math.round(f*100)}`,
          {
            chosenLevel: perFraction[f].chosenLevel,
            margin:      perFraction[f].margin,
            scoresByLevel: perFraction[f].scores,
            ok:          bottomOkByFrac[f],
          },
        ])),
      });
    }
  }

  const outDir = path.join(__dirname, 'bottom10_results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'level_disambiguation.json'), JSON.stringify(allRows, null, 2));

  console.log('\n=== Summary ===');
  console.log(`Slots evaluated: ${allRows.length}`);
  for (const frac of BOTTOM_FRACTIONS) {
    const pct = Math.round(frac * 100);
    console.log(`  bottom${pct}% picked SAME level as detector: ${bottomMatchesDetectorByFrac[frac]} / ${allRows.length}`);
  }
  if (groundTruth && totalEvaluated > 0) {
    console.log(`\nAgainst ground truth (${totalEvaluated} labelled slots):`);
    console.log(`  Current detector correct: ${detectorCorrect} / ${totalEvaluated}`);
    for (const frac of BOTTOM_FRACTIONS) {
      const pct = Math.round(frac * 100);
      console.log(`  bottom${pct}% correct:        ${bottomCorrectByFrac[frac]} / ${totalEvaluated}`);
    }
  } else {
    console.log(`\nNo ground truth at ${GROUND_TRUTH_PATH} — accuracy not scored.`);
    console.log(`Add a JSON like { "check1.png": { "0": 1, "1": 2 } } to score.`);
  }
  console.log(`\nWrote ${path.join(outDir, 'level_disambiguation.json')}`);

  process.exit(0);
});
