'use strict';

// name_strip_detector.js
//
// Drop-in replacement for the detectSlots() call in main.js.
// Identifies each hand slot by matching only the left-side name strip
// (a ~14% wide × 60% tall column on the card) instead of the full card image.
//
// Strengths over full-image MSE:
//   - Insensitive to level differences (same strip across all levels of a family)
//   - Fast: one small NCC per candidate per slot
//
// Dream card phase (1–5) is resolved by delegating to slot_detector.resolveDreamPhase
// after the family is identified. The strip cannot disambiguate phases (only the
// art below the name differs); the chromatic-region resolver handles that.
//
// To revert to the old detector, swap the two commented lines in main.js.

const {
  buildTemplateIndex,
  normalizeCardName,
  NUM_SLOTS,
  resolveDreamPhase,
} = require('./slot_detector');
const { loadBaselineMasks } = require('./detection_masks');
const { getNativeImagePixelSize } = require('./native_image_pixels');
const { computeLayoutTransform } = require('./rect_scale');

// ── Strip geometry per card class ────────────────────────────────────────────
// From name_strip_config.json reviewRectOverride (Phase 1 calibration results).
// Side-job cards share the sect rect.
const STRIP_RECT = {
  sect:     { x: 0.0988, y: 0, width: 0.1412, height: 0.6 },
  dream:    { x: 0.0608, y: 0, width: 0.1392, height: 0.6 },
  personal: { x: 0.109,  y: 0, width: 0.1398, height: 0.6 },
};

// Canonical height used for all strip comparisons (matches benchmark pipeline).
const STRIP_CANONICAL_H = 192;

// NCC threshold and margin.
//
// Live captures across multiple screenshots: sect/personal cards score 0.85–0.93,
// dream cards score 0.63–0.70 (decorative variance in the strip area, not a
// geometry bug). Locked / empty slots peak at ~0.23 and have margin ~0.001.
// Cross-family margins for real detections stay ≥0.08, so a 0.55 floor admits
// dream cards while leaving 0.32 of headroom above noise. NCC_MARGIN (0.05)
// continues to gate same-family ambiguity independent of the absolute threshold.
const NCC_THRESHOLD = 0.55;
const NCC_MARGIN    = 0.05;

// Level disambiguator. After the family is identified, sibling level templates
// (same baseName, same class, same character) are re-scored over the bottom
// 20% of the canonical strip, split into 4 sub-bands of 5% each, taking the
// MIN ZNCC. Rationale: the level decoration sits in a narrow band somewhere
// in the bottom of the strip; whole-slice NCC averages that disagreement with
// surrounding agreement and ties levels for art like 金灵•针. Empirically the
// min-sub-band approach drops worst-case within-family NCC from 0.65 → -0.00
// across 1093 pairs and breaks the 金灵•针 tie (margin 0.003 → 0.257). See
// debug/name_strip_detection_check/test_weighted_ncc.js for the full study.
//
// If no sibling beats the original by DISAMBIG_MARGIN, keep whatever the
// family-NCC step picked — disambiguator is conservative.
const DISAMBIG_BOTTOM_FRACTION = 0.20;
const DISAMBIG_SUB_BANDS       = 4;
const DISAMBIG_MARGIN          = 0.05;

// The NCC peak is 1-2px wide in both x and y. Calibration rounding can put the
// strip 1-2px off in either axis, dropping NCC from ~0.75 to ~0.48. Search a
// small neighbourhood and take the best score.
//
// These are baseline values tuned at the calibration's native pixel scale.
// At higher capture resolutions, calibration rounding error grows linearly,
// so the effective search range is computed per-call as ceil(BASE * scale).
const Y_SEARCH_RANGE_BASE = 4;
const X_SEARCH_RANGE_BASE = 2;

// ── Dream / personal card geometry (mirrors slot_detector.js) ────────────────
// Dream cards render slightly smaller and shifted right vs the normal slot anchor.
const DEFAULT_DREAM_RATIO    = { width: 0.925, height: 0.977 };
const DEFAULT_DREAM_X_OFFSET = 8;  // pixels in calibration coordinate space

// Personal card geometry overrides by character name.
const PERSONAL_GEO_OVERRIDES = {
  FengXu: {
    ratio:   { width: 1.104, height: 1.102 },
    xOffset: -10,
    yOffset: -16,
  }
};
const PERSONAL_GEO_DEFAULT = { ratio: { width: 1, height: 1 }, xOffset: 0, yOffset: 0 };

