const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');
const { getCodePath } = require('./runtime_paths');
const { getNativeImagePixelSize } = require('./native_image_pixels');
const { computeLayoutTransform } = require('./rect_scale');
const {
  loadBaselineMasks,
  getMaskKeyForTemplate,
  resizeMaskNN
} = require('./detection_masks');

// Dream cards occupy a slightly smaller region that is shifted right relative to
// the normal slot anchor.  Values confirmed by grid-search debug across 8 slots:
//   xOffset ~+8 px (in calibration physical-pixel space)
//   width  ratio ~0.925  (196 / 212)
//   height ratio ~0.977  (335 / 343)
// These defaults are used when calibration was done before dream geometry was stored.
const DEFAULT_DREAM_RATIO = { width: 0.925, height: 0.977 };
const DEFAULT_DREAM_X_OFFSET = 8;  // pixels in calibration coordinate space

// Personal (talent-granted) card geometry is character-specific. FengXu's
// personal cards (击虚, 阴符玉简, 孤虚金书, 背孤) render larger and shifted
// vs. normal hand cards — values confirmed by grid-search on fengxuround2.png:
//   xOffset  ~ -10 px,  yOffset  ~ -16 px
//   width  ratio ~ 1.104  (234 / 212),  height ratio ~ 1.102  (378 / 343)
// Other characters' personal cards render at the same size and position as
// normal hand cards, so they default to no offset / no scale change. Add new
// entries here as more characters' personal cards are measured.
const PERSONAL_GEO_OVERRIDES = {
  FengXu: {
    ratio:   { width: 1.104, height: 1.102 },
    xOffset: -10,
    yOffset: -16
  }
};
const PERSONAL_GEO_DEFAULT = {
  ratio:   { width: 1, height: 1 },
  xOffset: 0,
  yOffset: 0
};

const CONFIG_PATH = getCodePath('slot_detector_config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const STABLE_REGIONS = config.stableRegions;
const DEFAULT_METRIC = config.defaultMetric;
const NUM_SLOTS = 8;

// Calibration override — set via setCalibration() from main process
let activeCalibration = null;

function setCalibration(data) {
  activeCalibration = data || null;
}

// Returns the effective geometry from calibration, or null if not yet calibrated
function getActiveGeometry() {
  const s = activeCalibration?.slots;
  if (!s) return null;
  return {
    baseScreenWidth:  s.baseScreenWidth,
    baseScreenHeight: s.baseScreenHeight,
    slotXPositions:   s.slotXPositions,
    slotY:            s.slotY,
    slotWidth:        s.slotWidth,
    slotHeight:       s.slotHeight,
    dreamSlotRatio:   s.dreamSlotRatio || null,
    dreamXOffset:     typeof s.dreamXOffset === 'number' ? s.dreamXOffset : null
  };
}

let templateIndexCache = null;

const CARD_NAME_ALIASES = {
  '梦•凝意决': '梦•凝意诀'
};

function normalizeCardName(name) {
  const normalized = (name || '').replace(/[·•]/g, '•').trim();
  return CARD_NAME_ALIASES[normalized] || normalized;
}

function isDreamCardName(name) {
  return normalizeCardName(name).startsWith('梦');
}

function isSeasonalTemplatePath(filePath) {
  const seasonalSegment = `${path.sep}seasonal${path.sep}`;
  return filePath.includes(seasonalSegment);
}

function isPersonalTemplatePath(filePath) {
  const personalSegment = `${path.sep}personal${path.sep}`;
  return filePath.includes(personalSegment);
}

function getTemplatePreferenceScore(filePath) {
  const fileName = path.basename(filePath);
  let score = 0;
  if (isSeasonalTemplatePath(filePath)) score += 10;
  if (fileName.includes('•')) score += 2;
  if (!fileName.includes('·')) score += 1;
  return score;
}

function walkDir(dirPath) {
  let results = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walkDir(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
      results.push(fullPath);
    }
  }
  return results;
}

function parseTemplateFilename(filePath) {
  const fileName = path.basename(filePath, '.png');
  const match = fileName.match(/^(.*?)(\d+)$/u);
  if (!match) return null;
  const baseName = normalizeCardName(match[1]);
  const suffixNumber = Number.parseInt(match[2], 10);
  const isDream = isDreamCardName(baseName);
  // Personal templates live in `images/personal/<CharName>/...`. Capture the
  // character name so detectSlots can pick the right per-character geometry.
  const personalMatch = filePath.match(/[\\/]personal[\\/]([^\\/]+)[\\/]/);
  const personalCharacter = personalMatch ? personalMatch[1] : null;
  return {
    baseName,
    level: isDream ? 1 : suffixNumber,
    phase: isDream ? suffixNumber : null,
    isDream,
    isSeasonal: isSeasonalTemplatePath(filePath),
    isPersonal: isPersonalTemplatePath(filePath),
    personalCharacter
  };
}

function imageToGray(image) {
  const bitmap = image.toBitmap();
  const { width, height } = getNativeImagePixelSize(image);
  const gray = new Float32Array(width * height);
  for (let i = 0, px = 0; i < bitmap.length; i += 4, px += 1) {
    const b = bitmap[i];
    const g = bitmap[i + 1];
    const r = bitmap[i + 2];
    gray[px] = (0.114 * b) + (0.587 * g) + (0.299 * r);
  }
  return { gray, width, height };
}

function imageToRgb(image) {
  const bitmap = image.toBitmap();
  const { width, height } = getNativeImagePixelSize(image);
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0, px = 0; i < bitmap.length; i += 4, px += 3) {
    rgb[px] = bitmap[i + 2];
    rgb[px + 1] = bitmap[i + 1];
    rgb[px + 2] = bitmap[i];
  }
  return { rgb, width, height };
}

// Extract and bilinear-resize a rectangular sub-region from a full-image gray array.
// Avoids nativeImage.crop() which returns logical-pixel getSize() but physical toBitmap()
// at DPI > 1, causing stride mismatch in comparison.
function extractSubGray(src, cropX, cropY, cropW, cropH, dstW, dstH) {
  const out = new Float32Array(dstW * dstH);
  const scaleX = cropW / dstW;
  const scaleY = cropH / dstH;
  const SW = src.width, SH = src.height;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx = cropX + dx * scaleX, sy = cropY + dy * scaleY;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, SW - 1), y1 = Math.min(y0 + 1, SH - 1);
      const wx = sx - x0, wy = sy - y0;
      out[dy * dstW + dx] =
        (1 - wx) * (1 - wy) * src.gray[y0 * SW + x0] +
        wx       * (1 - wy) * src.gray[y0 * SW + x1] +
        (1 - wx) * wy       * src.gray[y1 * SW + x0] +
        wx       * wy       * src.gray[y1 * SW + x1];
    }
  }
  return { gray: out, width: dstW, height: dstH };
}

