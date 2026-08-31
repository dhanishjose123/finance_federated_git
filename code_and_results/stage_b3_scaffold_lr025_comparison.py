#!/usr/bin/env python
"""Stage B3: does SCAFFOLD with its sensitivity-selected correction rate
(c_lr = 0.25) still beat FedAvg and FedProx, against the same strategies as
Stage B?

Stage B (fedavg_fedprox_scaffold_comparison / checked_results_20260816/
stage_b_fedavg_fedprox_scaffold) used SCAFFOLD's default correction rate,
scaffold_c_lr = 0.5 (see egt_apr_simulation.Financier.scaffold_c_lr). The
50-borrower correction-rate sensitivity check (scaffold_sensitivity_50_borrowers,
compared only against isolated RL, not FedAvg/FedProx) found that a lower
rate, c_lr = 0.25, gives the strongest average result.

This script re-runs the exact Stage B design -- same 39-wholesaler
population, same 4000-day horizon, same three seeds, three capital levels,
four default-severity profiles, same non-IID borrower segmentation, same
matched counterfactual (separate_policy_runs=True) design -- with SCAFFOLD's
correction rate fixed at 0.25 instead of the default 0.5, so the comparison
against FedAvg and FedProx is apples-to-apples with the existing Stage B
table (tab:fedavg-fedprox-scaffold in the manuscript).

Run with: python stage_b3_scaffold_lr025_comparison.py
Output: stage_b3_scaffold_lr025_comparison/
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

import egt_apr_simulation as sim
from federated_comparison_common import matched_comparison, run_experiment, summarize_by_group

SCAFFOLD_C_LR = 0.25
STRESSED_SCENARIOS = ["low_default", "medium_default", "high_default"]

POLICY_GROUPS = ["fl_rl", "fl_rl_prox", "fl_rl_scaffold"]
POLICY_LABELS = {
    "fl_rl": "FedAvg (baseline)",
    "fl_rl_prox": "FedProx",
    "fl_rl_scaffold": f"SCAFFOLD (c_lr={SCAFFOLD_C_LR:.2f})",
}
NON_IID_GROUP_POLICIES = ("fl_rl", "fl_rl_prox", "fl_rl_scaffold")

_original_build_financiers = sim.build_financiers


def _patched_build_financiers(*args, **kwargs):
    """Force every fl_rl_scaffold financier onto the sensitivity-selected
    correction rate instead of the class default (0.5), leaving FedAvg and
    FedProx financiers untouched. Same technique used in
    scaffold_sensitivity_50_borrowers.py.
    """
    financiers = _original_build_financiers(*args, **kwargs)
    for financier in financiers:
        if financier.wholesaler_policy == "fl_rl_scaffold":
            financier.scaffold_c_lr = SCAFFOLD_C_LR
    return financiers


def write_stressed_only_report(output_dir: Path, output_prefix: str) -> None:
    """Post-process run_experiment's saved raw CSV into a stressed-only
    (low/medium/high default, none_default excluded) supplementary report.
    none_default has no repayment stress and therefore little differentiated
    signal for any aggregation rule to correct for -- this is the number
    that should be quoted as the headline result, not the all-4-scenario
    pooled figure.
    """
    raw = pd.read_csv(output_dir / f"{output_prefix}_raw_summary.csv")
    stressed = raw[raw["default_scenario"].isin(STRESSED_SCENARIOS)]

    overall_stressed = summarize_by_group(stressed, ["wholesaler_policy"], POLICY_LABELS)
    comparison_stressed = matched_comparison(
        stressed, "fl_rl", ["fl_rl_prox", "fl_rl_scaffold"], POLICY_LABELS
    )

    report_lines = [
        f"Stage B3 -- STRESSED-ONLY (low/medium/high default only, none_default excluded)",
        "=" * 88,
        "Recomputed from stage_b3_raw_summary.csv, filtering out none_default before pooling.",
        "",
        f"--- Matched comparison vs. FedAvg (baseline), stressed scenarios only ---",
        comparison_stressed.to_string(index=False),
        "",
        "--- Overall (pooled across seeds, capital levels, stressed scenarios only) ---",
        overall_stressed.to_string(index=False),
    ]
    report_text = "\n".join(report_lines)
    print()
    print(report_text)
    (output_dir / f"{output_prefix}_stressed_only_report.txt").write_text(report_text, encoding="utf-8")
    print(f"\nSaved: {output_dir / f'{output_prefix}_stressed_only_report.txt'}")


if __name__ == "__main__":
    OUTPUT_DIR = Path("stage_b3_scaffold_lr025_comparison")
    OUTPUT_PREFIX = "stage_b3"
    sim.build_financiers = _patched_build_financiers
    try:
        run_experiment(
            title=f"Stage B3: FedAvg vs. FedProx vs. SCAFFOLD (c_lr={SCAFFOLD_C_LR:.2f})",
            policy_groups=POLICY_GROUPS,
            policy_labels=POLICY_LABELS,
            non_iid_group_policies=NON_IID_GROUP_POLICIES,
            baseline_policy="fl_rl",
            other_policies=["fl_rl_prox", "fl_rl_scaffold"],
            output_dir=OUTPUT_DIR,
            output_prefix=OUTPUT_PREFIX,
            separate_policy_runs=True,
        )
    finally:
        sim.build_financiers = _original_build_financiers

    write_stressed_only_report(OUTPUT_DIR, OUTPUT_PREFIX)
