# EGT Borrower Model Selection Report

## 1. Objective

The objective of this experiment is to compare borrower-screening models under the same financier-side APR setting framework. The main question is whether borrower-side EGT variants improve final financier capital compared with borrower-side RL and fixed APR baselines.

The selection criterion is **highest total final capital** summed across all capital levels, default scenarios, and seeds.

## 2. Experiment Design

Each simulation run includes competing financiers. The learning financiers use `pure_rl` for financier-side APR setting. Borrower screening changes by model.

Tested borrower-side models:

- Borrower RL: `rl`
- Regular EGT: `egt`
- EGT replicator: `egt_replicator`
- EGT linear reinforcement: `egt_linear_reinforcement`
- EGT Fermi: `egt_fermi`
- EGT best response: `egt_best_response`
- EGT polynomial: `egt_polynomial`
- Fixed APR baselines with no borrower screening: `fixed_6 + none`, `fixed_8 + none`, `fixed_10 + none`

Scenario coverage:

- Capitals: 1M, 5M, 10M
- Default scenarios: none_default, low_default, medium_default, high_default
- Seeds: 42, 123, 777
- Distinct scenario runs: 36
- Runtime horizon: 4000 days
- Borrower margin: 0.20
- Borrower EGT alpha: 0.3
- Borrower EGT eta: 200.0
- Offered APR formula: `base_apr + risk_premium`, clamped to the allowed APR range

Note: The result tables below are from the previous completed run. Rerun `run_egt_model_selection.py` to refresh them with the updated capital levels and optimized EGT parameters.

## 3. Overall Results

Overall winner: **Fin_RL_Borrower_RL**

- Borrower model: `rl`
- APR strategy: `pure_rl`
- Total final capital: **144,602,080.48**
- Average final capital: **4,016,724.46**
- Average utilization: **0.8100**
- Run wins: **30**

| Rank | Financier | APR Strategy | Borrower Model | Total Final Capital | Avg Final Capital | Avg Utilization | Avg Offered APR | Run Wins |
|---:|---|---|---|---:|---:|---:|---:|---:|
| 1 | Fin_RL_Borrower_RL | pure_rl | rl | 144,602,080.48 | 4,016,724.46 | 0.8100 | 13.41 | 30 |
| 2 | Fin_Fixed_6_None | fixed_6 | none | 100,749,642.44 | 2,798,601.18 | 0.9465 | 6.00 | 6 |
| 3 | Fin_Fixed_10_None | fixed_10 | none | 95,267,671.82 | 2,646,324.22 | 0.6358 | 10.00 | 0 |
| 4 | Fin_Fixed_8_None | fixed_8 | none | 86,657,921.80 | 2,407,164.49 | 0.7157 | 8.00 | 0 |
| 5 | Fin_RL_Borrower_EGT_Linear | pure_rl | egt_linear_reinforcement | 82,293,248.29 | 2,285,923.56 | 0.1704 | 20.54 | 0 |
| 6 | Fin_RL_Borrower_EGT | pure_rl | egt | 82,173,274.59 | 2,282,590.96 | 0.1721 | 20.55 | 0 |
| 7 | Fin_RL_Borrower_EGT_Fermi | pure_rl | egt_fermi | 82,064,753.88 | 2,279,576.50 | 0.1744 | 20.73 | 0 |
| 8 | Fin_RL_Borrower_EGT_Best_Response | pure_rl | egt_best_response | 82,010,131.35 | 2,278,059.20 | 0.1660 | 20.53 | 0 |
| 9 | Fin_RL_Borrower_EGT_Polynomial | pure_rl | egt_polynomial | 81,918,164.57 | 2,275,504.57 | 0.1701 | 20.63 | 0 |
| 10 | Fin_RL_Borrower_EGT_Replicator | pure_rl | egt_replicator | 81,808,318.05 | 2,272,453.28 | 0.1668 | 20.83 | 0 |

## 4. EGT Model Ranking

Best EGT borrower model: **egt_linear_reinforcement**

- Best EGT total final capital: **82,293,248.29**
- Worst EGT total final capital: **81,808,318.05**
- Difference between best and worst EGT: **484,930.24**, or **0.59%**

| EGT Rank | Borrower Model | Total Final Capital | Avg Final Capital | Avg Utilization | Avg Offered APR | Avg Risk Premium | Avg Borrower Score | Loans Issued | Defaults |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | egt_linear_reinforcement | 82,293,248.29 | 2,285,923.56 | 0.1704 | 20.54 | 13.76 | 0.0855 | 5118 | 353 |
| 2 | egt | 82,173,274.59 | 2,282,590.96 | 0.1721 | 20.55 | 13.76 | 0.0856 | 5202 | 441 |
| 3 | egt_fermi | 82,064,753.88 | 2,279,576.50 | 0.1744 | 20.73 | 13.76 | 0.0855 | 5168 | 439 |
| 4 | egt_best_response | 82,010,131.35 | 2,278,059.20 | 0.1660 | 20.53 | 13.77 | 0.0853 | 4958 | 398 |
| 5 | egt_polynomial | 81,918,164.57 | 2,275,504.57 | 0.1701 | 20.63 | 13.76 | 0.0855 | 5062 | 449 |
| 6 | egt_replicator | 81,808,318.05 | 2,272,453.28 | 0.1668 | 20.83 | 13.76 | 0.0856 | 4972 | 395 |

## 5. Winner Pattern By Scenario

| Default Scenario | Run Winner | Winner Borrower Model | Wins |
|---|---|---|---:|
| high_default | Fin_RL_Borrower_RL | rl | 90 |
| low_default | Fin_RL_Borrower_RL | rl | 60 |
| low_default | Fin_Fixed_6_None | none | 30 |
| medium_default | Fin_RL_Borrower_RL | rl | 90 |
| none_default | Fin_RL_Borrower_RL | rl | 60 |
| none_default | Fin_Fixed_6_None | none | 30 |

## 6. Interpretation

The three-seed rerun confirms that borrower RL is still the strongest overall competitor. It wins **30** of the scenario-level rows and has the highest total final capital.

Among EGT variants, the best model is now **egt_linear_reinforcement**. The EGT models remain close to each other: the difference between best and worst EGT total final capital is only **0.59%**. This means the current experiment still does not show a large practical separation among the EGT update equations.

After removing the separate borrower-score APR adjustment, EGT performance improved in utilization relative to the earlier one-seed report, because offered APR is now driven only by the selected base APR and risk premium. However, EGT still uses a high average risk premium, around **13.76**, and its utilization remains much lower than borrower RL and fixed 6. That suggests the main remaining issue is the risk-premium mapping and parameter sensitivity, not the choice among EGT variants alone.

## 7. Selected Model

For the next stage, regular `egt` can still be selected as the working EGT model for parameter optimization. Although **egt_linear_reinforcement** ranks first in this three-seed selection run, the gap among EGT variants is small, and regular `egt` is simpler to justify and explain.

The next experiment should therefore optimize regular EGT parameters:

- Keep borrower model fixed to `egt`
- Optimize EGT `alpha` and `eta`
- Compare against `pure_rl + rl`, `fixed_6 + none`, `fixed_8 + none`, and `fixed_10 + none`
- Use total final capital across capitals, default scenarios, and seeds as the objective

## 8. Files

- Result workbook: `egt_model_selection_results.xlsx`
- Source runner: `run_egt_model_selection.py`
- This report: `egt_model_selection_detailed_report.md`
