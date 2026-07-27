#!/usr/bin/env python
"""Optimize borrower-side RL screening parameters.

Experiment design:
- Candidate uses pure RL for financier-side APR and borrower-side RL screening.
- Financier-side RL parameters are fixed from the previous rl_fin optimization.
- Candidate is compared with RL+EGT, RL+none, and fixed 6/8/10 no-screening baselines.
- Ranking objective is target total final capital across capitals, default scenarios, and seeds.
"""

from __future__ import annotations

import importlib.util
import sys
import time
from pathlib import Path
from typing import Any

import pandas as pd


ROOT_DIR = Path(__file__).resolve().parents[2]
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

# Fixed financier-side RL setup from rl_optimization/rl_fin.
OPTIMAL_APR_ALPHA = 0.25
OPTIMAL_APR_GAMMA = 0.50
APR_ACTIONS = (6.0, 8.0, 10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 24.0, 30.0, 36.0)

# Borrower-side RL parameters to optimize.
BORROWER_ALPHA_VALUES = [0.10, 0.25, 0.40]
BORROWER_GAMMA_VALUES = [0.50, 0.70, 0.95]
BORROWER_EPSILON_VALUES = [0.02, 0.05, 0.12]
BORROWER_RISK_PREMIUM_GRIDS = {
    "hybrid_2_4pp": (-2.0, 0.0, 2.0, 4.0, 8.0, 12.0, 16.0),
    "fine_2pp": (-2.0, 0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0),
    "coarse_4pp": (-2.0, 0.0, 4.0, 8.0, 12.0, 16.0),
}

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

FINANCIERS = [
    ("Fin_RL_Borrower_RL", "pure_rl", "rl", 6.0),
    ("Fin_RL_Borrower_EGT", "pure_rl", "egt", 6.0),
    ("Fin_RL_None", "pure_rl", "none", 6.0),
    ("Fin_Fixed_6_None", "fixed_6", "none", 6.0),
    ("Fin_Fixed_8_None", "fixed_8", "none", 8.0),
    ("Fin_Fixed_10_None", "fixed_10", "none", 10.0),
]

FINANCIER_NAMES = [name for name, _, _, _ in FINANCIERS]
APR_STRATEGIES = [apr_strategy for _, apr_strategy, _, _ in FINANCIERS]
WHOLESALER_POLICIES = [policy for _, _, policy, _ in FINANCIERS]
BASE_APRS = [base_apr for _, _, _, base_apr in FINANCIERS]
TARGET_FINANCIER = "Fin_RL_Borrower_RL"


def money(value: float) -> str:
    return f"{value:,.2f}"


def format_duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {seconds:02d}s"
    if minutes:
        return f"{minutes}m {seconds:02d}s"
    return f"{seconds}s"