// ── Module state ─────────────────────────────────────────────────────────────

let activeCalibration = null;

// Strip cache: keyed by template filePath → { gray: Float32Array, w, h }
// Rebuilt whenever imagesDir changes.
let stripCacheDir = null;
let stripCache    = null;

// Baseline-mask cache for dream-phase resolution. Loaded once per imagesDir.
let baselineMasksDir   = null;
let baselineMasksCache = null;

// ── Calibration ──────────────────────────────────────────────────────────────

function setCalibration(data) {
  activeCalibration = data || null;
}

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
    dreamXOffset:     typeof s.dreamXOffset === 'number' ? s.dreamXOffset : null,
  };
}

// ── Image utilities ──────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function bilinearSample(gray, w, h, x, y) {
  const x0 = clamp(Math.floor(x), 0, w - 1);
  const y0 = clamp(Math.floor(y), 0, h - 1);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const wx = x - x0, wy = y - y0;
  return (
    (1 - wx) * (1 - wy) * gray[y0 * w + x0] +
    wx * (1 - wy) * gray[y0 * w + x1] +
    (1 - wx) * wy * gray[y1 * w + x0] +
    wx * wy * gray[y1 * w + x1]
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

// Convert an Electron nativeImage (bitmap = BGRA) to a grayscale Float32Array.
function nativeImageToGray(image) {
  const bitmap = image.toBitmap();
  const { width, height } = getNativeImagePixelSize(image);
  const gray = new Float32Array(width * height);
  for (let i = 0, px = 0; i < bitmap.length; i += 4, px += 1) {
    // Electron bitmap is BGRA
    gray[px] = 0.114 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.299 * bitmap[i + 2];
  }
  return { gray, width, height };
}

// Convert an Electron nativeImage (BGRA) to an interleaved RGB Float32Array,
// matching the {rgb, width, height} format slot_detector's resolveDreamPhase
// expects for srcRgbData.
function nativeImageToRgb(image) {
  const bitmap = image.toBitmap();
  const { width, height } = getNativeImagePixelSize(image);
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0, px = 0; i < bitmap.length; i += 4, px += 3) {
    rgb[px]     = bitmap[i + 2]; // R from B-position
    rgb[px + 1] = bitmap[i + 1]; // G
    rgb[px + 2] = bitmap[i];     // B from R-position
  }
  return { rgb, width, height };
}

// ── Strip extraction ─────────────────────────────────────────────────────────

function stripRectForTemplate(tmpl) {
  if (tmpl.isPersonal) return STRIP_RECT.personal;
  if (tmpl.isDream)    return STRIP_RECT.dream;
  return STRIP_RECT.sect;
}

// Extract the canonical name strip from a template nativeImage as a
// grayscale Float32Array resized to STRIP_CANONICAL_H tall.
function extractCanonicalStrip(image, rect) {
  const { gray, width, height } = nativeImageToGray(image);
  const cx = clamp(Math.round(rect.x * width),  0, width  - 1);
  const cy = clamp(Math.round(rect.y * height), 0, height - 1);
  const cw = Math.max(1, Math.min(width  - cx, Math.round(rect.width  * width)));
  const ch = Math.max(1, Math.min(height - cy, Math.round(rect.height * height)));

  const crop = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      crop[y * cw + x] = gray[(cy + y) * width + (cx + x)];
    }
  }

  const canonH = STRIP_CANONICAL_H;
  // Use the ACTUAL pixel aspect ratio (cw/ch) of the crop, not rect.width/rect.height.
  // rect.width/rect.height assumes a square card; for a ~0.6-AR card the two differ
  // significantly (0.138 vs 0.232), causing template and screenshot strips to be
  // distorted in opposite directions and degrading NCC.
  const canonW = Math.max(24, Math.round((cw / ch) * canonH));
  return { gray: resizeGray(crop, cw, ch, canonW, canonH), w: canonW, h: canonH };
}

