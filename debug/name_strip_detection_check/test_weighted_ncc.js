#!/usr/bin/env node
'use strict';

// Stage-2 follow-up: at the chosen bottom-20% slice, compare three matching
// methods that try to amplify the within-family level signal:
//
//   A) plain         — ZNCC over the whole 20% slice (the existing baseline).
//   B) weighted      — ZNCC weighted by per-pixel std across all levels in
//                      the family. Pixels that don't vary across levels get
//                      near-zero weight; pixels in the discriminating band
//                      get high weight.
//   C) min-sub-band  — split the 20% slice into K horizontal sub-bands; take
//                      ZNCC of each band separately; report the MIN. A
//                      narrow discriminating band drives the score down even
//                      if surrounding rows agree.
//
// For 金灵•針 specifically, the diagnostic earlier showed L1↔L2 differs only
// in a ~10-row band at canonical y ≈ 158-168. Whole-slice NCC averages that
// disagreement with surrounding agreement (0.61). Weighted and sub-band-min
// should both surface the actual disagreement.
//
// Run: node debug/name_strip_detection_check/test_weighted_ncc.js

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

const CANON_W = 60;
const CANON_H = 192;
const FRACTION = 0.20;
const BOTTOM_H = Math.max(1, Math.round(CANON_H * FRACTION)); // 38
const SUB_BANDS = 4; // 4 × 5% sub-bands inside the 20% slice
const SUB_BAND_H = Math.max(1, Math.floor(BOTTOM_H / SUB_BANDS)); // 9 rows each

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
  const g = new Float32Array(w * h);
  for (let i = 0, px = 0; px < w * h; i += 4, px += 1) {
    g[px] = 0.299*rgba[i] + 0.587*rgba[i+1] + 0.114*rgba[i+2];
  }
  return g;
}
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

// Weighted ZNCC — each pixel contributes proportional to weight[i]. Both
// inputs and weights are 1-D arrays of length n. Mean is also weighted.
function weightedZncc(a, b, weight, n) {
  let wSum = 0, sA = 0, sB = 0;
  for (let i = 0; i < n; i++) {
    const w = weight[i];
    wSum += w; sA += w * a[i]; sB += w * b[i];
  }
  if (wSum < 1e-9) return 0;
  const mA = sA/wSum, mB = sB/wSum;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const w = weight[i];
    const da = a[i] - mA, db = b[i] - mB;
    num += w * da * db;
    dA  += w * da * da;
    dB  += w * db * db;
  }
  const denom = Math.sqrt(dA * dB);
  return denom < 1e-9 ? 0 : num / denom;
}

// Min ZNCC across SUB_BANDS horizontal bands of SUB_BAND_H rows each (left-
// over rows are folded into the last band).
function minSubBandZncc(a, b) {
  let minScore = +Infinity;
  for (let band = 0; band < SUB_BANDS; band += 1) {
    const yStart = band * SUB_BAND_H;
    const yEnd   = (band === SUB_BANDS - 1) ? BOTTOM_H : yStart + SUB_BAND_H;
    const h = yEnd - yStart;
    const n = CANON_W * h;
    const sub = (arr) => arr.subarray(yStart * CANON_W, (yStart + h) * CANON_W);
    const score = zncc(sub(a), sub(b), n);
    if (score < minScore) minScore = score;
  }
  return minScore;
}

// Build a fixed-size grayscale slice of the bottom-20% canonical strip.
function buildBottomSlice(decoded, classKey) {
  const { width: W, height: H, data } = decoded;
  const rect = STRIP_RECT[classKey];
  const cx = clamp(Math.round(rect.x * W), 0, W - 1);
  const cy = clamp(Math.round(rect.y * H), 0, H - 1);
  const cw = Math.max(1, Math.min(W - cx, Math.round(rect.width  * W)));
  const ch = Math.max(1, Math.min(H - cy, Math.round(rect.height * H)));
  const fullGray = rgbaToGray(data, W, H);
  const stripCrop = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    stripCrop[y*cw + x] = fullGray[(cy + y)*W + (cx + x)];
  }
  const canon = resizeGray(stripCrop, cw, ch, CANON_W, CANON_H);
  const bottom = new Float32Array(CANON_W * BOTTOM_H);
  for (let y = 0; y < BOTTOM_H; y++) for (let x = 0; x < CANON_W; x++) {
    bottom[y * CANON_W + x] = canon[(CANON_H - BOTTOM_H + y) * CANON_W + x];
  }
  return bottom;
}

// Per-pixel std across all level slices in a family. This is the per-family
// "discrimination map" used as the weight in option B. Resulting weights are
// in raw intensity units (0..255 scale), not normalized. weightedZncc only
// cares about relative weights so that's fine.
function buildVarianceMap(slicesByLevel) {
  const n = CANON_W * BOTTOM_H;
  const levels = [...slicesByLevel.keys()];
  const k = levels.length;
  const map = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let mean = 0;
    for (const lvl of levels) mean += slicesByLevel.get(lvl)[i];
    mean /= k;
    let varSum = 0;
    for (const lvl of levels) {
      const d = slicesByLevel.get(lvl)[i] - mean;
      varSum += d * d;
    }
    map[i] = Math.sqrt(varSum / k);
  }
  return map;
}

// ── Build per-family slice index ───────────────────────────────────────────

