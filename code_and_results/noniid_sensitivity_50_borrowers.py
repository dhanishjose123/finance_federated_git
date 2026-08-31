#!/usr/bin/env python
"""Non-IID heterogeneity sensitivity check: does SCAFFOLD's edge over FedAvg
and FedProx grow as financier borrower portfolios become more skewed?

IMPORTANT -- primary_share direction: assign_non_iid_borrower_segments()'s
own docstring and the other stage scripts' report headers claim
"primary_share=1.0 reproduces the fully-shared/IID market" and "lower
primary_share for stronger heterogeneity." That is backwards. Tracing the
actual formula, minority_count = max(1, round(pool_size * (1 - primary_share))):
  - primary_share = 0.0 -> minority_count = full pool for every other tier
    -> every financier is eligible for ALL borrowers -> fully shared / IID.
  - primary_share = 1.0 -> minority_count = 1 (floor) for every other tier
    -> each financier sees almost only its own primary risk tier
    -> maximally skewed / non-IID.
This script uses that corrected direction and labels its output accordingly.
The existing Stage A/B/B2/SCAFFOLD-sensitivity results all used
primary_share=0.5 (a moderate point roughly mid-range, not "close to IID" as
their own headers imply).

IMPORTANT -- matched design (fixed after the first run): the first version of
this script ran FedAvg, FedProx, and SCAFFOLD together in ONE shared
simulation per (level, seed, capital, scenario), competing for the same
50-borrower pool simultaneously. That is NOT how Stage A/B/B2/B3 are run --
they all use separate_policy_runs=True, an independent simulation per
policy, specifically so one policy's loan volume can't mechanically crowd
out another's and confound the aggregation-rule comparison with a
market-share effect. The first run's results (16/36, 16/36, 13/36 wins for
SCAFFOLD as heterogeneity increased -- the opposite of the expected trend)
are not trustworthy and should be discarded; they live in the old
noniid_sensitivity_50_borrowers/ output folder, which this version does not
read from or write to. This version fixes that: each policy is simulated
alone, matching Stage B3's design exactly, just swept over non_iid_level
instead of held at 0.5.

Design: mirrors scaffold_sensitivity_50_borrowers.py's reduced-scale pattern
(50 borrowers, 2000-day horizon, three seeds, three capital levels, four
default-severity profiles) rather than the full 39-wholesaler/4000-day main
design, to keep this secondary sensitivity check affordable. SCAFFOLD's
correction rate is held fixed at 0.25 throughout (the value selected by the
correction-rate sensitivity check), so this isolates the effect of
heterogeneity alone. Compares FedAvg, FedProx, and SCAFFOLD (not just
SCAFFOLD vs. isolated RL), matching Stage B's three-way design, via separate
matched counterfactual runs (matching Stage B/B3's separate_policy_runs=True).

Run with: python noniid_sensitivity_50_borrowers.py
Output: noniid_sensitivity_50_borrowers_matched/
"""

from __future__ import annotations

import time
from pathlib import Path

import pandas as pd

import egt_apr_simulation as sim

# ---------------------------------------------------------------------------
# Editable experiment settings
# ---------------------------------------------------------------------------

DAYS = 2000
SEEDS = [709098, 436570, 831197]
CAPITALS_PER_FINANCIER = [1_000_000.0, 5_000_000.0, 10_000_000.0]

# Corrected-direction sweep: 0.0 = fully shared/IID, 1.0 = maximally skewed.
NON_IID_LEVELS = [0.0, 0.5, 1.0]

SCAFFOLD_C_LR = 0.25  # fixed throughout -- this check isolates heterogeneity, not correction rate.

NUM_FINANCIERS_PER_GROUP = 3
POLICY_GROUPS = ["fl_rl", "fl_rl_prox", "fl_rl_scaffold"]
POLICY_LABELS = {
    "fl_rl": "FedAvg (baseline)",
    "fl_rl_prox": "FedProx",
    "fl_rl_scaffold": f"SCAFFOLD (c_lr={SCAFFOLD_C_LR:.2f})",
}
BASELINE_POLICY = "fl_rl"
OTHER_POLICIES = ["fl_rl_prox", "fl_rl_scaffold"]