// Extract the name strip region from the screenshot for a given slot rect,
// returning the raw crop (not yet resized to canonical size).
//
// Calibration slotY/slotHeight come from NCC-fitting the full card template
// against the screenshot (calibrator.js findCardSlots), so they already mark
// the actual card top and full card height. The strip rect is applied directly
// — same as how it's applied to template PNGs in extractCanonicalStrip.
function extractScreenStripCrop(srcGray, srcW, srcH, slotRect, rect) {
  const sx = Math.round(slotRect.x + rect.x * slotRect.width);
  const sy = Math.round(slotRect.y + rect.y * slotRect.height);
  const sw = Math.max(1, Math.round(rect.width  * slotRect.width));
  const sh = Math.max(1, Math.round(rect.height * slotRect.height));

  const x0 = Math.max(0, sx),         y0 = Math.max(0, sy);
  const x1 = Math.min(srcW, sx + sw), y1 = Math.min(srcH, sy + sh);
  const aw = x1 - x0, ah = y1 - y0;
  if (aw <= 0 || ah <= 0) return null;

  const crop = new Float32Array(aw * ah);
  for (let y = 0; y < ah; y += 1) {
    for (let x = 0; x < aw; x += 1) {
      crop[y * aw + x] = srcGray[(y0 + y) * srcW + (x0 + x)];
    }
  }
  return { gray: crop, w: aw, h: ah };
}

// ── Level disambiguator ─────────────────────────────────────────────────────

// Min ZNCC across DISAMBIG_SUB_BANDS horizontal sub-bands inside the bottom
// DISAMBIG_BOTTOM_FRACTION of a (w × h) canonical strip. Both inputs must be
// the same dimensions; leftover rows fold into the last band.
function bottomMinSubBandZncc(slotGray, tmplGray, w, h) {
  const bottomH = Math.max(1, Math.round(h * DISAMBIG_BOTTOM_FRACTION));
  const startRow = h - bottomH;
  const subH = Math.max(1, Math.floor(bottomH / DISAMBIG_SUB_BANDS));
  let minScore = +Infinity;
  for (let band = 0; band < DISAMBIG_SUB_BANDS; band += 1) {
    const yStart = startRow + band * subH;
    const yEnd   = (band === DISAMBIG_SUB_BANDS - 1) ? (startRow + bottomH) : (yStart + subH);
    const bandRows = yEnd - yStart;
    if (bandRows <= 0) continue;
    const offset = yStart * w;
    const len    = bandRows * w;
    const slotSub = slotGray.subarray(offset, offset + len);
    const tmplSub = tmplGray.subarray(offset, offset + len);
    const score = zncc(slotSub, tmplSub, len);
    if (score < minScore) minScore = score;
  }
  return Number.isFinite(minScore) ? minScore : -Infinity;
}

// Re-pick which level template wins for an already-identified family. Sibling
// templates share baseName + class + character (so they're alternate levels
// of the same card art); they get scored over the bottom-20% min-sub-band
// region. If the top sibling beats the second by DISAMBIG_MARGIN, return it;
// otherwise return the original best (conservative — never harms accuracy).
function disambiguateLevel(best, scored, srcGrayData) {
  if (!best || best.isDream) return best;

  const sameFamily = (c) =>
    c.baseName === best.baseName &&
    !!c.isPersonal === !!best.isPersonal &&
    (best.isPersonal ? c.personalCharacter === best.personalCharacter : true) &&
    !c.isDream;

  const siblings = scored.filter(sameFamily);
  if (siblings.length < 2) return best;

  const stripRect = stripRectForTemplate(best);
  const { gray: srcGray, width: srcW, height: srcH } = srcGrayData;

  const scoresByTemplate = [];
  for (const t of siblings) {
    const canon = stripCache.get(t.filePath);
    if (!canon) continue;
    const dx = t.bestDx | 0;
    const dy = t.bestDy | 0;
    const searchRect = (dx === 0 && dy === 0)
      ? t.slotRect
      : { ...t.slotRect, x: t.slotRect.x + dx, y: t.slotRect.y + dy };
    const crop = extractScreenStripCrop(srcGray, srcW, srcH, searchRect, stripRect);
    if (!crop) continue;
    const screenResized = resizeGray(crop.gray, crop.w, crop.h, canon.w, canon.h);
    const score = bottomMinSubBandZncc(screenResized, canon.gray, canon.w, canon.h);
    if (Number.isFinite(score)) scoresByTemplate.push({ tmpl: t, score });
  }

  if (scoresByTemplate.length < 2) return best;
  scoresByTemplate.sort((a, b) => b.score - a.score);
  const margin = scoresByTemplate[0].score - scoresByTemplate[1].score;
  return margin >= DISAMBIG_MARGIN ? scoresByTemplate[0].tmpl : best;
}

// ── Strip cache ───────────────────────────────────────────────────────────────

