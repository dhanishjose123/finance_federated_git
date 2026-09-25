# Simulation Code and Results

This directory supports the current manuscript's four-stage evaluation.
Manuscripts, bibliographies and manuscript figures are deliberately excluded.

## Evidence by Stage

| Stage | Code and saved evidence |
| --- | --- |
| 1: financier base-APR selection | `rl_optimization/rl_fin/` |
| 1b: full strategy comparison | `stage1_full_strategy_comparison.py`, `stage1_full_strategy_comparison/`; partial outputs, not a completed comparison |
| 2: borrower-screening parameter selection | `rl_optimization/rl_borrower_opt/` |
| 3: isolated versus federated screening | `checked_results_20260816/stage_a_isolated_vs_federated/`, `stage_a_extra_seeds/` |
| 4: aggregation-rule comparison | `stage_b3_scaffold_lr025_comparison/`, `stage_b3_extra_seeds/`; older aggregation results in `checked_results_20260816/stage_b_fedavg_fedprox_scaffold/` |
| Pooled Stage 3/4 inference | `combined_significance/`, `combine_and_retest_significance.py` |
| SCAFFOLD sensitivity | `scaffold_sensitivity_50_borrowers/` |
| Non-IID sensitivity | `noniid_sensitivity_50_borrowers/` |
| Convergence evidence | `convergence_analysis/` raw CSVs; `convergence_analysis.py` |
| Blockchain benchmark | `hyperledger/caliper_300tps_summary.csv`, `hyperledger/caliper_300tps_logs/` |

Fixed/proportional-capital scalability and visit-weighted comparisons are
supplementary, not additional numbered manuscript stages. Their existing
directories are retained. Older EGT experiments and duplicate copies were
archived outside this repository.

## Design and Metrics

The main federation comparisons use 39 borrowers, a 4000-day nominal horizon,
three financiers per policy, and 1M, 5M or 10M initial capital per financier.
Aggregation occurs every 30 simulation days. Three seeds produce 36 matched
seed-capital-stress scenarios and 108 financier observations per policy.
Seventeen seeds produce 204 scenarios and 612 observations per policy.

The non-IID setting is 0.5: each financier is eligible for all borrowers in its
primary stress tier and a sampled half of each other tier. It is not a guarantee
that half of the realised portfolio belongs to the primary tier.

Main comparisons average financier loan-default ratios within scenarios.
The 50-borrower sensitivity instead uses group defaulted loans divided by group
issued loans. Default amounts divided by initial capital are a different metric.
Capital-pooled returns and equally weighted scenario differences must not be
treated as identical summaries.

The SCAFFOLD sensitivity uses 50 borrowers, 2000 days, three seeds and four
correction rates (0.25, 0.50, 0.75, 1.00), with 36 comparisons per rate.
Outstanding loans can be followed beyond the nominal horizon for settlement.

## Running

Run from this directory to preserve relative paths:

```sh
pip install -r requirements.txt
```

Experiment entry points include `stage1_full_strategy_comparison.py`,
`stage_a_extra_seeds.py`, `stage_b3_extra_seeds.py`, and
`scaffold_sensitivity_50_borrowers.py`. They may take hours and write results.
Use a separate checkout for new runs. The shared engine is
`egt_apr_simulation.py`; its historical filename does not imply EGT is part
of the reported four-stage evaluation.

See [the manuscript map](../docs/MANUSCRIPT_MAP.md) and
[benchmark notes](../docs/BENCHMARK_NOTES.md). The aggregation benchmark
reports a compound workload, not 311 successful aggregation calls.

The archived code and data support inspection, but their inclusion does not
resolve pending manuscript comparisons or certify all reported claims.