const families = [];
for (const scan of SCAN) {
  const baseDir = path.join(ROOT, 'images', scan.dir);
  if (!fs.existsSync(baseDir)) continue;
  const grouped = new Map();
  for (const filePath of walkDir(baseDir)) {
    const parsed = parseLevel(filePath);
    if (!parsed) continue;
    let familyKey = parsed.baseName;
    const re = new RegExp(`[\\\\/]${scan.dir}[\\\\/]([^\\\\/]+)[\\\\/]`);
    const m = filePath.match(re);
    if (m) familyKey = `${m[1]}__${parsed.baseName}`;
    if (!grouped.has(familyKey)) grouped.set(familyKey, new Map());
    const byLevel = grouped.get(familyKey);
    if (!byLevel.has(parsed.level)) byLevel.set(parsed.level, filePath);
  }
  for (const [familyKey, byLevel] of grouped) {
    if (byLevel.size < 2) continue;
    const slicesByLevel = new Map();
    for (const [level, filePath] of byLevel) {
      slicesByLevel.set(level, buildBottomSlice(decodePng(filePath), scan.classKey));
    }
    families.push({
      classLabel: scan.label,
      familyKey,
      slicesByLevel,
      varianceMap: buildVarianceMap(slicesByLevel),
    });
  }
}

console.log(`Built bottom-20% slices for ${families.length} multi-level families.`);
console.log(`Sub-band split: ${SUB_BANDS} × ${SUB_BAND_H}-row bands inside ${BOTTOM_H}-row slice.\n`);

// ── Within-family pairwise NCC under each method ───────────────────────────

const N = CANON_W * BOTTOM_H;
const stats = {
  plain:    { values: [] },
  weighted: { values: [] },
  minBand:  { values: [] },
};
const detailRows = [];

for (const fam of families) {
  const levels = [...fam.slicesByLevel.keys()].sort((a, b) => a - b);
  for (let i = 0; i < levels.length; i++) {
    for (let j = i + 1; j < levels.length; j++) {
      const a = fam.slicesByLevel.get(levels[i]);
      const b = fam.slicesByLevel.get(levels[j]);
      const plain    = zncc(a, b, N);
      const weighted = weightedZncc(a, b, fam.varianceMap, N);
      const minBand  = minSubBandZncc(a, b);
      stats.plain.values.push(plain);
      stats.weighted.values.push(weighted);
      stats.minBand.values.push(minBand);
      detailRows.push({
        classLabel: fam.classLabel, familyKey: fam.familyKey,
        levelA: levels[i], levelB: levels[j], plain, weighted, minBand,
      });
    }
  }
}

function quantile(arr, q) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = clamp(Math.floor(q * sorted.length), 0, sorted.length - 1);
  return sorted[idx];
}
function mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

function summarize(name, vals) {
  const m = mean(vals);
  return {
    method: name,
    count:  vals.length,
    mean:   m,
    min:    Math.min(...vals),
    max:    Math.max(...vals),
    p10:    quantile(vals, 0.10),
    p50:    quantile(vals, 0.50),
    p90:    quantile(vals, 0.90),
  };
}

const summaries = [
  summarize('plain    (baseline)', stats.plain.values),
  summarize('weighted (variance)', stats.weighted.values),
  summarize('minBand  (4 × 5%)  ', stats.minBand.values),
];

console.log('Within-family different-level NCC under each method:');
console.log('  method                count   mean    min     max    p10    p50    p90');
for (const s of summaries) {
  console.log(`  ${s.method}  ` +
    `${String(s.count).padStart(5)}  ` +
    `${s.mean.toFixed(3).padStart(6)} ` +
    `${s.min.toFixed(3).padStart(6)} ` +
    `${s.max.toFixed(3).padStart(6)} ` +
    `${s.p10.toFixed(3).padStart(6)} ` +
    `${s.p50.toFixed(3).padStart(6)} ` +
    `${s.p90.toFixed(3).padStart(6)}`);
}

console.log('\n(Lower = better — different levels should look different.');
console.log(' Look at p90 / max especially — those are the "worst case" pairs');
console.log(' that drive disambiguation failure.)\n');

// ── Focused diagnosis for 金灵•針 ────────────────────────────────────────

const FAMILY_OF_INTEREST = 'five-element__金灵•针';
const target = families.find(f => f.familyKey === FAMILY_OF_INTEREST);
if (target) {
  console.log(`=== ${FAMILY_OF_INTEREST} pairwise scores under each method ===`);
  const rows = detailRows.filter(r => r.familyKey === FAMILY_OF_INTEREST);
  console.log('  pair       plain    weighted   minBand');
  for (const r of rows) {
    console.log(`  L${r.levelA}↔L${r.levelB}     ` +
      `${r.plain.toFixed(3).padStart(6)}    ` +
      `${r.weighted.toFixed(3).padStart(6)}    ` +
      `${r.minBand.toFixed(3).padStart(6)}`);
  }

  // Show the variance map's per-row sum so we can see which rows the weighted
  // NCC is actually emphasizing.
  console.log('\nPer-row variance map magnitude (canonical y in 20% slice):');
  for (let y = 0; y < BOTTOM_H; y++) {
    let sum = 0;
    for (let x = 0; x < CANON_W; x++) sum += target.varianceMap[y * CANON_W + x];
    const avg = sum / CANON_W;
    const yAbs = CANON_H - BOTTOM_H + y;
    const yPct = ((yAbs / CANON_H) * 100).toFixed(0);
    const bar = '█'.repeat(Math.min(50, Math.round(avg / 2)));
    console.log(`  y=${String(yAbs).padStart(3)} (${yPct}%)  ${avg.toFixed(1).padStart(5)}  ${bar}`);
  }
}

// ── Output ─────────────────────────────────────────────────────────────────

const outDir = path.join(__dirname, 'bottom10_results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'weighted_within_family_20.json'), JSON.stringify(detailRows, null, 2));
fs.writeFileSync(path.join(outDir, 'weighted_summary_20.json'), JSON.stringify(summaries, null, 2));
console.log(`\nWrote ${path.join(outDir, 'weighted_within_family_20.json')}`);