function buildStripCache(templateIndex) {
  const cache = new Map();
  for (const templates of templateIndex.values()) {
    for (const tmpl of templates) {
      if (cache.has(tmpl.filePath)) continue;
      const rect = stripRectForTemplate(tmpl);
      try {
        cache.set(tmpl.filePath, extractCanonicalStrip(tmpl.originalImage, rect));
      } catch (_e) {
        // Skip unloadable templates silently
      }
    }
  }
  return cache;
}

// ── Slot geometry ─────────────────────────────────────────────────────────────

// Accepts a pre-computed targetSize so toBitmap() is not called repeatedly.
function getScaledSlotRectForSize(slotIndex, targetSize, geometry) {
  const baseW = Number(geometry.baseScreenWidth)  || targetSize.width  || 1;
  const baseH = Number(geometry.baseScreenHeight) || targetSize.height || 1;
  const transform = computeLayoutTransform({ width: baseW, height: baseH }, targetSize);
  return {
    x:      Math.round(geometry.slotXPositions[slotIndex] * transform.scaleX),
    y:      Math.round(geometry.slotY    * transform.scaleY),
    width:  Math.max(1, Math.round(geometry.slotWidth  * transform.sizeScaleX)),
    height: Math.max(1, Math.round(geometry.slotHeight * transform.sizeScaleY)),
  };
}

// ── Main detection function ───────────────────────────────────────────────────

