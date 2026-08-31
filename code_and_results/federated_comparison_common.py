#!/usr/bin/env python
"""Shared plumbing for the federated-RL comparison stages.

Stage A (isolated_vs_federated.py): does federating at all help, holding the
aggregation method aside? Compares "rl" (isolated, no cross-financier
aggregation) against "fl_rl" (FedAvg) through separate matched counterfactual
runs. Each seed, capital level, and default scenario is run once with only
isolated RL financiers and once with only federated RL financiers.

Stage B (fedavg_fedprox_scaffold.py): given that financiers do federate,
which aggregation rule works best? Compares fl_rl (FedAvg) vs fl_rl_prox
(FedProx) vs fl_rl_scaffold (SCAFFOLD), all three matched on the same
non-IID segmentation. This is the 3-group comparison already validated and
incorporated into the manuscript's Abstract/Introduction/Related Work.

Stage B2 (stage_b2_visitweighted_comparison.py): extends Stage B with a
fourth, tabular-specific aggregation rule, fl_rl_visitweighted, which
weights each financier's contribution to a (state, action) cell by how many
times that financier has personally visited that cell.

All stages share this module so the simulation parameters, hyperparameters,
default scenarios, and reporting logic never drift apart from each other.
"""

from __future__ import annotations

import time
from pathlib import Path

import pandas as pd

from egt_apr_simulation import run_simulation, write_excel

# ---------------------------------------------------------------------------
# Shared configuration -- identical across all stages
# ---------------------------------------------------------------------------

SMALL_TEST = False

if SMALL_TEST:
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
    # run_multiple_capitals.py exactly.
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

# Non-IID knob: 1.0 = fully shared/IID borrower pool. Lower values give each
# financier a more skewed primary risk-tier. Every policy group present in a
# given run gets the SAME treatment (see non_iid_group_policies passed into
# run_one below) -- no group is left with unrestricted pool access while
# others are segmented, which would let it out-compete segmented groups for
# loans and confound the comparison.
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


def build_group_lists(policy_groups: list[str]) -> tuple[list[str], list[str], list[float]]:
    """Build parallel financier_names / wholesaler_policies / base_aprs lists."""
    financier_names: list[str] = []
    wholesaler_policies: list[str] = []
    base_aprs: list[float] = []
    for policy in policy_groups:
        for i in range(1, NUM_FINANCIERS_PER_GROUP + 1):
            financier_names.append(f"Fin_{policy}_{i}")
            wholesaler_policies.append(policy)
            base_aprs.append(6.0)
    return financier_names, wholesaler_policies, base_aprs


def run_one(
    seed: int,
    scenario: dict,
    capital: float,
    policy_groups: list[str],
    non_iid_group_policies: tuple[str, ...],
) -> pd.DataFrame:
    financier_names, wholesaler_policies, base_aprs = build_group_lists(policy_groups)
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
        non_iid_group_policies=non_iid_group_policies,
    )

    summary = frames["Financier_Summary"].copy()
    summary["seed"] = seed
    summary["default_scenario"] = scenario["name"]
    summary["capital_per_financier"] = capital
    return summary


def summarize_by_group(
    all_summaries: pd.DataFrame, group_cols: list[str], policy_labels: dict[str, str]
) -> pd.DataFrame:
    # Named .agg() with a closure over the outer DataFrame, instead of
    # groupby().apply(include_groups=...), which needs a recent pandas
    # version.
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
    grouped["label"] = grouped["wholesaler_policy"].map(policy_labels)
    sort_cols = [c for c in group_cols if c != "wholesaler_policy"]
    return grouped.sort_values(sort_cols + ["mean_final_capital"], ascending=[True] * len(sort_cols) + [False])


