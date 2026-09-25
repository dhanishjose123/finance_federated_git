#!/usr/bin/env python
"""Compare FedAvg, FedProx, and SCAFFOLD aggregation for federated borrower-side RL.

Background
----------
The existing federated wholesaler policy ("fl_rl") averages borrower-premium
Q-tables uniformly across financiers every 30 days (FedAvg). This script
compares that baseline against two additions made in egt_apr_simulation.py:

  * fl_rl_prox      -- FedProx: local Q-updates are pulled back toward the
                        last aggregated global Q-table via a proximal term
                        (financier.fedprox_mu).
  * fl_rl_scaffold  -- SCAFFOLD: a tabular adaptation of control-variate
                        drift correction (Karimireddy et al., 2020) applied
                        to TD updates on Q-table cells.

Each policy group gets NUM_FINANCIERS_PER_GROUP financiers so there is
actually something to federate across (previously, every experiment script
in this repo only ever instantiated a single "fl_rl" financier per run,
which made aggregation a no-op regardless of any other bugs).

Non-IID heterogeneity
----------------------
By default (NON_IID_PRIMARY_SHARE < 1.0), each financier within a policy
group is assigned a primary borrower risk-tier (shock_profile) plus a
minority share of the other tiers, rather than all financiers sharing the
exact same borrower pool. This creates genuine client drift for FedProx and
SCAFFOLD to correct -- without it, the three methods will likely look very
similar, since every financier sees nearly the same data. The partitioning
is matched across policy groups (see assign_non_iid_borrower_segments in
egt_apr_simulation.py) so financier #1 in fl_rl, fl_rl_prox, and
fl_rl_scaffold all get the same primary tier -- the only thing that differs
between the three groups is the aggregation algorithm.

Scale
-----
This script defaults to a SMALL sanity-check scale (few days, one seed,
one default scenario, smaller capital) so it runs quickly and you can
confirm the new code behaves sensibly before committing to the full grid.
Flip SMALL_TEST = False (or edit the grids directly) to run something
closer to the scale used in run_multiple_capitals.py (4,000 days, multiple
seeds, capitals up to 10M, all four default scenarios).

IMPORTANT: this script has not been executed yet. The sandbox this was
written in hit a persistent shell/environment error that blocked running
Python at all, so please run this yourself and sanity-check the output
before relying on it. If anything errors out, the most likely spots are the
new aggregation functions or the non_iid_primary_share plumbing in
run_simulation -- see egt_apr_simulation.py's aggregate_federated_rl_prox,
aggregate_federated_rl_scaffold, and assign_non_iid_borrower_segments.
"""

from __future__ import annotations

import time
from pathlib import Path

import pandas as pd

from egt_apr_simulation import run_simulation, write_excel

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SMALL_TEST = False

if SMALL_TEST:
    # Middle-ground config: longer than the first sanity run (more time and
    # ~50 federation rounds for Q-learning and FedProx/SCAFFOLD corrections
    # to actually differentiate) but still much faster than the full grid.
    DAYS = 1500
    SEEDS = [42, 43]
    CAPITALS_PER_FINANCIER = [300_000.0]
    DEFAULT_SCENARIOS = [
        {
            "name": "medium_default",
            "disable_defaults": False,
            "shock_profile_counts": {"none": 13, "medium": 13, "high": 13},
            "medium_shock_range": (-0.02, -0.08),
            "high_shock_range": (-0.09, -0.20),
        },
    ]
else:
    # Matches DEFAULT_SCENARIOS_TO_RUN and CAPITALS_TO_RUN in
    # run_multiple_capitals.py exactly (all 4 canonical default scenarios
    # and all 3 canonical capital levels) so this comparison is on the same
    # footing as the rest of the project's results.
    DAYS = 4000
    SEEDS = [709098, 436570, 831197]
    CAPITALS_PER_FINANCIER = [1_000_000.0, 5_000_000.0, 10_000_000.0]
    DEFAULT_SCENARIOS = [
        {
            "name": "none_default",
            "disable_defaults": True,
            "shock_profile_counts": {"none": 39},
            "medium_shock_range": (0.0, 0.0),
            "high_shock_range": (0.0, 0.0),
        },
        {
            "name": "low_default",
            "disable_defaults": False,
            "shock_profile_counts": {"none": 34, "medium": 4, "high": 1},
            "medium_shock_range": (-0.005, -0.015),
            "high_shock_range": (-0.02, -0.05),
        },
        {
            "name": "medium_default",
            "disable_defaults": False,
            "shock_profile_counts": {"none": 30, "medium": 7, "high": 2},
            "medium_shock_range": (-0.008, -0.025),
            "high_shock_range": (-0.04, -0.08),
        },
        {
            "name": "high_default",
            "disable_defaults": False,
            "shock_profile_counts": {"none": 25, "medium": 10, "high": 4},
            "medium_shock_range": (-0.01, -0.04),
            "high_shock_range": (-0.05, -0.12),
        },
    ]