function extractSubRgb(src, cropX, cropY, cropW, cropH, dstW, dstH) {
  const out = new Float32Array(dstW * dstH * 3);
  const scaleX = cropW / dstW;
  const scaleY = cropH / dstH;
  const SW = src.width, SH = src.height;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx = cropX + dx * scaleX, sy = cropY + dy * scaleY;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, SW - 1), y1 = Math.min(y0 + 1, SH - 1);
      const wx = sx - x0, wy = sy - y0;
      const base = (dy * dstW + dx) * 3;
      for (let c = 0; c < 3; c++) {
        out[base + c] =
          (1 - wx) * (1 - wy) * src.rgb[(y0 * SW + x0) * 3 + c] +
          wx       * (1 - wy) * src.rgb[(y0 * SW + x1) * 3 + c] +
          (1 - wx) * wy       * src.rgb[(y1 * SW + x0) * 3 + c] +
          wx       * wy       * src.rgb[(y1 * SW + x1) * 3 + c];
      }
    }
  }
  return { rgb: out, width: dstW, height: dstH };
}

// Fast RGB MSE between a source sub-region and a same-size template.
// Used for dream-card jitter search; avoids the resize and regional weighting
// of compareImages so the sweep stays cheap.
function fastRgbMseDirect(srcRgbData, ox, oy, tw, th, tmplRgb) {
  const SW  = srcRgbData.width;
  const src = srcRgbData.rgb;
  const tpl = tmplRgb.rgb;
  let sum = 0;
  for (let ty = 0; ty < th; ty++) {
    const sRow = ((oy + ty) * SW + ox) * 3;
    const tRow = ty * tw * 3;
    for (let tx = 0; tx < tw; tx++) {
      const sp = sRow + tx * 3;
      const tp = tRow + tx * 3;
      const dr = src[sp]     - tpl[tp];
      const dg = src[sp + 1] - tpl[tp + 1];
      const db = src[sp + 2] - tpl[tp + 2];
      sum += dr * dr + dg * dg + db * db;
    }
  }
  return sum / (tw * th * 3);
}

// Cache template raw data (gray + rgb + optional mask) at a given size.
// File-loaded images don't have DPI scaling so imageToGray/imageToRgb are
// reliable on them. The mask is resized via nearest-neighbour from the baseline
// to preserve the binary 0/1 shape exactly at the target dimensions.
function getTemplateRawData(template, width, height, baselineMasks) {
  const key = `${width}x${height}`;
  if (!template.rawDataCache) template.rawDataCache = new Map();
  if (template.rawDataCache.has(key)) return template.rawDataCache.get(key);
  const img = template.originalImage.resize({ width, height, quality: 'best' });

  let mask = null;
  const baseline = template.maskKey ? (baselineMasks && baselineMasks[template.maskKey]) : null;
  if (baseline) {
    mask = resizeMaskNN(baseline.mask, baseline.width, baseline.height, width, height);
  }

  const data = { gray: imageToGray(img), rgb: imageToRgb(img), mask };
  template.rawDataCache.set(key, data);
  return data;
}

function getRegionBounds(width, height, region) {
  const x0 = Math.max(0, Math.floor(region.x * width));
  const y0 = Math.max(0, Math.floor(region.y * height));
  const x1 = Math.min(width, Math.ceil((region.x + region.width) * width));
  const y1 = Math.min(height, Math.ceil((region.y + region.height) * height));
  return { x0, y0, x1, y1 };
}

function regionStats(grayDataA, grayDataB, region, mask = null) {
  const { width } = grayDataA;
  const { x0, y0, x1, y1 } = getRegionBounds(grayDataA.width, grayDataA.height, region);

  let sumA = 0;
  let sumB = 0;
  let grayMse = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = (y * width) + x;
      if (mask && mask[idx] === 0) continue;
      count += 1;
      const diff = grayDataA.gray[idx] - grayDataB.gray[idx];
      sumA += grayDataA.gray[idx];
      sumB += grayDataB.gray[idx];
      grayMse += diff * diff;
    }
  }

  if (count === 0) {
    return { ssim: 0, ncc: 0, grayMse: Number.POSITIVE_INFINITY };
  }

  const meanA = sumA / count;
  const meanB = sumB / count;
  let varianceA = 0;
  let varianceB = 0;
  let covariance = 0;
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = (y * width) + x;
      if (mask && mask[idx] === 0) continue;
      const centeredA = grayDataA.gray[idx] - meanA;
      const centeredB = grayDataB.gray[idx] - meanB;
      varianceA += centeredA * centeredA;
      varianceB += centeredB * centeredB;
      covariance += centeredA * centeredB;
      numerator += grayDataA.gray[idx] * grayDataB.gray[idx];
      denomA += grayDataA.gray[idx] * grayDataA.gray[idx];
      denomB += grayDataB.gray[idx] * grayDataB.gray[idx];
    }
  }

  const divisor = Math.max(1, count - 1);
  varianceA /= divisor;
  varianceB /= divisor;
  covariance /= divisor;

  const c1 = 6.5025;
  const c2 = 58.5225;
  const ssimNumerator = ((2 * meanA * meanB) + c1) * ((2 * covariance) + c2);
  const ssimDenominator = ((meanA * meanA) + (meanB * meanB) + c1) * (varianceA + varianceB + c2);
  const ssim = ssimDenominator === 0 ? 0 : ssimNumerator / ssimDenominator;
  const nccDenominator = Math.sqrt(denomA * denomB);
  const ncc = nccDenominator === 0 ? 0 : numerator / nccDenominator;

  return {
    ssim: Number.isFinite(ssim) ? ssim : 0,
    ncc: Number.isFinite(ncc) ? ncc : 0,
    grayMse: grayMse / count
  };
}

function regionRgbMse(rgbDataA, rgbDataB, region, mask = null) {
  const { width } = rgbDataA;
  const { x0, y0, x1, y1 } = getRegionBounds(rgbDataA.width, rgbDataA.height, region);
  let total = 0;
  let count = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const pixelIdx = (y * width) + x;
      if (mask && mask[pixelIdx] === 0) continue;
      count += 1;
      const idx = pixelIdx * 3;
      const dr = rgbDataA.rgb[idx] - rgbDataB.rgb[idx];
      const dg = rgbDataA.rgb[idx + 1] - rgbDataB.rgb[idx + 1];
      const db = rgbDataA.rgb[idx + 2] - rgbDataB.rgb[idx + 2];
      total += (dr * dr) + (dg * dg) + (db * db);
    }
  }

  if (count === 0) return Number.POSITIVE_INFINITY;
  return total / (count * 3);
}