function detectSlotsNameStrip(sourceImage, handCardNames, imagesDir) {
  if (!sourceImage || sourceImage.isEmpty()) {
    return { slots: Array(NUM_SLOTS).fill(null), slotResults: [], debug: { reason: 'empty-source' } };
  }

  const active = getActiveGeometry();
  if (!active) {
    return { slots: Array(NUM_SLOTS).fill(null), slotResults: [], debug: { reason: 'not-calibrated' } };
  }

  const templateIndex = buildTemplateIndex(imagesDir);

  if (imagesDir !== stripCacheDir || !stripCache) {
    stripCache    = buildStripCache(templateIndex);
    stripCacheDir = imagesDir;
  }

  if (imagesDir !== baselineMasksDir || !baselineMasksCache) {
    baselineMasksCache = loadBaselineMasks(imagesDir);
    baselineMasksDir   = imagesDir;
  }

  // ── Dream geometry (same logic as slot_detector.js) ──────────────────────
  const storedRatio = active.dreamSlotRatio;
  const dreamRatio = (storedRatio && (storedRatio.width !== 1 || storedRatio.height !== 1))
    ? storedRatio
    : DEFAULT_DREAM_RATIO;
  const dreamXOff = typeof active.dreamXOffset === 'number'
    ? active.dreamXOffset
    : DEFAULT_DREAM_X_OFFSET;
  const dreamGeometry = {
    ...active,
    slotXPositions: active.slotXPositions.map((x) => x + dreamXOff),
    slotWidth:  Math.max(1, Math.round(active.slotWidth  * dreamRatio.width)),
    slotHeight: Math.max(1, Math.round(active.slotHeight * dreamRatio.height)),
  };

  // ── Personal geometry per character (lazy cache) ─────────────────────────
  const personalGeometryCache = new Map();
  function getPersonalGeometry(charName) {
    const key = charName || '';
    if (personalGeometryCache.has(key)) return personalGeometryCache.get(key);
    const cfg = PERSONAL_GEO_OVERRIDES[key] || PERSONAL_GEO_DEFAULT;
    const geom = (cfg === PERSONAL_GEO_DEFAULT) ? active : {
      ...active,
      slotXPositions: active.slotXPositions.map((x) => x + cfg.xOffset),
      slotY:      active.slotY + cfg.yOffset,
      slotWidth:  Math.max(1, Math.round(active.slotWidth  * cfg.ratio.width)),
      slotHeight: Math.max(1, Math.round(active.slotHeight * cfg.ratio.height)),
    };
    personalGeometryCache.set(key, geom);
    return geom;
  }

  // ── Collect candidate templates ───────────────────────────────────────────
  // Mirrors slot_detector.js candidate collection:
  //   • Dream card names carry a phase digit ("梦幻剑1") — strip it and look up
  //     both the raw and stripped key so phase-encoded names always find templates.
  //   • Dream templates must be isSeasonal (matches slot_detector.js filter).
  //   • Personal card safety rail: if any personal variant exists for a name,
  //     drop all non-personal variants of that name.
  const candidateTemplates = [];
  const seenTemplateFiles  = new Set();

  for (const cardName of handCardNames) {
    const normalized    = normalizeCardName(cardName);
    const isDream       = normalized.startsWith('梦');
    const stripped      = normalized.replace(/\d+$/, '');
    const lookupKeys    = normalized !== stripped ? [normalized, stripped] : [normalized];

    const variants = lookupKeys
      .flatMap((key) => templateIndex.get(key) || [])
      .filter((t, idx, arr) => arr.indexOf(t) === idx)
      .filter((t) => {
        if (isDream) return t.isDream && t.isSeasonal;
        return !t.isDream;
      })
      .filter((t) => stripCache.has(t.filePath));

    for (const t of variants) {
      if (seenTemplateFiles.has(t.filePath)) continue;
      seenTemplateFiles.add(t.filePath);
      candidateTemplates.push(t);
    }
  }

  // Personal safety rail
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

  if (candidateTemplates.length === 0) {
    return { slots: Array(NUM_SLOTS).fill(null), slotResults: [], debug: { reason: 'no-candidates' } };
  }

  // Compute screenshotSize once — calling getNativeImagePixelSize (which calls
  // toBitmap) repeatedly returns inconsistent sizes on some platforms, which
  // causes all scaled slot rects to have garbage coordinates.
  const screenshotSize = getNativeImagePixelSize(sourceImage);
  const { gray: srcGray, width: srcW, height: srcH } = nativeImageToGray(sourceImage);
  // RGB form is needed by resolveDreamPhase (chromatic-region averaging).
  // Only built when at least one dream candidate exists, to keep cost down on
  // the common no-dream-in-hand case.
  const hasDreamCandidate = candidateTemplates.some((t) => t.isDream);
  const srcGrayData = { gray: srcGray, width: srcW, height: srcH };
  const srcRgbData  = hasDreamCandidate ? nativeImageToRgb(sourceImage) : null;

  // Pre-compute normal and dream slot rects for all slots.
  const normalSlotRects = Array.from({ length: NUM_SLOTS }, (_, i) =>
    getScaledSlotRectForSize(i, screenshotSize, active)
  );
  const dreamSlotRects = Array.from({ length: NUM_SLOTS }, (_, i) =>
    getScaledSlotRectForSize(i, screenshotSize, dreamGeometry)
  );

  // Scale the dx/dy search window with the capture-vs-calibration transform
  // so we cover the same physical search distance regardless of resolution.
  // Calibration rounding error is ±0.5 calibration-pixel; at 2× capture scale
  // that's ±1 capture-pixel, so a fixed pixel window undershoots at high res.
  const captureTransform = computeLayoutTransform(
    { width: active.baseScreenWidth, height: active.baseScreenHeight },
    screenshotSize
  );
  const xSearchRange = Math.max(X_SEARCH_RANGE_BASE, Math.ceil(X_SEARCH_RANGE_BASE * captureTransform.scaleX));
  const ySearchRange = Math.max(Y_SEARCH_RANGE_BASE, Math.ceil(Y_SEARCH_RANGE_BASE * captureTransform.scaleY));

  // Personal slot rects per character, computed lazily.
  const personalSlotRectsByChar = new Map();
  function getPersonalSlotRects(charName) {
    const key = charName || '';
    if (personalSlotRectsByChar.has(key)) return personalSlotRectsByChar.get(key);
    const geom = getPersonalGeometry(key);
    const rects = (geom === active)
      ? normalSlotRects
      : Array.from({ length: NUM_SLOTS }, (_, i) => getScaledSlotRectForSize(i, screenshotSize, geom));
    personalSlotRectsByChar.set(key, rects);
    return rects;
  }

  const slotResults = Array.from({ length: NUM_SLOTS }, (_, slotIndex) => {
    const normalSlotRect = normalSlotRects[slotIndex];
    const dreamSlotRect  = dreamSlotRects[slotIndex];

    // Score every candidate against this slot's strip region.
    // Each card type uses its own class-specific slot rect AND strip rect.
    const scored = [];
    for (const tmpl of candidateTemplates) {
      // Pick the slot rect that matches how this card type renders on screen.
      let cardRect;
      if (tmpl.isDream) {
        cardRect = dreamSlotRect;
      } else if (tmpl.isPersonal) {
        cardRect = getPersonalSlotRects(tmpl.personalCharacter)[slotIndex];
      } else {
        cardRect = normalSlotRect;
      }

      const stripRect = stripRectForTemplate(tmpl);
      const canon = stripCache.get(tmpl.filePath);

      // Fine x+y search: the NCC peak is 1-2px wide in both axes. Calibration
      // rounding can put the strip 1-2px off in either direction (more at
      // higher capture resolutions — see xSearchRange/ySearchRange above).
      let nccScore = -Infinity;
      let bestDx = 0, bestDy = 0;
      for (let dy = -ySearchRange; dy <= ySearchRange; dy += 1) {
        for (let dx = -xSearchRange; dx <= xSearchRange; dx += 1) {
          const searchRect = (dy === 0 && dx === 0)
            ? cardRect
            : { ...cardRect, x: cardRect.x + dx, y: cardRect.y + dy };
          const crop = extractScreenStripCrop(srcGray, srcW, srcH, searchRect, stripRect);
          if (!crop) continue;
          const screenResized = resizeGray(crop.gray, crop.w, crop.h, canon.w, canon.h);
          const score = zncc(screenResized, canon.gray, canon.w * canon.h);
          if (score > nccScore) { nccScore = score; bestDx = dx; bestDy = dy; }
        }
      }
      if (nccScore === -Infinity) continue;
      // metrics.ncc is read by slot_detector.resolveDreamPhase when it logs
      // each phase candidate's familyScore; including it here keeps the debug
      // payload consistent with the old detector's shape.
      // bestDx/bestDy are reused by disambiguateLevel so it doesn't have to
      // re-search for each sibling template.
      scored.push({
        ...tmpl,
        ncc: nccScore,
        slotRect: cardRect,
        bestDx,
        bestDy,
        metrics: { ncc: nccScore },
      });
    }

    if (scored.length === 0) {
      return buildSlotResult(slotIndex, normalSlotRect, dreamSlotRect, null, null, null, false, 0, Infinity);
    }

    scored.sort((a, b) => b.ncc - a.ncc);
    const best = scored[0];

    // Margin = gap between best and the best candidate from a different card name.
    let second = null;
    for (const c of scored) {
      if (c.baseName !== best.baseName) { second = c; break; }
    }
    const margin = second ? best.ncc - second.ncc : Infinity;

    const accepted = best.ncc >= NCC_THRESHOLD && margin >= NCC_MARGIN;

    // Dream phase resolution: the strip only contains the family name, so the
    // top NCC score is shared across all 5 phase variants. Delegate to the
    // chromatic-region resolver in slot_detector.js.
    const dreamPhaseResult = (accepted && best.isDream && srcRgbData)
      ? resolveDreamPhase(best, scored, srcGrayData, srcRgbData, baselineMasksCache, 'ncc')
      : null;
    let resolvedTemplate = dreamPhaseResult?.template || best;
    const resolvedPhase  = dreamPhaseResult?.phase ?? (best.isDream ? null : null);

    // Bottom-20% min-sub-band level disambiguator. Runs after the family is
    // identified; only for non-dream cards (dream uses phase, not level).
    if (accepted && !best.isDream) {
      resolvedTemplate = disambiguateLevel(resolvedTemplate, scored, srcGrayData);
    }

    // Personal rect for the debug overlay: prefer winning character, then any personal candidate.
    let personalSlotRect = null;
    if (candidateTemplates.some((t) => t.isPersonal)) {
      const winnerChar = best?.isPersonal ? best.personalCharacter : null;
      const fallbackChar = winnerChar ||
        (candidateTemplates.find((t) => t.isPersonal)?.personalCharacter || null);
      if (fallbackChar) {
        const pGeo = getPersonalGeometry(fallbackChar);
        if (pGeo !== active) {
          personalSlotRect = getPersonalSlotRects(fallbackChar)[slotIndex];
        }
      }
    }

    return buildSlotResult(
      slotIndex, normalSlotRect, dreamSlotRect, personalSlotRect,
      best, second, accepted, best.ncc, margin,
      resolvedTemplate, resolvedPhase, dreamPhaseResult,
    );
  });

  return {
    slots: slotResults.map((r) => r.card),
    slotResults,
    debug: {
      metric:           'ncc',
      scoreDirection:   'higher-is-better',
      threshold:        NCC_THRESHOLD,
      marginThreshold:  NCC_MARGIN,
      candidateCount:   candidateTemplates.length,
      searchRange:      { x: xSearchRange, y: ySearchRange },
      captureScale:     { x: captureTransform.scaleX, y: captureTransform.scaleY },
      normalGeometry:   active,
      dreamGeometry,
      personalGeometryByCharacter: Object.fromEntries(personalGeometryCache),
    },
  };
}