NUM_FINANCIERS_PER_GROUP = 3
POLICY_GROUPS = ["fl_rl", "fl_rl_prox", "fl_rl_scaffold"]
POLICY_LABELS = {
    "fl_rl": "FedAvg (baseline)",
    "fl_rl_prox": "FedProx",
    "fl_rl_scaffold": "SCAFFOLD (tabular adaptation)",
}

# Non-IID knob: 1.0 = fully shared/IID borrower pool (matches the market-wide
# behaviour used everywhere else in this repo). Lower values give each
# financier a more skewed primary risk-tier. Dropped from 0.8 to 0.5 for a
# starker test of FedProx/SCAFFOLD after the first run showed all three
# methods landing within noise of each other.
NON_IID_PRIMARY_SHARE = 0.5

# Selected hyperparameters from optimum_experiment_parameters.md, so this
# comparison is apples-to-apples with the rest of the project's results.
APR_ALPHA = 0.25
APR_GAMMA = 0.95
APR_EPSILON = 0.08
BORROWER_ALPHA = 0.10
BORROWER_GAMMA = 0.70
BORROWER_EPSILON = 0.05
BORROWER_PREMIUM_ACTIONS = (-2.0, 0.0, 4.0, 8.0, 12.0, 16.0)

OUTPUT_DIR = Path("fedavg_fedprox_scaffold_comparison")
OUTPUT_DIR.mkdir(exist_ok=True)


def build_group_lists() -> tuple[list[str], list[str], list[float]]:
    """Build parallel financier_names / wholesaler_policies / base_aprs lists."""
    financier_names: list[str] = []
    wholesaler_policies: list[str] = []
    base_aprs: list[float] = []
    for policy in POLICY_GROUPS:
        for i in range(1, NUM_FINANCIERS_PER_GROUP + 1):
            financier_names.append(f"Fin_{policy}_{i}")
            wholesaler_policies.append(policy)
            base_aprs.append(6.0)
    return financier_names, wholesaler_policies, base_aprs


def run_one(seed: int, scenario: dict, capital: float) -> pd.DataFrame:
    financier_names, wholesaler_policies, base_aprs = build_group_lists()
    n = len(financier_names)

    frames = run_simulation(
        days=DAYS,
        seed=seed,
        apr_strategies=["pure_rl"] * n,
        wholesaler_policies=wholesaler_policies,
        financier_names=financier_names,
        base_aprs=base_aprs,
        apr_alphas=[APR_ALPHA] * n,
        apr_gammas=[APR_GAMMA] * n,
        apr_epsilons=[APR_EPSILON] * n,
        borrower_alphas=[BORROWER_ALPHA] * n,
        borrower_gammas=[BORROWER_GAMMA] * n,
        borrower_epsilons=[BORROWER_EPSILON] * n,
        borrower_premium_action_sets=[BORROWER_PREMIUM_ACTIONS] * n,
        initial_wallet=capital,
        initial_capital=capital,
        disable_defaults=scenario["disable_defaults"],
        shock_profile_counts=scenario["shock_profile_counts"],
        medium_shock_range=scenario["medium_shock_range"],
        high_shock_range=scenario["high_shock_range"],
        non_iid_primary_share=NON_IID_PRIMARY_SHARE,
        non_iid_group_policies=tuple(POLICY_GROUPS),
    )

    summary = frames["Financier_Summary"].copy()
    summary["seed"] = seed
    summary["default_scenario"] = scenario["name"]
    summary["capital_per_financier"] = capital
    return summary