// Clip all stable regions to exclude a border of `inset` fraction on each side.
// Used for personal cards whose decorative border differs from the template.
const PERSONAL_BORDER_INSET = 0.10;

function insetRegions(regions, inset) {
  const result = [];
  for (const r of regions) {
    const x0 = Math.max(r.x, inset);
    const y0 = Math.max(r.y, inset);
    const x1 = Math.min(r.x + r.width,  1 - inset);
    const y1 = Math.min(r.y + r.height, 1 - inset);
    if (x1 > x0 && y1 > y0) result.push({ ...r, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return result;
}

const PERSONAL_REGIONS = insetRegions(STABLE_REGIONS, PERSONAL_BORDER_INSET);

// Phase variants of the same dream card often share art/name/color, so full-card
// matching is a weak phase resolver.  Build a per-family mask from pixels that
// differ across phase templates, constrained to the text/stat area where phase
// changes are normally printed.
const DREAM_PHASE_MASK_REGIONS = [
  { x: 0.06, y: 0.45, width: 0.88, height: 0.48, weight: 1 }
];
const DREAM_PHASE_FALLBACK_REGIONS = [
  { x: 0.08, y: 0.48, width: 0.84, height: 0.18, weight: 0.30 },
  { x: 0.08, y: 0.64, width: 0.84, height: 0.24, weight: 0.60 },
  { x: 0.18, y: 0.86, width: 0.64, height: 0.08, weight: 0.10 }
];
const DREAM_PHASE_MIN_MASK_PIXELS = 200;
const DREAM_PHASE_MASK_TOP_FRACTION = 0.16;
const DREAM_PHASE_MASK_MIN_GRAY_DIFF = 3;
const DREAM_PHASE_GRAY_WEIGHT = 0.65;
const DREAM_PHASE_RGB_WEIGHT = 0.35;
const DREAM_PHASE_AMBIGUOUS_ABSOLUTE_MARGIN = 40;
const DREAM_PHASE_AMBIGUOUS_RELATIVE_MARGIN = 0.035;

// Chromatic phase signal: each dream-card phase has a distinct colour cast
// along the card border. Sweeping every strip on 梦•蜻蜓点水's 5 phases
// (debug/dream_card_phase_differentiation/) showed the LEFT EDGE of the card
// is the strongest discriminator — phase tint colours the background behind
// the vertical name text, with adjacent-phase RGB distances of ~12 there
// (vs ~6 for the top, ~9 for the description). The bottom border adds extra
// spread (54+ for the family) so we sum the two as the chromatic score.
// Average RGB is alignment-invariant — robust to 1–3 px slot-rect drift.
//
// Rank-combined with the existing pixel-mask phaseScore (chromatic 0.8 +
// mask 0.2) so the chromatic decision dominates but the mask still breaks
// ties when colour casts are close.
const DREAM_PHASE_CHROMATIC_REGIONS = [
  { x: 0.00, y: 0.00, width: 0.10, height: 1.00 }, // left edge (vertical name strip)
  { x: 0.00, y: 0.90, width: 1.00, height: 0.10 }  // bottom border
];
const DREAM_PHASE_CHROMATIC_RANK_WEIGHT = 0.8;
const DREAM_PHASE_MASK_RANK_WEIGHT      = 0.2;

const dreamPhaseMaskCache = new Map();

function buildRegionMask(width, height, regions) {
  const mask = new Uint8Array(width * height);
  for (const region of regions) {
    const { x0, y0, x1, y1 } = getRegionBounds(width, height, region);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        mask[(y * width) + x] = 1;
      }
    }
  }
  return mask;
}

function buildDreamPhaseMaskKey(phaseTemplates, width, height) {
  const signature = phaseTemplates
    .map((template) => `${template.phase ?? ''}:${template.filePath}`)
    .join('|');
  return `${width}x${height}:${signature}`;
}

// Average RGB over a rectangular region (x/y/width/height as fractions of the
// containing image), honouring an optional alpha mask. Returns null when the
// region has no usable pixels (e.g. fully transparent).
function computeRegionAverageRgb(rgbData, mask, width, height, region) {
  const { x0, y0, x1, y1 } = getRegionBounds(width, height, region);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = (y * width) + x;
      if (mask && mask[idx] === 0) continue;
      const rgbIdx = idx * 3;
      r += rgbData.rgb[rgbIdx];
      g += rgbData.rgb[rgbIdx + 1];
      b += rgbData.rgb[rgbIdx + 2];
      n += 1;
    }
  }
  if (n === 0) return null;
  return { r: r / n, g: g / n, b: b / n };
}

// Sum of CHROMATICITY distances between corresponding region averages.
// Chromaticity = (r/(r+g+b), g/(r+g+b), b/(r+g+b)) normalises out overall
// brightness, so a crop that's the same colour cast as a template but a few
// shades brighter (common: live-render gamma vs saved-template gamma) still
// matches. Without this, a brighter render of P1 lands closer to P2's RGB
// purely by absolute-magnitude — see board.png's slot 1 where raw-RGB picked
// P2 even though channel ratios identified P1 cleanly.
//
// Returns +Infinity if any region is missing, so a partially-transparent
// template doesn't accidentally tie with a clean one.
function rgbToChromaticity(avg) {
  if (!avg) return null;
  const sum = avg.r + avg.g + avg.b;
  if (sum < 1) return null;
  return { r: avg.r / sum, g: avg.g / sum, b: avg.b / sum };
}

function chromaticRegionsDistance(cropAvgs, templateAvgs) {
  if (!cropAvgs || !templateAvgs) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < cropAvgs.length; i += 1) {
    const a = rgbToChromaticity(cropAvgs[i]);
    const b = rgbToChromaticity(templateAvgs[i]);
    if (!a || !b) return Number.POSITIVE_INFINITY;
    const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    total += Math.sqrt((dr * dr) + (dg * dg) + (db * db));
  }
  return total;
}

