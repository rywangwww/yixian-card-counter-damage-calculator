#!/usr/bin/env node
'use strict';

// Stage 2 of the bottom-10% level-disambiguation test plan.
//
// Quantifies how distinguishable the bottom 10% of the name strip is across
// levels of the same card family, and how generic the same-level signal is
// across different families.
//
// For every multi-level family in images/{sect,personal,side-jobs}:
//   - Build a canonical (CANON_W × CANON_H) grayscale strip per level
//   - Slice the bottom 10% (CANON_W × bottom rows)
//   - Compute pairwise ZNCC across that family's levels
// Also samples cross-family same-level pairs as a baseline.
//
// Pass thresholds (set by the plan):
//   - same family, different levels: ZNCC ≤ ~0.85
//   - cross-family,  same level:     ZNCC < ~0.7
//   - margin between best-match level and second-best: ≥ 0.05
//
// Run: node debug/name_strip_detection_check/test_bottom10_ncc.js

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));

const STRIP_RECT = {
  sect:     { x: 0.0988, y: 0, width: 0.1412, height: 0.6 },
  personal: { x: 0.109,  y: 0, width: 0.1398, height: 0.6 },
};
const SCAN = [
  { dir: 'sect',      classKey: 'sect',     label: 'sect'      },
  { dir: 'personal',  classKey: 'personal', label: 'personal'  },
  { dir: 'side-jobs', classKey: 'sect',     label: 'side-jobs' },
];

// Fixed canonical strip dims for stage-2 comparison. Width tuned to match the
// production code's typical canonW (≈ 45 for AR ~0.235), padded to 60 for
// headroom.
const CANON_W = 60;
const CANON_H = 192;
// Compare bottom 10/20/30% slices to see which region size best discriminates
// levels.
const BOTTOM_FRACTIONS = [0.10, 0.20, 0.30];

// How many cross-family same-level pairs to sample for the baseline. Full
// pairwise would be O(N^2) over hundreds of templates; 5000 random pairs is
// plenty to characterize the distribution.
const CROSS_FAMILY_SAMPLES = 5000;

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

function parseLevel(filePath) {
  const fileName = path.basename(filePath, '.png');
  const match = fileName.match(/^(.*?)(\d+)$/u);
  if (!match) return null;
  return { baseName: match[1], level: Number.parseInt(match[2], 10) };
}

function rgbaToGray(rgba, w, h) {
  // decodePng returns RGBA, so channel order is R,G,B,A.
  const gray = new Float32Array(w * h);
  for (let i = 0, px = 0; px < w * h; i += 4, px += 1) {
    gray[px] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return gray;
}

// Bilinear resize, matching name_strip_detector.js:resizeGray.
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

// ZNCC, copied from name_strip_detector.js:139.
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

// Given a decoded PNG and a class key, build the canonical name strip and
// return one bottom-X% slice per fraction. All slices come from the same
// resized canonical strip so they are directly comparable across fractions.
function buildBottomSlices(decoded, classKey) {
  const { width, height, data } = decoded;
  const rect = STRIP_RECT[classKey];
  const cx = clamp(Math.round(rect.x * width),  0, width  - 1);
  const cy = clamp(Math.round(rect.y * height), 0, height - 1);
  const cw = Math.max(1, Math.min(width  - cx, Math.round(rect.width  * width)));
  const ch = Math.max(1, Math.min(height - cy, Math.round(rect.height * height)));

  const fullGray = rgbaToGray(data, width, height);
  const stripCrop = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      stripCrop[y * cw + x] = fullGray[(cy + y) * width + (cx + x)];
    }
  }
  const canon = resizeGray(stripCrop, cw, ch, CANON_W, CANON_H);

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

// ── Build per-family slice index ────────────────────────────────────────────
// Per family, byLevel maps level → { [frac]: { gray, n } } (one entry per
// configured BOTTOM_FRACTIONS value).

const families = [];

for (const scan of SCAN) {
  const baseDir = path.join(ROOT, 'images', scan.dir);
  if (!fs.existsSync(baseDir)) continue;

  const grouped = new Map(); // familyKey -> Map<level, filePath>
  for (const filePath of walkDir(baseDir)) {
    const parsed = parseLevel(filePath);
    if (!parsed) continue;

    let familyKey = parsed.baseName;
    if (scan.dir === 'sect' || scan.dir === 'side-jobs' || scan.dir === 'personal') {
      const re = new RegExp(`[\\\\/]${scan.dir}[\\\\/]([^\\\\/]+)[\\\\/]`);
      const m = filePath.match(re);
      if (m) familyKey = `${m[1]}__${parsed.baseName}`;
    }

    if (!grouped.has(familyKey)) grouped.set(familyKey, new Map());
    const byLevel = grouped.get(familyKey);
    if (!byLevel.has(parsed.level)) byLevel.set(parsed.level, filePath);
  }

  for (const [familyKey, byLevel] of grouped) {
    if (byLevel.size < 2) continue;
    const sliceByLevel = new Map();
    for (const [level, filePath] of byLevel) {
      const decoded = decodePng(filePath);
      sliceByLevel.set(level, buildBottomSlices(decoded, scan.classKey));
    }
    families.push({ classLabel: scan.label, familyKey, byLevel: sliceByLevel });
  }
}