def summarize_by_group(all_summaries: pd.DataFrame, group_cols: list[str]) -> pd.DataFrame:
    # Same pattern as the original (already verified working) version, just
    # parameterized over group_cols instead of hardcoding
    # "wholesaler_policy". Avoids groupby().apply(include_groups=...), which
    # needs a recent pandas version -- this uses plain named .agg() instead.
    def weighted_return_pct(capital_change: pd.Series) -> float:
        initial_capital_sum = all_summaries.loc[capital_change.index, "initial_capital"].sum()
        if not initial_capital_sum:
            return 0.0
        return 100.0 * capital_change.sum() / initial_capital_sum

    grouped = (
        all_summaries.groupby(group_cols)
        .agg(
            financiers=("financier", "nunique"),
            runs=("financier", "count"),
            total_initial_capital=("initial_capital", "sum"),
            total_final_capital=("final_capital", "sum"),
            mean_final_capital=("final_capital", "mean"),
            mean_return_pct=("capital_change", weighted_return_pct),
            total_defaults=("defaults", "sum"),
            total_loans=("loans_issued", "sum"),
            default_count_rate=("default_count_rate", "mean"),
            default_amount_to_initial_capital_rate=("default_amount_to_initial_capital_rate", "mean"),
        )
        .reset_index()
    )
    grouped["label"] = grouped["wholesaler_policy"].map(POLICY_LABELS)
    sort_cols = [c for c in group_cols if c != "wholesaler_policy"]
    return grouped.sort_values(sort_cols + ["mean_final_capital"], ascending=[True] * len(sort_cols) + [False])


def main() -> None:
    start = time.time()
    all_summaries = []
    total_runs = len(DEFAULT_SCENARIOS) * len(SEEDS) * len(CAPITALS_PER_FINANCIER)
    run_index = 0
    for capital in CAPITALS_PER_FINANCIER:
        for scenario in DEFAULT_SCENARIOS:
            for seed in SEEDS:
                run_index += 1
                print(
                    f"[{run_index}/{total_runs}] Running seed={seed} "
                    f"scenario={scenario['name']} capital={capital:,.0f} ..."
                )
                all_summaries.append(run_one(seed, scenario, capital))

    combined = pd.concat(all_summaries, ignore_index=True)
    overall_summary = summarize_by_group(combined, ["wholesaler_policy"])
    by_scenario_summary = summarize_by_group(combined, ["default_scenario", "wholesaler_policy"])
    by_capital_summary = summarize_by_group(combined, ["capital_per_financier", "wholesaler_policy"])
    by_capital_scenario_summary = summarize_by_group(
        combined, ["capital_per_financier", "default_scenario", "wholesaler_policy"]
    )

    report_lines = []
    report_lines.append("FedAvg vs FedProx vs SCAFFOLD -- federated borrower-RL comparison")
    report_lines.append("=" * 72)
    report_lines.append(f"Days: {DAYS} | Seeds: {SEEDS} | Financiers per group: {NUM_FINANCIERS_PER_GROUP}")
    report_lines.append(f"Non-IID primary share: {NON_IID_PRIMARY_SHARE} (1.0 = fully shared/IID pool)")
    report_lines.append(f"Default scenarios: {[s['name'] for s in DEFAULT_SCENARIOS]}")
    report_lines.append(f"Capital levels per financier: {CAPITALS_PER_FINANCIER}")
    report_lines.append("")
    report_lines.append("--- Overall (pooled across all seeds, scenarios, capital levels) ---")
    report_lines.append(overall_summary.to_string(index=False))
    report_lines.append("")
    report_lines.append("--- By default scenario (pooled across seeds and capital levels) ---")
    report_lines.append(by_scenario_summary.to_string(index=False))
    report_lines.append("")
    report_lines.append("--- By capital level (pooled across seeds and default scenarios) ---")
    report_lines.append(by_capital_summary.to_string(index=False))
    report_lines.append("")
    report_lines.append(f"Elapsed: {time.time() - start:.1f}s")

    report_text = "\n".join(report_lines)
    print()
    print(report_text)

    (OUTPUT_DIR / "fedavg_fedprox_scaffold_report.txt").write_text(report_text, encoding="utf-8")
    combined.to_csv(OUTPUT_DIR / "fedavg_fedprox_scaffold_raw_summary.csv", index=False)
    write_excel(
        {
            "Overall_Summary": overall_summary,
            "By_Scenario": by_scenario_summary,
            "By_Capital": by_capital_summary,
            "By_Capital_Scenario": by_capital_scenario_summary,
            "Raw_Summary": combined,
        },
        OUTPUT_DIR / "fedavg_fedprox_scaffold_results.xlsx",
    )

    print(f"\nSaved: {OUTPUT_DIR / 'fedavg_fedprox_scaffold_report.txt'}")
    print(f"Saved: {OUTPUT_DIR / 'fedavg_fedprox_scaffold_results.xlsx'}")


if __name__ == "__main__":
    main()