function buildDreamPhaseDiscriminantMask(phaseTemplates, width, height, baselineMasks) {
  const usableTemplates = phaseTemplates
    .filter((template) => template && template.isDream && Number.isFinite(Number(template.phase)))
    .sort((a, b) => Number(a.phase) - Number(b.phase));

  if (usableTemplates.length < 2) {
    return {
      mask: null,
      pixelCount: 0,
      mode: 'fallback-regions',
      reason: 'not-enough-phases',
      chromaticByPhase: new Map()
    };
  }

  const cacheKey = buildDreamPhaseMaskKey(usableTemplates, width, height);
  if (dreamPhaseMaskCache.has(cacheKey)) return dreamPhaseMaskCache.get(cacheKey);

  const regionMask = buildRegionMask(width, height, DREAM_PHASE_MASK_REGIONS);
  const phaseData = usableTemplates.map((template) => getTemplateRawData(template, width, height, baselineMasks));

  // Pre-compute each phase template's average RGB over the chromatic regions
  // (left edge + bottom border by default — see DREAM_PHASE_CHROMATIC_REGIONS).
  // This is alignment-invariant and the dominant signal for distinguishing
  // adjacent phases whose only pixel-level difference is a single stat digit.
  const chromaticByPhase = new Map();
  for (let i = 0; i < usableTemplates.length; i += 1) {
    const template = usableTemplates[i];
    const data = phaseData[i];
    chromaticByPhase.set(
      template.phase,
      DREAM_PHASE_CHROMATIC_REGIONS.map((region) =>
        computeRegionAverageRgb(data.rgb, data.mask, width, height, region)
      )
    );
  }

  const diffs = [];

  for (let idx = 0; idx < width * height; idx += 1) {
    if (regionMask[idx] === 0) continue;

    let valid = true;
    let minGray = Number.POSITIVE_INFINITY;
    let maxGray = Number.NEGATIVE_INFINITY;
    for (const data of phaseData) {
      if (data.mask && data.mask[idx] === 0) {
        valid = false;
        break;
      }
      const gray = data.gray.gray[idx];
      if (gray < minGray) minGray = gray;
      if (gray > maxGray) maxGray = gray;
    }
    if (!valid) continue;

    const grayDiff = maxGray - minGray;
    if (grayDiff > 0) {
      diffs.push({ idx, grayDiff });
    }
  }

  diffs.sort((a, b) => b.grayDiff - a.grayDiff);

  const targetCount = Math.min(
    diffs.length,
    Math.max(DREAM_PHASE_MIN_MASK_PIXELS, Math.floor(diffs.length * DREAM_PHASE_MASK_TOP_FRACTION))
  );
  let selected = diffs
    .slice(0, targetCount)
    .filter((entry) => entry.grayDiff >= DREAM_PHASE_MASK_MIN_GRAY_DIFF);

  // If the phase art/text only differs subtly, keep the strongest pixels rather
  // than falling back too early.  A tiny mask is worse than fixed text regions.
  if (selected.length < DREAM_PHASE_MIN_MASK_PIXELS) {
    selected = diffs.slice(0, Math.min(diffs.length, DREAM_PHASE_MIN_MASK_PIXELS));
  }

  if (selected.length < DREAM_PHASE_MIN_MASK_PIXELS) {
    const result = {
      mask: null,
      pixelCount: selected.length,
      mode: 'fallback-regions',
      reason: 'too-few-discriminating-pixels',
      chromaticByPhase
    };
    dreamPhaseMaskCache.set(cacheKey, result);
    return result;
  }

  const mask = new Uint8Array(width * height);
  for (const entry of selected) {
    mask[entry.idx] = 1;
  }

  const result = {
    mask,
    pixelCount: selected.length,
    mode: 'phase-discriminant-mask',
    reason: null,
    chromaticByPhase
  };
  dreamPhaseMaskCache.set(cacheKey, result);
  return result;
}

function combinePhaseScore(grayMse, rgbMse) {
  if (!Number.isFinite(grayMse) || !Number.isFinite(rgbMse)) return Number.POSITIVE_INFINITY;
  return (grayMse * DREAM_PHASE_GRAY_WEIGHT) + (rgbMse * DREAM_PHASE_RGB_WEIGHT);
}

function scoreMaskedDreamPhase(cropGray, cropRgb, templateData, mask) {
  let grayTotal = 0;
  let rgbTotal = 0;
  let count = 0;

  for (let idx = 0; idx < mask.length; idx += 1) {
    if (mask[idx] === 0) continue;
    count += 1;

    const grayDiff = cropGray.gray[idx] - templateData.gray.gray[idx];
    grayTotal += grayDiff * grayDiff;

    const rgbIdx = idx * 3;
    const dr = cropRgb.rgb[rgbIdx] - templateData.rgb.rgb[rgbIdx];
    const dg = cropRgb.rgb[rgbIdx + 1] - templateData.rgb.rgb[rgbIdx + 1];
    const db = cropRgb.rgb[rgbIdx + 2] - templateData.rgb.rgb[rgbIdx + 2];
    rgbTotal += (dr * dr) + (dg * dg) + (db * db);
  }

  if (count === 0) {
    return {
      grayMse: Number.POSITIVE_INFINITY,
      rgbMse: Number.POSITIVE_INFINITY,
      phaseScore: Number.POSITIVE_INFINITY
    };
  }

  const grayMse = grayTotal / count;
  const rgbMse = rgbTotal / (count * 3);
  return {
    grayMse,
    rgbMse,
    phaseScore: combinePhaseScore(grayMse, rgbMse)
  };
}

function scoreRegionalDreamPhase(cropGray, cropRgb, templateData) {
  const metrics = compareImages(
    cropGray,
    cropRgb,
    templateData.gray,
    templateData.rgb,
    DREAM_PHASE_FALLBACK_REGIONS,
    templateData.mask
  );
  return {
    grayMse: metrics.grayMse,
    rgbMse: metrics.rgbMse,
    phaseScore: combinePhaseScore(metrics.grayMse, metrics.rgbMse)
  };
}

