# EGT APR Simulation Architecture & Experimental Methodology

This document outlines the core architecture of the lending simulation and the systematic experimental methodology used to optimize its components. 

The simulation uses a **dual-layer decision system** where the overall interest rate (Final APR) offered to a borrower is determined by two separate, interacting models:

1. **The Financier-Side (Base APR):** Manages the overall lending portfolio and macro-level rates.
2. **The Wholesaler-Side (Borrower Screening):** Evaluates individual borrower risk and applies personalized premiums.

```math
Final APR = Base APR (Financier) + Risk Premium (Wholesaler)
```

---

## Part 1: Core Architecture

### 1. Financier-Side (Base APR Strategy)
**Goal:** Optimize the baseline interest rate to maximize total capital return based on how much of the financier's money is currently loaned out.

Configured using the `apr_strategy` parameter:
*   **`fixed_X` (e.g., `fixed_6`, `fixed_10`):** A static, unchanging base APR of X%.
*   **`pure_rl` (Reinforcement Learning):** 
    *   **State Space:** Current Capital Utilization (chunked into three discrete buckets: `<33%`, `33%-66%`, `>66%`).
    *   **Action Space:** A pre-defined list of base APRs (e.g., `6%, 8%, 10%... 36%`).
    *   **Reward:** The Q-table is updated *twice* per loan. An optimistic update when the loan is issued, and a massive correction update when the loan closes (based on actual realized profit or default loss).

### 2. Wholesaler-Side (Borrower Screening & Risk Premium)
**Goal:** Evaluate the specific historical performance of individual borrowers to punish defaults with higher premiums or reject them entirely, while rewarding good behavior with baseline rates.

Configured using the `wholesaler_policy` parameter:
*   **`none`:** No screening. All borrowers receive a 0% risk premium modifier.
*   **`egt` (Direct EGT Screening):** Every borrower has a dynamic `score` (0.0 to 1.0) updated dynamically based on the borrower's "payoff" using EGT logistic functions. Low scores trigger loan rejections.
*   **`rl` (Reinforcement Learning Premium):** 
    *   **State Space:** The borrower's historical Exponentially Weighted Moving Average (`ewma_profit_ratio`).
    *   **Action Space:** A risk premium modifier (e.g., `-2%, 0%, +4%, +8%, +12%`).
    *   **Reward:** Realized profit percentage (`fin_profit_pct`), heavily scaled negatively for defaults. Uses borrower-specific Epsilon decay.

---

## Part 2: Experimental Methodology & Optimization

To ensure the dual-layer system was properly tuned without cross-contamination, we isolated and optimized each side individually using grid search experiments across multiple capital bounds (0.5M, 1M, 5M), multiple random seeds, and various default severity scenarios (None, Low, Medium, High).

### Phase A: Wholesaler-Side Optimization (EGT)
*Objective: Build the strongest possible borrower screening mechanism.*

1. **EGT Model Selection:** 
   We first tested several different mathematical flavors of Evolutionary Game Theory (Standard Logistic, Replicator Dynamics, Fermi Rule, Linear Reinforcement, Polynomial, etc.). We compared their ability to accurately reject bad borrowers without stifling loan volume, and selected the "Direct EGT" model as the base structural architecture.
2. **EGT Parameter Optimization:** 
   Once the Direct EGT model was selected, we locked it in and ran a massive grid search to optimize its internal hyperparameters. We tested combinations of:
   *   `alpha` (Learning Rate): $[0.10, 0.20, 0.30, 0.50, 0.70]$
   *   `eta` (Selection Intensity / Sensitivity): $[1.0, 2.0, 4.0, 6.0, 8.0]$
   *   *Result:* The optimal `(alpha, eta)` pair was extracted by ranking the combinations strictly by Total Final Capital accumulated across all scenarios.

### Phase B: Financier-Side Optimization (Base RL)
*Objective: Build the smartest Base APR adjustment agent, isolated from borrower behavior.*

1. **Isolating the Environment:** 
   To prevent the Wholesaler's EGT logic from confusing the Financier's RL agent, we temporarily **switched the Wholesaler side completely OFF** (`wholesaler_policy = "none"`).
2. **Establishing Baselines:** 
   We pitted the pure RL agent directly against static, fixed-rate competitors (`fixed_6`, `fixed_8`, `fixed_10`) to ensure the AI could mathematically outperform a simple, static market strategy.
3. **RL Parameter Optimization:** 
   With the Wholesaler off and competitors set, we ran a grid search exclusively targeting the Q-learning hyperparameters of the Financier agent:
   *   `apr_alpha` (Learning Rate): $[0.10, 0.25, 0.40, 0.60]$
   *   `apr_gamma` (Discount Factor): $[0.50, 0.70, 0.85, 0.95]$
   *   *Result:* The combinations were ranked by their ability to generate capital strictly through macro-utilization Base APR adjustments. 

### Final Integration
With Phase A yielding the optimal Wholesaler EGT parameters, and Phase B yielding the optimal Financier RL parameters, the two optimized systems are combined into the final `Fin_RL_Borrower_EGT` super-agent!
