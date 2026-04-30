#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));
const { encodePng, drawRect } = require(path.join(ROOT, 'calibration_debug_draw'));

const CONFIG_PATH = path.join(__dirname, 'name_strip_config.json');
const DATASET_PATH = path.join(__dirname, 'calibration_dataset.json');
const REPORT_PATH = path.join(__dirname, 'name_strip_geometry_report.json');
const SUMMARY_PATH = path.join(__dirname, 'name_strip_geometry_summary.md');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function round6(value) {
  return Math.round(value * 1000000) / 1000000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function* floatRange(min, max, step) {
  const epsilon = step / 10;
  for (let value = min; value <= max + epsilon; value += step) {
    yield round4(value);
  }
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'sample';
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadImage(relPath) {
  const absPath = path.join(ROOT, relPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Missing image: ${relPath}`);
  }
  const decoded = decodePng(absPath);
  return {
    relPath,
    absPath,
    width: decoded.width,
    height: decoded.height,
    rgba: decoded.data
  };
}

function bilinearSampleRgba(src, srcW, srcH, x, y, channel) {
  const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(y)));
  const x1 = Math.max(0, Math.min(srcW - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1));
  const wx = x - x0;
  const wy = y - y0;

  const i00 = (y0 * srcW + x0) * 4 + channel;
  const i10 = (y0 * srcW + x1) * 4 + channel;
  const i01 = (y1 * srcW + x0) * 4 + channel;
  const i11 = (y1 * srcW + x1) * 4 + channel;

  const v00 = src[i00];
  const v10 = src[i10];
  const v01 = src[i01];
  const v11 = src[i11];

  return (
    (1 - wx) * (1 - wy) * v00 +
    wx * (1 - wy) * v10 +
    (1 - wx) * wy * v01 +
    wx * wy * v11
  );
}

function cropNormalizedRgba(image, rect, targetHeight) {
  const cropX = clamp(Math.round(rect.x * image.width), 0, image.width - 1);
  const cropY = clamp(Math.round(rect.y * image.height), 0, image.height - 1);
  const cropW = Math.max(1, Math.min(image.width - cropX, Math.round(rect.width * image.width)));
  const cropH = Math.max(1, Math.min(image.height - cropY, Math.round(rect.height * image.height)));
  const targetWidth = Math.max(24, Math.round((rect.width / rect.height) * targetHeight));
  const out = new Uint8Array(targetWidth * targetHeight * 4);

  for (let dy = 0; dy < targetHeight; dy += 1) {
    for (let dx = 0; dx < targetWidth; dx += 1) {
      const sx = cropX + ((dx + 0.5) * cropW / targetWidth) - 0.5;
      const sy = cropY + ((dy + 0.5) * cropH / targetHeight) - 0.5;
      const di = (dy * targetWidth + dx) * 4;
      out[di] = Math.round(bilinearSampleRgba(image.rgba, image.width, image.height, sx, sy, 0));
      out[di + 1] = Math.round(bilinearSampleRgba(image.rgba, image.width, image.height, sx, sy, 1));
      out[di + 2] = Math.round(bilinearSampleRgba(image.rgba, image.width, image.height, sx, sy, 2));
      out[di + 3] = Math.round(bilinearSampleRgba(image.rgba, image.width, image.height, sx, sy, 3));
    }
  }

  return {
    rgba: out,
    width: targetWidth,
    height: targetHeight,
    pixelRect: { x: cropX, y: cropY, width: cropW, height: cropH }
  };
}

function rgbaToGrayAlpha(crop) {
  const pixelCount = crop.width * crop.height;
  const gray = new Float32Array(pixelCount);
  const alpha = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const r = crop.rgba[i * 4];
    const g = crop.rgba[i * 4 + 1];
    const b = crop.rgba[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    alpha[i] = crop.rgba[i * 4 + 3];
  }
  return {
    gray,
    alpha,
    width: crop.width,
    height: crop.height
  };
}

function compareGrayCrops(cropA, cropB, alphaThreshold) {
  if (cropA.width !== cropB.width || cropA.height !== cropB.height) {
    throw new Error('Crop size mismatch');
  }

  let count = 0;
  let sumA = 0;
  let sumB = 0;

  for (let i = 0; i < cropA.gray.length; i += 1) {
    if (cropA.alpha[i] < alphaThreshold || cropB.alpha[i] < alphaThreshold) continue;
    count += 1;
    sumA += cropA.gray[i];
    sumB += cropB.gray[i];
  }

  if (count === 0) {
    return { ncc: 0, grayMse: Infinity, pixelCount: 0 };
  }

  const meanA = sumA / count;
  const meanB = sumB / count;
  let mse = 0;
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;

  for (let i = 0; i < cropA.gray.length; i += 1) {
    if (cropA.alpha[i] < alphaThreshold || cropB.alpha[i] < alphaThreshold) continue;
    const a = cropA.gray[i];
    const b = cropB.gray[i];
    const da = a - meanA;
    const db = b - meanB;
    const diff = a - b;
    mse += diff * diff;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }

  const denom = Math.sqrt(denomA * denomB);
  return {
    ncc: denom > 0 ? numerator / denom : 0,
    grayMse: mse / count,
    pixelCount: count
  };
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function pairwiseAccuracy(positiveValues, negativeValues, positiveWinsWhen) {
  if (!positiveValues.length || !negativeValues.length) return null;
  let wins = 0;
  let ties = 0;
  let total = 0;
  for (const positive of positiveValues) {
    for (const negative of negativeValues) {
      total += 1;
      if (positive === negative) {
        ties += 1;
      } else if (positiveWinsWhen(positive, negative)) {
        wins += 1;
      }
    }
  }
  return total === 0 ? null : (wins + ties * 0.5) / total;
}

function buildClassSamples(classGroups) {
  const samples = [];
  let sampleIndex = 0;
  for (const group of classGroups) {
    for (const relPath of group.images) {
      sampleIndex += 1;
      samples.push({
        id: `sample-${String(sampleIndex).padStart(2, '0')}`,
        family: group.family,
        relPath,
        image: loadImage(relPath)
      });
    }
  }
  return samples;
}

function collectPairMetrics(samples, cropBySample, alphaThreshold) {
  const positive = [];
  const negative = [];

  for (let i = 0; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      const a = samples[i];
      const b = samples[j];
      const metrics = compareGrayCrops(cropBySample.get(a.id), cropBySample.get(b.id), alphaThreshold);
      const record = {
        a: a.id,
        b: b.id,
        familyA: a.family,
        familyB: b.family,
        ncc: metrics.ncc,
        grayMse: metrics.grayMse,
        pixelCount: metrics.pixelCount
      };
      if (a.family === b.family) positive.push(record);
      else negative.push(record);
    }
  }

  return { positive, negative };
}

function summarizeMetrics(pairs) {
  const nccValues = pairs.map((pair) => pair.ncc);
  const mseValues = pairs.map((pair) => pair.grayMse).filter((value) => Number.isFinite(value));
  return {
    count: pairs.length,
    nccMean: average(nccValues),
    nccMedian: median(nccValues),
    grayMseMean: average(mseValues),
    grayMseMedian: median(mseValues)
  };
}

function buildCandidateScore(positivePairs, negativePairs) {
  const posNcc = positivePairs.map((pair) => pair.ncc);
  const negNcc = negativePairs.map((pair) => pair.ncc);
  const posMse = positivePairs.map((pair) => pair.grayMse).filter((value) => Number.isFinite(value));
  const negMse = negativePairs.map((pair) => pair.grayMse).filter((value) => Number.isFinite(value));

  const nccAccuracy = pairwiseAccuracy(posNcc, negNcc, (positive, negative) => positive > negative) ?? -1;
  const mseAccuracy = pairwiseAccuracy(posMse, negMse, (positive, negative) => positive < negative) ?? -1;
  const posNccMean = average(posNcc) ?? 0;
  const negNccMean = average(negNcc) ?? 0;
  const posMseMean = average(posMse) ?? Infinity;
  const negMseMean = average(negMse) ?? Infinity;
  const normalizedMseGap = Number.isFinite(posMseMean) && Number.isFinite(negMseMean) && negMseMean > 0
    ? (negMseMean - posMseMean) / negMseMean
    : -1;

  const combined = (
    (nccAccuracy * 0.4) +
    (mseAccuracy * 0.4) +
    ((posNccMean - negNccMean) * 0.1) +
    (normalizedMseGap * 0.1)
  );

  return {
    combined,
    nccAccuracy,
    mseAccuracy,
    posNccMean,
    negNccMean,
    posMseMean,
    negMseMean,
    normalizedMseGap
  };
}

function evaluateRect(rect, samples, settings) {
  const cropBySample = new Map();
  for (const sample of samples) {
    const crop = cropNormalizedRgba(sample.image, rect, settings.resize.targetHeight);
    cropBySample.set(sample.id, rgbaToGrayAlpha(crop));
  }

  const { positive, negative } = collectPairMetrics(samples, cropBySample, settings.alphaThreshold);
  const score = buildCandidateScore(positive, negative);

  return {
    rect,
    score,
    positiveSummary: summarizeMetrics(positive),
    negativeSummary: summarizeMetrics(negative)
  };
}

function generateCoarseCandidates(bounds, coarseStep) {
  const candidates = [];
  const yValues = bounds.y.min === bounds.y.max ? [round4(bounds.y.min)] : Array.from(floatRange(bounds.y.min, bounds.y.max, coarseStep.y));
  const hValues = bounds.height.min === bounds.height.max ? [round4(bounds.height.min)] : Array.from(floatRange(bounds.height.min, bounds.height.max, coarseStep.height));
  for (const x of floatRange(bounds.x.min, bounds.x.max, coarseStep.x)) {
    for (const y of yValues) {
      for (const width of floatRange(bounds.width.min, bounds.width.max, coarseStep.width)) {
        for (const height of hValues) {
          if (x + width > 0.40) continue;
          if (y + height > 1.001) continue;
          candidates.push({ x, y, width, height });
        }
      }
    }
  }
  return candidates;
}

function generateFineCandidates(bestRect, bounds, fineRadius, fineStep) {
  const candidates = [];
  const xMin = clamp(bestRect.x - fineRadius.x, bounds.x.min, bounds.x.max);
  const xMax = clamp(bestRect.x + fineRadius.x, bounds.x.min, bounds.x.max);
  const yMin = bounds.y.min === bounds.y.max
    ? bounds.y.min
    : clamp(bestRect.y - fineRadius.y, bounds.y.min, bounds.y.max);
  const yMax = bounds.y.min === bounds.y.max
    ? bounds.y.max
    : clamp(bestRect.y + fineRadius.y, bounds.y.min, bounds.y.max);
  const wMin = clamp(bestRect.width - fineRadius.width, bounds.width.min, bounds.width.max);
  const wMax = clamp(bestRect.width + fineRadius.width, bounds.width.min, bounds.width.max);
  const hMin = bounds.height.min === bounds.height.max
    ? bounds.height.min
    : clamp(bestRect.height - fineRadius.height, bounds.height.min, bounds.height.max);
  const hMax = bounds.height.min === bounds.height.max
    ? bounds.height.max
    : clamp(bestRect.height + fineRadius.height, bounds.height.min, bounds.height.max);
  const yValues = yMin === yMax ? [round4(yMin)] : Array.from(floatRange(yMin, yMax, fineStep.y));
  const hValues = hMin === hMax ? [round4(hMin)] : Array.from(floatRange(hMin, hMax, fineStep.height));

  for (const x of floatRange(xMin, xMax, fineStep.x)) {
    for (const y of yValues) {
      for (const width of floatRange(wMin, wMax, fineStep.width)) {
        for (const height of hValues) {
          if (x + width > 0.40) continue;
          if (y + height > 1.001) continue;
          candidates.push({ x, y, width, height });
        }
      }
    }
  }
  return candidates;
}

function pickBestEvaluation(evaluations) {
  return evaluations.reduce((best, current) => {
    if (!best) return current;
    if (current.score.combined > best.score.combined) return current;
    if (current.score.combined < best.score.combined) return best;
    if (current.score.nccAccuracy > best.score.nccAccuracy) return current;
    if (current.score.nccAccuracy < best.score.nccAccuracy) return best;
    return current.score.mseAccuracy > best.score.mseAccuracy ? current : best;
  }, null);
}

function saveAnnotatedSamples(className, samples, rect, targetHeight) {
  const annotatedDir = path.join(OUTPUTS_DIR, 'annotated', className);
  const cropsDir = path.join(OUTPUTS_DIR, 'crops', className);
  ensureDir(annotatedDir);
  ensureDir(cropsDir);

  const manifest = [];

  for (const sample of samples) {
    const sampleName = `${sample.id}-${sanitizeName(sample.family)}`;
    const crop = cropNormalizedRgba(sample.image, rect, targetHeight);
    const annotated = new Uint8Array(sample.image.rgba);
    const px = crop.pixelRect;
    drawRect(annotated, sample.image.width, sample.image.height, px.x, px.y, px.width, px.height, 255, 128, 0, 3);

    const annotatedPath = path.join(annotatedDir, `${sampleName}.png`);
    const cropPath = path.join(cropsDir, `${sampleName}.png`);
    fs.writeFileSync(annotatedPath, encodePng(annotated, sample.image.width, sample.image.height));
    fs.writeFileSync(cropPath, encodePng(crop.rgba, crop.width, crop.height));

    manifest.push({
      id: sample.id,
      family: sample.family,
      relPath: sample.relPath,
      annotatedPath: path.relative(__dirname, annotatedPath),
      cropPath: path.relative(__dirname, cropPath),
      pixelRect: crop.pixelRect
    });
  }

  return manifest;
}

function chooseRecommendedMetric(score) {
  if (score.nccAccuracy >= score.mseAccuracy) {
    return {
      metric: 'ncc',
      accuracy: score.nccAccuracy,
      rationale: 'Higher positive-vs-negative pairwise accuracy on the winning crop.'
    };
  }
  return {
    metric: 'grayMse',
    accuracy: score.mseAccuracy,
    rationale: 'Higher positive-vs-negative pairwise accuracy on the winning crop.'
  };
}

function updateConfigWithWinners(config, classResults) {
  const next = JSON.parse(JSON.stringify(config));
  for (const result of classResults) {
    next.classes[result.className].selectedRect = result.finalRect;
    next.classes[result.className].status = result.rectSource;
  }
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

function writeSummary(report) {
  const lines = [];
  lines.push('# Name-Strip Geometry Summary');
  lines.push('');
  lines.push(`Generated from \`calibration_dataset.json\` using \`${path.basename(CONFIG_PATH)}\`.`);
  lines.push('');

  for (const result of report.classResults) {
    lines.push(`## ${result.className}`);
    lines.push('');
    lines.push(`- Auto rect: \`x=${result.winningRect.x}\`, \`y=${result.winningRect.y}\`, \`width=${result.winningRect.width}\`, \`height=${result.winningRect.height}\``);
    lines.push(`- Final rect: \`x=${result.finalRect.x}\`, \`y=${result.finalRect.y}\`, \`width=${result.finalRect.width}\`, \`height=${result.finalRect.height}\` (${result.rectSource})`);
    lines.push(`- Recommended metric: \`${result.recommendedMetric.metric}\` (${round6(result.recommendedMetric.accuracy)})`);
    lines.push(`- Positive mean NCC: \`${round6(result.winningScore.posNccMean)}\``);
    lines.push(`- Negative mean NCC: \`${round6(result.winningScore.negNccMean)}\``);
    lines.push(`- Positive mean gray MSE: \`${round6(result.winningScore.posMseMean)}\``);
    lines.push(`- Negative mean gray MSE: \`${round6(result.winningScore.negMseMean)}\``);
    lines.push(`- Combined search score: \`${round6(result.winningScore.combined)}\``);
    lines.push('');
  }

  lines.push('## Next step');
  lines.push('');
  lines.push('- Manually inspect the annotated and cropped outputs.');
  lines.push('- If the strips visually align, reuse these rectangles for the phase-2 benchmark harness.');
  lines.push('- If any class drifts into the art region, tighten the bounds or seed rect and rerun.');
  lines.push('');

  fs.writeFileSync(SUMMARY_PATH, lines.join('\n'));
}

function main() {
  ensureDir(OUTPUTS_DIR);

  const config = loadJson(CONFIG_PATH);
  const dataset = loadJson(DATASET_PATH);
  const classResults = [];

  for (const className of Object.keys(dataset.classes)) {
    const classConfig = config.classes[className];
    const samples = buildClassSamples(dataset.classes[className]);

    const coarseCandidates = generateCoarseCandidates(classConfig.bounds, config.search.coarseStep);
    const coarseEvaluations = coarseCandidates.map((rect) => evaluateRect(rect, samples, config));
    const coarseBest = pickBestEvaluation(coarseEvaluations);

    const fineCandidates = generateFineCandidates(
      coarseBest.rect,
      classConfig.bounds,
      config.search.fineRadius,
      config.search.fineStep
    );
    const fineEvaluations = fineCandidates.map((rect) => evaluateRect(rect, samples, config));
    const fineBest = pickBestEvaluation(fineEvaluations);
    const winner = pickBestEvaluation([coarseBest, fineBest]);
    const reviewedRect = classConfig.reviewRectOverride || null;
    const finalRect = reviewedRect || winner.rect;

    const sampleOutputs = saveAnnotatedSamples(className, samples, finalRect, config.resize.targetHeight);
    const recommendedMetric = chooseRecommendedMetric(winner.score);

    classResults.push({
      className,
      sampleCount: samples.length,
      familyCount: dataset.classes[className].length,
      searchSettings: {
        bounds: classConfig.bounds,
        coarseStep: config.search.coarseStep,
        fineRadius: config.search.fineRadius,
        fineStep: config.search.fineStep
      },
      coarseCandidateCount: coarseCandidates.length,
      fineCandidateCount: fineCandidates.length,
      winningRect: winner.rect,
      finalRect,
      rectSource: reviewedRect ? 'reviewed-override' : 'auto-selected',
      winningScore: {
        combined: round6(winner.score.combined),
        nccAccuracy: round6(winner.score.nccAccuracy),
        mseAccuracy: round6(winner.score.mseAccuracy),
        posNccMean: round6(winner.score.posNccMean),
        negNccMean: round6(winner.score.negNccMean),
        posMseMean: round6(winner.score.posMseMean),
        negMseMean: round6(winner.score.negMseMean),
        normalizedMseGap: round6(winner.score.normalizedMseGap)
      },
      positiveSummary: {
        count: winner.positiveSummary.count,
        nccMean: round6(winner.positiveSummary.nccMean),
        nccMedian: round6(winner.positiveSummary.nccMedian),
        grayMseMean: round6(winner.positiveSummary.grayMseMean),
        grayMseMedian: round6(winner.positiveSummary.grayMseMedian)
      },
      negativeSummary: {
        count: winner.negativeSummary.count,
        nccMean: round6(winner.negativeSummary.nccMean),
        nccMedian: round6(winner.negativeSummary.nccMedian),
        grayMseMean: round6(winner.negativeSummary.grayMseMean),
        grayMseMedian: round6(winner.negativeSummary.grayMseMedian)
      },
      recommendedMetric,
      sampleOutputs
    });
  }

  updateConfigWithWinners(config, classResults);

  const report = {
    generatedAt: new Date().toISOString(),
    datasetPath: path.relative(__dirname, DATASET_PATH),
    configPath: path.relative(__dirname, CONFIG_PATH),
    testedClasses: classResults.map((result) => result.className),
    classResults
  };

  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeSummary(report);

  console.log(`Wrote ${path.relative(ROOT, REPORT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, SUMMARY_PATH)}`);
}

main();