# Selected finance-model parameters used in the main experiments.
APR_ALPHA = 0.25
APR_GAMMA = 0.95
APR_EPSILON = 0.08
BORROWER_ALPHA = 0.10
BORROWER_GAMMA = 0.70
BORROWER_EPSILON = 0.05
BORROWER_PREMIUM_ACTIONS = (-2.0, 0.0, 4.0, 8.0, 12.0, 16.0)

# 50-borrower versions of the four default scenarios (same as
# scaffold_sensitivity_50_borrowers.py, for direct comparability).
DEFAULT_SCENARIOS = [
    {
        "name": "none_default",
        "disable_defaults": True,
        "shock_profile_counts": {"none": 50},
        "medium_shock_range": (0.0, 0.0),
        "high_shock_range": (0.0, 0.0),
    },
    {
        "name": "low_default",
        "disable_defaults": False,
        "shock_profile_counts": {"none": 44, "medium": 5, "high": 1},
        "medium_shock_range": (-0.005, -0.015),
        "high_shock_range": (-0.02, -0.05),
    },
    {
        "name": "medium_default",
        "disable_defaults": False,
        "shock_profile_counts": {"none": 38, "medium": 9, "high": 3},
        "medium_shock_range": (-0.008, -0.025),
        "high_shock_range": (-0.04, -0.08),
    },
    {
        "name": "high_default",
        "disable_defaults": False,
        "shock_profile_counts": {"none": 32, "medium": 13, "high": 5},
        "medium_shock_range": (-0.01, -0.04),
        "high_shock_range": (-0.05, -0.12),
    },
]

# New output location -- deliberately does not reuse the old (shared-market,
# invalid) noniid_sensitivity_50_borrowers/ folder, so stale results can't be
# silently mixed with the corrected matched-counterfactual runs.
OUTPUT_DIR = Path("noniid_sensitivity_50_borrowers_matched")
RAW_PATH = OUTPUT_DIR / "noniid_sensitivity_50b_raw_summary.csv"
RUN_LOG_PATH = OUTPUT_DIR / "noniid_sensitivity_50b_run_log.csv"
EXCEL_PATH = OUTPUT_DIR / "noniid_sensitivity_50b_results.xlsx"
REPORT_PATH = OUTPUT_DIR / "noniid_sensitivity_50b_report.txt"
SHEET_CSV_DIR = OUTPUT_DIR / "summary_sheets"

_original_build_financiers = sim.build_financiers


def _patched_build_financiers(*args, **kwargs):
    """Force every fl_rl_scaffold financier onto the fixed c_lr=0.25 used
    throughout this check, leaving FedAvg and FedProx financiers untouched.
    """
    financiers = _original_build_financiers(*args, **kwargs)
    for financier in financiers:
        if financier.wholesaler_policy == "fl_rl_scaffold":
            financier.scaffold_c_lr = SCAFFOLD_C_LR
    return financiers


def level_tag(value: float) -> str:
    return f"{value:.2f}".replace(".", "p")


def build_group_lists(policy: str) -> tuple[list[str], list[str], list[float]]:
    """Single-policy version: builds only this policy's financiers, so each
    simulation run contains one policy group in isolation (matched
    counterfactual design), not all three competing together.
    """
    financier_names: list[str] = []
    wholesaler_policies: list[str] = []
    base_aprs: list[float] = []
    for idx in range(1, NUM_FINANCIERS_PER_GROUP + 1):
        financier_names.append(f"Fin_{policy}_{idx}")
        wholesaler_policies.append(policy)
        base_aprs.append(6.0)
    return financier_names, wholesaler_policies, base_aprs


