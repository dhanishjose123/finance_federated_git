#!/usr/bin/env python
"""Run APR-side comparison with wholesaler screening turned off for multiple capital values."""

from __future__ import annotations

from pathlib import Path
import time
import random

import pandas as pd

from egt_apr_simulation import run_simulation, save_q_tables, write_excel

CAPITALS_TO_RUN = [
    1_000_000.0,
    5_000_000.0,
    10_000_000.0,
   
]

WRITE_DETAILED_SIMULATION_EXCEL = True
SAVE_Q_TABLES = False
Q_TABLE_OUTPUT_DIR = Path("trained_q_tables")

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

FINE_ACTIONS = (
    6.0,
    7.0,
    8.0,
    9.0,
    10.0,
    11.0,
    12.0,
    13.0,
    14.0,
    15.0,
    16.0,
    17.0,
    18.0,
    19.0,
    20.0,
    21.0,
    22.0,
    23.0,
    24.0,
    25.0,
    26.0,
    27.0,
    28.0,
    29.0,
    30.0,
    31.0,
    32.0,
    33.0,
    34.0,
    35.0,
    36.0,
)
BORROWER_PREMIUM_ACTIONS = (-2.0, 0.0, 4.0, 8.0, 12.0, 16.0)

BASE_FINANCIERS = [
    ("Fin_RL_Borrower_RL", "pure_rl", "rl"),
    ("Fin_RL_Borrower_FL_RL", "pure_rl", "fl_rl"),
    ("Fin_RL_Borrower_EGT", "pure_rl", "egt"),
    ("Fin_RL_Borrower_FL_EGT", "pure_rl", "fl_egt"),
    ("Fin_RL_Borrower_Local_EGT", "pure_rl", "local_egt"),
    ("Fin_RL_Borrower_none", "pure_rl", "none"),
    ("Fin_6pct", "fixed_6", "none"),
    ("Fin_8pct", "fixed_8", "none"),
    ("fixed_10ct", "fixed_10", "none"),
]
FINANCIER_NAMES = [financier_name for financier_name, _, _ in BASE_FINANCIERS]
APR_STRATEGIES = [apr_strategy for _, apr_strategy, _ in BASE_FINANCIERS]
WHOLESALER_POLICIES = [wholesaler_policy for _, _, wholesaler_policy in BASE_FINANCIERS]
PURE_RL_FINANCIERS = {
    "Fin_RL_Borrower_RL",
    "Fin_RL_Borrower_FL_RL",
    "Fin_RL_Borrower_EGT",
    "Fin_RL_Borrower_FL_EGT",
    "Fin_RL_Borrower_Local_EGT",
    "Fin_RL_Borrower_none",
}
BASE_APRS = [6.0] * len(PURE_RL_FINANCIERS) + [6.0, 8.0, 10.0]


def money(value: float) -> str:
    return f"{value:,.2f}"


def pct(value: float) -> str:
    return f"{100.0 * value:,.2f}%"