def matched_comparison(
    all_summaries: pd.DataFrame,
    baseline_policy: str,
    other_policies: list[str],
    policy_labels: dict[str, str],
) -> pd.DataFrame:
    """Matched win-count and mean-delta table: each policy in other_policies
    vs. baseline_policy, one matched comparison per (seed, capital,
    default_scenario) run.
    """
    match_keys = ["seed", "capital_per_financier", "default_scenario"]

    def weighted_return_pct(capital_change: pd.Series) -> float:
        initial_capital_sum = all_summaries.loc[capital_change.index, "initial_capital"].sum()
        if not initial_capital_sum:
            return 0.0
        return 100.0 * capital_change.sum() / initial_capital_sum

    per_run_by_policy = (
        all_summaries.groupby(match_keys + ["wholesaler_policy"])
        .agg(
            mean_return_pct=("capital_change", weighted_return_pct),
            mean_default_count_rate=("default_count_rate", "mean"),
            mean_net_profit=("capital_change", "mean"),
        )
        .reset_index()
    )

    baseline = per_run_by_policy[per_run_by_policy["wholesaler_policy"] == baseline_policy].set_index(match_keys)

    rows = []
    for policy in other_policies:
        other = per_run_by_policy[per_run_by_policy["wholesaler_policy"] == policy].set_index(match_keys)
        matched = other.join(baseline, lsuffix="_other", rsuffix="_base", how="inner")
        total = len(matched)
        wins = int((matched["mean_return_pct_other"] > matched["mean_return_pct_base"]).sum())
        other_mean_return = matched["mean_return_pct_other"].mean()
        base_mean_return = matched["mean_return_pct_base"].mean()
        other_mean_default = matched["mean_default_count_rate_other"].mean()
        base_mean_default = matched["mean_default_count_rate_base"].mean()
        other_mean_profit = matched["mean_net_profit_other"].mean()
        base_mean_profit = matched["mean_net_profit_base"].mean()
        rows.append(
            {
                "matched_comparison": f"{policy_labels[policy]} vs. {policy_labels[baseline_policy]}",
                "wins": f"{wins}/{total}",
                "other_mean_return_pct": other_mean_return,
                "baseline_mean_return_pct": base_mean_return,
                "delta_return_pp": other_mean_return - base_mean_return,
                "delta_default_count_rate_pp": 100.0 * (other_mean_default - base_mean_default),
                "mean_net_profit_diff": other_mean_profit - base_mean_profit,
            }
        )
    return pd.DataFrame(rows)


def paired_deltas(
    all_summaries: pd.DataFrame,
    baseline_policy: str,
    other_policies: list[str],
    policy_labels: dict[str, str],
) -> pd.DataFrame:
    """Return one row per matched scenario-policy pair for audit and plotting."""
    match_keys = ["seed", "capital_per_financier", "default_scenario"]

    def weighted_return_pct(capital_change: pd.Series) -> float:
        initial_capital_sum = all_summaries.loc[capital_change.index, "initial_capital"].sum()
        if not initial_capital_sum:
            return 0.0
        return 100.0 * capital_change.sum() / initial_capital_sum

    per_run_by_policy = (
        all_summaries.groupby(match_keys + ["wholesaler_policy"])
        .agg(
            mean_return_pct=("capital_change", weighted_return_pct),
            mean_default_count_rate=("default_count_rate", "mean"),
            mean_net_profit=("capital_change", "mean"),
            total_loans=("loans_issued", "sum"),
            total_defaults=("defaults", "sum"),
        )
        .reset_index()
    )

    baseline = per_run_by_policy[per_run_by_policy["wholesaler_policy"] == baseline_policy].set_index(match_keys)
    rows = []
    for policy in other_policies:
        other = per_run_by_policy[per_run_by_policy["wholesaler_policy"] == policy].set_index(match_keys)
        matched = other.join(baseline, lsuffix="_other", rsuffix="_base", how="inner").reset_index()
        for _, row in matched.iterrows():
            rows.append(
                {
                    "comparison": f"{policy_labels[policy]} vs. {policy_labels[baseline_policy]}",
                    "seed": row["seed"],
                    "capital_per_financier": row["capital_per_financier"],
                    "default_scenario": row["default_scenario"],
                    "other_policy": policy,
                    "baseline_policy": baseline_policy,
                    "other_return_pct": row["mean_return_pct_other"],
                    "baseline_return_pct": row["mean_return_pct_base"],
                    "delta_return_pp": row["mean_return_pct_other"] - row["mean_return_pct_base"],
                    "other_default_count_rate": row["mean_default_count_rate_other"],
                    "baseline_default_count_rate": row["mean_default_count_rate_base"],
                    "delta_default_count_rate_pp": 100.0
                    * (row["mean_default_count_rate_other"] - row["mean_default_count_rate_base"]),
                    "other_mean_net_profit": row["mean_net_profit_other"],
                    "baseline_mean_net_profit": row["mean_net_profit_base"],
                    "delta_mean_net_profit": row["mean_net_profit_other"] - row["mean_net_profit_base"],
                    "other_total_loans": row["total_loans_other"],
                    "baseline_total_loans": row["total_loans_base"],
                    "other_total_defaults": row["total_defaults_other"],
                    "baseline_total_defaults": row["total_defaults_base"],
                }
            )
    return pd.DataFrame(rows)


