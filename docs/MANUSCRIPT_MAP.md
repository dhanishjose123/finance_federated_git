# Manuscript-to-Project Map

The current PeerJ manuscript defines four evaluation stages. All paths in the
table below are relative to `code_and_results/`.

| Manuscript component | Code or evidence |
| --- | --- |
| Simulation and shared parameters | `egt_apr_simulation.py`, `federated_comparison_common.py` |
| Stage 1: base-APR selection | `rl_optimization/rl_fin/` |
| Stage 1b: full strategy comparison | `stage1_full_strategy_comparison.py`, partial summaries in `stage1_full_strategy_comparison/seed_709098/` |
| Stage 2: borrower screening | `rl_optimization/rl_borrower_opt/` |
| Stage 3: isolated versus federated | `checked_results_20260816/stage_a_isolated_vs_federated/`, `stage_a_extra_seeds/` |
| Stage 4: FedAvg, FedProx, tabular SCAFFOLD | `stage_b_fedavg_fedprox_scaffold.py`, `stage_b3_scaffold_lr025_comparison/`, `stage_b3_extra_seeds/` |
| Pooled statistical comparisons | `combine_and_retest_significance.py`, `combined_significance/` |
| Correction-rate sensitivity | `scaffold_sensitivity_50_borrowers.py`, `scaffold_sensitivity_50_borrowers/` |
| Non-IID sensitivity | `noniid_sensitivity_50_borrowers.py`, `noniid_sensitivity_50_borrowers/` |
| Convergence analysis | `convergence_analysis.py`; manuscript figures are excluded from this repository |
| Caliper benchmark table | `hyperledger/caliper_300tps_summary.csv` |
| Smart contracts and integration | `chaincode/`, `hyperledger/cardamom_11.js`, `fabric_integration/` |

## Supplementary and Historical Material

The retained visit-weighted comparison, fixed-capital scalability,
proportional-capital scalability directories are not additional numbered stages
of the current manuscript. They should not be interpreted as evidence for a
manuscript claim without checking the corresponding configuration. Older EGT
experiments, nested copies and manuscript-review documents were archived outside
this repository under the working project's `optional_material/git_archive_*`.

## Reproduction

Run Python commands from `code_and_results/`; this preserves the relative
input/output paths used by the scripts. Install `requirements.txt` first.
The original checked results and extra-seed summary files are kept at their
expected paths so pooled comparisons can find them. Scripts can write outputs;
use a separate checkout for new experiments rather than replacing checked data.

The manuscript, bibliography and figure assets are deliberately excluded.
They remain in the full working project, not in this repository.

## Limits of This Package

- Stage 1b contains three strategy summaries for seed 709098, but no final combined report. No new experiment was run.
- Chaincode and Fabric material are retained snapshots, not a verified complete deployment bundle.
- Raw convergence CSV histories are included to support the plotted analyses. Large per-run workbooks, caches and private network identities are excluded.
- Citation audits remain with the manuscript in the working project.
- Packaging does not validate the numerical claims or constitute publication approval.