function resolveDreamPhase(best, scored, srcGrayData, srcRgbData, baselineMasks, metricName) {
  if (!best?.isDream) return null;

  const phaseTemplates = scored.filter((candidate) => (
    candidate.isDream &&
    candidate.baseName === best.baseName &&
    Number.isFinite(Number(candidate.phase))
  ));
  if (phaseTemplates.length === 0) return null;

  const width = best.compareWidth || best.slotRect.width;
  const height = best.compareHeight || best.slotRect.height;
  const cropGray = extractSubGray(srcGrayData, best.slotRect.x, best.slotRect.y, best.slotRect.width, best.slotRect.height, width, height);
  const cropRgb = extractSubRgb(srcRgbData, best.slotRect.x, best.slotRect.y, best.slotRect.width, best.slotRect.height, width, height);
  const maskInfo = buildDreamPhaseDiscriminantMask(phaseTemplates, width, height, baselineMasks);

  // Crop's chromatic profile — average RGB over the same regions we
  // pre-computed for each phase template. Alignment-invariant.
  const cropChromatic = DREAM_PHASE_CHROMATIC_REGIONS.map((region) =>
    computeRegionAverageRgb(cropRgb, null, width, height, region)
  );

  const phaseScored = phaseTemplates.map((candidate) => {
    const templateData = getTemplateRawData(candidate, width, height, baselineMasks);
    const phaseMetrics = maskInfo.mask
      ? scoreMaskedDreamPhase(cropGray, cropRgb, templateData, maskInfo.mask)
      : scoreRegionalDreamPhase(cropGray, cropRgb, templateData);
    const tmplChromatic = maskInfo.chromaticByPhase?.get(candidate.phase) || null;
    const chromaticScore = chromaticRegionsDistance(cropChromatic, tmplChromatic);
    return {
      ...candidate,
      phaseMetrics,
      chromaticScore
    };
  });

  // Rank-weighted combination: chromatic 0.8 + mask 0.2. Using ranks keeps
  // the two signals on the same scale (both 1..N) and prevents the mask's
  // larger raw numbers from drowning the cleaner chromatic signal — see
  // diagnostic data in debug/dream_card_phase_differentiation/.
  const byChromatic = [...phaseScored].sort((a, b) => {
    if (a.chromaticScore !== b.chromaticScore) return a.chromaticScore - b.chromaticScore;
    return Number(a.phase ?? 0) - Number(b.phase ?? 0);
  });
  const byMask = [...phaseScored].sort((a, b) => {
    if (a.phaseMetrics.phaseScore !== b.phaseMetrics.phaseScore) {
      return a.phaseMetrics.phaseScore - b.phaseMetrics.phaseScore;
    }
    return Number(a.phase ?? 0) - Number(b.phase ?? 0);
  });
  const chromaticRank = new Map();
  const maskRank      = new Map();
  byChromatic.forEach((c, i) => chromaticRank.set(c, i + 1));
  byMask.forEach     ((c, i) => maskRank.set     (c, i + 1));

  // Decorate each candidate with its ranks + combined rank, then sort.
  for (const c of phaseScored) {
    c.chromaticRank = chromaticRank.get(c);
    c.maskRank      = maskRank.get(c);
    c.combinedRank  = (DREAM_PHASE_CHROMATIC_RANK_WEIGHT * c.chromaticRank)
                    + (DREAM_PHASE_MASK_RANK_WEIGHT      * c.maskRank);
  }
  phaseScored.sort((a, b) => {
    if (a.combinedRank !== b.combinedRank) return a.combinedRank - b.combinedRank;
    if (a.chromaticScore !== b.chromaticScore) return a.chromaticScore - b.chromaticScore;
    return Number(a.phase ?? 0) - Number(b.phase ?? 0);
  });

  const bestPhase = phaseScored[0] || null;
  if (!bestPhase || !Number.isFinite(bestPhase.chromaticScore)) return null;

  const secondPhase = phaseScored[1] || null;
  // Surface the chromatic-distance margin since that's the dominant signal.
  // Treat the result as ambiguous when (a) chromatic margin is small AND
  // (b) the two ranking systems disagreed on the winner — that's the case
  // where a mis-call is most likely.
  const phaseMargin = secondPhase
    ? secondPhase.chromaticScore - bestPhase.chromaticScore
    : Number.POSITIVE_INFINITY;
  const rankingsAgree = byChromatic[0] === byMask[0];
  const phaseAmbiguous = !rankingsAgree && Number.isFinite(phaseMargin) && phaseMargin < 8;

  return {
    template: bestPhase,
    phase: bestPhase.phase ?? null,
    phaseScore: bestPhase.chromaticScore,
    phaseMargin,
    phaseAmbiguous,
    rankingsAgree,
    phaseMaskPixelCount: maskInfo.pixelCount,
    phaseScoringMode: maskInfo.mode,
    phaseMaskReason: maskInfo.reason,
    candidates: phaseScored.map((candidate) => ({
      phase: candidate.phase ?? null,
      templateFile: candidate.fileName,
      combinedRank:    +candidate.combinedRank.toFixed(2),
      chromaticRank:   candidate.chromaticRank,
      maskRank:        candidate.maskRank,
      chromaticScore:  roundMetric(candidate.chromaticScore),
      maskPhaseScore:  roundMetric(candidate.phaseMetrics.phaseScore),
      grayMse:         roundMetric(candidate.phaseMetrics.grayMse),
      rgbMse:          roundMetric(candidate.phaseMetrics.rgbMse),
      familyScore:     roundMetric(candidate.metrics[metricName])
    }))
  };
}

function compareImages(grayA, rgbA, grayB, rgbB, regions = STABLE_REGIONS, mask = null) {
  let weightedSSIM = 0;
  let weightedNCC = 0;
  let weightedGrayMse = 0;
  let weightedRgbMse = 0;
  let totalWeight = 0;

  for (const region of regions) {
    const { ssim, ncc, grayMse } = regionStats(grayA, grayB, region, mask);
    const rgbMse = regionRgbMse(rgbA, rgbB, region, mask);
    weightedSSIM += ssim * region.weight;
    weightedNCC += ncc * region.weight;
    weightedGrayMse += grayMse * region.weight;
    weightedRgbMse += rgbMse * region.weight;
    totalWeight += region.weight;
  }

  if (totalWeight === 0) {
    return {
      ssim: 0,
      ncc: 0,
      grayMse: Number.POSITIVE_INFINITY,
      rgbMse: Number.POSITIVE_INFINITY
    };
  }

  return {
    ssim: weightedSSIM / totalWeight,
    ncc: weightedNCC / totalWeight,
    grayMse: weightedGrayMse / totalWeight,
    rgbMse: weightedRgbMse / totalWeight
  };
}

function getMetricDefinition(metricName) {
  const metric = config.metrics[metricName];
  if (!metric) {
    throw new Error(`Unknown slot detector metric: ${metricName}`);
  }
  return metric;
}

