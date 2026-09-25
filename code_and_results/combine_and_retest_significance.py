#!/usr/bin/env python
"""Pool the original 3-seed Stage A / Stage B3 runs with the additional
seeds from stage_a_extra_seeds.py / stage_b3_extra_seeds.py, recompute the
matched-comparison summary tables on the larger n, and re-run the paired
significance tests (paired t-test + Wilcoxon signed-rank) from
compute_significance.py on the pooled data.

Run this AFTER stage_a_extra_seeds.py and/or stage_b3_extra_seeds.py have
made progress -- it does not require the full 14-seed run to be finished.
Both extra-seeds scripts checkpoint one seed at a time under
stage_a_extra_seeds/seed_<seed>/ and stage_b3_extra_seeds/seed_<seed>/; this
script automatically discovers and pools however many of those seed folders
exist so far, so you can check partial-power results before the full run
completes. It never modifies the original checked_results_20260816/ or
stage_b3_scaffold_lr025_comparison/ files; everything pooled is written
fresh under combined_significance/.

Run with: python combine_and_retest_significance.py
Output: combined_significance/
  - combined_stage_a_raw_summary.csv / combined_stage_b3_raw_summary.csv
    (original + extra seeds concatenated, for audit)
  - combined_stage_a_matched_comparison.csv / combined_stage_b3_matched_comparison.csv
    (win-counts and mean deltas recomputed on the full pooled n)
  - combined_significance_report.txt (paired t-test + Wilcoxon on the pooled n)
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
from scipy import stats

from federated_comparison_common import matched_comparison, paired_deltas

STRESSED_SCENARIOS = ["low_default", "medium_default", "high_default"]
OUTPUT_DIR = Path("combined_significance")

ORIGINAL_STAGE_A_CSV = Path("checked_results_20260816/stage_a_isolated_vs_federated/stage_a_raw_summary.csv")
EXTRA_STAGE_A_DIR = Path("stage_a_extra_seeds")

ORIGINAL_STAGE_B3_CSV = Path("stage_b3_scaffold_lr025_comparison/stage_b3_raw_summary.csv")
EXTRA_STAGE_B3_DIR = Path("stage_b3_extra_seeds")


def load_extra_seed_csvs(extra_dir: Path) -> pd.DataFrame | None:
    """Discover and concatenate every seed_<seed>/*_raw_summary.csv under
    extra_dir (the checkpoint layout written by the rewritten
    stage_a_extra_seeds.py / stage_b3_extra_seeds.py). Returns None if no
    seed folders exist yet."""
    csvs = sorted(extra_dir.glob("seed_*/*_raw_summary.csv"))
    if not csvs:
        return None
    frames = [pd.read_csv(csv_path) for csv_path in csvs]
    combined = pd.concat(frames, ignore_index=True)
    print(f"  Found {len(csvs)} completed seed checkpoint(s) under {extra_dir}/")
    return combined


def run_tests(paired: pd.DataFrame, label: str) -> list[str]:
    """Same logic as compute_significance.py's run_tests, reused so the two
    scripts' output is directly comparable."""
    lines = [f"--- {label} (n={len(paired)}) ---"]
    if len(paired) < 2:
        lines.append("  Not enough matched pairs to test.")
        return lines

    t_stat, t_p = stats.ttest_rel(paired["other_return_pct"], paired["baseline_return_pct"])
    try:
        w_stat, w_p = stats.wilcoxon(paired["delta_return_pp"])
    except ValueError as exc:
        w_stat, w_p = float("nan"), float("nan")
        lines.append(f"  (Wilcoxon on return skipped: {exc})")
    mean_delta = paired["delta_return_pp"].mean()
    sd_delta = paired["delta_return_pp"].std(ddof=1)
    lines.append(
        f"  Return %:  mean delta = {mean_delta:+.3f} pp, sd = {sd_delta:.3f} pp | "
        f"paired t = {t_stat:.3f}, p = {t_p:.4f} | Wilcoxon W = {w_stat:.1f}, p = {w_p:.4f}"
    )

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


