# Borrower-Side RL Screening Parameter Optimization

## Objective

This experiment optimizes borrower-side RL screening parameters while keeping the financier-side RL APR learner fixed at its previously selected settings.

The target model is:

- `Fin_RL_Borrower_RL`: financier-side RL APR + borrower-side RL risk-premium screening.

It is compared against:

- `Fin_RL_Borrower_EGT`: financier-side RL APR + regular EGT borrower screening.
- `Fin_RL_None`: financier-side RL APR + no borrower screening.
- `Fin_Fixed_6_None`: fixed 6% APR + no borrower screening.
- `Fin_Fixed_8_None`: fixed 8% APR + no borrower screening.
- `Fin_Fixed_10_None`: fixed 10% APR + no borrower screening.

## Fixed Financier-Side RL Setup

The financier-side RL parameters are fixed from the previous `rl_fin` optimization:

- APR alpha: `0.25`
- APR gamma: `0.50`

The APR action grid is kept fixed during this borrower-side RL parameter search. If the APR grid optimization is completed later, this experiment can be rerun using the best APR grid.

## Borrower-Side RL Parameters Optimized

The borrower-side RL model selects a borrower-specific risk premium. The following parameters are optimized:

1. `borrower_alpha`
   - Learning rate for borrower-side Q-value updates.
   - Controls how strongly the borrower-risk policy reacts to new repayment outcomes.

2. `borrower_gamma`
   - Discount factor for borrower-side temporal-difference learning.
   - Controls how much future borrower state value affects the current update.

3. `borrower_epsilon`
   - Exploration rate for borrower-side risk-premium action selection.
   - Controls how often the model tries non-greedy risk-premium actions.

The values tried are:

```python
borrower_alpha = (0.10, 0.25, 0.40)
borrower_gamma = (0.50, 0.70, 0.95)
borrower_epsilon = (0.02, 0.05, 0.12)
```

4. `risk_premium_grid`
   - The action set available to the borrower-side RL screening policy.
   - Controls whether the learner can make fine or coarse risk-premium adjustments.

## Borrower Risk-Premium Grids Tried

The borrower risk-premium values are APR percentage-point adjustments. The experiment tries:

```python
hybrid_2_4pp = (-2.0, 0.0, 2.0, 4.0, 8.0, 12.0, 16.0)
fine_2pp    = (-2.0, 0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0)
coarse_4pp  = (-2.0, 0.0, 4.0, 8.0, 12.0, 16.0)
```

Only `Fin_RL_Borrower_RL` receives the candidate grid. The EGT and no-screening comparators are kept unchanged.

The full borrower-side search therefore has:

```text
3 alpha values x 3 gamma values x 3 epsilon values x 3 risk-premium grids = 81 combinations
```

## Scenario Grid

The experiment runs across:

- Capital levels: `1M`, `5M`, `10M`
- Default scenarios: no-default, low-default, medium-default, high-default
- Seeds: `42`, `123`, `777`
- Horizon: `4000` days

## Ranking Objective

Parameter combinations are ranked by:

```text
Total final capital of Fin_RL_Borrower_RL across all runs
```

Secondary metrics include:

- average final capital
- average return on initial capital
- average utilization
- average offered APR
- average risk premium
- loans issued
- defaults
- default amount relative to initial capital
- run-level wins
