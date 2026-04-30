# Phase 1: Name-Strip Geometry Calibration

## Scope
This folder is for the first offline feasibility pass for name-strip-based card detection.

This phase does only three things:
- define a fixed calibration dataset for `sect`, `dream`, and `personal` cards
- search for the best normalized left-side crop per class
- write visual and JSON outputs for manual review

This phase does not:
- change live detection
- benchmark random card pairs yet
- add OCR

## Inputs
- Card image assets under `images/`
- Fixed dataset manifest in `calibration_dataset.json`
- Search settings in `name_strip_config.json`

## Outputs
- `name_strip_geometry_report.json`
- `name_strip_geometry_summary.md`
- `outputs/annotated/<class>/`
- `outputs/crops/<class>/`

## Calibration Goal
For each class, find one normalized crop rectangle that captures the vertical left-side name strip well enough that:
- same-family variants stay similar
- different names separate more clearly

The crop rectangle is stored in normalized card-local coordinates:
- `x`
- `y`
- `width`
- `height`

## Search And Scoring
- Search each class separately
- Start from a conservative left-strip seed
- Use bounded coarse search followed by bounded fine refinement
- Compare cropped strips using:
  - grayscale normalized correlation
  - grayscale MSE

The search objective is family-level separation, not level or phase detection.

## Next Step
After manual review of the chosen rectangles, phase 2 should add a benchmark harness with fixed pair buckets such as:
- same family vs different family
- same card different level
- sect vs personal
- sect vs dream
- truly random

## Phase 2 Benchmark
The benchmark should use the reviewed rectangles from `name_strip_config.json`, not a separate geometry source.

The first benchmark pass uses 5 fixed buckets with 10 sampled pairs each:
- `sect_same_pool_different_family`
- `same_card_different_level`
- `truly_random`
- `sect_vs_personal`
- `sect_vs_dream`

Outputs:
- `name_strip_benchmark_report.json`
- `name_strip_benchmark_summary.md`

Each pair record should include:
- bucket
- card A / card B image path
- class and family metadata
- expected match / non-match
- grayscale `ncc`
- grayscale `grayMse`

Sampling should be deterministic so reruns are comparable.
