#!/usr/bin/env python
"""Sensitivity analysis for the selected RL APR + EGT borrower-screening model."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from egt_apr_simulation import run_simulation  # noqa: E402


OUTPUT_DIR = Path(__file__).resolve().parent
OUTPUT_XLSX = OUTPUT_DIR / "rl_egt_sensitivity_results.xlsx"
OUTPUT_REPORT = OUTPUT_DIR / "rl_egt_sensitivity_report.txt"

TARGET_FINANCIER = "Fin_RL_Borrower_EGT"

CAPITALS_TO_RUN = [1_000_000.0, 5_000_000.0, 10_000_000.0]
SEEDS_TO_RUN = [42]
SIMULATION_DAYS = 4000
BORROWER_MARGIN = 0.20

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

APR_ACTIONS_FINE_1PP = tuple(float(apr) for apr in range(6, 37))
BORROWER_PREMIUM_ACTIONS = (-2.0, 0.0, 4.0, 8.0, 12.0, 16.0)

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

SELECTED_PARAMS = {
    "apr_alpha": 0.25,
    "apr_gamma": 0.95,
    "apr_epsilon": 0.08,
    "egt_alpha": 0.30,
    "egt_eta": 200.0,
}

BORROWER_RL_PARAMS = {
    "borrower_alpha": 0.10,
    "borrower_gamma": 0.70,
    "borrower_epsilon": 0.05,
}

SENSITIVITY_CASES = [
    {
        "case_id": "baseline_selected",
        "factor": "baseline",
        "value": "selected",
        "params": SELECTED_PARAMS,
    },
    {
        "case_id": "apr_alpha_low",
        "factor": "apr_alpha",
        "value": 0.10,
        "params": {**SELECTED_PARAMS, "apr_alpha": 0.10},
    },
    {
        "case_id": "apr_alpha_high",
        "factor": "apr_alpha",
        "value": 0.40,
        "params": {**SELECTED_PARAMS, "apr_alpha": 0.40},
    },
    {
        "case_id": "apr_gamma_low",
        "factor": "apr_gamma",
        "value": 0.70,
        "params": {**SELECTED_PARAMS, "apr_gamma": 0.70},
    },
    {
        "case_id": "apr_gamma_mid",
        "factor": "apr_gamma",
        "value": 0.85,
        "params": {**SELECTED_PARAMS, "apr_gamma": 0.85},
    },
    {
        "case_id": "apr_epsilon_low",
        "factor": "apr_epsilon",
        "value": 0.02,
        "params": {**SELECTED_PARAMS, "apr_epsilon": 0.02},
    },
    {
        "case_id": "apr_epsilon_mid",
        "factor": "apr_epsilon",
        "value": 0.05,
        "params": {**SELECTED_PARAMS, "apr_epsilon": 0.05},
    },
    {
        "case_id": "egt_alpha_low",
        "factor": "egt_alpha",
        "value": 0.10,
        "params": {**SELECTED_PARAMS, "egt_alpha": 0.10},
    },
    {
        "case_id": "egt_alpha_high",
        "factor": "egt_alpha",
        "value": 0.60,
        "params": {**SELECTED_PARAMS, "egt_alpha": 0.60},
    },
    {
        "case_id": "egt_eta_low",
        "factor": "egt_eta",
        "value": 100.0,
        "params": {**SELECTED_PARAMS, "egt_eta": 100.0},
    },
    {
        "case_id": "egt_eta_high",
        "factor": "egt_eta",
        "value": 300.0,
        "params": {**SELECTED_PARAMS, "egt_eta": 300.0},
    },
]


def fmt_money(value: float) -> str:
    return f"{value:,.2f}"


def parameter_vector(case: dict[str, object]) -> tuple[list[float], list[float], list[float]]:
    params = case["params"]
    apr_alphas = []
    apr_gammas = []
    apr_epsilons = []
    for financier in FINANCIER_NAMES:
        if financier == TARGET_FINANCIER:
            apr_alphas.append(float(params["apr_alpha"]))
            apr_gammas.append(float(params["apr_gamma"]))
            apr_epsilons.append(float(params["apr_epsilon"]))
        else:
            apr_alphas.append(SELECTED_PARAMS["apr_alpha"])
            apr_gammas.append(SELECTED_PARAMS["apr_gamma"])
            apr_epsilons.append(SELECTED_PARAMS["apr_epsilon"])
    return apr_alphas, apr_gammas, apr_epsilons


def extract_run_rows(
    frames: dict[str, pd.DataFrame],
    case: dict[str, object],
    capital: float,
    seed: int,
    scenario: dict[str, object],
) -> tuple[dict[str, object], list[dict[str, object]]]:
    summary = frames["Financier_Summary"].copy()
    history = frames["Financier_History"].copy()
    loans = frames["Loans"].copy()
    params = case["params"]

    winner = summary.loc[summary["final_capital"].idxmax()]
    target = summary.loc[summary["financier"] == TARGET_FINANCIER].iloc[0]

    history_metrics = history.groupby("financier").agg(
        average_utilization=("utilization", "mean"),
        max_utilization=("utilization", "max"),
        average_apr=("new_apr", "mean"),
        average_offered_apr=("offered_apr", "mean"),
        average_risk_premium=("risk_premium", "mean"),
        average_borrower_score=("borrower_score", "mean"),
        average_payoff=("payoff", "mean"),
    )
    loan_metrics = loans.groupby("financier").agg(
        total_issued_principal=("amount", "sum"),
        principal_paid=("principal_paid", "sum"),
    )
    if not loan_metrics.empty:
        loan_metrics["default_amount"] = (
            loan_metrics["total_issued_principal"] - loan_metrics["principal_paid"]
        ).clip(lower=0.0)
        loan_metrics["default_amount_to_initial_capital_rate"] = (
            loan_metrics["default_amount"] / capital if capital else 0.0
        )

    target_history = history_metrics.loc[TARGET_FINANCIER]
    target_loan = loan_metrics.loc[TARGET_FINANCIER] if TARGET_FINANCIER in loan_metrics.index else None
    target_default_amount = float(target_loan["default_amount"]) if target_loan is not None else 0.0
    target_issued = float(target_loan["total_issued_principal"]) if target_loan is not None else 0.0

    target_row = {
        "Case_ID": case["case_id"],
        "Sensitivity_Factor": case["factor"],
        "Sensitivity_Value": case["value"],
        "APR_Alpha": params["apr_alpha"],
        "APR_Gamma": params["apr_gamma"],
        "APR_Epsilon": params["apr_epsilon"],
        "EGT_Alpha": params["egt_alpha"],
        "EGT_Eta": params["egt_eta"],
        "Capital": capital,
        "Default_Scenario": scenario["name"],
        "Seed": seed,
        "Target_Final_Capital": float(target["final_capital"]),
        "Target_Return_On_Initial_Capital": (float(target["final_capital"]) - capital) / capital,
        "Target_Final_APR": float(target["final_apr"]),
        "Target_Loans_Issued": float(target["loans_issued"]),
        "Target_Defaults": float(target["defaults"]),
        "Target_Default_Count_Rate": float(target.get("default_count_rate", 0.0)),
        "Target_Default_Amount": target_default_amount,
        "Target_Default_Amount_To_Initial_Capital_Rate": (
            target_default_amount / capital if capital else 0.0
        ),
        "Target_Default_Amount_To_Issued_Rate": (
            target_default_amount / target_issued if target_issued else 0.0
        ),
        "Target_Average_Utilization": float(target_history["average_utilization"]),
        "Target_Average_Offered_APR": float(target_history["average_offered_apr"]),
        "Target_Average_Risk_Premium": float(target_history["average_risk_premium"]),
        "Target_Average_Borrower_Score": float(target_history["average_borrower_score"]),
        "Target_Average_Payoff": float(target_history["average_payoff"]),
        "Run_Winner": winner["financier"],
        "Target_Is_Run_Winner": winner["financier"] == TARGET_FINANCIER,
        "Run_Winner_Final_Capital": float(winner["final_capital"]),
    }

    financier_rows = []
    for _, row in summary.iterrows():
        financier = row["financier"]
        h = history_metrics.loc[financier] if financier in history_metrics.index else None
        lm = loan_metrics.loc[financier] if financier in loan_metrics.index else None
        default_amount = float(lm["default_amount"]) if lm is not None else 0.0
        issued = float(lm["total_issued_principal"]) if lm is not None else 0.0
        financier_rows.append(
            {
                "Case_ID": case["case_id"],
                "Sensitivity_Factor": case["factor"],
                "Sensitivity_Value": case["value"],
                "Capital": capital,
                "Default_Scenario": scenario["name"],
                "Seed": seed,
                "Financier": financier,
                "APR_Strategy": row["apr_strategy"],
                "Borrower_Strategy": row["wholesaler_policy"],
                "Final_Capital": float(row["final_capital"]),
                "Return_On_Initial_Capital": (float(row["final_capital"]) - capital) / capital,
                "Final_APR": float(row["final_apr"]),
                "Loans_Issued": float(row["loans_issued"]),
                "Defaults": float(row["defaults"]),
                "Default_Amount": default_amount,
                "Default_Amount_To_Initial_Capital_Rate": default_amount / capital if capital else 0.0,
                "Default_Amount_To_Issued_Rate": default_amount / issued if issued else 0.0,
                "Average_Utilization": float(h["average_utilization"]) if h is not None else 0.0,
                "Average_Offered_APR": float(h["average_offered_apr"]) if h is not None else 0.0,
                "Average_Risk_Premium": float(h["average_risk_premium"]) if h is not None else 0.0,
                "Average_Borrower_Score": float(h["average_borrower_score"]) if h is not None else 0.0,
                "Average_Payoff": float(h["average_payoff"]) if h is not None else 0.0,
                "Is_Run_Winner": winner["financier"] == financier,
            }
        )

    return target_row, financier_rows


def write_outputs(target_runs: pd.DataFrame, financier_runs: pd.DataFrame) -> None:
    ranking = (
        target_runs.groupby(["Case_ID", "Sensitivity_Factor", "Sensitivity_Value"], as_index=False)
        .agg(
            Runs=("Seed", "count"),
            Target_Total_Final_Capital=("Target_Final_Capital", "sum"),
            Target_Avg_Final_Capital=("Target_Final_Capital", "mean"),
            Target_Avg_Return=("Target_Return_On_Initial_Capital", "mean"),
            Target_Avg_Utilization=("Target_Average_Utilization", "mean"),
            Target_Avg_Offered_APR=("Target_Average_Offered_APR", "mean"),
            Target_Avg_Risk_Premium=("Target_Average_Risk_Premium", "mean"),
            Target_Avg_Default_Amount_To_Initial_Capital_Rate=(
                "Target_Default_Amount_To_Initial_Capital_Rate",
                "mean",
            ),
            Target_Total_Default_Amount=("Target_Default_Amount", "sum"),
            Target_Total_Loans_Issued=("Target_Loans_Issued", "sum"),
            Target_Total_Defaults=("Target_Defaults", "sum"),
            Target_Run_Wins=("Target_Is_Run_Winner", "sum"),
        )
        .sort_values("Target_Total_Final_Capital", ascending=False)
    )
    ranking.insert(0, "Rank", range(1, len(ranking) + 1))

    scenario_avg = (
        target_runs.groupby(
            ["Case_ID", "Sensitivity_Factor", "Sensitivity_Value", "Capital", "Default_Scenario"],
            as_index=False,
        )
        .agg(
            Seeds=("Seed", "nunique"),
            Target_Avg_Final_Capital=("Target_Final_Capital", "mean"),
            Target_Avg_Return=("Target_Return_On_Initial_Capital", "mean"),
            Target_Avg_Utilization=("Target_Average_Utilization", "mean"),
            Target_Avg_Offered_APR=("Target_Average_Offered_APR", "mean"),
            Target_Avg_Risk_Premium=("Target_Average_Risk_Premium", "mean"),
            Target_Avg_Default_Amount_To_Initial_Capital_Rate=(
                "Target_Default_Amount_To_Initial_Capital_Rate",
                "mean",
            ),
            Target_Run_Wins=("Target_Is_Run_Winner", "sum"),
        )
    )

    with pd.ExcelWriter(OUTPUT_XLSX, engine="openpyxl") as writer:
        ranking.to_excel(writer, sheet_name="Sensitivity_Ranking", index=False)
        scenario_avg.to_excel(writer, sheet_name="Scenario_Averages", index=False)
        target_runs.to_excel(writer, sheet_name="Target_Run_Detail", index=False)
        financier_runs.to_excel(writer, sheet_name="All_Financier_Run_Detail", index=False)

        wb = writer.book
        for ws in wb.worksheets:
            ws.freeze_panes = "A2"
            ws.auto_filter.ref = ws.dimensions
            for col in ws.columns:
                max_len = max(len(str(cell.value)) if cell.value is not None else 0 for cell in col[:100])
                ws.column_dimensions[col[0].column_letter].width = min(max(max_len + 2, 12), 34)

    best = ranking.iloc[0]
    baseline = ranking.loc[ranking["Case_ID"] == "baseline_selected"].iloc[0]
    lines = [
        "RL APR + EGT borrower-screening sensitivity analysis",
        "=" * 80,
        "Target model: Fin_RL_Borrower_EGT",
        "Evaluation: 3 capitals x 4 default scenarios x 1 seed per sensitivity case",
        f"Cases evaluated: {len(ranking)}",
        "",
        "Selected baseline:",
        f"- Total final capital: {fmt_money(float(baseline['Target_Total_Final_Capital']))}",
        f"- Average utilisation: {float(baseline['Target_Avg_Utilization']):.4f}",
        f"- Average offered APR: {float(baseline['Target_Avg_Offered_APR']):.2f}%",
        f"- Default amount / initial capital: {100.0 * float(baseline['Target_Avg_Default_Amount_To_Initial_Capital_Rate']):.2f}%",
        f"- Run wins: {int(baseline['Target_Run_Wins'])}",
        "",
        "Best sensitivity case by total final capital:",
        f"- Case: {best['Case_ID']}",
        f"- Factor: {best['Sensitivity_Factor']} = {best['Sensitivity_Value']}",
        f"- Total final capital: {fmt_money(float(best['Target_Total_Final_Capital']))}",
        f"- Run wins: {int(best['Target_Run_Wins'])}",
        "",
        f"Excel written to: {OUTPUT_XLSX.resolve()}",
    ]
    OUTPUT_REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    target_rows: list[dict[str, object]] = []
    financier_rows: list[dict[str, object]] = []
    total_runs = len(SENSITIVITY_CASES) * len(CAPITALS_TO_RUN) * len(DEFAULT_SCENARIOS_TO_RUN) * len(SEEDS_TO_RUN)
    completed = 0
    start = time.perf_counter()

    for case in SENSITIVITY_CASES:
        apr_alphas, apr_gammas, apr_epsilons = parameter_vector(case)
        params = case["params"]
        for capital in CAPITALS_TO_RUN:
            for scenario in DEFAULT_SCENARIOS_TO_RUN:
                for seed in SEEDS_TO_RUN:
                    completed += 1
                    elapsed = time.perf_counter() - start
                    avg = elapsed / max(completed - 1, 1)
                    remaining = total_runs - completed + 1
                    eta_minutes = (avg * remaining) / 60.0
                    print(
                        f"Run {completed}/{total_runs} | ETA {eta_minutes:.1f} min | "
                        f"case={case['case_id']} | capital={capital:,.0f} | "
                        f"default={scenario['name']} | seed={seed}",
                        flush=True,
                    )
                    frames = run_simulation(
                        days=SIMULATION_DAYS,
                        seed=seed,
                        apr_strategies=APR_STRATEGIES,
                        wholesaler_policies=WHOLESALER_POLICIES,
                        financier_names=FINANCIER_NAMES,
                        base_aprs=BASE_APRS,
                        initial_wallet=capital,
                        initial_capital=capital,
                        disable_defaults=bool(scenario["disable_defaults"]),
                        borrower_margin=BORROWER_MARGIN,
                        shock_profile_counts=scenario["shock_profile_counts"],
                        medium_shock_range=scenario["medium_shock_range"],
                        high_shock_range=scenario["high_shock_range"],
                        apr_alphas=apr_alphas,
                        apr_gammas=apr_gammas,
                        apr_epsilons=apr_epsilons,
                        borrower_alphas=[BORROWER_RL_PARAMS["borrower_alpha"]] * len(FINANCIERS),
                        borrower_gammas=[BORROWER_RL_PARAMS["borrower_gamma"]] * len(FINANCIERS),
                        borrower_epsilons=[BORROWER_RL_PARAMS["borrower_epsilon"]] * len(FINANCIERS),
                        borrower_premium_action_sets=[BORROWER_PREMIUM_ACTIONS] * len(FINANCIERS),
                        pure_rl_apr_action_sets=[APR_ACTIONS_FINE_1PP] * len(FINANCIERS),
                        borrower_egt_alpha=float(params["egt_alpha"]),
                        borrower_egt_eta=float(params["egt_eta"]),
                    )
                    target_row, run_financier_rows = extract_run_rows(frames, case, capital, seed, scenario)
                    target_rows.append(target_row)
                    financier_rows.extend(run_financier_rows)

    target_runs = pd.DataFrame(target_rows)
    financier_runs = pd.DataFrame(financier_rows)
    write_outputs(target_runs, financier_runs)
    print(f"Excel written to: {OUTPUT_XLSX.resolve()}", flush=True)
    print(f"Report written to: {OUTPUT_REPORT.resolve()}", flush=True)


if __name__ == "__main__":
    main()