def load_and_pool(original_csv: Path, extra_dir: Path, label: str) -> pd.DataFrame | None:
    if not original_csv.exists():
        print(f"SKIPPING {label}: original file not found at {original_csv}")
        return None
    extra = load_extra_seed_csvs(extra_dir)
    if extra is None:
        print(
            f"SKIPPING {label}: no completed seed checkpoints found under {extra_dir}/. "
            f"Run the corresponding *_extra_seeds.py script first (it saves progress "
            f"seed-by-seed, so this works even on a partially-finished run)."
        )
        return None
    original = pd.read_csv(original_csv)
    overlap = set(original["seed"]).intersection(set(extra["seed"]))
    if overlap:
        raise ValueError(
            f"{label}: extra-seed file shares seed(s) {overlap} with the original file -- "
            f"refusing to pool duplicated runs. Check EXTRA_SEEDS in the *_extra_seeds.py script."
        )
    pooled = pd.concat([original, extra], ignore_index=True)
    print(
        f"{label}: pooled {original['seed'].nunique()} original seed(s) + "
        f"{extra['seed'].nunique()} extra seed(s) = {pooled['seed'].nunique()} total seeds."
    )
    return pooled


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    report: list[str] = []

    # --- Stage A: isolated RL vs. FedAvg (federated) ---
    pooled_a = load_and_pool(ORIGINAL_STAGE_A_CSV, EXTRA_STAGE_A_DIR, "Stage A")
    if pooled_a is not None:
        pooled_a.to_csv(OUTPUT_DIR / "combined_stage_a_raw_summary.csv", index=False)
        labels_a = {"rl": "Isolated RL", "fl_rl": "FedAvg (federated)"}
        comparison_a = matched_comparison(pooled_a, "rl", ["fl_rl"], labels_a)
        comparison_a.to_csv(OUTPUT_DIR / "combined_stage_a_matched_comparison.csv", index=False)
        paired_a = paired_deltas(pooled_a, "rl", ["fl_rl"], labels_a)

        report.append("=" * 78)
        report.append("STAGE A (POOLED): FedAvg (federated) vs. Isolated RL")
        report.append("=" * 78)
        report.append(comparison_a.to_string(index=False))
        report.append("")
        report.extend(run_tests(paired_a, "Pooled, all matched seed-capital-scenario pairs"))
        stressed_a = paired_a[paired_a["default_scenario"].isin(STRESSED_SCENARIOS)]
        report.extend(run_tests(stressed_a, "Stressed-only (low/medium/high default)"))
        report.append("")

    # --- Stage B3: FedProx / SCAFFOLD (c_lr=0.25) vs. FedAvg ---
    pooled_b3 = load_and_pool(ORIGINAL_STAGE_B3_CSV, EXTRA_STAGE_B3_DIR, "Stage B3")
    if pooled_b3 is not None:
        pooled_b3.to_csv(OUTPUT_DIR / "combined_stage_b3_raw_summary.csv", index=False)
        labels_b3 = {
            "fl_rl": "FedAvg (baseline)",
            "fl_rl_prox": "FedProx",
            "fl_rl_scaffold": "SCAFFOLD (c_lr=0.25)",
        }
        comparison_b3 = matched_comparison(pooled_b3, "fl_rl", ["fl_rl_prox", "fl_rl_scaffold"], labels_b3)
        comparison_b3.to_csv(OUTPUT_DIR / "combined_stage_b3_matched_comparison.csv", index=False)
        paired_b3 = paired_deltas(pooled_b3, "fl_rl", ["fl_rl_prox", "fl_rl_scaffold"], labels_b3)

        report.append("=" * 78)
        report.append("STAGE B3 (POOLED): FedProx / SCAFFOLD (c_lr=0.25) vs. FedAvg")
        report.append("=" * 78)
        report.append(comparison_b3.to_string(index=False))
        report.append("")
        for policy_key, policy_label in [("fl_rl_prox", "FedProx"), ("fl_rl_scaffold", "SCAFFOLD (c_lr=0.25)")]:
            subset = paired_b3[paired_b3["other_policy"] == policy_key]
            report.append(f"### {policy_label} vs. FedAvg ###")
            report.extend(run_tests(subset, "Pooled, all matched seed-capital-scenario pairs"))
            stressed_subset = subset[subset["default_scenario"].isin(STRESSED_SCENARIOS)]
            report.extend(run_tests(stressed_subset, "Stressed-only (low/medium/high default)"))
        report.append("")

    if not report:
        print("Nothing to do -- no extra-seed files found yet.")
        return

    report_text = "\n".join(report)
    print()
    print(report_text)
    (OUTPUT_DIR / "combined_significance_report.txt").write_text(report_text, encoding="utf-8")
    print(f"\nSaved: {OUTPUT_DIR / 'combined_significance_report.txt'}")


if __name__ == "__main__":
    main()
