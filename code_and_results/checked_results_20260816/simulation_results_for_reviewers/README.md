# Simulation Results Folder

This folder keeps only the essential simulation outputs used for checking and
reporting the finance-federated experiments. The original detailed files remain
in their source folders.

## Contents

- `stage_a_isolated_vs_federated/`: matched Stage A comparison of isolated RL
  and federated FedAvg RL.
- `stage_b_fedavg_fedprox_scaffold/`: Stage B comparison of FedAvg, FedProx,
  and SCAFFOLD-style tabular aggregation.
- `summary_across_capitals.xlsx`: aggregate scenario-level results across
  capital and default settings.
- `summary_across_capitals_seed_averaged.xlsx`: seed-averaged scenario summary.
- `multiple_capitals_report.txt`: text report for the capital/default
  simulation batch.

## Current Interpretation

Stage A is the main isolated-versus-federated comparison. Stage B is a
robustness comparison among federated aggregation rules. The Stage B differences
are modest: SCAFFOLD gives the highest pooled return, while FedProx is
competitive in lower-risk or higher-capital settings. These results support
federated aggregation in general rather than a strong claim that one aggregation
rule always dominates.

## Notes

Large detailed per-seed workbooks and raw CSV files are not included here. They
remain in the original experiment folders if audit-level checking is needed.
