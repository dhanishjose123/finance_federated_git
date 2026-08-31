# RL APR + EGT Sensitivity Analysis

This folder contains the sensitivity experiment for the selected combined finance model:

`Fin_RL_Borrower_EGT = RL financier APR strategy + EGT borrower screening`

The experiment evaluates whether the selected model remains stable when one optimized parameter is changed at a time. The selected baseline is:

| Parameter | Baseline value |
|---|---:|
| APR RL alpha | 0.25 |
| APR RL gamma | 0.95 |
| APR RL epsilon | 0.08 |
| Borrower EGT alpha | 0.30 |
| Borrower EGT eta | 200 |

The APR action grid is fixed at 6% to 36% with 1 percentage-point spacing. The borrower risk-premium action set is fixed at `-2, 0, 4, 8, 12, 16`.

## Sensitivity Cases

| Case | Changed parameter | Value |
|---|---|---:|
| baseline_selected | none | selected optimum |
| apr_alpha_low | APR RL alpha | 0.10 |
| apr_alpha_high | APR RL alpha | 0.40 |
| apr_gamma_low | APR RL gamma | 0.70 |
| apr_gamma_mid | APR RL gamma | 0.85 |
| apr_epsilon_low | APR RL epsilon | 0.02 |
| apr_epsilon_mid | APR RL epsilon | 0.05 |
| egt_alpha_low | Borrower EGT alpha | 0.10 |
| egt_alpha_high | Borrower EGT alpha | 0.60 |
| egt_eta_low | Borrower EGT eta | 100 |
| egt_eta_high | Borrower EGT eta | 300 |

## Tournament Setting

Each sensitivity case is evaluated with the full Stage 4 strategy set:

| Financier | APR strategy | Borrower screening |
|---|---|---|
| Fin_RL_Borrower_RL | RL APR | RL screening |
| Fin_RL_Borrower_EGT | RL APR | EGT screening |
| Fin_RL_None | RL APR | No screening |
| Fin_Fixed_6_None | Fixed 6% APR | No screening |
| Fin_Fixed_8_None | Fixed 8% APR | No screening |
| Fin_Fixed_10_None | Fixed 10% APR | No screening |

The script runs each case across:

| Dimension | Values |
|---|---|
| Initial capital | 1M, 5M, 10M |
| Default scenarios | no default, low, medium, high |
| Seed | 42 |
| Simulation length | 4000 days |

Total simulations: `11 cases x 3 capitals x 4 default scenarios x 1 seed = 132 runs`.

## Run Command

From the `basics` folder:

```powershell
python sensitivity_analysis\run_rl_egt_sensitivity.py
```

The script prints `Run current/total` and estimated time remaining while it runs.

## Outputs

The experiment writes:

| File | Contents |
|---|---|
| `rl_egt_sensitivity_results.xlsx` | Ranking, scenario averages, target-run details, and all-financier details |
| `rl_egt_sensitivity_report.txt` | Short text summary of the baseline and best sensitivity case |

The main ranking uses total final capital of `Fin_RL_Borrower_EGT` across all capital, scenario, and seed runs. The output also reports average utilization, average offered APR, risk premium, default amount to initial capital, and run wins.
