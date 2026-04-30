# Name-Strip Benchmark Summary

Seed: `20260427`
Pairs per bucket: `10`

## Decision Summary

- Recommendation: `strong-fallback-or-reranker-candidate`
- Labeled pairs used for threshold sweep: `40`
- Best NCC threshold: `0.774798` with accuracy `0.975`
- Best gray MSE threshold: `2149.931148` with accuracy `0.975`

## sect_same_pool_different_family

- Expected match: `false`
- Actual same-family pairs in sample: `0`
- Available pair count: `54`
- Sampled pair count: `10`
- Mean NCC: `0.309158`
- Median NCC: `0.280245`
- Mean gray MSE: `6743.866573`
- Median gray MSE: `6608.265345`

## same_card_different_level

- Expected match: `true`
- Actual same-family pairs in sample: `10`
- Available pair count: `36`
- Sampled pair count: `10`
- Mean NCC: `0.862854`
- Median NCC: `0.959718`
- Mean gray MSE: `1437.53374`
- Median gray MSE: `436.415384`

## truly_random

- Expected match: `null`
- Actual same-family pairs in sample: `2`
- Available pair count: `630`
- Sampled pair count: `10`
- Mean NCC: `0.282994`
- Median NCC: `0.128683`
- Mean gray MSE: `7640.24535`
- Median gray MSE: `8564.790902`

## sect_vs_personal

- Expected match: `false`
- Actual same-family pairs in sample: `0`
- Available pair count: `144`
- Sampled pair count: `10`
- Mean NCC: `0.16592`
- Median NCC: `0.168299`
- Mean gray MSE: `8138.281474`
- Median gray MSE: `8457.100273`

## sect_vs_dream

- Expected match: `false`
- Actual same-family pairs in sample: `0`
- Available pair count: `144`
- Sampled pair count: `10`
- Mean NCC: `0.085264`
- Median NCC: `0.100674`
- Mean gray MSE: `10768.63073`
- Median gray MSE: `10771.793373`

