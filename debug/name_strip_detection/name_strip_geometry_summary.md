# Name-Strip Geometry Summary

Generated from `calibration_dataset.json` using `name_strip_config.json`.

## sect

- Auto rect: `x=0.11`, `y=0`, `width=0.1`, `height=0.6`
- Final rect: `x=0.0988`, `y=0`, `width=0.1412`, `height=0.6` (reviewed-override)
- Recommended metric: `ncc` (1)
- Positive mean NCC: `0.864411`
- Negative mean NCC: `0.240532`
- Positive mean gray MSE: `1590.463235`
- Negative mean gray MSE: `8449.197193`
- Combined search score: `0.943564`

## dream

- Auto rect: `x=0.08`, `y=0`, `width=0.1`, `height=0.6`
- Final rect: `x=0.0608`, `y=0`, `width=0.1392`, `height=0.6` (reviewed-override)
- Recommended metric: `ncc` (1)
- Positive mean NCC: `0.998802`
- Negative mean NCC: `0.341653`
- Positive mean gray MSE: `19.276029`
- Negative mean gray MSE: `10121.858548`
- Combined search score: `0.965525`

## personal

- Auto rect: `x=0.07`, `y=0`, `width=0.1`, `height=0.6`
- Final rect: `x=0.109`, `y=0`, `width=0.1398`, `height=0.6` (reviewed-override)
- Recommended metric: `grayMse` (0.938272)
- Positive mean NCC: `0.533579`
- Negative mean NCC: `0.146944`
- Positive mean gray MSE: `3408.599525`
- Negative mean gray MSE: `7833.996934`
- Combined search score: `0.800091`

## Next step

- Manually inspect the annotated and cropped outputs.
- If the strips visually align, reuse these rectangles for the phase-2 benchmark harness.
- If any class drifts into the art region, tighten the bounds or seed rect and rerun.
