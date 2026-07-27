# EGT Parameter Optimization Procedure

This document outlines the procedure for optimizing the Evolutionary Game Theory (EGT) parameters (`alpha` and `eta`) for the borrower-side (wholesaler) screening models.

## Overview

The script `run_egt_parameter_optimization.py` automates a massive grid search over various combinations of the `borrower_egt_alpha` and `borrower_egt_eta` parameters. It tests the `"egt"` borrower model against competing baseline models across multiple randomized scenarios.

The target financier in this script is configured as:
- **APR Strategy:** `pure_rl` (Reinforcement Learning Base APR)
- **Wholesaler Policy:** `egt` (Direct EGT risk premium/screening model)

## How It Works

1. **Grid Search Definition:** 
   The script is pre-configured with a grid of values to test.
   ```python
   EGT_ALPHA_VALUES = [0.10, 0.30, 0.60]
   EGT_ETA_VALUES = [100.0, 200.0, 300.0]
   ```
   *Modify these lists at the top of the script if you wish to explore different parameter ranges or finer steps.*

2. **Simulation Environments:**
   For every single combination of `(alpha, eta)`, the script runs the simulation across:
   - Multiple Initial Capitals (e.g., 1M, 5M, 10M)
   - Multiple Default Scenarios (None, Low, Medium, High)
   - Multiple Random Seeds (to ensure statistical robustness)

3. **Performance Aggregation:**
   After all simulations complete, the script aggregates the results and judges the combinations strictly based on the **Total Final Capital** accumulated by the target EGT financier across all permutations.

## Running the Optimization

To execute the optimization, open a PowerShell terminal in the `basics` directory and run:

```powershell
python egt_optimization/run_egt_parameter_optimization.py
```

*Note: Depending on your CPU and the number of scenarios in the grid, this search may take a significant amount of time to complete.*

## Reading the Results

Upon completion, the script generates two outputs directly in the `egt_optimization` folder:

1. **`egt_parameter_optimization_results.xlsx`**: 
   - **`Parameter_Ranking` Sheet**: This is the most important sheet. It sorts every `(alpha, eta)` pair from best to worst based on the total capital generated. Look at row #1 to see your optimal parameters.
   - **`Financier_Summary` Sheet**: Detailed breakdown of how the EGT model performed against the competitors (Fixed APR models and RL models) for each parameter combination.
   - **`Scenario_Runs` Sheet**: The raw data for every single simulation run executed during the grid search.

2. **`egt_parameter_optimization_report.txt`**:
   A quick, high-level text summary of the experiment that immediately prints out the best `alpha` and `eta` values discovered, alongside their total generated capital and overall win rate.

## Latest Optimization Result

The latest EGT parameter run used:

```text
EGT alpha grid = {0.10, 0.30, 0.60}
EGT eta grid   = {100, 200, 300}
```

It selected:

```text
EGT alpha = 0.3
EGT eta   = 200.0
```

The selected pair achieved:

```text
Target total final capital = 275,686,576.66
Candidate run wins         = 28
```

This is the parameter pair to use for the regular borrower-side EGT screening model in the next comparison stage.
