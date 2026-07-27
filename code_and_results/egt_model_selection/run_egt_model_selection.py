#!/usr/bin/env python
"""Select the best borrower-side EGT model with common financier APR RL.

Experiment design:
- Learning financiers use pure RL for base APR.
- Borrower screening varies only across EGT update models.
- Borrower RL and fixed-rate no-screening baselines are excluded; this is a
  separate EGT-family model-selection experiment.
- Capital scenarios: 1M, 5M, and 10M.
"""

from __future__ import annotations

import importlib.util
import sys
import time
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
OPTIMAL_BORROWER_EGT_ALPHA = 0.30
OPTIMAL_BORROWER_EGT_ETA = 200.0

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

BORROWER_MODELS_TO_TRY = [
    ("Fin_RL_Borrower_EGT", "egt"),
    ("Fin_RL_Borrower_EGT_Replicator", "egt_replicator"),
    ("Fin_RL_Borrower_EGT_Linear", "egt_linear_reinforcement"),
    ("Fin_RL_Borrower_EGT_Fermi", "egt_fermi"),
    ("Fin_RL_Borrower_EGT_Best_Response", "egt_best_response"),
    ("Fin_RL_Borrower_EGT_Polynomial", "egt_polynomial"),
]

BASE_FINANCIERS = [
    *[(name, "pure_rl", policy, 6.0) for name, policy in BORROWER_MODELS_TO_TRY],
]

FINANCIER_NAMES = [name for name, _, _, _ in BASE_FINANCIERS]
APR_STRATEGIES = [apr_strategy for _, apr_strategy, _, _ in BASE_FINANCIERS]
WHOLESALER_POLICIES = [policy for _, _, policy, _ in BASE_FINANCIERS]
BASE_APRS = [base_apr for _, _, _, base_apr in BASE_FINANCIERS]


def money(value: float) -> str:
    return f"{value:,.2f}"


def safe_mean(frame: pd.DataFrame, column: str) -> float:
    if frame.empty or column not in frame.columns:
        return 0.0
    return float(pd.to_numeric(frame[column], errors="coerce").mean() or 0.0)