function buildSlotResult(
  slotIndex, normalSlotRect, dreamSlotRect, personalSlotRect,
  best, second, accepted, bestScore, margin,
  resolvedTemplate, resolvedPhase, dreamPhaseResult,
) {
  const roundedScore  = Number.isFinite(bestScore) ? Number(bestScore.toFixed(4))  : bestScore;
  const roundedMargin = Number.isFinite(margin)     ? Number(margin.toFixed(4))     : margin;

  // Simple confidence: linear scale from threshold (0) to 1.0 (1).
  const confidence = (accepted && Number.isFinite(bestScore))
    ? Math.min(1, Number(((bestScore - NCC_THRESHOLD) / (1 - NCC_THRESHOLD)).toFixed(4)))
    : 0;

  // Use the winning template's actual slot rect (dream/personal/normal) so the
  // debug box aligns with the card. Fall back to normal when nothing was accepted.
  const winningRect = (accepted && best?.slotRect) ? best.slotRect : normalSlotRect;

  // Prefer the phase-resolved template's filename for display when available
  // (so the user sees e.g. "梦•混元碎击1.png" instead of whichever phase the
  // strip-NCC happened to tie-break on).
  const displayTemplate = (accepted ? (resolvedTemplate || best) : null);

  return {
    slotIndex,
    rect: winningRect,
    candidateRects: {
      normal:   normalSlotRect,
      dream:    dreamSlotRect ?? null,
      personal: personalSlotRect ?? null,
    },
    winningTemplate: accepted ? {
      name:               displayTemplate.baseName,
      phase:              resolvedPhase ?? null,
      isDream:            !!displayTemplate.isDream,
      isPersonal:         !!displayTemplate.isPersonal,
      score:              roundedScore,
      templateFile:       displayTemplate.fileName,
      phaseScore:         dreamPhaseResult?.phaseScore ?? null,
      phaseMargin:        dreamPhaseResult?.phaseMargin ?? null,
      phaseAmbiguous:     !!dreamPhaseResult?.phaseAmbiguous,
      phaseScoringMode:   dreamPhaseResult?.phaseScoringMode ?? null,
      phaseMaskPixelCount: dreamPhaseResult?.phaseMaskPixelCount ?? null,
    } : null,
    metric:           'ncc',
    accepted,
    bestScore:        roundedScore,
    margin:           roundedMargin,
    displayConfidence: confidence,
    bestCandidate:    best   ? debugCandidate(best,   best.ncc)   : null,
    secondCandidate:  second ? debugCandidate(second, second.ncc) : null,
    dreamPhaseCandidates:    dreamPhaseResult?.candidates || null,
    dreamPhaseScore:         dreamPhaseResult?.phaseScore ?? null,
    dreamPhaseMargin:        dreamPhaseResult?.phaseMargin ?? null,
    dreamPhaseAmbiguous:     !!dreamPhaseResult?.phaseAmbiguous,
    dreamPhaseScoringMode:   dreamPhaseResult?.phaseScoringMode ?? null,
    dreamPhaseMaskPixelCount: dreamPhaseResult?.phaseMaskPixelCount ?? null,
    dreamPhaseMaskReason:    dreamPhaseResult?.phaseMaskReason ?? null,
    allCandidates:           undefined,
    card: accepted ? {
      name:         displayTemplate.baseName,
      level:        displayTemplate.level,
      phase:        resolvedPhase ?? null,
      isDream:      !!displayTemplate.isDream,
      isPersonal:   !!displayTemplate.isPersonal,
      templateFile: displayTemplate.fileName,
      confidence,
    } : null,
  };
}

function debugCandidate(tmpl, nccScore) {
  return {
    name:         tmpl.baseName,
    level:        tmpl.level,
    phase:        tmpl.phase ?? null,
    isDream:      !!tmpl.isDream,
    templateFile: tmpl.fileName,
    primaryScore: Number(nccScore.toFixed(4)),
    metrics:      { ncc: Number(nccScore.toFixed(4)) },
  };
}

module.exports = {
  detectSlotsNameStrip,
  setCalibration,
  NUM_SLOTS,
};