def summarize_run(
    frames: dict[str, pd.DataFrame],
    capital: float,
    scenario: dict[str, Any],
    seed: int,
    borrower_alpha: float,
    borrower_gamma: float,
    borrower_epsilon: float,
    risk_premium_grid_name: str,
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
            "Borrower_Alpha": borrower_alpha,
            "Borrower_Gamma": borrower_gamma,
            "Borrower_Epsilon": borrower_epsilon,
            "Risk_Premium_Grid": risk_premium_grid_name,
            "APR_Alpha": OPTIMAL_APR_ALPHA,
            "APR_Gamma": OPTIMAL_APR_GAMMA,
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
    total_runs = (
        len(BORROWER_ALPHA_VALUES)
        * len(BORROWER_GAMMA_VALUES)
        * len(BORROWER_EPSILON_VALUES)
        * len(BORROWER_RISK_PREMIUM_GRIDS)
        * len(CAPITALS_TO_RUN)
        * len(DEFAULT_SCENARIOS_TO_RUN)
        * len(SEEDS_TO_RUN)
    )
    completed_runs = 0
    start_time = time.perf_counter()

    for borrower_alpha in BORROWER_ALPHA_VALUES:
        for borrower_gamma in BORROWER_GAMMA_VALUES:
            for borrower_epsilon in BORROWER_EPSILON_VALUES:
                for risk_premium_grid_name, risk_premium_grid in BORROWER_RISK_PREMIUM_GRIDS.items():
                    for capital in CAPITALS_TO_RUN:
                        for scenario in DEFAULT_SCENARIOS_TO_RUN:
                            for seed in SEEDS_TO_RUN:
                                run_no = completed_runs + 1
                                elapsed = time.perf_counter() - start_time
                                avg_seconds = elapsed / completed_runs if completed_runs else 0.0
                                eta_seconds = avg_seconds * (total_runs - completed_runs) if completed_runs else 0.0
                                print(
                                    "Running borrower RL optimization | "
                                    f"run={run_no}/{total_runs} | "
                                    f"elapsed={format_duration(elapsed)} | "
                                    f"eta={format_duration(eta_seconds) if completed_runs else 'calculating'} | "
                                    f"borrower_alpha={borrower_alpha} | "
                                    f"borrower_gamma={borrower_gamma} | "
                                    f"borrower_epsilon={borrower_epsilon} | "
                                    f"risk_premium_grid={risk_premium_grid_name} | "
                                    f"capital={capital:,.0f} | default={scenario['name']} | seed={seed}..."
                                )

                                borrower_alphas = [
                                    borrower_alpha if policy == "rl" else 0.25
                                    for policy in WHOLESALER_POLICIES
                                ]
                                borrower_gammas = [
                                    borrower_gamma if policy == "rl" else 0.70
                                    for policy in WHOLESALER_POLICIES
                                ]
                                borrower_epsilons = [
                                    borrower_epsilon if policy == "rl" else 0.05
                                    for policy in WHOLESALER_POLICIES
                                ]
                                borrower_premium_action_sets = [
                                    risk_premium_grid if policy == "rl" else BORROWER_RISK_PREMIUM_GRIDS["hybrid_2_4pp"]
                                    for policy in WHOLESALER_POLICIES
                                ]

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
                                    apr_alphas=[OPTIMAL_APR_ALPHA] * len(APR_STRATEGIES),
                                    apr_gammas=[OPTIMAL_APR_GAMMA] * len(APR_STRATEGIES),
                                    borrower_alphas=borrower_alphas,
                                    borrower_gammas=borrower_gammas,
                                    borrower_epsilons=borrower_epsilons,
                                    borrower_premium_action_sets=borrower_premium_action_sets,
                                    pure_rl_apr_action_sets=[APR_ACTIONS] * len(APR_STRATEGIES),
                                )
                                scenario_rows.extend(
                                    summarize_run(
                                        frames,
                                        capital,
                                        scenario,
                                        seed,
                                        borrower_alpha,
                                        borrower_gamma,
                                        borrower_epsilon,
                                        risk_premium_grid_name,
                                    )
                                )
                                completed_runs += 1
                                elapsed = time.perf_counter() - start_time
                                avg_seconds = elapsed / completed_runs
                                eta_seconds = avg_seconds * (total_runs - completed_runs)
                                print(
                                    "Completed borrower RL optimization | "
                                    f"run={completed_runs}/{total_runs} | "
                                    f"elapsed={format_duration(elapsed)} | "
                                    f"eta={format_duration(eta_seconds)}"
                                )

    scenario_df = pd.DataFrame(scenario_rows)
    target_df = scenario_df[scenario_df["Financier"] == TARGET_FINANCIER].copy()

    parameter_ranking_df = (
        target_df.groupby(
            ["Borrower_Alpha", "Borrower_Gamma", "Borrower_Epsilon", "Risk_Premium_Grid"],
            dropna=False,
        )
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
        scenario_df.groupby(
            [
                "Borrower_Alpha",
                "Borrower_Gamma",
                "Borrower_Epsilon",
                "Risk_Premium_Grid",
                "Financier",
                "APR_Strategy",
                "Borrower_Model",
            ],
            dropna=False,
        )
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

    output_xlsx = OUTPUT_DIR / "borrower_rl_parameter_optimization_results.xlsx"
    with pd.ExcelWriter(output_xlsx, engine="xlsxwriter") as writer:
        parameter_ranking_df.to_excel(writer, sheet_name="Parameter_Ranking", index=False)
        competitor_summary_df.to_excel(writer, sheet_name="Financier_Summary", index=False)
        scenario_df.to_excel(writer, sheet_name="Scenario_Runs", index=False)

    best = parameter_ranking_df.iloc[0]
    output_report = OUTPUT_DIR / "borrower_rl_parameter_optimization_report.txt"
    report_lines = [
        "Borrower-side RL screening parameter optimization",
        "=" * 80,
        "Design:",
        "- Target: pure RL financier APR + borrower-side RL screening",
        "- Comparators: RL+EGT, RL+none, fixed 6 none, fixed 8 none, fixed 10 none",
        f"- Fixed financier APR alpha: {OPTIMAL_APR_ALPHA}",
        f"- Fixed financier APR gamma: {OPTIMAL_APR_GAMMA}",
        "- Objective: maximize target total final capital across all runs",
        "- Capitals: 1M, 5M, 10M",
        "- Default scenarios: none, low, medium, high",
        "",
        f"Best borrower alpha: {best['Borrower_Alpha']}",
        f"Best borrower gamma: {best['Borrower_Gamma']}",
        f"Best borrower epsilon: {best['Borrower_Epsilon']}",
        f"Best borrower risk-premium grid: {best['Risk_Premium_Grid']}",
        f"Best target total final capital: {money(float(best['Target_Total_Final_Capital']))}",
        f"Target run wins: {int(best['Target_Run_Wins'])}",
        "",
        f"Excel written to: {output_xlsx}",
    ]
    output_report.write_text("\n".join(report_lines), encoding="utf-8")

    print("\n".join(report_lines))


if __name__ == "__main__":
    main()