def summarize_run(
    frames: dict[str, pd.DataFrame],
    capital: float,
    scenario: dict[str, Any],
    seed: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
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

    system_total_initial_capital = capital * len(summary)
    system_final_capital = float(summary["final_capital"].sum()) if not summary.empty else 0.0
    system_default_amount = (
        float(loan_metrics["default_amount"].sum()) if not loan_metrics.empty else 0.0
    )
    system_default_amount_to_total_capital_rate = (
        system_default_amount / system_total_initial_capital
        if system_total_initial_capital
        else 0.0
    )
    if history.empty:
        system_avg_utilization = 0.0
        system_max_utilization = 0.0
    else:
        utilization_by_day = (
            history.assign(utilization=pd.to_numeric(history["utilization"], errors="coerce"))
            .groupby("day")["utilization"]
            .mean()
        )
        system_avg_utilization = float(utilization_by_day.mean() or 0.0)
        system_max_utilization = float(utilization_by_day.max() or 0.0)

    system_row = {
        "Capital": capital,
        "Default_Scenario": scenario["name"],
        "Seed": seed,
        "Num_Financiers": len(summary),
        "System_Total_Initial_Capital": system_total_initial_capital,
        "System_Final_Capital": system_final_capital,
        "System_Return_On_Total_Capital": (
            (system_final_capital - system_total_initial_capital)
            / system_total_initial_capital
            if system_total_initial_capital
            else 0.0
        ),
        "System_Average_Utilization": system_avg_utilization,
        "System_Max_Utilization": system_max_utilization,
        "System_Default_Amount": system_default_amount,
        "System_Default_Amount_To_Total_Capital_Rate": (
            system_default_amount_to_total_capital_rate
        ),
    }

    winner = summary.loc[summary["final_capital"].idxmax()]
    rows = []
    for _, row in summary.iterrows():
        financier = row["financier"]
        out = {
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
            "System_Average_Utilization": system_avg_utilization,
            "System_Max_Utilization": system_max_utilization,
            "System_Default_Amount": system_default_amount,
            "System_Default_Amount_To_Total_Capital_Rate": (
                system_default_amount_to_total_capital_rate
            ),
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
    return rows, system_row


def main() -> None:
    scenario_rows: list[dict[str, Any]] = []
    system_rows: list[dict[str, Any]] = []
    total_runs = len(CAPITALS_TO_RUN) * len(DEFAULT_SCENARIOS_TO_RUN) * len(SEEDS_TO_RUN)
    completed_runs = 0
    start_time = time.perf_counter()

    for capital in CAPITALS_TO_RUN:
        for scenario in DEFAULT_SCENARIOS_TO_RUN:
            for seed in SEEDS_TO_RUN:
                completed_runs += 1
                elapsed = time.perf_counter() - start_time
                avg_per_run = elapsed / max(1, completed_runs - 1)
                remaining = max(0, total_runs - completed_runs + 1)
                eta_seconds = avg_per_run * remaining
                print(
                    f"Running EGT model selection | run {completed_runs}/{total_runs} | "
                    f"ETA {eta_seconds/60:.1f} min | capital={capital:,.0f} | "
                    f"default={scenario['name']} | seed={seed}..."
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
                    borrower_egt_alpha=OPTIMAL_BORROWER_EGT_ALPHA,
                    borrower_egt_eta=OPTIMAL_BORROWER_EGT_ETA,
                    pure_rl_apr_action_sets=[FINE_ACTIONS] * len(APR_STRATEGIES),
                )
                run_rows, system_row = summarize_run(frames, capital, scenario, seed)
                scenario_rows.extend(run_rows)
                system_rows.append(system_row)

    scenario_df = pd.DataFrame(scenario_rows)
    system_df = pd.DataFrame(system_rows)
    egt_ranking_df = (
        scenario_df.groupby(["Financier", "APR_Strategy", "Borrower_Model"], dropna=False)
        .agg(
            Total_Final_Capital=("Final_Capital", "sum"),
            Avg_Final_Capital=("Final_Capital", "mean"),
            Avg_Return=("Return_On_Initial_Capital", "mean"),
            Avg_Utilization=("Average_Utilization", "mean"),
            Avg_Default_Amount_To_Initial_Capital_Rate=(
                "Default_Amount_To_Initial_Capital_Rate",
                "mean",
            ),
            Avg_Offered_APR=("Average_Offered_APR", "mean"),
            Avg_Risk_Premium=("Average_Risk_Premium", "mean"),
            Avg_Borrower_Score=("Average_Borrower_Score", "mean"),
            Total_Loans_Issued=("Loans_Issued", "sum"),
            Total_Defaults=("Defaults", "sum"),
            Run_Wins=("Is_Run_Winner", "sum"),
        )
        .reset_index()
        .sort_values("Total_Final_Capital", ascending=False)
    )
    egt_ranking_df.insert(0, "EGT_Rank", range(1, len(egt_ranking_df) + 1))

    output_xlsx = OUTPUT_DIR / "egt_only_model_selection_results.xlsx"
    with pd.ExcelWriter(output_xlsx, engine="xlsxwriter") as writer:
        egt_ranking_df.to_excel(writer, sheet_name="EGT_Model_Ranking", index=False)
        system_df.to_excel(writer, sheet_name="System_Runs", index=False)
        scenario_df.to_excel(writer, sheet_name="Scenario_Runs", index=False)

    best_egt = egt_ranking_df.iloc[0]
    report_lines = [
        "EGT-only borrower model selection experiment",
        "=" * 80,
        "Design:",
        "- Pure RL base APR + EGT borrower-screening variants only",
        "- Borrower RL and fixed-rate no-screening baselines are excluded",
        "- Capitals: 1M, 5M, 10M",
        f"- Borrower EGT alpha: {OPTIMAL_BORROWER_EGT_ALPHA}",
        f"- Borrower EGT eta: {OPTIMAL_BORROWER_EGT_ETA}",
        "- Default scenarios: none, low, medium, high",
        f"- EGT candidates: {len(BASE_FINANCIERS)}",
        f"- Scenario runs: {total_runs}",
        "",
        f"Best EGT borrower model: {best_egt['Borrower_Model']}",
        f"Best EGT financier: {best_egt['Financier']}",
        f"Best EGT total final capital: {money(float(best_egt['Total_Final_Capital']))}",
        "",
        "System run metrics:",
        "- System_Average_Utilization is the average run-level utilization across financiers.",
        "- System_Default_Amount_To_Total_Capital_Rate is total default amount divided by total initial capital across financiers in that run.",
    ]
    report_lines.extend(
        [
            "",
            f"Excel written to: {output_xlsx}",
        ]
    )
    output_report = OUTPUT_DIR / "egt_only_model_selection_report.txt"
    output_report.write_text("\n".join(report_lines), encoding="utf-8")

    print("\n".join(report_lines))


if __name__ == "__main__":
    main()