def run_experiment(
    *,
    title: str,
    policy_groups: list[str],
    policy_labels: dict[str, str],
    non_iid_group_policies: tuple[str, ...],
    baseline_policy: str,
    other_policies: list[str],
    output_dir: Path,
    output_prefix: str,
    separate_policy_runs: bool = False,
) -> None:
    output_dir.mkdir(exist_ok=True)
    start = time.time()
    all_summaries = []
    policy_run_multiplier = len(policy_groups) if separate_policy_runs else 1
    total_runs = len(DEFAULT_SCENARIOS) * len(SEEDS) * len(CAPITALS_PER_FINANCIER) * policy_run_multiplier
    run_index = 0
    for capital in CAPITALS_PER_FINANCIER:
        for scenario in DEFAULT_SCENARIOS:
            for seed in SEEDS:
                if separate_policy_runs:
                    for policy in policy_groups:
                        run_index += 1
                        print(
                            f"[{run_index}/{total_runs}] Running policy={policy} seed={seed} "
                            f"scenario={scenario['name']} capital={capital:,.0f} ..."
                        )
                        policy_non_iid_groups = tuple(
                            p for p in non_iid_group_policies if p == policy
                        )
                        all_summaries.append(run_one(seed, scenario, capital, [policy], policy_non_iid_groups))
                else:
                    run_index += 1
                    print(
                        f"[{run_index}/{total_runs}] Running seed={seed} "
                        f"scenario={scenario['name']} capital={capital:,.0f} ..."
                    )
                    all_summaries.append(run_one(seed, scenario, capital, policy_groups, non_iid_group_policies))

    combined = pd.concat(all_summaries, ignore_index=True)
    overall_summary = summarize_by_group(combined, ["wholesaler_policy"], policy_labels)
    by_scenario_summary = summarize_by_group(combined, ["default_scenario", "wholesaler_policy"], policy_labels)
    by_capital_summary = summarize_by_group(combined, ["capital_per_financier", "wholesaler_policy"], policy_labels)
    by_capital_scenario_summary = summarize_by_group(
        combined, ["capital_per_financier", "default_scenario", "wholesaler_policy"], policy_labels
    )
    comparison_table = matched_comparison(combined, baseline_policy, other_policies, policy_labels)
    paired_delta_table = paired_deltas(combined, baseline_policy, other_policies, policy_labels)

    report_lines = []
    report_lines.append(title)
    report_lines.append("=" * len(title))
    report_lines.append(f"Days: {DAYS} | Seeds: {SEEDS} | Financiers per group: {NUM_FINANCIERS_PER_GROUP}")
    report_lines.append(
        "Run design: "
        + (
            "separate matched counterfactual policy runs"
            if separate_policy_runs
            else "single shared market containing all policy groups"
        )
    )
    report_lines.append(f"Non-IID primary share: {NON_IID_PRIMARY_SHARE} (1.0 = fully shared/IID pool)")
    report_lines.append(f"Non-IID applies to: {non_iid_group_policies} (all groups matched, none excluded)")
    report_lines.append(f"Default scenarios: {[s['name'] for s in DEFAULT_SCENARIOS]}")
    report_lines.append(f"Capital levels per financier: {CAPITALS_PER_FINANCIER}")
    report_lines.append("")
    report_lines.append(f"--- Matched comparison vs. {policy_labels[baseline_policy]} ---")
    report_lines.append(comparison_table.to_string(index=False))
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

    (output_dir / f"{output_prefix}_report.txt").write_text(report_text, encoding="utf-8")
    combined.to_csv(output_dir / f"{output_prefix}_raw_summary.csv", index=False)
    write_excel(
        {
            "Matched_Comparison": comparison_table,
            "Overall_Summary": overall_summary,
            "By_Scenario": by_scenario_summary,
            "By_Capital": by_capital_summary,
            "By_Capital_Scenario": by_capital_scenario_summary,
            "Paired_Deltas": paired_delta_table,
            "Raw_Summary": combined,
        },
        output_dir / f"{output_prefix}_results.xlsx",
    )

    print(f"\nSaved: {output_dir / f'{output_prefix}_report.txt'}")
    print(f"Saved: {output_dir / f'{output_prefix}_results.xlsx'}")