def run_one(seed: int, scenario: dict, capital: float, policy: str, non_iid_level: float) -> pd.DataFrame:
    financier_names, wholesaler_policies, base_aprs = build_group_lists(policy)
    n = len(financier_names)

    frames = sim.run_simulation(
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
        non_iid_primary_share=non_iid_level,
        non_iid_group_policies=(policy,),
    )

    summary = frames["Financier_Summary"].copy()
    summary["non_iid_level"] = non_iid_level
    summary["non_iid_tag"] = level_tag(non_iid_level)
    summary["seed"] = seed
    summary["default_scenario"] = scenario["name"]
    summary["capital_per_financier"] = capital
    return summary


def summarize_by_group(rows: pd.DataFrame, group_cols: list[str]) -> pd.DataFrame:
    def weighted_return_pct(capital_change: pd.Series) -> float:
        initial_capital_sum = rows.loc[capital_change.index, "initial_capital"].sum()
        if not initial_capital_sum:
            return 0.0
        return 100.0 * capital_change.sum() / initial_capital_sum

    grouped = (
        rows.groupby(group_cols)
        .agg(
            financiers=("financier", "nunique"),
            runs=("financier", "count"),
            total_initial_capital=("initial_capital", "sum"),
            total_final_capital=("final_capital", "sum"),
            mean_return_pct=("capital_change", weighted_return_pct),
            total_defaults=("defaults", "sum"),
            total_loans=("loans_issued", "sum"),
            default_count_rate=("default_count_rate", "mean"),
        )
        .reset_index()
    )
    if "wholesaler_policy" in grouped.columns:
        grouped["policy_label"] = grouped["wholesaler_policy"].map(POLICY_LABELS)
    return grouped


def matched_comparison_by_level(rows: pd.DataFrame) -> pd.DataFrame:
    """Per non_iid_level, win count and mean delta for FedProx and SCAFFOLD
    vs. FedAvg, so the trend across heterogeneity levels is directly
    readable.
    """
    match_keys = ["non_iid_level", "seed", "capital_per_financier", "default_scenario"]

    def weighted_return_pct(capital_change: pd.Series) -> float:
        initial_capital_sum = rows.loc[capital_change.index, "initial_capital"].sum()
        if not initial_capital_sum:
            return 0.0
        return 100.0 * capital_change.sum() / initial_capital_sum

    per_run = (
        rows.groupby(match_keys + ["wholesaler_policy"])
        .agg(
            mean_return_pct=("capital_change", weighted_return_pct),
            mean_default_count_rate=("default_count_rate", "mean"),
        )
        .reset_index()
    )
    baseline = per_run[per_run["wholesaler_policy"] == BASELINE_POLICY].set_index(match_keys)

    out_rows = []
    for level in NON_IID_LEVELS:
        for policy in OTHER_POLICIES:
            other = per_run[
                (per_run["wholesaler_policy"] == policy) & (per_run["non_iid_level"] == level)
            ].set_index(match_keys)
            base_level = baseline[baseline.index.get_level_values("non_iid_level") == level]
            matched = other.join(base_level, lsuffix="_other", rsuffix="_base", how="inner")
            if matched.empty:
                continue
            wins = int((matched["mean_return_pct_other"] > matched["mean_return_pct_base"]).sum())
            out_rows.append(
                {
                    "non_iid_level": level,
                    "comparison": f"{POLICY_LABELS[policy]} vs. {POLICY_LABELS[BASELINE_POLICY]}",
                    "wins": f"{wins}/{len(matched)}",
                    "mean_delta_return_pp": (
                        matched["mean_return_pct_other"] - matched["mean_return_pct_base"]
                    ).mean(),
                    "mean_delta_default_count_rate_pp": 100.0
                    * (matched["mean_default_count_rate_other"] - matched["mean_default_count_rate_base"]).mean(),
                }
            )
    return pd.DataFrame(out_rows)


STRESSED_SCENARIOS = ["low_default", "medium_default", "high_default"]


