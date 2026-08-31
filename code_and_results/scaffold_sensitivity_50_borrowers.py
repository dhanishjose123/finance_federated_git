#!/usr/bin/env python
"""SCAFFOLD sensitivity test against isolated RL with 50 borrowers.

Run with:
    python scaffold_sensitivity_50_borrowers.py

Output:
    scaffold_sensitivity_50_borrowers/

The script compares isolated borrower-side RL with federated SCAFFOLD under
different SCAFFOLD correction rates. It fixes the borrower population at 50
and saves checkpoint CSV files after every completed run.
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
SCAFFOLD_LEVELS = [0.25, 0.50, 0.75, 1.00]

NUM_FINANCIERS_PER_GROUP = 3
POLICY_GROUPS = ["rl", "fl_rl_scaffold"]
POLICY_LABELS = {
    "rl": "Isolated RL",
    "fl_rl_scaffold": "Federated RL with SCAFFOLD",
}

# Lower values make each financier see a more skewed local borrower segment.
NON_IID_PRIMARY_SHARE = 0.5

# Selected finance-model parameters used in the main experiments.
APR_ALPHA = 0.25
APR_GAMMA = 0.95
APR_EPSILON = 0.08
BORROWER_ALPHA = 0.10
BORROWER_GAMMA = 0.70
BORROWER_EPSILON = 0.05
BORROWER_PREMIUM_ACTIONS = (-2.0, 0.0, 4.0, 8.0, 12.0, 16.0)

# 50-borrower versions of the four default scenarios.
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

OUTPUT_DIR = Path("scaffold_sensitivity_50_borrowers")
RAW_PATH = OUTPUT_DIR / "scaffold_sensitivity_50b_raw_summary.csv"
RUN_LOG_PATH = OUTPUT_DIR / "scaffold_sensitivity_50b_run_log.csv"
EXCEL_PATH = OUTPUT_DIR / "scaffold_sensitivity_50b_results.xlsx"
REPORT_PATH = OUTPUT_DIR / "scaffold_sensitivity_50b_report.txt"
SHEET_CSV_DIR = OUTPUT_DIR / "summary_sheets"


def scaffold_tag(value: float) -> str:
    return f"{value:.2f}".replace(".", "p")


def build_group_lists() -> tuple[list[str], list[str], list[float]]:
    financier_names: list[str] = []
    wholesaler_policies: list[str] = []
    base_aprs: list[float] = []
    for policy in POLICY_GROUPS:
        for idx in range(1, NUM_FINANCIERS_PER_GROUP + 1):
            financier_names.append(f"Fin_{policy}_{idx}")
            wholesaler_policies.append(policy)
            base_aprs.append(6.0)
    return financier_names, wholesaler_policies, base_aprs


def run_one(seed: int, scenario: dict, capital: float, scaffold_lr: float) -> pd.DataFrame:
    financier_names, wholesaler_policies, base_aprs = build_group_lists()
    n = len(financier_names)

    original_build_financiers = sim.build_financiers

    def patched_build_financiers(*args, **kwargs):
        financiers = original_build_financiers(*args, **kwargs)
        for financier in financiers:
            if financier.wholesaler_policy == "fl_rl_scaffold":
                financier.scaffold_c_lr = scaffold_lr
        return financiers

    sim.build_financiers = patched_build_financiers
    try:
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
            non_iid_primary_share=NON_IID_PRIMARY_SHARE,
            non_iid_group_policies=tuple(POLICY_GROUPS),
        )
    finally:
        sim.build_financiers = original_build_financiers

    summary = frames["Financier_Summary"].copy()
    summary["scaffold_lr"] = scaffold_lr
    summary["scaffold_level"] = scaffold_tag(scaffold_lr)
    summary["seed"] = seed
    summary["default_scenario"] = scenario["name"]
    summary["capital_per_financier"] = capital
    summary["borrower_count"] = sum(scenario["shock_profile_counts"].values())
    return summary


def summarize_by_group(rows: pd.DataFrame, group_cols: list[str]) -> pd.DataFrame:
    agg_spec = {
        "financiers": ("financier", "nunique"),
        "rows": ("financier", "count"),
        "total_initial_capital": ("initial_capital", "sum"),
        "total_final_capital": ("final_capital", "sum"),
        "mean_final_capital": ("final_capital", "mean"),
        "total_capital_change": ("capital_change", "sum"),
        "total_defaults": ("defaults", "sum"),
        "total_loans": ("loans_issued", "sum"),
        "mean_default_amount_rate": ("default_amount_to_initial_capital_rate", "mean"),
        "mean_final_utilization": ("final_utilization", "mean"),
    }
    grouped = rows.groupby(group_cols).agg(**agg_spec).reset_index()
    grouped["mean_return_pct"] = (
        100.0 * grouped["total_capital_change"] / grouped["total_initial_capital"]
    )
    grouped["total_default_rate_pct"] = grouped.apply(
        lambda row: 100.0 * row["total_defaults"] / row["total_loans"]
        if row["total_loans"]
        else 0.0,
        axis=1,
    )
    grouped["mean_final_utilization_pct"] = 100.0 * grouped["mean_final_utilization"]
    if "wholesaler_policy" in grouped.columns:
        grouped["policy_label"] = grouped["wholesaler_policy"].map(POLICY_LABELS)
    return grouped


def paired_win_summary(run_policy: pd.DataFrame) -> pd.DataFrame:
    index_cols = ["scaffold_lr", "seed", "capital_per_financier", "default_scenario"]
    return_pivot = run_policy.pivot(
        index=index_cols, columns="wholesaler_policy", values="mean_return_pct"
    )
    default_pivot = run_policy.pivot(
        index=index_cols, columns="wholesaler_policy", values="total_default_rate_pct"
    )

    if not {"rl", "fl_rl_scaffold"}.issubset(return_pivot.columns):
        return pd.DataFrame()

    paired = return_pivot.reset_index()
    paired["delta_return_pp"] = paired["fl_rl_scaffold"] - paired["rl"]
    paired["scaffold_return_win"] = paired["delta_return_pp"] > 0
    paired["delta_default_pp"] = (
        default_pivot["rl"] - default_pivot["fl_rl_scaffold"]
    ).reset_index(drop=True)
    paired["scaffold_default_win"] = paired["delta_default_pp"] > 0

    return (
        paired.groupby("scaffold_lr")
        .agg(
            matched_runs=("seed", "count"),
            return_wins=("scaffold_return_win", "sum"),
            default_wins=("scaffold_default_win", "sum"),
            mean_delta_return_pp=("delta_return_pp", "mean"),
            mean_delta_default_pp=("delta_default_pp", "mean"),
        )
        .reset_index()
    )


def write_result_tables(frames: dict[str, pd.DataFrame], output_path: Path) -> str:
    """Write the summary tables without requiring xlsxwriter.

    The main simulation helper uses the xlsxwriter engine. Some Anaconda
    environments do not install it by default. This fallback first tries
    openpyxl, then writes one CSV file per sheet so results are never lost.
    """
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


def load_existing() -> tuple[pd.DataFrame, pd.DataFrame, set[tuple[float, int, float, str]]]:
    if RAW_PATH.exists():
        raw = pd.read_csv(RAW_PATH)
    else:
        raw = pd.DataFrame()

    if RUN_LOG_PATH.exists():
        run_log = pd.read_csv(RUN_LOG_PATH)
    else:
        run_log = pd.DataFrame()

    completed: set[tuple[float, int, float, str]] = set()
    if not raw.empty:
        key_cols = ["scaffold_lr", "seed", "capital_per_financier", "default_scenario"]
        for row in raw[key_cols].drop_duplicates().itertuples(index=False, name=None):
            completed.add((float(row[0]), int(row[1]), float(row[2]), str(row[3])))
    return raw, run_log, completed


def save_outputs(raw: pd.DataFrame, run_log: pd.DataFrame) -> None:
    raw.to_csv(RAW_PATH, index=False)
    run_log.to_csv(RUN_LOG_PATH, index=False)

    run_policy = summarize_by_group(
        raw,
        ["scaffold_lr", "seed", "capital_per_financier", "default_scenario", "wholesaler_policy"],
    )
    overall = summarize_by_group(raw, ["scaffold_lr", "wholesaler_policy"])
    by_capital = summarize_by_group(raw, ["scaffold_lr", "capital_per_financier", "wholesaler_policy"])
    by_scenario = summarize_by_group(raw, ["scaffold_lr", "default_scenario", "wholesaler_policy"])
    by_capital_scenario = summarize_by_group(
        raw, ["scaffold_lr", "capital_per_financier", "default_scenario", "wholesaler_policy"]
    )
    wins = paired_win_summary(run_policy)

    workbook_status = write_result_tables(
        {
            "Overall": overall,
            "By_Capital": by_capital,
            "By_Scenario": by_scenario,
            "By_Capital_Scenario": by_capital_scenario,
            "Run_Policy": run_policy,
            "Win_Summary": wins,
            "Run_Log": run_log,
            "Raw_Summary": raw,
        },
        EXCEL_PATH,
    )

    best_line = "No completed runs yet."
    if not wins.empty:
        best = wins.sort_values(
            ["mean_delta_return_pp", "mean_delta_default_pp"], ascending=False
        ).iloc[0]
        best_line = (
            f"Best mean return gain: scaffold_lr={best['scaffold_lr']:.2f}, "
            f"return delta={best['mean_delta_return_pp']:.3f} pp, "
            f"default-rate delta={best['mean_delta_default_pp']:.3f} pp."
        )

    report = [
        "SCAFFOLD sensitivity test against isolated RL with 50 borrowers",
        "=" * 72,
        f"Days: {DAYS}",
        f"Seeds: {SEEDS}",
        f"Capital levels per financier: {CAPITALS_PER_FINANCIER}",
        f"SCAFFOLD correction rates tested: {SCAFFOLD_LEVELS}",
        f"Financiers per policy group: {NUM_FINANCIERS_PER_GROUP}",
        f"Non-IID primary share: {NON_IID_PRIMARY_SHARE}",
        f"Default scenarios: {[scenario['name'] for scenario in DEFAULT_SCENARIOS]}",
        workbook_status,
        "",
        best_line,
        "",
        "Overall summary:",
        overall.to_string(index=False),
        "",
        "Win summary:",
        wins.to_string(index=False) if not wins.empty else "No paired comparison available.",
    ]
    REPORT_PATH.write_text("\n".join(report), encoding="utf-8")


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    raw, run_log, completed = load_existing()
    raw_frames = [] if raw.empty else [raw]
    run_rows = [] if run_log.empty else run_log.to_dict("records")

    total_runs = (
        len(SCAFFOLD_LEVELS)
        * len(CAPITALS_PER_FINANCIER)
        * len(DEFAULT_SCENARIOS)
        * len(SEEDS)
    )
    run_index = 0
    start = time.time()

    for scaffold_lr in SCAFFOLD_LEVELS:
        for capital in CAPITALS_PER_FINANCIER:
            for scenario in DEFAULT_SCENARIOS:
                for seed in SEEDS:
                    run_index += 1
                    key = (float(scaffold_lr), int(seed), float(capital), scenario["name"])
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
                        f"[{run_index}/{total_runs}] scaffold_lr={scaffold_lr:.2f} "
                        f"seed={seed} scenario={scenario['name']} "
                        f"capital={capital:,.0f} borrowers=50 ETA={eta / 60:.1f} min"
                    )

                    one_start = time.time()
                    summary = run_one(seed, scenario, capital, scaffold_lr)
                    raw_frames.append(summary)
                    completed.add(key)
                    run_rows.append(
                        {
                            "scaffold_lr": scaffold_lr,
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

    if raw_frames:
        raw = pd.concat(raw_frames, ignore_index=True)
        run_log = pd.DataFrame(run_rows)
        save_outputs(raw, run_log)

    print(f"\nSaved: {REPORT_PATH}")
    print(f"Saved: {EXCEL_PATH}")
    print(f"Elapsed: {(time.time() - start) / 60:.1f} min")


if __name__ == "__main__":
    main()