function buildTemplateIndex(imagesDir) {
  if (templateIndexCache) return templateIndexCache;

  const files = walkDir(imagesDir);
  const templatesByCard = new Map();

  for (const filePath of files) {
    const parsed = parseTemplateFilename(filePath);
    if (!parsed) continue;

    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) continue;

    const existing = templatesByCard.get(parsed.baseName) || [];
    const nextTemplate = {
      baseName: parsed.baseName,
      level: parsed.level,
      phase: parsed.phase,
      isDream: parsed.isDream,
      isSeasonal: parsed.isSeasonal,
      isPersonal: parsed.isPersonal,
      personalCharacter: parsed.personalCharacter,
      maskKey: getMaskKeyForTemplate(filePath, parsed.level),
      filePath,
      fileName: path.basename(filePath),
      originalImage: image,
      resizedImages: new Map()
    };

    if (parsed.isDream) {
      const duplicateIndex = existing.findIndex((template) => (
        template.isDream &&
        template.phase === nextTemplate.phase
      ));
      if (duplicateIndex >= 0) {
        const existingTemplate = existing[duplicateIndex];
        if (getTemplatePreferenceScore(nextTemplate.filePath) > getTemplatePreferenceScore(existingTemplate.filePath)) {
          existing[duplicateIndex] = nextTemplate;
        }
      } else {
        existing.push(nextTemplate);
      }
    } else {
      existing.push(nextTemplate);
    }

    templatesByCard.set(parsed.baseName, existing);
  }

  for (const [cardName, variants] of templatesByCard.entries()) {
    variants.sort((a, b) => {
      const aOrder = a.isDream ? (a.phase ?? 0) : a.level;
      const bOrder = b.isDream ? (b.phase ?? 0) : b.level;
      return aOrder - bOrder;
    });
    templatesByCard.set(cardName, variants);
  }

  templateIndexCache = templatesByCard;
  return templateIndexCache;
}

function getScaledSlotRect(slotIndex, sourceImage) {
  const active = getActiveGeometry();
  if (!active) return null;
  return getScaledSlotRectForGeometry(slotIndex, sourceImage, active);
}

function normalizeGeometry(geometry) {
  const active = getActiveGeometry();
  if (!geometry) {
    if (!active) return null;
    return {
      baseScreenWidth:  active.baseScreenWidth,
      baseScreenHeight: active.baseScreenHeight,
      slotXPositions: [...active.slotXPositions],
      slotY:      active.slotY,
      slotWidth:  active.slotWidth,
      slotHeight: active.slotHeight
    };
  }

  const slotXPositions = Array.isArray(geometry.slotXPositions) && geometry.slotXPositions.length === NUM_SLOTS
    ? geometry.slotXPositions.map((value) => Number(value))
    : active ? [...active.slotXPositions] : null;
  if (!slotXPositions) return null;
  const slotY      = Number.isFinite(Number(geometry.slotY))      ? Number(geometry.slotY)      : active?.slotY;
  const slotWidth  = Number.isFinite(Number(geometry.slotWidth))  ? Number(geometry.slotWidth)  : active?.slotWidth;
  const slotHeight = Number.isFinite(Number(geometry.slotHeight)) ? Number(geometry.slotHeight) : active?.slotHeight;
  const baseScreenWidth  = Number.isFinite(Number(geometry.baseScreenWidth))  ? Number(geometry.baseScreenWidth)  : active?.baseScreenWidth;
  const baseScreenHeight = Number.isFinite(Number(geometry.baseScreenHeight)) ? Number(geometry.baseScreenHeight) : active?.baseScreenHeight;

  return { baseScreenWidth, baseScreenHeight, slotXPositions, slotY, slotWidth, slotHeight };
}

function getScaledSlotRectForGeometry(slotIndex, sourceImage, geometry) {
  const sourceSize = getNativeImagePixelSize(sourceImage);
  const baseScreenWidth = Number(geometry.baseScreenWidth) || sourceSize.width || 1;
  const baseScreenHeight = Number(geometry.baseScreenHeight) || sourceSize.height || 1;
  const transform = computeLayoutTransform(
    { width: baseScreenWidth, height: baseScreenHeight },
    sourceSize
  );
  return {
    x: Math.round(geometry.slotXPositions[slotIndex] * transform.scaleX),
    y: Math.round(geometry.slotY * transform.scaleY),
    width: Math.max(1, Math.round(geometry.slotWidth * transform.sizeScaleX)),
    height: Math.max(1, Math.round(geometry.slotHeight * transform.sizeScaleY))
  };
}

function roundMetric(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : value;
}

function buildDebugCandidate(candidate, metricName) {
  if (!candidate) return null;
  return {
    name: candidate.baseName,
    level: candidate.level,
    phase: candidate.phase ?? null,
    isDream: !!candidate.isDream,
    templateFile: candidate.fileName,
    templatePath: candidate.filePath,
    primaryScore: roundMetric(candidate.metrics[metricName]),
    metrics: {
      ssim: roundMetric(candidate.metrics.ssim),
      ncc: roundMetric(candidate.metrics.ncc),
      grayMse: roundMetric(candidate.metrics.grayMse),
      rgbMse: roundMetric(candidate.metrics.rgbMse)
    }
  };
}

function buildDisplayConfidence(bestScore, margin, metric) {
  if (!Number.isFinite(bestScore)) return 0;

  let scoreComponent = 0;
  if (metric.higherIsBetter) {
    scoreComponent = metric.threshold <= 0 ? 1 : Math.max(0, Math.min(1, bestScore / metric.threshold));
  } else {
    if (bestScore <= 0) {
      scoreComponent = 1;
    } else {
      scoreComponent = Math.max(0, Math.min(1, metric.threshold / bestScore));
    }
  }

  // Infinite margin means there is no second candidate — treat as maximum margin confidence.
  const marginComponent = (!Number.isFinite(margin) || metric.margin <= 0)
    ? 1
    : Math.max(0, Math.min(1, margin / (margin + metric.margin)));

  return Number(((scoreComponent + marginComponent) / 2).toFixed(4));
}