console.log(`Built bottom slices for ${families.length} multi-level families `
          + `at fractions ${BOTTOM_FRACTIONS.map(f => (f*100).toFixed(0)+'%').join(', ')}.`);

// ── Helpers ─────────────────────────────────────────────────────────────────

function quantile(arr, q) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = clamp(Math.floor(q * sorted.length), 0, sorted.length - 1);
  return sorted[idx];
}

const PASS_WITHIN = 0.85; // same family, different levels: NCC ≤ 0.85 wanted
const PASS_MARGIN = 0.05; // 1 - maxCrossLevelNcc ≥ 0.05 wanted

const rng = (seed => () => (seed = (seed * 9301 + 49297) % 233280) / 233280)(123456);
function pickRandom(arr) { return arr[Math.floor(rng() * arr.length)]; }

// ── Run analysis once per fraction ──────────────────────────────────────────

const outDir = path.join(__dirname, 'bottom10_results');
fs.mkdirSync(outDir, { recursive: true });

const summaryPerFraction = {};

for (const frac of BOTTOM_FRACTIONS) {
  const pct = Math.round(frac * 100);
  const bottomH = Math.max(1, Math.round(CANON_H * frac));
  const N = CANON_W * bottomH;

  // Within-family pairwise NCC.
  const withinFamilyRows = [];
  let withinSum = 0, withinCount = 0;
  let withinMin = +Infinity, withinMax = -Infinity;
  const familyMarginRows = [];

  for (const fam of families) {
    const levels = [...fam.byLevel.keys()].sort((a, b) => a - b);
    for (let i = 0; i < levels.length; i += 1) {
      for (let j = i + 1; j < levels.length; j += 1) {
        const a = fam.byLevel.get(levels[i])[frac].gray;
        const b = fam.byLevel.get(levels[j])[frac].gray;
        const score = zncc(a, b, N);
        withinFamilyRows.push({
          classLabel: fam.classLabel, familyKey: fam.familyKey,
          levelA: levels[i], levelB: levels[j], ncc: score,
        });
        withinSum += score; withinCount += 1;
        if (score < withinMin) withinMin = score;
        if (score > withinMax) withinMax = score;
      }
    }
    for (let i = 0; i < levels.length; i += 1) {
      let maxCross = -Infinity;
      for (let j = 0; j < levels.length; j += 1) {
        if (i === j) continue;
        const a = fam.byLevel.get(levels[i])[frac].gray;
        const b = fam.byLevel.get(levels[j])[frac].gray;
        maxCross = Math.max(maxCross, zncc(a, b, N));
      }
      familyMarginRows.push({
        classLabel: fam.classLabel, familyKey: fam.familyKey,
        level: levels[i], maxCrossLevelNcc: maxCross, margin: 1.0 - maxCross,
      });
    }
  }

  // Cross-family same-level NCC.
  const crossFamilyRows = [];
  let crossSum = 0, crossCount = 0;
  let crossMin = +Infinity, crossMax = -Infinity;
  const byClassLevel = new Map();
  for (const fam of families) {
    for (const [level, slicesByFrac] of fam.byLevel) {
      const key = `${fam.classLabel}__L${level}`;
      if (!byClassLevel.has(key)) byClassLevel.set(key, []);
      byClassLevel.get(key).push({
        familyKey: fam.familyKey, classLabel: fam.classLabel,
        level, slice: slicesByFrac[frac].gray,
      });
    }
  }
  for (const [, group] of byClassLevel) {
    if (group.length < 2) continue;
    const samplesForGroup = Math.max(1, Math.round(CROSS_FAMILY_SAMPLES * (group.length / families.length)));
    for (let s = 0; s < samplesForGroup; s += 1) {
      const a = pickRandom(group);
      let b = pickRandom(group);
      let attempts = 0;
      while (b.familyKey === a.familyKey && attempts < 8) { b = pickRandom(group); attempts += 1; }
      if (b.familyKey === a.familyKey) continue;
      const score = zncc(a.slice, b.slice, N);
      crossFamilyRows.push({
        classLabel: a.classLabel, level: a.level,
        familyA: a.familyKey, familyB: b.familyKey, ncc: score,
      });
      crossSum += score; crossCount += 1;
      if (score < crossMin) crossMin = score;
      if (score > crossMax) crossMax = score;
    }
  }

  const withinValues = withinFamilyRows.map(r => r.ncc);
  const crossValues  = crossFamilyRows.map(r => r.ncc);

  const withinPassFraction =
    withinValues.filter(v => v <= PASS_WITHIN).length / Math.max(1, withinValues.length);
  const marginPassFraction =
    familyMarginRows.filter(r => r.margin >= PASS_MARGIN).length / Math.max(1, familyMarginRows.length);

  const summary = {
    fraction:    frac,
    canonical:   { width: CANON_W, height: CANON_H, bottomRows: bottomH },
    families:    families.length,
    withinFamilyPairs: withinValues.length,
    crossFamilyPairs:  crossValues.length,
    withinFamilyStats: {
      mean: withinCount ? withinSum / withinCount : null,
      min:  withinValues.length ? withinMin : null,
      max:  withinValues.length ? withinMax : null,
      p10:  quantile(withinValues, 0.10),
      p50:  quantile(withinValues, 0.50),
      p90:  quantile(withinValues, 0.90),
    },
    crossFamilyStats: {
      mean: crossCount ? crossSum / crossCount : null,
      min:  crossValues.length ? crossMin : null,
      max:  crossValues.length ? crossMax : null,
      p10:  quantile(crossValues, 0.10),
      p50:  quantile(crossValues, 0.50),
      p90:  quantile(crossValues, 0.90),
    },
    passFractions: {
      withinFamilyPairsBelow_0_85: withinPassFraction,
      familyLevelsWithMargin_0_05: marginPassFraction,
    },
  };
  summaryPerFraction[`bottom${pct}`] = summary;

  fs.writeFileSync(path.join(outDir, `within_family_${pct}.json`), JSON.stringify(withinFamilyRows, null, 2));
  fs.writeFileSync(path.join(outDir, `cross_family_${pct}.json`),  JSON.stringify(crossFamilyRows,  null, 2));
  fs.writeFileSync(path.join(outDir, `family_margins_${pct}.json`), JSON.stringify(familyMarginRows, null, 2));

  console.log(`\n=== bottom ${pct}% ===`);
  console.log(`Within-family pairs: count=${withinValues.length} `
            + `mean=${summary.withinFamilyStats.mean?.toFixed(3)} `
            + `min=${summary.withinFamilyStats.min?.toFixed(3)} max=${summary.withinFamilyStats.max?.toFixed(3)} `
            + `p50=${summary.withinFamilyStats.p50?.toFixed(3)} p90=${summary.withinFamilyStats.p90?.toFixed(3)}`);
  console.log(`Cross-family pairs:  count=${crossValues.length} `
            + `mean=${summary.crossFamilyStats.mean?.toFixed(3)} `
            + `min=${summary.crossFamilyStats.min?.toFixed(3)} max=${summary.crossFamilyStats.max?.toFixed(3)} `
            + `p50=${summary.crossFamilyStats.p50?.toFixed(3)} p90=${summary.crossFamilyStats.p90?.toFixed(3)}`);
  console.log(`Within-family pairs at NCC ≤ ${PASS_WITHIN}: ${(withinPassFraction*100).toFixed(1)}%`);
  console.log(`Levels with margin  ≥ ${PASS_MARGIN}:       ${(marginPassFraction*100).toFixed(1)}%`);
}

fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summaryPerFraction, null, 2));

// Compact comparison table.
console.log('\n=== Side-by-side comparison ===');
console.log('               within mean   within p50   within p90   cross mean   cross p50   margin≥0.05');
for (const frac of BOTTOM_FRACTIONS) {
  const pct = Math.round(frac * 100);
  const s = summaryPerFraction[`bottom${pct}`];
  console.log(
    `bottom ${String(pct).padStart(2)}%      ` +
    `${s.withinFamilyStats.mean.toFixed(3).padStart(7)}      ` +
    `${s.withinFamilyStats.p50.toFixed(3).padStart(6)}       ` +
    `${s.withinFamilyStats.p90.toFixed(3).padStart(6)}       ` +
    `${s.crossFamilyStats.mean.toFixed(3).padStart(6)}      ` +
    `${s.crossFamilyStats.p50.toFixed(3).padStart(6)}      ` +
    `${(s.passFractions.familyLevelsWithMargin_0_05*100).toFixed(1).padStart(5)}%`
  );
}

console.log(`\nWritten per-fraction JSONs and ${path.join(outDir, 'summary.json')}`);
