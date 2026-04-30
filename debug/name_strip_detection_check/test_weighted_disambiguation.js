'use strict';

// End-to-end check of the weighted / min-sub-band methods on real captures.
// Mirrors test_level_disambiguation.js but at fixed bottom-20% with three
// scoring methods: plain, weighted (per-family variance map), min-sub-band.
//
// Run from project root:
//   ELECTRON_RUN_AS_NODE= node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     debug/name_strip_detection_check/test_weighted_disambiguation.js

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
const FRACTION = 0.20;
const BOTTOM_H = Math.max(1, Math.round(CANON_H * FRACTION));
const SUB_BANDS = 4;
const SUB_BAND_H = Math.max(1, Math.floor(BOTTOM_H / SUB_BANDS));

const CAL_PATH   = path.join(process.env.HOME, 'Library', 'Application Support', 'yixian-overlay', 'calibration.json');
const IMAGES_DIR = path.join(ROOT, 'images');
const CHECKS = [
  { file: path.join(__dirname, 'check1.png'),
    hand: ['梦•混元碎击', '木灵•桃花印', '木灵•芽', '金灵•针'] },
  { file: path.join(__dirname, 'check2.png'),
    hand: ['梦•混元碎击', '木灵•桃花印', '木灵•芽', '金灵•针'] },
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
    const da = a[i]-mA, db = b[i]-mB;
    num += da*db; dA += da*da; dB += db*db;
  }
  const denom = Math.sqrt(dA * dB);
  return denom < 1 ? 0 : num / denom;
}
function weightedZncc(a, b, weight, n) {
  let wSum = 0, sA = 0, sB = 0;
  for (let i = 0; i < n; i++) {
    const w = weight[i];
    wSum += w; sA += w*a[i]; sB += w*b[i];
  }
  if (wSum < 1e-9) return 0;
  const mA = sA/wSum, mB = sB/wSum;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const w = weight[i];
    const da = a[i]-mA, db = b[i]-mB;
    num += w*da*db; dA += w*da*da; dB += w*db*db;
  }
  const denom = Math.sqrt(dA * dB);
  return denom < 1e-9 ? 0 : num / denom;
}
function minSubBandZncc(a, b) {
  let minScore = +Infinity;
  for (let band = 0; band < SUB_BANDS; band++) {
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

function nativeImageToGray(image) {
  const bitmap = image.toBitmap();
  const { width, height } = getNativeImagePixelSize(image);
  const gray = new Float32Array(width * height);
  for (let i = 0, px = 0; i < bitmap.length; i += 4, px += 1) {
    gray[px] = 0.114*bitmap[i] + 0.587*bitmap[i+1] + 0.299*bitmap[i+2];
  }
  return { gray, width, height };
}

function bottomSliceFromCanon(canon) {
  const out = new Float32Array(CANON_W * BOTTOM_H);
  for (let y = 0; y < BOTTOM_H; y++) for (let x = 0; x < CANON_W; x++) {
    out[y*CANON_W+x] = canon[(CANON_H - BOTTOM_H + y) * CANON_W + x];
  }
  return out;
}
function bottomSliceFromGray(srcGray, srcW, srcH, slotRect, classKey) {
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
  for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
    stripCrop[y*aw + x] = srcGray[(y0+y) * srcW + (x0+x)];
  }
  return bottomSliceFromCanon(resizeGray(stripCrop, aw, ah, CANON_W, CANON_H));
}
function bottomSliceFromTemplate(filePath, classKey) {
  const img = nativeImage.createFromPath(filePath);
  const { gray, width, height } = nativeImageToGray(img);
  const rect = STRIP_RECT[classKey];
  const cx = clamp(Math.round(rect.x * width),  0, width  - 1);
  const cy = clamp(Math.round(rect.y * height), 0, height - 1);
  const cw = Math.max(1, Math.min(width  - cx, Math.round(rect.width  * width)));
  const ch = Math.max(1, Math.min(height - cy, Math.round(rect.height * height)));
  const stripCrop = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    stripCrop[y*cw + x] = gray[(cy+y) * width + (cx+x)];
  }
  return bottomSliceFromCanon(resizeGray(stripCrop, cw, ch, CANON_W, CANON_H));
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
function findFamilyLevelTemplates(card) {
  const isPersonal = !!card.isPersonal;
  const baseName   = card.name;
  const classKey   = isPersonal ? 'personal' : 'sect';
  const tier1Dirs  = isPersonal
    ? [path.join(IMAGES_DIR, 'personal')]
    : [path.join(IMAGES_DIR, 'sect'), path.join(IMAGES_DIR, 'side-jobs')];
  const out = [];
  for (const root of tier1Dirs) {
    for (const filePath of walkDir(root)) {
      const parsed = parseLevel(filePath);
      if (!parsed || parsed.baseName !== baseName) continue;
      out.push({ level: parsed.level, filePath, classKey });
    }
  }
  const byLevel = new Map();
  for (const t of out) if (!byLevel.has(t.level)) byLevel.set(t.level, t);
  return [...byLevel.values()].sort((a, b) => a.level - b.level);
}

function buildVarianceMap(slicesByLevel) {
  const n = CANON_W * BOTTOM_H;
  const levels = [...slicesByLevel.keys()];
  const k = levels.length;
  const map = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const lvl of levels) m += slicesByLevel.get(lvl)[i];
    m /= k;
    let varSum = 0;
    for (const lvl of levels) {
      const d = slicesByLevel.get(lvl)[i] - m;
      varSum += d * d;
    }
    map[i] = Math.sqrt(varSum / k);
  }
  return map;
}

