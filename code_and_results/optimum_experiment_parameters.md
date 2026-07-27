# Optimum Experiment Parameters

This file records the selected parameter values from the completed model-selection and optimization experiments. These values are used as the default settings for the basic simulation experiment.

## Selected model structure

| Component | Selected setting | Source experiment |
|---|---:|---|
| Financier-side APR strategy | Pure RL APR | Stage 1 financier-side APR optimization |
| Borrower-side EGT model form | Regular EGT | EGT-only borrower model selection |
| Borrower-side RL screening | Borrower RL risk-premium table | Borrower RL parameter optimization |
| APR lower bound | 6% | Experiment design |
| APR upper bound | 36% | Experiment design |
| Risk-premium lower bound | -2 percentage points | Experiment design |
| Risk-premium upper bound | 16 percentage points | Experiment design |

## Financier-side APR RL parameters

| Parameter | Selected value |
|---|---:|
| APR RL alpha | 0.25 |
| APR RL gamma | 0.95 |
| APR RL epsilon | 0.08 |
| APR action grid | Fine 1 pp grid: 6, 7, ..., 36 |
| Best total final capital | 254.39M |
| Run wins | 12 |

Source: `rl_optimization/rl_fin/fin_rl_parameter_optimization_report.txt` and `rl_optimization/rl_fin/fin_rl_apr_grid_optimization_report.txt`.

## Borrower-side EGT screening parameters

| Parameter | Selected value |
|---|---:|
| EGT model form | Regular EGT |
| EGT alpha | 0.30 |
| EGT eta | 200 |
| Best total final capital | 275.69M |
| Average final capital | 7.66M |
| Average utilization | 0.544 |
| Run wins | 28 |

Source: `egt_model_selection/egt_only_model_selection_report.txt` and `egt_optimization/egt_parameter_optimization_report.txt`.

## Borrower-side RL screening parameters

| Parameter | Selected value |
|---|---:|
| Borrower RL alpha | 0.10 |
| Borrower RL gamma | 0.70 |
| Borrower RL epsilon | 0.05 |
| Risk-premium action grid | Coarse 4 pp grid: -2, 0, 4, 8, 12, 16 |
| Best total final capital | 243.59M |
| Run wins | 11 |

Source: `rl_optimization/rl_borrower_opt/borrower_rl_parameter_optimization_report.txt`.

## Simulation files updated

The following basic experiment files were updated to use these selected values:

| File | Update |
|---|---|
| `egt_apr_simulation.py` | Core defaults for APR RL, borrower EGT, borrower RL, APR grid, risk-premium grid, and APR cap |
| `run_multiple_capitals.py` | Multi-capital experiment now passes the selected APR RL, borrower EGT, borrower RL, APR grid, and risk-premium grid values |