function detectSlots(sourceImage, handCardNames, imagesDir, options = {}) {
  if (!sourceImage || sourceImage.isEmpty()) {
    return { slots: Array(NUM_SLOTS).fill(null), slotResults: [], debug: { reason: 'empty-source' } };
  }

  const active = getActiveGeometry();
  if (!active) {
    return { slots: Array(NUM_SLOTS).fill(null), slotResults: [], debug: { reason: 'not-calibrated' } };
  }

  const metricName = options.metric || DEFAULT_METRIC;
  const metric = getMetricDefinition(metricName);
  const normalGeometry = normalizeGeometry(options.geometry);
  const templateIndex = buildTemplateIndex(imagesDir);
  const baselineMasks = loadBaselineMasks(imagesDir);
  const candidateTemplates = [];
  const seenTemplateFiles = new Set();

  for (const cardName of handCardNames || []) {
    const normalizedCardName = normalizeCardName(cardName);
    const isDream = isDreamCardName(normalizedCardName);
    const strippedCardName = normalizedCardName.replace(/\d+$/, '');
    const lookupKeys = normalizedCardName !== strippedCardName
      ? [normalizedCardName, strippedCardName]
      : [normalizedCardName];
    const variants = lookupKeys
      .flatMap((key) => templateIndex.get(key) || [])
      .filter((template, idx, arr) => arr.indexOf(template) === idx)
      .filter((template) => {
        if (isDream) return template.isDream && template.isSeasonal;
        return !template.isDream;
    });
    for (const template of variants) {
      if (seenTemplateFiles.has(template.filePath)) continue;
      seenTemplateFiles.add(template.filePath);
      candidateTemplates.push(template);
    }
  }

  // Safety rail: if a personal template exists for a baseName, drop any
  // non-personal templates that share the name. Personal cards have unique
  // nameCn (e.g. 阴符玉简), so this is a no-op in normal play — it guards the
  // rare case where a duplicate-named non-personal template would compete
  // across a different geometry and win on an incomparable score.
  const personalBaseNames = new Set(
    candidateTemplates.filter((t) => t.isPersonal).map((t) => t.baseName)
  );
  if (personalBaseNames.size > 0) {
    for (let i = candidateTemplates.length - 1; i >= 0; i -= 1) {
      const t = candidateTemplates[i];
      if (!t.isPersonal && personalBaseNames.has(t.baseName)) {
        candidateTemplates.splice(i, 1);
      }
    }
  }

  // Compute dream geometry: dream cards are slightly narrower/shorter and their
  // top-left anchor is shifted right relative to the normal slot x position.
  // Treat stored ratio of {1,1} as the old placeholder (pre-dream-geometry calibration)
  // and fall back to the code defaults so existing calibrations get the correct geometry
  // without needing a re-calibration.
  const storedRatio = active.dreamSlotRatio;
  const ratio = (storedRatio && (storedRatio.width !== 1 || storedRatio.height !== 1))
    ? storedRatio
    : DEFAULT_DREAM_RATIO;
  const xOffset = typeof active.dreamXOffset === 'number'
    ? active.dreamXOffset
    : DEFAULT_DREAM_X_OFFSET;
  let dreamGeometry = normalGeometry;
  if (normalGeometry) {
    const dw = Math.max(1, Math.round(normalGeometry.slotWidth  * ratio.width));
    const dh = Math.max(1, Math.round(normalGeometry.slotHeight * ratio.height));
    dreamGeometry = {
      ...normalGeometry,
      slotXPositions: normalGeometry.slotXPositions.map((x) => x + xOffset),
      slotWidth:  dw,
      slotHeight: dh
    };
  }

  // Personal (talent-granted) card geometry is character-specific. Each
  // character that has a personal template in the candidate pool gets its own
  // geometry derived from PERSONAL_GEO_OVERRIDES (or the default no-op shift
  // for unknown characters, which equals normalGeometry).
  const personalGeometryByChar = new Map();
  function buildPersonalGeometry(charName) {
    if (!normalGeometry) return null;
    const cfg = PERSONAL_GEO_OVERRIDES[charName] || PERSONAL_GEO_DEFAULT;
    if (cfg === PERSONAL_GEO_DEFAULT) return normalGeometry;
    return {
      ...normalGeometry,
      slotXPositions: normalGeometry.slotXPositions.map((x) => x + cfg.xOffset),
      slotY:      normalGeometry.slotY + cfg.yOffset,
      slotWidth:  Math.max(1, Math.round(normalGeometry.slotWidth  * cfg.ratio.width)),
      slotHeight: Math.max(1, Math.round(normalGeometry.slotHeight * cfg.ratio.height))
    };
  }
  function getPersonalGeometry(charName) {
    const key = charName || '';
    if (!personalGeometryByChar.has(key)) {
      personalGeometryByChar.set(key, buildPersonalGeometry(key));
    }
    return personalGeometryByChar.get(key);
  }

  if (candidateTemplates.length === 0) {
    return {
      slots: Array(NUM_SLOTS).fill(null),
      slotResults: [],
      debug: { reason: 'no-candidates', metric: metricName }
    };
  }

  // Convert full source image to raw arrays ONCE — bypasses nativeImage.crop() DPI stride mismatch
  // (crop().getSize() returns logical pixels but toBitmap() returns physical on Windows DPI > 1).
  const srcGrayData = imageToGray(sourceImage);
  const srcRgbData  = imageToRgb(sourceImage);

  const normalSlotRects = Array.from({ length: NUM_SLOTS }, (_, i) =>
    getScaledSlotRectForGeometry(i, sourceImage, normalGeometry)
  );
  const dreamSlotRects = dreamGeometry !== normalGeometry
    ? Array.from({ length: NUM_SLOTS }, (_, i) =>
        getScaledSlotRectForGeometry(i, sourceImage, dreamGeometry)
      )
    : normalSlotRects;

  // Per-character personal slot rects, computed lazily for any character that
  // appears in the candidate pool.
  const personalSlotRectsByChar = new Map();
  function getPersonalSlotRects(charName) {
    const key = charName || '';
    if (!personalSlotRectsByChar.has(key)) {
      const geom = getPersonalGeometry(key);
      personalSlotRectsByChar.set(key,
        geom === normalGeometry
          ? normalSlotRects
          : Array.from({ length: NUM_SLOTS }, (_, i) => getScaledSlotRectForGeometry(i, sourceImage, geom))
      );
    }
    return personalSlotRectsByChar.get(key);
  }

  const slotResults = Array.from({ length: NUM_SLOTS }, (_, slotIndex) => {
    const scored = candidateTemplates.map((template) => {
      const personalGeom = template.isPersonal ? getPersonalGeometry(template.personalCharacter) : null;
      const personalRect = template.isPersonal ? getPersonalSlotRects(template.personalCharacter)[slotIndex] : null;
      const geom = template.isDream ? dreamGeometry : (template.isPersonal ? personalGeom : normalGeometry);
      const rect = template.isDream ? dreamSlotRects[slotIndex] : (template.isPersonal ? personalRect : normalSlotRects[slotIndex]);
      const dstW = geom.slotWidth, dstH = geom.slotHeight;

      const tmpl = getTemplateRawData(template, dstW, dstH, baselineMasks);

      const cropGray = extractSubGray(srcGrayData, rect.x, rect.y, rect.width, rect.height, dstW, dstH);
      const cropRgb  = extractSubRgb(srcRgbData,  rect.x, rect.y, rect.width, rect.height, dstW, dstH);

      // PERSONAL_REGIONS insets 10% of the border to skip a decorative frame —
      // only applicable when the personal geometry is actually different from
      // normal (i.e. FengXu's bigger / shifted personal cards). For characters
      // whose personal cards render at normal geometry, the inset just throws
      // away high-signal regions (level badge, description box).
      const regions = (template.isPersonal && personalGeom && personalGeom !== normalGeometry)
        ? PERSONAL_REGIONS
        : STABLE_REGIONS;
      return {
        ...template,
        metrics: compareImages(cropGray, cropRgb, tmpl.gray, tmpl.rgb, regions, tmpl.mask),
        slotRect: { ...rect },
        compareWidth: dstW,
        compareHeight: dstH
      };
    });

    scored.sort((a, b) => {
      if (a.metrics[metricName] !== b.metrics[metricName]) {
        return metric.higherIsBetter
          ? (b.metrics[metricName] - a.metrics[metricName])
          : (a.metrics[metricName] - b.metrics[metricName]);
      }
      return b.metrics.ncc - a.metrics.ncc;
    });

    const best = scored[0] || null;
    const bestScore = best ? best.metrics[metricName] : Number.NaN;

    // Margin is computed against the best competitor from a *different* card.
    // Using scored[1] (same card, different level/phase) produces a near-zero
    // margin that kills acceptance even when the correct card is obvious.
    const bestCardName = best?.baseName ?? null;
    const rival = scored.find((t) => t.baseName !== bestCardName) || null;
    const rivalScore = rival ? rival.metrics[metricName] : Number.NaN;
    const margin = !Number.isFinite(rivalScore)
      ? Number.POSITIVE_INFINITY
      : metric.higherIsBetter
        ? (bestScore - rivalScore)
        : (rivalScore - bestScore);
    // Keep second for debug display (still the overall runner-up, regardless of card name).
    const second = scored[1] || null;

    const accepted = !!best &&
      ((metric.higherIsBetter && bestScore >= metric.threshold) ||
        (!metric.higherIsBetter && bestScore <= metric.threshold)) &&
      margin >= metric.margin;
    const dreamPhaseResult = accepted && best?.isDream
      ? resolveDreamPhase(best, scored, srcGrayData, srcRgbData, baselineMasks, metricName)
      : null;
    const phaseResolvedTemplate = dreamPhaseResult?.template || best;
    const resolvedPhase = dreamPhaseResult?.phase ?? best?.phase ?? null;
    const dreamPhaseCandidates = dreamPhaseResult?.candidates || null;

    // For the debug overlay's "personal" candidate rect, prefer the winning
    // template's character if it's personal; otherwise fall back to any
    // personal candidate in the pool. Returns null when no personal templates
    // are in play, or when the resolved geometry is identical to normal.
    let personalRectForDebug = null;
    {
      const winnerChar = best?.isPersonal ? best.personalCharacter : null;
      const fallbackChar = winnerChar
        ? null
        : (candidateTemplates.find((t) => t.isPersonal)?.personalCharacter || null);
      const debugChar = winnerChar || fallbackChar;
      if (debugChar) {
        const geom = getPersonalGeometry(debugChar);
        if (geom !== normalGeometry) {
          personalRectForDebug = { ...getPersonalSlotRects(debugChar)[slotIndex] };
        }
      }
    }

    const slotResult = {
      slotIndex,
      rect: best?.slotRect || normalSlotRects[slotIndex],
      // All three candidate rects so the debug overlay can draw where the
      // detector *would* compare each geometry. Dream/personal are null when
      // they coincide with normal (no-calibration fallback path).
      candidateRects: {
        normal:   { ...normalSlotRects[slotIndex] },
        dream:    dreamGeometry !== normalGeometry ? { ...dreamSlotRects[slotIndex] } : null,
        personal: personalRectForDebug
      },
      winningTemplate: best ? {
        name: best.baseName,
        phase: resolvedPhase,
        isDream: !!best.isDream,
        isPersonal: !!best.isPersonal,
        score: roundMetric(bestScore),
        templateFile: phaseResolvedTemplate?.fileName || best.fileName,
        phaseScore: dreamPhaseResult ? roundMetric(dreamPhaseResult.phaseScore) : null,
        phaseMargin: dreamPhaseResult ? roundMetric(dreamPhaseResult.phaseMargin) : null,
        phaseAmbiguous: dreamPhaseResult ? dreamPhaseResult.phaseAmbiguous : false,
        phaseScoringMode: dreamPhaseResult?.phaseScoringMode || null,
        phaseMaskPixelCount: dreamPhaseResult?.phaseMaskPixelCount ?? null
      } : null,
      metric: metricName,
      accepted,
      bestScore: roundMetric(bestScore),
      margin: roundMetric(margin),
      displayConfidence: best ? buildDisplayConfidence(bestScore, margin, metric) : 0,
      bestCandidate: buildDebugCandidate(best, metricName),
      secondCandidate: buildDebugCandidate(second, metricName),
      dreamPhaseCandidates,
      dreamPhaseScore: dreamPhaseResult ? roundMetric(dreamPhaseResult.phaseScore) : null,
      dreamPhaseMargin: dreamPhaseResult ? roundMetric(dreamPhaseResult.phaseMargin) : null,
      dreamPhaseAmbiguous: dreamPhaseResult ? dreamPhaseResult.phaseAmbiguous : false,
      dreamPhaseScoringMode: dreamPhaseResult?.phaseScoringMode || null,
      dreamPhaseMaskPixelCount: dreamPhaseResult?.phaseMaskPixelCount ?? null,
      dreamPhaseMaskReason: dreamPhaseResult?.phaseMaskReason || null,
      allCandidates: options.verboseDebug ? scored.map((c) => buildDebugCandidate(c, metricName)) : undefined,
      card: accepted ? {
        name: best.baseName,
        level: phaseResolvedTemplate?.level ?? best.level,
        phase: resolvedPhase,
        isDream: !!best.isDream,
        isPersonal: !!best.isPersonal,
        templateFile: phaseResolvedTemplate?.fileName || best.fileName,
        confidence: buildDisplayConfidence(bestScore, margin, metric)
      } : null
    };

    return slotResult;
  });

  return {
    slots: slotResults.map((result) => result.card),
    slotResults,
    debug: {
      metric: metricName,
      scoreDirection: metric.higherIsBetter ? 'higher-is-better' : 'lower-is-better',
      threshold: metric.threshold,
      marginThreshold: metric.margin,
      candidateCount: candidateTemplates.length,
      normalGeometry,
      dreamGeometry: dreamGeometry !== normalGeometry ? dreamGeometry : null,
      personalGeometryByCharacter: Object.fromEntries(
        Array.from(personalGeometryByChar.entries())
          .filter(([_, geom]) => geom && geom !== normalGeometry)
      )
    }
  };
}

module.exports = {
  NUM_SLOTS,
  STABLE_REGIONS,
  DEFAULT_METRIC,
  setCalibration,
  getActiveGeometry,
  buildTemplateIndex,
  detectSlots,
  normalizeCardName,
  // Exposed so name_strip_detector.js can reuse the dream-phase resolver
  // without duplicating its chromatic-rank logic.
  resolveDreamPhase,
  extractSubGray,
  extractSubRgb,
  getTemplateRawData
};
