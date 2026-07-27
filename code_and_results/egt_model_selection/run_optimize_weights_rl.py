#!/usr/bin/env python
"""Optimize Fin_RL APR learning parameters across capitals, default scenarios, and seeds."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from egt_apr_simulation import run_simulation

TARGET_FINANCIER = "Fin_RL"

CAPITALS_TO_RUN = [
    1_000_000.0,
    5_000_000.0,
]

SEEDS_TO_RUN = [
    42,
]

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

APR_ALPHAS_TO_TRY = [0.10, 0.25, 0.40]
APR_GAMMAS_TO_TRY = [0.60, 0.85]
APR_EPSILONS_TO_TRY = [0.02, 0.05, 0.08]

PARAMS_TO_RUN = [
    {
        "apr_alpha": apr_alpha,
        "apr_gamma": apr_gamma,
        "apr_epsilon": apr_epsilon,
    }
    for apr_alpha in APR_ALPHAS_TO_TRY
    for apr_gamma in APR_GAMMAS_TO_TRY
    for apr_epsilon in APR_EPSILONS_TO_TRY
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

BASE_FINANCIERS = [
    ("Fin_RL", "pure_rl", "rl"),
    ("Fin_RL_Borrower_EGT", "pure_rl", "egt"),
    ("Fin_RL_Borrower_EGT_Replicator", "pure_rl", "egt_replicator"),
    ("Fin_RL_Borrower_EGT_Fermi", "pure_rl", "egt_fermi"),
    ("Fin_6pct", "fixed_6", "none"),
    ("Fin_8pct", "fixed_8", "none"),
    ("fixed_10ct", "fixed_10", "none"),
]
FINANCIER_NAMES = [financier_name for financier_name, _, _ in BASE_FINANCIERS]
APR_STRATEGIES = [apr_strategy for _, apr_strategy, _ in BASE_FINANCIERS]
WHOLESALER_POLICIES = [wholesaler_policy for _, _, wholesaler_policy in BASE_FINANCIERS]
PURE_RL_FINANCIERS = {"Fin_RL"}
BASE_APRS = [6.0, 6.0, 6.0, 6.0, 6.0, 8.0, 10.0]


def money(value: float) -> str:
    return f"{value:,.2f}"


def pct(value: float) -> str:
    return f"{100.0 * value:,.2f}%"


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


def summarize(
    frames: dict[str, pd.DataFrame],
    params: dict[str, float],
    capital: float,
    seed: int,
    default_scenario: dict[str, object],
) -> str:
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
        interest_income=("interest_paid", "sum"),
        penalty_income=("penalty_paid", "sum"),
    )
    decisions = decision_counts(results)
    merged = summary.set_index("financier").join(hist_metrics, how="left").join(loan_metrics, how="left")
    if not decisions.empty:
        merged = merged.join(decisions.set_index("financier"), how="left")

    total_initial = capital * len(summary)
    total_final = float(summary["final_capital"].sum())
    total_loans = float(summary["loans_issued"].sum())
    total_defaults = float(summary["defaults"].sum())
    
    params_str = (
        f"apr_alpha={params['apr_alpha']}, "
        f"apr_gamma={params['apr_gamma']}, "
        f"apr_epsilon={params['apr_epsilon']}"
    )

    lines = [
        f"APR-side comparison with capital = {capital:,.2f} | seed: {seed} | params: {params_str}",
        "Financier APR strategies: pure_rl learning financiers plus fixed APR baselines",
        "Borrower screening policies: rl, egt, egt_replicator, egt_fermi, none",
        f"Defaults enabled: {not bool(default_scenario.get('disable_defaults', False))}",
        f"Default scenario: {default_scenario['name']}",
        "Borrower margin: current simulator setting",
        "Days: 4000",
        f"Seed: {seed}",
        "",
        f"Total initial capital: {money(total_initial)}",
        f"Total final capital: {money(total_final)}",
        f"Total net profit: {money(total_final - total_initial)}",
        f"Total return on initial capital: {pct((total_final - total_initial) / total_initial) if total_initial else '0.00%'}",
        f"Total loans issued: {int(total_loans):,}",
        f"Total defaults: {int(total_defaults):,}",
        f"System default rate: {pct(total_defaults / total_loans if total_loans else 0.0)}",
        f"Overall average utilization: {pct(float(history['utilization'].mean())) if not history.empty else '0.00%'}",
        f"Overall average APR: {float(history['new_apr'].mean()) if not history.empty else 0.0:,.2f}%",
        "",
        "Financier metrics:",
    ]

    for financier, row in merged.sort_values("final_capital", ascending=False).iterrows():
        loans_issued = float(row.get("loans_issued", 0.0) or 0.0)
        defaults = float(row.get("defaults", 0.0) or 0.0)
        net_profit = float(row["final_capital"] - capital)
        lines.extend(
            [
                "-" * 96,
                f"Financier: {financier}",
                f"Strategy: {row.get('apr_strategy', 'N/A')}",
                f"Wholesaler policy: {row.get('wholesaler_policy', 'N/A')}",
                f"Final capital: {money(float(row['final_capital']))}",
                f"Net profit: {money(net_profit)}",
                f"Return on initial capital: {pct(net_profit / capital) if capital else '0.00%'}",
                f"Loans issued: {int(loans_issued):,}",
                f"Market share by loan count: {pct(loans_issued / total_loans if total_loans else 0.0)}",
                f"Defaults: {int(defaults):,}",
                f"Default rate: {pct(defaults / loans_issued if loans_issued else 0.0)}",
                f"Average utilization: {pct(float(row.get('average_utilization', 0.0) or 0.0))}",
                f"Max utilization: {pct(float(row.get('max_utilization', 0.0) or 0.0))}",
                f"Average APR: {float(row.get('average_apr', 0.0) or 0.0):,.2f}%",
                f"APR volatility: {float(row.get('apr_volatility', 0.0) or 0.0):,.2f}",
                f"Final APR: {float(row.get('final_apr', 0.0) or 0.0):,.2f}%",
                f"Average payoff: {float(row.get('average_payoff', 0.0) or 0.0):,.6f}",
                f"Interest income: {money(float(row.get('interest_income', 0.0) or 0.0))}",
                f"Penalty income: {money(float(row.get('penalty_income', 0.0) or 0.0))}",
                f"Profit per loan: {money(net_profit / loans_issued if loans_issued else 0.0)}",
                f"Financier rejections: {int(row.get('FINANCIER_REJECTED', 0.0) or 0.0):,}",
                f"Wholesaler rejections: {int(row.get('WHOLESALER_REJECTED', 0.0) or 0.0):,}",
            ]
        )
    return "\n".join(lines) + "\n"


def main() -> None:
    param_summary_data = []
    all_reports = []
    for idx, params in enumerate(PARAMS_TO_RUN, 1):
        apr_alpha = params["apr_alpha"]
        apr_gamma = params["apr_gamma"]
        apr_epsilon = params["apr_epsilon"]
        params_str = f"alpha_{apr_alpha}_gamma_{apr_gamma}_epsilon_{apr_epsilon}"
        apr_alphas = [
            apr_alpha if name in PURE_RL_FINANCIERS else 0.25
            for name in FINANCIER_NAMES
        ]
        apr_gammas = [
            apr_gamma if name in PURE_RL_FINANCIERS else 0.70
            for name in FINANCIER_NAMES
        ]
        apr_epsilons = [
            apr_epsilon if name in PURE_RL_FINANCIERS else 0.08
            for name in FINANCIER_NAMES
        ]
        
        sum_system_utilization = 0.0
        sum_system_default_amount = 0.0
        sum_system_initial_capital = 0.0
        sum_system_final_capital = 0.0
        sum_target_final_capital = 0.0
        worst_target_final_capital = None
        sum_financier_capitals = {fin: 0.0 for fin in FINANCIER_NAMES}
        sum_target_by_scenario = {
            scenario["name"]: 0.0 for scenario in DEFAULT_SCENARIOS_TO_RUN
        }
        
        for capital in CAPITALS_TO_RUN:
            for default_scenario in DEFAULT_SCENARIOS_TO_RUN:
                for seed in SEEDS_TO_RUN:
                    scenario_name = default_scenario["name"]
                    print(
                        f"Running APR parameter optimization {idx}/{len(PARAMS_TO_RUN)} | "
                        f"Params: {params_str} | Capital: {capital:,.0f} | "
                        f"Defaults: {scenario_name} | Seed: {seed}..."
                    )
                    
                    defaults_disabled = bool(default_scenario.get("disable_defaults", False))
                    frames = run_simulation(
                        days=4000,
                        seed=seed,
                        apr_strategies=APR_STRATEGIES,
                        wholesaler_policies=WHOLESALER_POLICIES,
                        financier_names=FINANCIER_NAMES,
                        base_aprs=BASE_APRS,
                        initial_wallet=capital,
                        initial_capital=capital,
                        disable_defaults=defaults_disabled,
                        borrower_margin=BORROWER_MARGIN,
                        shock_profile_counts=default_scenario["shock_profile_counts"],
                        medium_shock_range=default_scenario["medium_shock_range"],
                        high_shock_range=default_scenario["high_shock_range"],
                        apr_alphas=apr_alphas,
                        apr_gammas=apr_gammas,
                        apr_epsilons=apr_epsilons,
                        pure_rl_apr_action_sets=[FINE_ACTIONS] * len(APR_STRATEGIES),
                    )

                    report = summarize(frames, params, capital, seed, default_scenario)
                    all_reports.append(
                        f"================================================================================\n"
                        f"PARAMS: {params_str} | CAPITAL: {capital:,.2f} | "
                        f"DEFAULTS: {scenario_name} | SEED: {seed}\n"
                        f"================================================================================\n"
                        f"{report}\n"
                    )
                    
                    summary_df_sim = frames["Financier_Summary"]
                    history_df_sim = frames["Financier_History"]
                    loans_df_sim = frames["Loans"]
                    
                    system_utilization = (
                        float(history_df_sim["utilization"].mean())
                        if not history_df_sim.empty
                        else 0.0
                    )
                    total_issued_principal = (
                        float(loans_df_sim["amount"].sum()) if not loans_df_sim.empty else 0.0
                    )
                    total_principal_paid = (
                        float(loans_df_sim["principal_paid"].sum()) if not loans_df_sim.empty else 0.0
                    )
                    system_default_amount = max(0.0, total_issued_principal - total_principal_paid)
                    system_initial_capital = capital * len(summary_df_sim)
                    system_final_capital = float(summary_df_sim["final_capital"].sum())
                    target_final_capital = float(
                        summary_df_sim.loc[
                            summary_df_sim["financier"] == TARGET_FINANCIER,
                            "final_capital",
                        ].sum()
                    )

                    sum_system_utilization += system_utilization
                    sum_system_default_amount += system_default_amount
                    sum_system_initial_capital += system_initial_capital
                    sum_system_final_capital += system_final_capital
                    sum_target_final_capital += target_final_capital
                    sum_target_by_scenario[scenario_name] += target_final_capital
                    worst_target_final_capital = (
                        target_final_capital
                        if worst_target_final_capital is None
                        else min(worst_target_final_capital, target_final_capital)
                    )
                    
                    for _, row in summary_df_sim.iterrows():
                        sum_financier_capitals[row["financier"]] += row["final_capital"]

        # Calculate averages across capitals and seeds for this parameter configuration
        num_runs = len(CAPITALS_TO_RUN) * len(DEFAULT_SCENARIOS_TO_RUN) * len(SEEDS_TO_RUN)
        avg_system_utilization = sum_system_utilization / num_runs
        system_default_amount_to_initial_capital_rate = (
            sum_system_default_amount / sum_system_initial_capital
            if sum_system_initial_capital
            else 0.0
        )
        avg_capitals = {fin: sum_financier_capitals[fin] / num_runs for fin in FINANCIER_NAMES}
        
        # Determine overall winner across all runs for these params.
        winner = max(avg_capitals, key=avg_capitals.get)
        
        run_data = {
            "APR_Alpha": apr_alpha,
            "APR_Gamma": apr_gamma,
            "APR_Epsilon": apr_epsilon,
            "Overall_Winner": winner,
            "Winner_Avg_Capital": avg_capitals[winner],
            "Total_System_Final_Capital": sum_system_final_capital,
            "Total_Target_Final_Capital": sum_target_final_capital,
            "Worst_Target_Final_Capital": worst_target_final_capital or 0.0,
            "Avg_System_Utilization": avg_system_utilization,
            "System_Default_Amount": sum_system_default_amount,
            "System_Initial_Capital": sum_system_initial_capital,
            "System_Default_Amount_To_Initial_Capital_Rate": (
                system_default_amount_to_initial_capital_rate
            ),
        }
        for scenario_name, scenario_target_capital in sum_target_by_scenario.items():
            run_data[f"Total_{TARGET_FINANCIER}_Capital_{scenario_name}"] = scenario_target_capital
        for fin in FINANCIER_NAMES:
            run_data[f"Avg_{fin}_Capital"] = avg_capitals[fin]
            
        param_summary_data.append(run_data)

    final_output = "\n".join(all_reports)
    
    report_path = Path("optimize_apr_params_report.txt")
    report_path.write_text(final_output, encoding="utf-8")
    
    # Create and write the summary Excel file
    summary_df = pd.DataFrame(param_summary_data)
    
    summary_excel_path = Path("summary_across_apr_params.xlsx")
    summary_df.to_excel(summary_excel_path, index=False)
    
    if not summary_df.empty and "Total_Target_Final_Capital" in summary_df.columns:
        best_row = summary_df.loc[summary_df["Total_Target_Final_Capital"].idxmax()]
        best_params_str = (
            f"apr_alpha={best_row['APR_Alpha']}, "
            f"apr_gamma={best_row['APR_Gamma']}, "
            f"apr_epsilon={best_row['APR_Epsilon']}"
        )
        best_target_total_cap = best_row["Total_Target_Final_Capital"]
        best_system_total_cap = best_row["Total_System_Final_Capital"]
        best_system_utilization = best_row["Avg_System_Utilization"]
        best_default_capital_rate = best_row["System_Default_Amount_To_Initial_Capital_Rate"]
    else:
        best_params_str = "N/A"
        best_target_total_cap = 0.0
        best_system_total_cap = 0.0
        best_system_utilization = 0.0
        best_default_capital_rate = 0.0

    print("\n" + "=" * 80)
    print("ALL SIMULATIONS COMPLETED. FINAL REPORT:")
    print("=" * 80)
    print(f"\nCombined text report written to: {report_path.resolve()}")
    print(f"Summary Excel written to: {summary_excel_path.resolve()}")
    print("\n" + "*" * 80)
    print("APR PARAMETER OPTIMIZATION RESULTS:")
    print("*" * 80)
    print(f"Best APR learning params for {TARGET_FINANCIER}: {best_params_str}")
    print(f"{TARGET_FINANCIER}'s total final capital across all runs: {money(best_target_total_cap)}")
    print(f"System total final capital across all runs: {money(best_system_total_cap)}")
    print(f"Average system utilization for best params: {pct(best_system_utilization)}")
    print(f"System default amount / initial capital for best params: {pct(best_default_capital_rate)}")


if __name__ == "__main__":
    main()
