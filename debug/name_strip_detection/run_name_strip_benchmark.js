#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));

const CONFIG_PATH = path.join(__dirname, 'name_strip_config.json');
const DATASET_PATH = path.join(__dirname, 'calibration_dataset.json');
const REPORT_PATH = path.join(__dirname, 'name_strip_benchmark_report.json');
const SUMMARY_PATH = path.join(__dirname, 'name_strip_benchmark_summary.md');

const BUCKET_SIZE = 10;
const RNG_SEED = 20260427;

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function round6(value) {
  return Math.round(value * 1000000) / 1000000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(array, rng) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function loadImage(relPath) {
  const absPath = path.join(ROOT, relPath);
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
  return (
    (1 - wx) * (1 - wy) * src[i00] +
    wx * (1 - wy) * src[i10] +
    (1 - wx) * wy * src[i01] +
    wx * wy * src[i11]
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
    height: targetHeight
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
  return { gray, alpha, width: crop.width, height: crop.height };
}

function compareGrayCrops(cropA, cropB, alphaThreshold) {
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

function buildSamples(dataset) {
  const samples = [];
  let sampleIndex = 0;
  for (const className of Object.keys(dataset.classes)) {
    for (const group of dataset.classes[className]) {
      for (const relPath of group.images) {
        sampleIndex += 1;
        samples.push({
          id: `sample-${String(sampleIndex).padStart(2, '0')}`,
          className,
          family: group.family,
          relPath,
          image: loadImage(relPath)
        });
      }
    }
  }
  return samples;
}

function buildCropCache(samples, config) {
  const cache = new Map();
  for (const sample of samples) {
    const rect = config.classes[sample.className].selectedRect;
    const crop = cropNormalizedRgba(sample.image, rect, config.resize.targetHeight);
    cache.set(sample.id, rgbaToGrayAlpha(crop));
  }
  return cache;
}

function uniquePairsFromSamples(samples, predicate) {
  const pairs = [];
  for (let i = 0; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      const a = samples[i];
      const b = samples[j];
      if (!predicate(a, b)) continue;
      pairs.push([a, b]);
    }
  }
  return pairs;
}

function samplePairs(allPairs, count, rng, label) {
  const shuffled = shuffle(allPairs, rng);
  if (shuffled.length < count) {
    throw new Error(`Bucket ${label} only has ${shuffled.length} pairs; need ${count}`);
  }
  return shuffled.slice(0, count);
}

function scorePair(a, b, cropCache, config) {
  const metrics = compareGrayCrops(
    cropCache.get(a.id),
    cropCache.get(b.id),
    config.alphaThreshold
  );
  return {
    ncc: round6(metrics.ncc),
    grayMse: round6(metrics.grayMse),
    pixelCount: metrics.pixelCount
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

function summarizeBucket(records) {
  const nccs = records.map((record) => record.metrics.ncc);
  const mses = records.map((record) => record.metrics.grayMse);
  const actualMatchCount = records.filter((record) => record.actualMatch).length;
  return {
    count: records.length,
    actualMatchCount,
    actualNonMatchCount: records.length - actualMatchCount,
    nccMean: round6(average(nccs)),
    nccMedian: round6(median(nccs)),
    grayMseMean: round6(average(mses)),
    grayMseMedian: round6(median(mses))
  };
}

function computeThresholdStats(records, metricName, predicate) {
  if (!records.length) return null;
  const sortedUniqueThresholds = [...new Set(records.map((record) => record.metrics[metricName]))].sort((a, b) => a - b);
  let best = null;

  for (const threshold of sortedUniqueThresholds) {
    let tp = 0;
    let tn = 0;
    let fp = 0;
    let fn = 0;

    for (const record of records) {
      const predictedMatch = predicate(record.metrics[metricName], threshold);
      const actualMatch = record.actualMatch;
      if (predictedMatch && actualMatch) tp += 1;
      else if (predictedMatch && !actualMatch) fp += 1;
      else if (!predictedMatch && actualMatch) fn += 1;
      else tn += 1;
    }

    const accuracy = (tp + tn) / records.length;
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall = tp + fn > 0 ? tp / (tp + fn) : null;
    const f1 = precision != null && recall != null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

    const candidate = {
      threshold: round6(threshold),
      accuracy: round6(accuracy),
      precision: precision == null ? null : round6(precision),
      recall: recall == null ? null : round6(recall),
      f1: f1 == null ? null : round6(f1),
      confusion: { tp, tn, fp, fn }
    };

    if (
      !best ||
      candidate.accuracy > best.accuracy ||
      (candidate.accuracy === best.accuracy && (candidate.f1 || -1) > (best.f1 || -1))
    ) {
      best = candidate;
    }
  }

  return best;
}

function buildDecisionSummary(bucketResults) {
  const labeledRecords = bucketResults
    .filter((bucket) => bucket.expectedMatch !== null)
    .flatMap((bucket) => bucket.pairs);

  const nccThreshold = computeThresholdStats(labeledRecords, 'ncc', (value, threshold) => value >= threshold);
  const grayMseThreshold = computeThresholdStats(labeledRecords, 'grayMse', (value, threshold) => value <= threshold);

  let recommendation = 'insufficient-data';
  if (nccThreshold && grayMseThreshold) {
    const bestAccuracy = Math.max(nccThreshold.accuracy, grayMseThreshold.accuracy);
    if (bestAccuracy >= 0.95) recommendation = 'strong-fallback-or-reranker-candidate';
    else if (bestAccuracy >= 0.85) recommendation = 'reasonable-reranker-candidate';
    else recommendation = 'needs-hybrid-signal';
  }

  return {
    labeledPairCount: labeledRecords.length,
    nccThreshold,
    grayMseThreshold,
    recommendation
  };
}

function main() {
  const config = loadJson(CONFIG_PATH);
  const dataset = loadJson(DATASET_PATH);
  const samples = buildSamples(dataset);
  const cropCache = buildCropCache(samples, config);
  const rng = mulberry32(RNG_SEED);

  const sect = samples.filter((sample) => sample.className === 'sect');
  const dream = samples.filter((sample) => sample.className === 'dream');
  const personal = samples.filter((sample) => sample.className === 'personal');

  const buckets = [
    {
      name: 'sect_same_pool_different_family',
      expectedMatch: false,
      pairs: uniquePairsFromSamples(sect, (a, b) => a.family !== b.family)
    },
    {
      name: 'same_card_different_level',
      expectedMatch: true,
      pairs: uniquePairsFromSamples(samples, (a, b) => a.family === b.family && a.relPath !== b.relPath)
    },
    {
      name: 'truly_random',
      expectedMatch: null,
      pairs: uniquePairsFromSamples(samples, (a, b) => a.relPath !== b.relPath)
    },
    {
      name: 'sect_vs_personal',
      expectedMatch: false,
      pairs: uniquePairsFromSamples(samples, (a, b) => {
        return (a.className === 'sect' && b.className === 'personal') ||
          (a.className === 'personal' && b.className === 'sect');
      })
    },
    {
      name: 'sect_vs_dream',
      expectedMatch: false,
      pairs: uniquePairsFromSamples(samples, (a, b) => {
        return (a.className === 'sect' && b.className === 'dream') ||
          (a.className === 'dream' && b.className === 'sect');
      })
    }
  ];

  const bucketResults = [];
  for (const bucket of buckets) {
    const selected = samplePairs(bucket.pairs, BUCKET_SIZE, rng, bucket.name);
    const records = selected.map(([a, b], index) => ({
      bucket: bucket.name,
      pairIndex: index + 1,
      expectedMatch: bucket.expectedMatch,
      actualMatch: a.family === b.family,
      cardA: {
        id: a.id,
        className: a.className,
        family: a.family,
        relPath: a.relPath
      },
      cardB: {
        id: b.id,
        className: b.className,
        family: b.family,
        relPath: b.relPath
      },
      metrics: scorePair(a, b, cropCache, config)
    }));

    bucketResults.push({
      name: bucket.name,
      expectedMatch: bucket.expectedMatch,
      availablePairCount: bucket.pairs.length,
      sampledPairCount: records.length,
      summary: summarizeBucket(records),
      pairs: records
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    seed: RNG_SEED,
    bucketSize: BUCKET_SIZE,
    configPath: path.relative(__dirname, CONFIG_PATH),
    datasetPath: path.relative(__dirname, DATASET_PATH),
    reviewedRects: Object.fromEntries(
      Object.entries(config.classes).map(([className, classConfig]) => [className, classConfig.selectedRect])
    ),
    decisionSummary: buildDecisionSummary(bucketResults),
    bucketResults
  };

  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

  const lines = [];
  lines.push('# Name-Strip Benchmark Summary');
  lines.push('');
  lines.push(`Seed: \`${RNG_SEED}\``);
  lines.push(`Pairs per bucket: \`${BUCKET_SIZE}\``);
  lines.push('');
  lines.push('## Decision Summary');
  lines.push('');
  lines.push(`- Recommendation: \`${report.decisionSummary.recommendation}\``);
  lines.push(`- Labeled pairs used for threshold sweep: \`${report.decisionSummary.labeledPairCount}\``);
  if (report.decisionSummary.nccThreshold) {
    lines.push(`- Best NCC threshold: \`${report.decisionSummary.nccThreshold.threshold}\` with accuracy \`${report.decisionSummary.nccThreshold.accuracy}\``);
  }
  if (report.decisionSummary.grayMseThreshold) {
    lines.push(`- Best gray MSE threshold: \`${report.decisionSummary.grayMseThreshold.threshold}\` with accuracy \`${report.decisionSummary.grayMseThreshold.accuracy}\``);
  }
  lines.push('');
  for (const bucket of bucketResults) {
    lines.push(`## ${bucket.name}`);
    lines.push('');
    lines.push(`- Expected match: \`${bucket.expectedMatch}\``);
    lines.push(`- Actual same-family pairs in sample: \`${bucket.summary.actualMatchCount}\``);
    lines.push(`- Available pair count: \`${bucket.availablePairCount}\``);
    lines.push(`- Sampled pair count: \`${bucket.sampledPairCount}\``);
    lines.push(`- Mean NCC: \`${bucket.summary.nccMean}\``);
    lines.push(`- Median NCC: \`${bucket.summary.nccMedian}\``);
    lines.push(`- Mean gray MSE: \`${bucket.summary.grayMseMean}\``);
    lines.push(`- Median gray MSE: \`${bucket.summary.grayMseMedian}\``);
    lines.push('');
  }
  fs.writeFileSync(SUMMARY_PATH, `${lines.join('\n')}\n`);

  console.log(`Wrote ${path.relative(ROOT, REPORT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, SUMMARY_PATH)}`);
}

main();
