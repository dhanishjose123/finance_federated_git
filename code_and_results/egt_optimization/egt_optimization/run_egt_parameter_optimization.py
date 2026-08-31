#!/usr/bin/env python
"""Optimize regular borrower-side EGT parameters.

Experiment design:
- Candidate financier uses pure RL for financier-side APR.
- Candidate borrower screening uses the regular ``egt`` borrower score model.
- Candidate competes against borrower RL and fixed 6/8/10 APR with no screening.
- Ranking objective is total final capital across capitals, default scenarios, and seeds.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

import pandas as pd


ROOT_DIR = Path(__file__).resolve().parents[1]
OUTPUT_DIR = Path(__file__).resolve().parent
SIM_PATH = ROOT_DIR / "egt_apr_simulation.py"

spec = importlib.util.spec_from_file_location("basics_egt_apr_simulation", SIM_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Could not load simulator from {SIM_PATH}")
sim = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = sim
spec.loader.exec_module(sim)

run_simulation = sim.run_simulation


CAPITALS_TO_RUN = [
    1_000_000.0,
    5_000_000.0,
    10_000_000.0,
]

SEEDS_TO_RUN = [42, 123, 777]
BORROWER_MARGIN = 0.20
DAYS = 4000

DEFAULT_SCENARIOS_TO_RUN = [
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

EGT_ALPHA_VALUES = [0.10, 0.30, 0.60]
EGT_ETA_VALUES = [100.0, 200.0, 300.0]

FINE_ACTIONS = (
    6.0,
    8.0,
    10.0,
    12.0,
    14.0,
    16.0,
    18.0,
    20.0,
    24.0,
    30.0,
    36.0,
)

FINANCIERS = [
    ("Fin_RL_Borrower_EGT", "pure_rl", "egt", 6.0),
    ("Fin_RL_Borrower_RL", "pure_rl", "rl", 6.0),
    ("Fin_Fixed_6_None", "fixed_6", "none", 6.0),
    ("Fin_Fixed_8_None", "fixed_8", "none", 8.0),
    ("Fin_Fixed_10_None", "fixed_10", "none", 10.0),
]

FINANCIER_NAMES = [name for name, _, _, _ in FINANCIERS]
APR_STRATEGIES = [apr_strategy for _, apr_strategy, _, _ in FINANCIERS]
WHOLESALER_POLICIES = [policy for _, _, policy, _ in FINANCIERS]
BASE_APRS = [base_apr for _, _, _, base_apr in FINANCIERS]
TARGET_FINANCIER = "Fin_RL_Borrower_EGT"


def money(value: float) -> str:
    return f"{value:,.2f}"


def summarize_run(
    frames: dict[str, pd.DataFrame],
    capital: float,
    scenario: dict[str, Any],
    seed: int,
    alpha: float,
    eta: float,
) -> list[dict[str, Any]]:
    summary = frames["Financier_Summary"].copy()
    history = frames["Financier_History"].copy()
    loans = frames["Loans"].copy()

    if history.empty:
        history_metrics = pd.DataFrame()
    else:
        history_metrics = history.groupby("financier").agg(
            average_utilization=("utilization", "mean"),
            max_utilization=("utilization", "max"),
            average_apr=("new_apr", "mean"),
            average_offered_apr=("offered_apr", "mean"),
            average_risk_premium=("risk_premium", "mean"),
            average_borrower_score=("borrower_score", "mean"),
            min_borrower_score=("borrower_score", "min"),
            max_borrower_score=("borrower_score", "max"),
            average_payoff=("payoff", "mean"),
        )

    if loans.empty:
        loan_metrics = pd.DataFrame()
    else:
        loan_metrics = loans.groupby("financier").agg(
            interest_paid=("interest_paid", "sum"),
            penalty_paid=("penalty_paid", "sum"),
            total_issued_principal=("amount", "sum"),
            principal_paid=("principal_paid", "sum"),
        )
        loan_metrics["default_amount"] = (
            loan_metrics["total_issued_principal"] - loan_metrics["principal_paid"]
        ).clip(lower=0.0)
        loan_metrics["default_amount_to_initial_capital_rate"] = (
            loan_metrics["default_amount"] / capital if capital else 0.0
        )

    winner = summary.loc[summary["final_capital"].idxmax()]
    rows = []
    for _, row in summary.iterrows():
        financier = row["financier"]
        out = {
            "EGT_Alpha": alpha,
            "EGT_Eta": eta,
            "Capital": capital,
            "Default_Scenario": scenario["name"],
            "Seed": seed,
            "Financier": financier,
            "APR_Strategy": row["apr_strategy"],
            "Borrower_Model": row["wholesaler_policy"],
            "Final_Capital": float(row["final_capital"]),
            "Return_On_Initial_Capital": (
                (float(row["final_capital"]) - capital) / capital if capital else 0.0
            ),
            "Loans_Issued": float(row.get("loans_issued", 0.0) or 0.0),
            "Defaults": float(row.get("defaults", 0.0) or 0.0),
            "Default_Count_Rate": float(row.get("default_count_rate", 0.0) or 0.0),
            "Final_APR": float(row.get("final_apr", 0.0) or 0.0),
            "Is_Run_Winner": financier == winner["financier"],
            "Run_Winner": winner["financier"],
            "Run_Winner_Borrower_Model": winner["wholesaler_policy"],
            "Run_Winner_Final_Capital": float(winner["final_capital"]),
        }

        if financier in history_metrics.index:
            h = history_metrics.loc[financier]
            out.update(
                {
                    "Average_Utilization": float(h["average_utilization"]),
                    "Max_Utilization": float(h["max_utilization"]),
                    "Average_APR": float(h["average_apr"]),
                    "Average_Offered_APR": float(h["average_offered_apr"]),
                    "Average_Risk_Premium": float(h["average_risk_premium"]),
                    "Average_Borrower_Score": float(h["average_borrower_score"]),
                    "Min_Borrower_Score": float(h["min_borrower_score"]),
                    "Max_Borrower_Score": float(h["max_borrower_score"]),
                    "Average_Payoff": float(h["average_payoff"]),
                }
            )
        else:
            out.update(
                {
                    "Average_Utilization": 0.0,
                    "Max_Utilization": 0.0,
                    "Average_APR": 0.0,
                    "Average_Offered_APR": 0.0,
                    "Average_Risk_Premium": 0.0,
                    "Average_Borrower_Score": 0.0,
                    "Min_Borrower_Score": 0.0,
                    "Max_Borrower_Score": 0.0,
                    "Average_Payoff": 0.0,
                }
            )

        if financier in loan_metrics.index:
            l = loan_metrics.loc[financier]
            out.update(
                {
                    "Interest_Paid": float(l["interest_paid"]),
                    "Penalty_Paid": float(l["penalty_paid"]),
                    "Total_Issued_Principal": float(l["total_issued_principal"]),
                    "Default_Amount": float(l["default_amount"]),
                    "Default_Amount_To_Initial_Capital_Rate": float(
                        l["default_amount_to_initial_capital_rate"]
                    ),
                }
            )
        else:
            out.update(
                {
                    "Interest_Paid": 0.0,
                    "Penalty_Paid": 0.0,
                    "Total_Issued_Principal": 0.0,
                    "Default_Amount": 0.0,
                    "Default_Amount_To_Initial_Capital_Rate": 0.0,
                }
            )

        rows.append(out)
    return rows


def main() -> None:
    scenario_rows: list[dict[str, Any]] = []

    for alpha in EGT_ALPHA_VALUES:
        for eta in EGT_ETA_VALUES:
            for capital in CAPITALS_TO_RUN:
                for scenario in DEFAULT_SCENARIOS_TO_RUN:
                    for seed in SEEDS_TO_RUN:
                        print(
                            f"Running EGT optimization | alpha={alpha} | eta={eta} | "
                            f"capital={capital:,.0f} | default={scenario['name']} | seed={seed}..."
                        )
                        frames = run_simulation(
                            days=DAYS,
                            seed=seed,
                            apr_strategies=APR_STRATEGIES,
                            wholesaler_policies=WHOLESALER_POLICIES,
                            financier_names=FINANCIER_NAMES,
                            base_aprs=BASE_APRS,
                            initial_wallet=capital,
                            initial_capital=capital,
                            disable_defaults=bool(scenario.get("disable_defaults", False)),
                            borrower_margin=BORROWER_MARGIN,
                            shock_profile_counts=scenario["shock_profile_counts"],
                            medium_shock_range=scenario["medium_shock_range"],
                            high_shock_range=scenario["high_shock_range"],
                            borrower_egt_alpha=alpha,
                            borrower_egt_eta=eta,
                            pure_rl_apr_action_sets=[FINE_ACTIONS] * len(APR_STRATEGIES),
                        )
                        scenario_rows.extend(summarize_run(frames, capital, scenario, seed, alpha, eta))

    scenario_df = pd.DataFrame(scenario_rows)
    target_df = scenario_df[scenario_df["Financier"] == TARGET_FINANCIER].copy()

    parameter_ranking_df = (
        target_df.groupby(["EGT_Alpha", "EGT_Eta"], dropna=False)
        .agg(
            Target_Total_Final_Capital=("Final_Capital", "sum"),
            Target_Avg_Final_Capital=("Final_Capital", "mean"),
            Target_Avg_Return=("Return_On_Initial_Capital", "mean"),
            Target_Avg_Utilization=("Average_Utilization", "mean"),
            Target_Avg_Default_Amount_To_Initial_Capital_Rate=(
                "Default_Amount_To_Initial_Capital_Rate",
                "mean",
            ),
            Target_Avg_Offered_APR=("Average_Offered_APR", "mean"),
            Target_Avg_Risk_Premium=("Average_Risk_Premium", "mean"),
            Target_Avg_Borrower_Score=("Average_Borrower_Score", "mean"),
            Target_Total_Loans_Issued=("Loans_Issued", "sum"),
            Target_Total_Defaults=("Defaults", "sum"),
            Target_Run_Wins=("Is_Run_Winner", "sum"),
        )
        .reset_index()
        .sort_values("Target_Total_Final_Capital", ascending=False)
    )
    parameter_ranking_df.insert(0, "Rank", range(1, len(parameter_ranking_df) + 1))

    competitor_summary_df = (
        scenario_df.groupby(["EGT_Alpha", "EGT_Eta", "Financier", "APR_Strategy", "Borrower_Model"], dropna=False)
        .agg(
            Total_Final_Capital=("Final_Capital", "sum"),
            Avg_Final_Capital=("Final_Capital", "mean"),
            Avg_Return=("Return_On_Initial_Capital", "mean"),
            Avg_Utilization=("Average_Utilization", "mean"),
            Avg_Offered_APR=("Average_Offered_APR", "mean"),
            Avg_Risk_Premium=("Average_Risk_Premium", "mean"),
            Avg_Borrower_Score=("Average_Borrower_Score", "mean"),
            Total_Loans_Issued=("Loans_Issued", "sum"),
            Total_Defaults=("Defaults", "sum"),
            Run_Wins=("Is_Run_Winner", "sum"),
        )
        .reset_index()
    )

    output_xlsx = OUTPUT_DIR / "egt_parameter_optimization_results.xlsx"
    with pd.ExcelWriter(output_xlsx, engine="xlsxwriter") as writer:
        parameter_ranking_df.to_excel(writer, sheet_name="Parameter_Ranking", index=False)
        competitor_summary_df.to_excel(writer, sheet_name="Financier_Summary", index=False)
        scenario_df.to_excel(writer, sheet_name="Scenario_Runs", index=False)

    best = parameter_ranking_df.iloc[0]
    output_report = OUTPUT_DIR / "egt_parameter_optimization_report.txt"
    report_lines = [
        "Regular borrower EGT parameter optimization",
        "=" * 80,
        "Design:",
        "- Candidate: pure RL financier APR + regular EGT borrower score",
        "- Competitors: borrower RL, fixed 6 none, fixed 8 none, fixed 10 none",
        "- Objective: maximize candidate total final capital across all runs",
        "- Capitals: 1M, 5M, 10M",
        "- Default scenarios: none, low, medium, high",
        "",
        f"Best EGT alpha: {best['EGT_Alpha']}",
        f"Best EGT eta: {best['EGT_Eta']}",
        f"Best candidate total final capital: {money(float(best['Target_Total_Final_Capital']))}",
        f"Candidate run wins: {int(best['Target_Run_Wins'])}",
        "",
        f"Excel written to: {output_xlsx}",
    ]
    output_report.write_text("\n".join(report_lines), encoding="utf-8")

    print("\n".join(report_lines))


if __name__ == "__main__":
    main()