app.whenReady().then(() => {
  setCalibration(JSON.parse(fs.readFileSync(CAL_PATH, 'utf8')));

  for (const check of CHECKS) {
    if (!fs.existsSync(check.file)) { console.log(`[skip] ${check.file}`); continue; }
    const ssName = path.basename(check.file);
    console.log(`\n=== ${ssName} ===`);

    const ssImg = nativeImage.createFromPath(check.file);
    const ssGrayPack = nativeImageToGray(ssImg);
    const res = detectSlotsNameStrip(ssImg, check.hand, IMAGES_DIR);

    for (let i = 0; i < res.slotResults.length; i++) {
      const r = res.slotResults[i];
      const c = r.card;
      if (!c || c.isDream) continue;
      const family = findFamilyLevelTemplates(c);
      if (family.length < 2) continue;

      const slotSlice = bottomSliceFromGray(
        ssGrayPack.gray, ssGrayPack.width, ssGrayPack.height, r.rect, family[0].classKey
      );
      if (!slotSlice) continue;

      const tmplSlicesByLevel = new Map();
      for (const t of family) tmplSlicesByLevel.set(t.level, bottomSliceFromTemplate(t.filePath, t.classKey));
      const varianceMap = buildVarianceMap(tmplSlicesByLevel);

      const N = CANON_W * BOTTOM_H;
      // For each method, score slot vs each level template; pick the highest.
      function scoreAll(scoreFn) {
        return family.map(t => ({
          level: t.level,
          score: scoreFn(slotSlice, tmplSlicesByLevel.get(t.level)),
        })).sort((a, b) => b.score - a.score);
      }
      const plainScores    = scoreAll((a, b) => zncc(a, b, N));
      const weightedScores = scoreAll((a, b) => weightedZncc(a, b, varianceMap, N));
      const minBandScores  = scoreAll((a, b) => minSubBandZncc(a, b));

      console.log(`  slot ${i}: ${c.name} class=${family[0].classKey} detectorL=${c.level}`);
      const fmt = (label, scores) => {
        const margin = scores[0].score - (scores[1]?.score ?? scores[0].score);
        const list = scores.map(s => `L${s.level}=${s.score.toFixed(3)}`).join(' ');
        console.log(`    ${label.padEnd(8)} chosen=L${scores[0].level} margin=${margin.toFixed(3)} [${list}]`);
      };
      fmt('plain',    plainScores);
      fmt('weighted', weightedScores);
      fmt('minBand',  minBandScores);
    }
  }
  process.exit(0);
});