def matched_comparison_by_level_stressed(rows: pd.DataFrame) -> pd.DataFrame:
    """Same as matched_comparison_by_level, but pooling only low/medium/high
    default scenarios -- excludes none_default, since that scenario has no
    repayment stress and therefore little differentiated signal for any
    aggregation rule to correct for. This is the number that should be
    quoted as the headline result.
    """
    return matched_comparison_by_level(rows[rows["default_scenario"].isin(STRESSED_SCENARIOS)])


def write_result_tables(frames: dict[str, pd.DataFrame], output_path: Path) -> str:
    try:
        sim.write_excel(frames, output_path)
        return f"Excel workbook saved: {output_path}"
    except ModuleNotFoundError as exc:
        if exc.name != "xlsxwriter":
            raise
    try:
        with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
            for sheet_name, frame in frames.items():
                frame.to_excel(writer, sheet_name=sheet_name[:31], index=False)
        return f"Excel workbook saved with openpyxl: {output_path}"
    except ModuleNotFoundError:
        SHEET_CSV_DIR.mkdir(exist_ok=True)
        for sheet_name, frame in frames.items():
            csv_name = f"{sheet_name}.csv".replace(" ", "_")
            frame.to_csv(SHEET_CSV_DIR / csv_name, index=False)
        return f"xlsxwriter/openpyxl not installed; CSV sheets saved in: {SHEET_CSV_DIR}"


def load_existing() -> tuple[pd.DataFrame, pd.DataFrame, set[tuple[float, int, float, str, str]]]:
    raw = pd.read_csv(RAW_PATH) if RAW_PATH.exists() else pd.DataFrame()
    run_log = pd.read_csv(RUN_LOG_PATH) if RUN_LOG_PATH.exists() else pd.DataFrame()
    completed: set[tuple[float, int, float, str, str]] = set()
    if not raw.empty:
        key_cols = ["non_iid_level", "seed", "capital_per_financier", "default_scenario", "wholesaler_policy"]
        for row in raw[key_cols].drop_duplicates().itertuples(index=False, name=None):
            completed.add((float(row[0]), int(row[1]), float(row[2]), str(row[3]), str(row[4])))
    return raw, run_log, completed