def finite_float(value: object, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    if pd.isna(result):
        return default
    return result


def decision_counts(results: pd.DataFrame) -> pd.DataFrame:
    if results.empty:
        return pd.DataFrame()
    return (
        results.pivot_table(
            index="financier",
            columns="decision",
            values="borrower",
            aggfunc="count",
            fill_value=0,
        )
        .reset_index()
        .rename_axis(None, axis=1)
    )


def summarize(frames: dict[str, pd.DataFrame], capital: float, default_scenario: dict[str, object]) -> str:
    summary = frames["Financier_Summary"].copy()
    history = frames["Financier_History"].copy()
    loans = frames["Loans"].copy()
    results = frames["Results"].copy()

    hist_metrics = history.groupby("financier").agg(
        average_utilization=("utilization", "mean"),
        max_utilization=("utilization", "max"),
        average_apr=("new_apr", "mean"),
        apr_volatility=("new_apr", "std"),
        average_payoff=("payoff", "mean"),
    )
    loan_metrics = loans.groupby("financier").agg(
        total_issued_principal=("amount", "sum"),
        principal_paid=("principal_paid", "sum"),
        interest_income=("interest_paid", "sum"),
        penalty_income=("penalty_paid", "sum"),
        average_projected_apr_rl_reward=("projected_apr_rl_reward", "mean"),
        average_realized_apr_rl_reward=("realized_apr_rl_reward", "mean"),
        average_opportunity_loss_at_issue=("opportunity_loss_at_issue", "mean"),
    )
    if not loan_metrics.empty:
        loan_metrics["default_amount"] = (
            loan_metrics["total_issued_principal"] - loan_metrics["principal_paid"]
        ).clip(lower=0.0)
        loan_metrics["default_amount_to_issued_rate"] = (
            loan_metrics["default_amount"] / loan_metrics["total_issued_principal"].clip(lower=1.0)
        )
        loan_metrics = loan_metrics.drop(
            columns=[
                column
                for column in (
                    "total_issued_principal",
                    "default_amount",
                    "default_amount_to_issued_rate",
                )
                if column in summary.columns
            ]
        )
    decisions = decision_counts(results)
    merged = summary.set_index("financier").join(hist_metrics, how="left").join(loan_metrics, how="left")
    if not decisions.empty:
        merged = merged.join(decisions.set_index("financier"), how="left")

    total_initial = capital * len(summary)
    total_final = float(summary["final_capital"].sum())
    total_loans = float(summary["loans_issued"].sum())
    total_defaults = float(summary["defaults"].sum())
    total_issued_principal = float(loans["amount"].sum()) if not loans.empty else 0.0
    total_principal_paid = float(loans["principal_paid"].sum()) if not loans.empty else 0.0
    total_default_amount = max(0.0, total_issued_principal - total_principal_paid)
    overall_default_amount_rate = (
        total_default_amount / total_issued_principal if total_issued_principal else 0.0
    )

    lines = [
        f"APR-side comparison with capital = {capital:,.2f}",
        "Wholesaler policies: Fin_RL_Borrower_RL=rl, Fin_RL_Borrower_EGT=egt, fixed APR baselines=none",
        f"Defaults enabled: {not bool(default_scenario.get('disable_defaults', False))}",
        f"Default scenario: {default_scenario['name']}",
        "Borrower margin: current simulator setting",
        "APR payoff: projected interest at issue, then realized interest + penalty - default amount at close",
        "Days: 4000",
        f"Seed: {default_scenario.get('seed', 42)}",
        "",
        f"Total initial capital: {money(total_initial)}",
        f"Total final capital: {money(total_final)}",
        f"Total net profit: {money(total_final - total_initial)}",
        f"Total return on initial capital: {pct((total_final - total_initial) / total_initial) if total_initial else '0.00%'}",
        f"Total loans issued: {int(total_loans):,}",
        f"Total defaults: {int(total_defaults):,}",
        f"System default rate: {pct(total_defaults / total_loans if total_loans else 0.0)}",
        f"Total issued principal: {money(total_issued_principal)}",
        f"Total default amount: {money(total_default_amount)}",
        f"Overall default amount / total issued principal: {pct(overall_default_amount_rate)}",
        f"Overall average utilization: {pct(float(history['utilization'].mean())) if not history.empty else '0.00%'}",
        f"Overall average APR: {float(history['new_apr'].mean()) if not history.empty else 0.0:,.2f}%",
        "",
        "Financier metrics:",
    ]

    for financier, row in merged.sort_values("final_capital", ascending=False).iterrows():
        loans_issued = finite_float(row.get("loans_issued", 0.0))
        defaults = finite_float(row.get("defaults", 0.0))
        final_capital = finite_float(row.get("final_capital", capital), capital)
        net_profit = final_capital - capital
        total_issued = finite_float(row.get("total_issued_principal", 0.0))
        default_amount = finite_float(row.get("default_amount", 0.0))
        default_amount_rate = finite_float(row.get("default_amount_to_issued_rate", 0.0))
        lines.extend(
            [
                "-" * 96,
                f"Financier: {financier}",
                f"Strategy: {row.get('apr_strategy', 'N/A')}",
                f"Wholesaler policy: {row.get('wholesaler_policy', 'N/A')}",
                f"Final capital: {money(final_capital)}",
                f"Net profit: {money(net_profit)}",
                f"Return on initial capital: {pct(net_profit / capital) if capital else '0.00%'}",
                f"Loans issued: {int(loans_issued):,}",
                f"Total issued principal: {money(total_issued)}",
                f"Market share by loan count: {pct(loans_issued / total_loans if total_loans else 0.0)}",
                f"Defaults: {int(defaults):,}",
                f"Default rate: {pct(defaults / loans_issued if loans_issued else 0.0)}",
                f"Default amount: {money(default_amount)}",
                f"Default amount / total issued principal: {pct(default_amount_rate)}",
                f"Average utilization: {pct(finite_float(row.get('average_utilization', 0.0)))}",
                f"Max utilization: {pct(finite_float(row.get('max_utilization', 0.0)))}",
                f"Average APR: {finite_float(row.get('average_apr', 0.0)):,.2f}%",
                f"APR volatility: {finite_float(row.get('apr_volatility', 0.0)):,.2f}",
                f"Final APR: {finite_float(row.get('final_apr', 0.0)):,.2f}%",
                f"Average payoff: {finite_float(row.get('average_payoff', 0.0)):,.6f}",
                f"Average projected APR-RL reward: {finite_float(row.get('average_projected_apr_rl_reward', 0.0)):,.6f}",
                f"Average realized APR-RL reward: {finite_float(row.get('average_realized_apr_rl_reward', 0.0)):,.6f}",
                f"Average opportunity loss at issue: {money(finite_float(row.get('average_opportunity_loss_at_issue', 0.0)))}",
                f"Interest income: {money(finite_float(row.get('interest_income', 0.0)))}",
                f"Penalty income: {money(finite_float(row.get('penalty_income', 0.0)))}",
                f"Profit per loan: {money(net_profit / loans_issued if loans_issued else 0.0)}",
                f"Financier rejections: {int(finite_float(row.get('FINANCIER_REJECTED', 0.0))):,}",
                f"Wholesaler rejections: {int(finite_float(row.get('WHOLESALER_REJECTED', 0.0))):,}",
            ]
        )
    return "\n".join(lines) + "\n"


def main() -> None:
    all_reports = []
    summary_data = []
    apr_alphas = [
        0.25 if name in PURE_RL_FINANCIERS else 0.25
        for name in FINANCIER_NAMES
    ]
    apr_gammas = [
        0.95 if name in PURE_RL_FINANCIERS else 0.70
        for name in FINANCIER_NAMES
    ]
    apr_epsilons = [
        0.05 if name == "Fin_6pct" else 0.08
        for name in FINANCIER_NAMES
    ]
    NUM_SEEDS = 3  # Change this number to control the number of random seeds
    SEEDS_TO_RUN = [random.randint(1, 1000000) for _ in range(NUM_SEEDS)]
    total_runs = len(CAPITALS_TO_RUN) * len(DEFAULT_SCENARIOS_TO_RUN) * len(SEEDS_TO_RUN)
    completed_runs = 0
    start_time = time.perf_counter()

    for seed in SEEDS_TO_RUN:
        for capital in CAPITALS_TO_RUN:
            for default_scenario in DEFAULT_SCENARIOS_TO_RUN:
                completed_runs += 1
                elapsed = time.perf_counter() - start_time
                avg_per_run = elapsed / max(1, completed_runs - 1)
                remaining = max(0, total_runs - completed_runs + 1)
                eta_seconds = avg_per_run * remaining

                scenario_name = default_scenario["name"]
                default_scenario["seed"] = seed
                print(
                    f"Running APR-side comparison | run {completed_runs}/{total_runs} | "
                    f"ETA {eta_seconds/60:.1f} min | capital={capital:,.0f} | "
                    f"default={scenario_name} | seed={seed}..."
                )
                frames = run_simulation(
                    days=4000,
                    seed=seed,
                    apr_strategies=APR_STRATEGIES,
                    wholesaler_policies=WHOLESALER_POLICIES,
                    financier_names=FINANCIER_NAMES,
                    base_aprs=BASE_APRS,
                    initial_wallet=capital,
                    initial_capital=capital,
                    disable_defaults=bool(default_scenario.get("disable_defaults", False)),
                    borrower_margin=BORROWER_MARGIN,
                    shock_profile_counts=default_scenario["shock_profile_counts"],
                    medium_shock_range=default_scenario["medium_shock_range"],
                    high_shock_range=default_scenario["high_shock_range"],
                    apr_alphas=apr_alphas,
                    apr_gammas=apr_gammas,
                    apr_epsilons=apr_epsilons,
                    borrower_alphas=[0.10] * len(APR_STRATEGIES),
                    borrower_gammas=[0.70] * len(APR_STRATEGIES),
                    borrower_epsilons=[0.05] * len(APR_STRATEGIES),
                    borrower_premium_action_sets=[BORROWER_PREMIUM_ACTIONS] * len(APR_STRATEGIES),
                    pure_rl_apr_action_sets=[FINE_ACTIONS] * len(APR_STRATEGIES),
                    borrower_egt_alpha=0.30,
                    borrower_egt_eta=200.0,
                )

                if SAVE_Q_TABLES:
                    Q_TABLE_OUTPUT_DIR.mkdir(exist_ok=True)
                    q_table_output_path = Q_TABLE_OUTPUT_DIR / (
                        f"trained_q_tables_seed_{seed}_{int(capital)}_{scenario_name}.json"
                    )
                    save_q_tables(frames, q_table_output_path)
                    print(f"Q-tables written to: {q_table_output_path.resolve()}", flush=True)

                if WRITE_DETAILED_SIMULATION_EXCEL:
                    excel_path = Path(
                        f"simulation_results_seed_{seed}_4000_{int(capital)}_{scenario_name}_no_wholesaler_reward_agent.xlsx"
                    )
                    write_excel(frames, excel_path)
                    print(f"Excel written to: {excel_path.resolve()}", flush=True)

                report = summarize(frames, capital, default_scenario)
                all_reports.append(
                    f"================================================================================\n"
                    f"          SEED: {seed} | CAPITAL: {capital:,.2f} | DEFAULT SCENARIO: {scenario_name}\n"
                    f"================================================================================\n"
                    f"{report}\n"
                )
                
                # Collect summary data for Excel: one row per capital/scenario/financier.
                summary_df_sim = frames["Financier_Summary"]
                history_df_sim = frames["Financier_History"]
                loans_df_sim = frames["Loans"]
                
                winner_row = summary_df_sim.loc[summary_df_sim["final_capital"].idxmax()]
                system_utilization = history_df_sim["utilization"].mean() if not history_df_sim.empty else 0.0
                if history_df_sim.empty:
                    history_metrics = pd.DataFrame()
                else:
                    history_metrics = history_df_sim.groupby("financier").agg(
                        average_utilization=("utilization", "mean"),
                        max_utilization=("utilization", "max"),
                        average_apr=("new_apr", "mean"),
                        average_offered_apr=("offered_apr", "mean"),
                        average_risk_premium=("risk_premium", "mean"),
                        average_borrower_score=("borrower_score", "mean"),
                        min_borrower_score=("borrower_score", "min"),
                        max_borrower_score=("borrower_score", "max"),
                        apr_volatility=("new_apr", "std"),
                        average_payoff=("payoff", "mean"),
                    )
                total_issued_principal = float(loans_df_sim["amount"].sum()) if not loans_df_sim.empty else 0.0
                total_principal_paid = float(loans_df_sim["principal_paid"].sum()) if not loans_df_sim.empty else 0.0
                system_default_amount = max(0.0, total_issued_principal - total_principal_paid)
                total_initial_capital = capital * len(summary_df_sim)
                system_default_amount_rate = (
                    system_default_amount / total_issued_principal if total_issued_principal else 0.0
                )
                system_default_amount_to_initial_capital_rate = (
                    system_default_amount / total_initial_capital if total_initial_capital else 0.0
                )
                if loans_df_sim.empty:
                    loan_default_metrics = pd.DataFrame()
                else:
                    loan_default_metrics = loans_df_sim.groupby("financier").agg(
                        total_issued_principal=("amount", "sum"),
                        principal_paid=("principal_paid", "sum"),
                        average_projected_apr_rl_reward=("projected_apr_rl_reward", "mean"),
                        average_realized_apr_rl_reward=("realized_apr_rl_reward", "mean"),
                        average_opportunity_loss_at_issue=("opportunity_loss_at_issue", "mean"),
                    )
                    loan_default_metrics["default_amount"] = (
                        loan_default_metrics["total_issued_principal"]
                        - loan_default_metrics["principal_paid"]
                    ).clip(lower=0.0)
                    loan_default_metrics["default_amount_to_issued_rate"] = (
                        loan_default_metrics["default_amount"]
                        / loan_default_metrics["total_issued_principal"].clip(lower=1.0)
                    )
                
                run_context = {
                    "Seed": seed,
                    "Capital_Run": capital,
                    "Default_Scenario": scenario_name,
                    "Defaults_Enabled": not bool(default_scenario.get("disable_defaults", False)),
                    "Shock_None_Count": default_scenario["shock_profile_counts"].get("none", 0),
                    "Shock_Medium_Count": default_scenario["shock_profile_counts"].get("medium", 0),
                    "Shock_High_Count": default_scenario["shock_profile_counts"].get("high", 0),
                    "Medium_Shock_Range": str(default_scenario["medium_shock_range"]),
                    "High_Shock_Range": str(default_scenario["high_shock_range"]),
                    "Winner": winner_row["financier"],
                    "Winner_APR_Strategy": winner_row["apr_strategy"],
                    "Winner_Borrower_Strategy": winner_row["wholesaler_policy"],
                    "Winner_Final_Capital": winner_row["final_capital"],
                    "Winner_Return_On_Initial_Capital": (
                        (winner_row["final_capital"] - capital) / capital if capital else 0.0
                    ),
                    "System_Utilization": system_utilization,
                    "System_Total_Issued_Principal": total_issued_principal,
                    "System_Total_Initial_Capital": total_initial_capital,
                    "System_Default_Amount": system_default_amount,
                    "System_Default_Amount_Rate": system_default_amount_rate,
                    "System_Default_Amount_To_Issued_Rate": system_default_amount_rate,
                    "System_Default_Amount_To_Initial_Capital_Rate": (
                        system_default_amount_to_initial_capital_rate
                    ),
                }
                
                for _, row in summary_df_sim.iterrows():
                    financier = row["financier"]
                    loans_issued = float(row.get("loans_issued", 0.0) or 0.0)
                    defaults = float(row.get("defaults", 0.0) or 0.0)
                    financier_data = {
                        **run_context,
                        "Financier": financier,
                        "APR_Strategy": row["apr_strategy"],
                        "Borrower_Strategy": row["wholesaler_policy"],
                        "Wholesaler_Policy": row["wholesaler_policy"],
                        "Final_Capital": row["final_capital"],
                        "Capital_Change": row.get("capital_change", row["final_capital"] - capital),
                        "Capital_Loss": row.get("capital_loss", max(0.0, capital - row["final_capital"])),
                        "Capital_Loss_Rate": row.get(
                            "capital_loss_rate",
                            max(0.0, capital - row["final_capital"]) / capital if capital else 0.0,
                        ),
                        "Final_APR": row["final_apr"],
                        "Loans_Issued": loans_issued,
                        "Defaults": defaults,
                        "Default_Count_Rate": row.get(
                            "default_count_rate",
                            defaults / loans_issued if loans_issued else 0.0,
                        ),
                        "Default_Amount_To_Initial_Capital_Rate": 0.0,
                        "Return_On_Initial_Capital": (
                            (row["final_capital"] - capital) / capital if capital else 0.0
                        ),
                        "Is_Winner": financier == winner_row["financier"],
                    }
                    if financier in history_metrics.index:
                        history_row = history_metrics.loc[financier]
                        financier_data["Average_Utilization"] = history_row["average_utilization"]
                        financier_data["Max_Utilization"] = history_row["max_utilization"]
                        financier_data["Average_APR"] = history_row["average_apr"]
                        financier_data["Average_Offered_APR"] = history_row["average_offered_apr"]
                        financier_data["Average_Risk_Premium"] = history_row["average_risk_premium"]
                        financier_data["Average_Borrower_Score"] = history_row["average_borrower_score"]
                        financier_data["Min_Borrower_Score"] = history_row["min_borrower_score"]
                        financier_data["Max_Borrower_Score"] = history_row["max_borrower_score"]
                        financier_data["APR_Volatility"] = history_row["apr_volatility"]
                        financier_data["Average_Payoff"] = history_row["average_payoff"]
                    else:
                        financier_data["Average_Utilization"] = 0.0
                        financier_data["Max_Utilization"] = 0.0
                        financier_data["Average_APR"] = 0.0
                        financier_data["Average_Offered_APR"] = 0.0
                        financier_data["Average_Risk_Premium"] = 0.0
                        financier_data["Average_Borrower_Score"] = 0.0
                        financier_data["Min_Borrower_Score"] = 0.0
                        financier_data["Max_Borrower_Score"] = 0.0
                        financier_data["APR_Volatility"] = 0.0
                        financier_data["Average_Payoff"] = 0.0
                    if financier in loan_default_metrics.index:
                        default_row = loan_default_metrics.loc[financier]
                        financier_data["Total_Issued_Principal"] = default_row["total_issued_principal"]
                        financier_data["Default_Amount"] = default_row["default_amount"]
                        financier_data["Default_Amount_To_Issued_Rate"] = default_row[
                            "default_amount_to_issued_rate"
                        ]
                        financier_data["Default_Amount_To_Initial_Capital_Rate"] = (
                            default_row["default_amount"] / capital if capital else 0.0
                        )
                        financier_data["Average_Projected_APR_RL_Reward"] = default_row[
                            "average_projected_apr_rl_reward"
                        ]
                        financier_data["Average_Realized_APR_RL_Reward"] = default_row[
                            "average_realized_apr_rl_reward"
                        ]
                        financier_data["Average_Opportunity_Loss_At_Issue"] = default_row[
                            "average_opportunity_loss_at_issue"
                        ]
                    else:
                        financier_data["Total_Issued_Principal"] = 0.0
                        financier_data["Default_Amount"] = 0.0
                        financier_data["Default_Amount_To_Issued_Rate"] = 0.0
                        financier_data["Default_Amount_To_Initial_Capital_Rate"] = 0.0
                        financier_data["Average_Projected_APR_RL_Reward"] = 0.0
                    financier_data["Average_Realized_APR_RL_Reward"] = 0.0
                    financier_data["Average_Opportunity_Loss_At_Issue"] = 0.0
                summary_data.append(financier_data)

    final_output = "\n".join(all_reports)
    
    report_path = Path("multiple_capitals_report.txt")
    report_path.write_text(final_output, encoding="utf-8")
    
    # Create and write the summary Excel file
    summary_df = pd.DataFrame(summary_data)
    
    summary_excel_path = Path("summary_across_capitals.xlsx")
    summary_df.to_excel(summary_excel_path, index=False)
    
    print("\n" + "=" * 80)
    print("ALL SIMULATIONS COMPLETED. FINAL REPORT:")
    print("=" * 80)
    print(final_output)
    print(f"\nCombined text report written to: {report_path.resolve()}", flush=True)
    print(f"Summary Excel written to: {summary_excel_path.resolve()}", flush=True)


if __name__ == "__main__":
    main()
