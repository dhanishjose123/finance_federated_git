#!/usr/bin/env python
"""Paired significance testing for Stage 3 (isolated vs. federated) and
Stage 4 (FedAvg vs. FedProx vs. SCAFFOLD), computed from the already-saved
raw per-financier CSVs -- no new simulation runs needed.

For each comparison, reports both a paired t-test and a Wilcoxon signed-rank
test (distribution-free, robust to the return-% outliers visible in the raw
data) on the return-% delta across the 36 matched (seed, capital,
default_scenario) pairs, and again restricted to the 27 pairs that exclude
the zero-stress none_default scenario (the "stressed-only" figures already
quoted in the manuscript). Also runs both tests on the default-rate delta.

Requires: pandas, scipy (pip install pandas scipy --break-system-packages if
either is missing).

Run with: python compute_significance.py
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
from scipy import stats

from federated_comparison_common import paired_deltas

STRESSED_SCENARIOS = ["low_default", "medium_default", "high_default"]


def run_tests(paired: pd.DataFrame, label: str) -> list[str]:
    lines = [f"--- {label} (n={len(paired)}) ---"]
    if len(paired) < 2:
        lines.append("  Not enough matched pairs to test.")
        return lines

    # Return-% delta
    t_stat, t_p = stats.ttest_rel(paired["other_return_pct"], paired["baseline_return_pct"])
    try:
        w_stat, w_p = stats.wilcoxon(paired["delta_return_pp"])
    except ValueError as exc:  # all-zero differences etc.
        w_stat, w_p = float("nan"), float("nan")
        lines.append(f"  (Wilcoxon on return skipped: {exc})")
    mean_delta = paired["delta_return_pp"].mean()
    sd_delta = paired["delta_return_pp"].std(ddof=1)
    lines.append(
        f"  Return %:  mean delta = {mean_delta:+.3f} pp, sd = {sd_delta:.3f} pp | "
        f"paired t = {t_stat:.3f}, p = {t_p:.4f} | Wilcoxon W = {w_stat:.1f}, p = {w_p:.4f}"
    )

    # Default-rate delta (already stored in percentage points in delta_default_count_rate_pp)
    t_stat_d, t_p_d = stats.ttest_rel(
        paired["other_default_count_rate"], paired["baseline_default_count_rate"]
    )
    try:
        w_stat_d, w_p_d = stats.wilcoxon(paired["delta_default_count_rate_pp"])
    except ValueError as exc:
        w_stat_d, w_p_d = float("nan"), float("nan")
        lines.append(f"  (Wilcoxon on default rate skipped: {exc})")
    mean_delta_d = paired["delta_default_count_rate_pp"].mean()
    sd_delta_d = paired["delta_default_count_rate_pp"].std(ddof=1)
    lines.append(
        f"  Default rate (pp): mean delta = {mean_delta_d:+.3f} pp, sd = {sd_delta_d:.3f} pp | "
        f"paired t = {t_stat_d:.3f}, p = {t_p_d:.4f} | Wilcoxon W = {w_stat_d:.1f}, p = {w_p_d:.4f}"
    )
    return lines


def main() -> None:
    report: list[str] = []

    # --- Stage 3: isolated RL vs. FedAvg (federated) ---
    stage_a_csv = Path("checked_results_20260816/stage_a_isolated_vs_federated/stage_a_raw_summary.csv")
    if stage_a_csv.exists():
        df_a = pd.read_csv(stage_a_csv)
        paired_a = paired_deltas(
            df_a,
            baseline_policy="rl",
            other_policies=["fl_rl"],
            policy_labels={"rl": "Isolated RL", "fl_rl": "FedAvg (federated)"},
        )
        report.append("=" * 78)
        report.append("STAGE 3: FedAvg (federated) vs. Isolated RL")
        report.append("=" * 78)
        report.extend(run_tests(paired_a, "Pooled, all 36 seed-capital-scenario pairs"))
        stressed_a = paired_a[paired_a["default_scenario"].isin(STRESSED_SCENARIOS)]
        report.extend(run_tests(stressed_a, "Stressed-only, 27 pairs (low/medium/high default)"))
        report.append("")
    else:
        report.append(f"SKIPPED Stage 3: {stage_a_csv} not found.")
        report.append("")

    # --- Stage 4: FedProx and SCAFFOLD (c_lr=0.25) vs. FedAvg ---
    stage_b3_csv = Path("stage_b3_scaffold_lr025_comparison/stage_b3_raw_summary.csv")
    if stage_b3_csv.exists():
        df_b3 = pd.read_csv(stage_b3_csv)
        labels = {
            "fl_rl": "FedAvg (baseline)",
            "fl_rl_prox": "FedProx",
            "fl_rl_scaffold": "SCAFFOLD (c_lr=0.25)",
        }
        paired_b3 = paired_deltas(
            df_b3,
            baseline_policy="fl_rl",
            other_policies=["fl_rl_prox", "fl_rl_scaffold"],
            policy_labels=labels,
        )
        report.append("=" * 78)
        report.append("STAGE 4: FedProx / SCAFFOLD (c_lr=0.25) vs. FedAvg")
        report.append("=" * 78)
        for policy_key, policy_label in [("fl_rl_prox", "FedProx"), ("fl_rl_scaffold", "SCAFFOLD (c_lr=0.25)")]:
            subset = paired_b3[paired_b3["other_policy"] == policy_key]
            report.append(f"\n### {policy_label} vs. FedAvg ###")
            report.extend(run_tests(subset, "Pooled, all 36 seed-capital-scenario pairs"))
            stressed_subset = subset[subset["default_scenario"].isin(STRESSED_SCENARIOS)]
            report.extend(run_tests(stressed_subset, "Stressed-only, 27 pairs (low/medium/high default)"))
        report.append("")
    else:
        report.append(f"SKIPPED Stage 4: {stage_b3_csv} not found.")
        report.append("")

    report_text = "\n".join(report)
    print(report_text)
    Path("significance_report.txt").write_text(report_text, encoding="utf-8")
    print("\nSaved: significance_report.txt")


if __name__ == "__main__":
    main()
