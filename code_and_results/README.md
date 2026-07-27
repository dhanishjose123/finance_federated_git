# Adaptive Finance Simulation Experiments

This repository contains the simulation code, experiment runners, compact result summaries, and supporting notes needed to review and reproduce the EGT/RL adaptive finance experiments.

## Contents

- `egt_apr_simulation.py`: core simulation engine.
- `run_exp.py`, `run_multiple_capitals.py`, `run_optimize_weights_rl.py`: top-level experiment runners.
- `egt_model_selection/`: model-selection experiments and reports.
- `egt_optimization/`: EGT parameter optimization code and summarized results.
- `rl_optimization/`: borrower-side and financier-side RL optimization experiments.
- `sensitivity_analysis/`: sensitivity analysis runner and summarized results.
- `capital_default_analysis/`: capital/default scenario analysis.
- `fabric_integration/` and `hyperledger/`: integration/service scripts and throughput logs.
- `trained_q_tables/`: small trained Q-table JSON files used for review/reproducibility.
- `Simulation_Architecture.md`, `model_development_flow.txt`, `optimum_experiment_parameters.md`: design and parameter notes.

Manuscript drafts, reviewer-response documents, local tool output, caches, and large raw generated files were intentionally excluded.

## Requirements

Install Python dependencies:

```bash
pip install -r requirements.txt
```

The code was prepared with Python 3.12, but should work with recent Python 3 versions that support the listed packages.

## Example Runs

Run the main multi-capital experiment:

```bash
python run_multiple_capitals.py
```

Run EGT parameter optimization:

```bash
python egt_optimization/run_egt_parameter_optimization.py
```

Run financier-side RL parameter optimization:

```bash
python rl_optimization/rl_fin/run_fin_rl_parameter_optimization.py
```

Run financier-side APR grid optimization:

```bash
python rl_optimization/rl_fin/run_fin_rl_apr_grid_optimization.py
```

Run borrower-side RL parameter optimization:

```bash
python rl_optimization/rl_borrower_opt/run_borrower_rl_parameter_optimization.py
```

## Notes for Reviewers

Some experiments are computationally heavy because they evaluate multiple capitals, default scenarios, seeds, and parameter grids. Compact reports and result spreadsheets are included so reviewers can inspect the reported outcomes without rerunning every experiment.