def save_outputs(raw: pd.DataFrame, run_log: pd.DataFrame) -> None:
    raw.to_csv(RAW_PATH, index=False)
    run_log.to_csv(RUN_LOG_PATH, index=False)

    overall = summarize_by_group(raw, ["non_iid_level", "wholesaler_policy"])
    by_capital = summarize_by_group(raw, ["non_iid_level", "capital_per_financier", "wholesaler_policy"])
    by_scenario = summarize_by_group(raw, ["non_iid_level", "default_scenario", "wholesaler_policy"])
    comparison = matched_comparison_by_level(raw)

    stressed_raw = raw[raw["default_scenario"].isin(STRESSED_SCENARIOS)]
    overall_stressed = summarize_by_group(stressed_raw, ["non_iid_level", "wholesaler_policy"])
    comparison_stressed = matched_comparison_by_level_stressed(raw)

    workbook_status = write_result_tables(
        {
            "Overall_By_Level": overall,
            "By_Capital": by_capital,
            "By_Scenario": by_scenario,
            "Matched_Comparison_By_Level": comparison,
            "Overall_Stressed_Only": overall_stressed,
            "Matched_Comparison_Stressed_Only": comparison_stressed,
            "Run_Log": run_log,
            "Raw_Summary": raw,
        },
        EXCEL_PATH,
    )

    report = [
        "Non-IID heterogeneity sensitivity check (FedAvg vs FedProx vs SCAFFOLD, c_lr=0.25 fixed)",
        "=" * 88,
        "Run design: separate matched counterfactual policy runs (matches Stage B3).",
        "NOTE: 0.0 = fully shared/IID borrower pool, 1.0 = maximally skewed/non-IID.",
        "(This is the OPPOSITE direction to the label used in other stage reports --",
        " see the docstring in this script for the traced formula.)",
        f"Days: {DAYS}",
        f"Seeds: {SEEDS}",
        f"Capital levels per financier: {CAPITALS_PER_FINANCIER}",
        f"Non-IID levels tested: {NON_IID_LEVELS}",
        f"SCAFFOLD correction rate (fixed): {SCAFFOLD_C_LR}",
        f"Financiers per policy group: {NUM_FINANCIERS_PER_GROUP}",
        f"Default scenarios: {[s['name'] for s in DEFAULT_SCENARIOS]}",
        workbook_status,
        "",
        "Overall summary by non-IID level and policy (all 4 default scenarios pooled):",
        overall.to_string(index=False),
        "",
        "Matched comparison vs. FedAvg, by non-IID level (all 4 default scenarios pooled):",
        comparison.to_string(index=False) if not comparison.empty else "No paired comparison available.",
        "",
        "=" * 88,
        "STRESSED-ONLY RESULTS (low/medium/high default only, none_default excluded)",
        "This is the headline result to quote -- none_default has no repayment stress and",
        "therefore little differentiated signal for any aggregation rule to correct for.",
        "=" * 88,
        "",
        "Overall summary by non-IID level and policy (stressed scenarios only):",
        overall_stressed.to_string(index=False),
        "",
        "Matched comparison vs. FedAvg, by non-IID level (stressed scenarios only):",
        comparison_stressed.to_string(index=False)
        if not comparison_stressed.empty
        else "No paired comparison available.",
    ]
    REPORT_PATH.write_text("\n".join(report), encoding="utf-8")


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    raw, run_log, completed = load_existing()
    raw_frames = [] if raw.empty else [raw]
    run_rows = [] if run_log.empty else run_log.to_dict("records")

    total_runs = (
        len(NON_IID_LEVELS) * len(CAPITALS_PER_FINANCIER) * len(DEFAULT_SCENARIOS) * len(SEEDS) * len(POLICY_GROUPS)
    )
    run_index = 0
    start = time.time()

    sim.build_financiers = _patched_build_financiers
    try:
        for non_iid_level in NON_IID_LEVELS:
            for capital in CAPITALS_PER_FINANCIER:
                for scenario in DEFAULT_SCENARIOS:
                    for seed in SEEDS:
                        for policy in POLICY_GROUPS:
                            run_index += 1
                            key = (float(non_iid_level), int(seed), float(capital), scenario["name"], policy)
                            if key in completed:
                                print(f"[{run_index}/{total_runs}] Skip completed {key}")
                                continue

                            elapsed = time.time() - start
                            completed_count = len(completed)
                            eta = (
                                elapsed / max(1, completed_count) * (total_runs - completed_count)
                                if completed_count
                                else 0.0
                            )
                            print(
                                f"[{run_index}/{total_runs}] non_iid_level={non_iid_level:.2f} "
                                f"policy={policy} seed={seed} scenario={scenario['name']} "
                                f"capital={capital:,.0f} borrowers=50 ETA={eta / 60:.1f} min"
                            )

                            one_start = time.time()
                            summary = run_one(seed, scenario, capital, policy, non_iid_level)
                            raw_frames.append(summary)
                            completed.add(key)
                            run_rows.append(
                                {
                                    "non_iid_level": non_iid_level,
                                    "policy": policy,
                                    "seed": seed,
                                    "capital_per_financier": capital,
                                    "default_scenario": scenario["name"],
                                    "borrower_count": 50,
                                    "elapsed_seconds": time.time() - one_start,
                                }
                            )

                            raw = pd.concat(raw_frames, ignore_index=True)
                            run_log = pd.DataFrame(run_rows)
                            save_outputs(raw, run_log)
                            print(f"Checkpoint saved: {len(completed)}/{total_runs} runs complete.")
    finally:
        sim.build_financiers = _original_build_financiers

    if raw_frames:
        raw = pd.concat(raw_frames, ignore_index=True)
        run_log = pd.DataFrame(run_rows)
        save_outputs(raw, run_log)

    print(f"\nSaved: {REPORT_PATH}")
    print(f"Saved: {EXCEL_PATH}")
    print(f"Elapsed: {(time.time() - start) / 60:.1f} min")


if __name__ == "__main__":
    main()
