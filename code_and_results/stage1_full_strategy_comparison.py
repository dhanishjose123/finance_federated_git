#!/usr/bin/env python
"""Full finance-strategy comparison: RL-based APR + RL borrower screening vs.
fixed-rate APR baselines, using the SAME seeds/capitals/defaults as the rest
of the manuscript's confirmatory results.

Why this script exists: the manuscript's existing Stage 1 table only tests
the base-APR mechanism alone (borrower screening switched OFF for every arm,
including the RL-APR arm). The manuscript's Stage 2 table only tests
screening-on vs. screening-off for the RL-APR arm, never against the
fixed-rate baselines. Neither table shows whether the FULL adopted strategy
(RL APR + RL screening, isolated or federated) actually beats fixed-rate
pricing -- that specific comparison previously only existed in an
exploratory model-selection run (egt_model_selection_results.xlsx) that used
different seeds (42, 123, 777) and also included several EGT-based
screening variants. Per instruction, EGT is removed entirely here -- this
script compares only the strategies actually used in the manuscript.

Six matched-counterfactual financier groups (3 financiers per group, same
NUM_FINANCIERS_PER_GROUP as every other stage):
  1. RL APR + isolated RL screening      (apr_strategy=pure_rl, policy=rl)
  2. RL APR + FL-RL (FedAvg) screening   (apr_strategy=pure_rl, policy=fl_rl)
  3. RL APR + no screening               (apr_strategy=pure_rl, policy=none)
  4. Fixed 6% APR + no screening         (apr_strategy=fixed_6, policy=none)
  5. Fixed 8% APR + no screening         (apr_strategy=fixed_8, policy=none)
  6. Fixed 10% APR + no screening        (apr_strategy=fixed_10, policy=none)

Uses the exact same DAYS, SEEDS ([709098, 436570, 831197]),
CAPITALS_PER_FINANCIER, DEFAULT_SCENARIOS, NON_IID_PRIMARY_SHARE, and RL
hyperparameters as federated_comparison_common.py (imported from there, not
redefined), so this result is directly poolable/comparable with every other
matched-pair result already in the manuscript -- no "different seeds"
caveat needed.

Design: separate matched-counterfactual runs (like Stage A/B), i.e. each
(seed, capital, default_scenario) combination is run ONCE PER STRATEGY with
only that strategy's 3 financiers active, exactly like every other stage.
That gives 3 seeds x 3 capitals x 4 default scenarios x 6 strategies = 216
individual simulation runs.

Runtime: Stage A's own timing note put single-policy runs at roughly
131s/run on comparable hardware. 216 runs x ~131s implies a rough budget of
~7-8 hours for a full pass. CHECKPOINTING is per (seed, strategy): each
seed/strategy's raw output is written to disk immediately after that
combination finishes, and already-completed combinations are skipped on
re-run, so the script is safely interruptible and resumable -- run it in
the background and let it pick up where it left off if stopped.

Run with: python stage1_full_strategy_comparison.py
Output:
  stage1_full_strategy_comparison/seed_<seed>/<strategy_key>_raw_summary.csv
    (one file per seed x strategy; safe to inspect individually)
  stage1_full_strategy_comparison/stage1_full_combined_raw_summary.csv
    (all seeds x strategies concatenated, once every combination is done)
  stage1_full_strategy_comparison/stage1_full_report.txt
    (overall summary table + matched comparison + significance tests vs.
    the best fixed-rate baseline, once every combination is done)
"""

from __future__ import annotations

import time
from pathlib import Path

import pandas as pd

import federated_comparison_common as fc
from egt_apr_simulation import run_simulation, write_excel

try:
    from scipy import stats

    HAVE_SCIPY = True
except ImportError:
    HAVE_SCIPY = False

# ---------------------------------------------------------------------------
# Strategy definitions -- EGT removed entirely, only the strategies actually
# used in the manuscript are compared.
# ---------------------------------------------------------------------------

STRATEGIES = [
    {
        "key": "rl_apr_isolated_screening",
        "label": "RL APR + isolated RL screening",
        "apr_strategy": "pure_rl",
        "wholesaler_policy": "rl",
        "base_apr": 6.0,  # unused by pure_rl (learned), kept for API parity
        "non_iid": True,
    },
    {
        "key": "rl_apr_fl_rl_screening",
        "label": "RL APR + FL-RL (FedAvg) screening",
        "apr_strategy": "pure_rl",
        "wholesaler_policy": "fl_rl",
        "base_apr": 6.0,
        "non_iid": True,
    },
    {
        "key": "rl_apr_no_screening",
        "label": "RL APR + no screening",
        "apr_strategy": "pure_rl",
        "wholesaler_policy": "none",
        "base_apr": 6.0,
        "non_iid": False,
    },
    {
        "key": "fixed_6_no_screening",
        "label": "Fixed 6% APR + no screening",
        "apr_strategy": "fixed_6",
        "wholesaler_policy": "none",
        "base_apr": 6.0,
        "non_iid": False,
    },
    {
        "key": "fixed_8_no_screening",
        "label": "Fixed 8% APR + no screening",
        "apr_strategy": "fixed_8",
        "wholesaler_policy": "none",
        "base_apr": 8.0,
        "non_iid": False,
    },
    {
        "key": "fixed_10_no_screening",
        "label": "Fixed 10% APR + no screening",
        "apr_strategy": "fixed_10",
        "wholesaler_policy": "none",
        "base_apr": 10.0,
        "non_iid": False,
    },
]

BASELINE_KEY = "fixed_10_no_screening"  # best-performing fixed baseline in
                                         # the existing Stage 1 table --
                                         # used for the significance test.
FOCAL_KEY = "rl_apr_isolated_screening"  # the manuscript's adopted strategy

BASE_OUTPUT_DIR = Path("stage1_full_strategy_comparison")


def run_one_strategy(seed: int, scenario: dict, capital: float, strategy: dict) -> pd.DataFrame:
    """Run all 3 financiers of ONE strategy for one (seed, capital, scenario)."""
    n = fc.NUM_FINANCIERS_PER_GROUP
    financier_names = [f"Fin_{strategy['key']}_{i}" for i in range(1, n + 1)]
    apr_strategies = [strategy["apr_strategy"]] * n
    wholesaler_policies = [strategy["wholesaler_policy"]] * n
    base_aprs = [strategy["base_apr"]] * n
    non_iid_group_policies = (strategy["wholesaler_policy"],) if strategy["non_iid"] else ()

    frames = run_simulation(
        days=fc.DAYS,
        seed=seed,
        apr_strategies=apr_strategies,
        wholesaler_policies=wholesaler_policies,
        financier_names=financier_names,
        base_aprs=base_aprs,
        apr_alphas=[fc.APR_ALPHA] * n,
        apr_gammas=[fc.APR_GAMMA] * n,
        apr_epsilons=[fc.APR_EPSILON] * n,
        borrower_alphas=[fc.BORROWER_ALPHA] * n,
        borrower_gammas=[fc.BORROWER_GAMMA] * n,
        borrower_epsilons=[fc.BORROWER_EPSILON] * n,
        borrower_premium_action_sets=[fc.BORROWER_PREMIUM_ACTIONS] * n,
        initial_wallet=capital,
        initial_capital=capital,
        disable_defaults=scenario["disable_defaults"],
        shock_profile_counts=scenario["shock_profile_counts"],
        medium_shock_range=scenario["medium_shock_range"],
        high_shock_range=scenario["high_shock_range"],
        non_iid_primary_share=fc.NON_IID_PRIMARY_SHARE,
        non_iid_group_policies=non_iid_group_policies,
    )

    summary = frames["Financier_Summary"].copy()
    summary["seed"] = seed
    summary["default_scenario"] = scenario["name"]
    summary["capital_per_financier"] = capital
    summary["strategy_key"] = strategy["key"]
    summary["strategy_label"] = strategy["label"]
    return summary


def weighted_return_pct(group: pd.DataFrame) -> float:
    total_initial = group["initial_capital"].sum()
    if not total_initial:
        return 0.0
    return 100.0 * group["capital_change"].sum() / total_initial


def build_summary_table(combined: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for strategy in STRATEGIES:
        sub = combined[combined["strategy_key"] == strategy["key"]]
        if sub.empty:
            continue
        rows.append(
            {
                "strategy": strategy["label"],
                "runs": sub["financier"].nunique(),
                "initial_capital": sub["initial_capital"].sum(),
                "final_capital": sub["final_capital"].sum(),
                "mean_return_pct": weighted_return_pct(sub),
                "avg_apr": sub["final_apr"].mean(),
                "default_to_initial_capital_rate_pct": 100.0 * sub["default_amount_to_initial_capital_rate"].mean(),
                "avg_utilization": sub["final_utilization"].mean(),
            }
        )
    return pd.DataFrame(rows)


def build_breakdown_table(combined: pd.DataFrame, group_col: str) -> pd.DataFrame:
    """Avg APR / return / default / utilisation per strategy, broken out by
    group_col (e.g. 'default_scenario' or 'capital_per_financier'). Includes
    every strategy -- RL and all three fixed-rate arms -- side by side, so
    the adaptive-vs-fixed contrast is visible directly in the table: the
    fixed arms' avg_apr should stay pinned at 6.0/8.0/10.0 in every group,
    while the RL arm's avg_apr should move across groups.
    """
    rows = []
    for group_value in sorted(combined[group_col].unique(), key=str):
        group_df = combined[combined[group_col] == group_value]
        for strategy in STRATEGIES:
            sub = group_df[group_df["strategy_key"] == strategy["key"]]
            if sub.empty:
                continue
            rows.append(
                {
                    group_col: group_value,
                    "strategy": strategy["label"],
                    "runs": sub["financier"].nunique(),
                    "mean_return_pct": weighted_return_pct(sub),
                    "avg_apr": sub["final_apr"].mean(),
                    "default_to_initial_capital_rate_pct": 100.0
                    * sub["default_amount_to_initial_capital_rate"].mean(),
                    "avg_utilization": sub["final_utilization"].mean(),
                }
            )
    return pd.DataFrame(rows)


def matched_pairs(combined: pd.DataFrame, focal_key: str, baseline_key: str) -> pd.DataFrame:
    """One row per (seed, capital, default_scenario): focal vs. baseline
    return_pct and default rate, for paired significance testing."""
    match_keys = ["seed", "capital_per_financier", "default_scenario"]

    def per_run(strategy_key: str) -> pd.DataFrame:
        sub = combined[combined["strategy_key"] == strategy_key]
        return (
            sub.groupby(match_keys)
            .apply(
                lambda g: pd.Series(
                    {
                        "return_pct": weighted_return_pct(g),
                        "default_rate_pct": 100.0 * g["default_amount_to_initial_capital_rate"].mean(),
                    }
                ),
                include_groups=False,
            )
            .reset_index()
        )

    focal = per_run(focal_key).set_index(match_keys)
    baseline = per_run(baseline_key).set_index(match_keys)
    matched = focal.join(baseline, lsuffix="_focal", rsuffix="_base", how="inner").reset_index()
    matched["delta_return_pp"] = matched["return_pct_focal"] - matched["return_pct_base"]
    matched["delta_default_rate_pp"] = matched["default_rate_pct_focal"] - matched["default_rate_pct_base"]
    return matched


def significance_block(matched: pd.DataFrame) -> str:
    lines = []
    n = len(matched)
    lines.append(f"Matched pairs: n={n}")
    pair_cols = {
        "delta_return_pp": ("return_pct_focal", "return_pct_base"),
        "delta_default_rate_pp": ("default_rate_pct_focal", "default_rate_pct_base"),
    }
    for col, label in [("delta_return_pp", "Return %"), ("delta_default_rate_pp", "Default rate (pp)")]:
        deltas = matched[col]
        mean_d = deltas.mean()
        sd_d = deltas.std()
        if HAVE_SCIPY and n > 1:
            focal_col, base_col = pair_cols[col]
            t_stat, t_p = stats.ttest_rel(matched[focal_col], matched[base_col])
            try:
                w_stat, w_p = stats.wilcoxon(deltas)
            except ValueError:
                w_stat, w_p = float("nan"), float("nan")
            lines.append(
                f"  {label}: mean delta = {mean_d:+.3f}, sd = {sd_d:.3f} | "
                f"paired t = {t_stat:.3f}, p = {t_p:.4f} | Wilcoxon p = {w_p:.4f}"
            )
        else:
            lines.append(f"  {label}: mean delta = {mean_d:+.3f}, sd = {sd_d:.3f} (scipy unavailable, no test)")
    return "\n".join(lines)


if __name__ == "__main__":
    BASE_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    start = time.time()

    total_combos = len(fc.SEEDS) * len(STRATEGIES)
    combo_index = 0
    all_frames = []

    for seed in fc.SEEDS:
        seed_dir = BASE_OUTPUT_DIR / f"seed_{seed}"
        seed_dir.mkdir(parents=True, exist_ok=True)
        for strategy in STRATEGIES:
            combo_index += 1
            out_csv = seed_dir / f"{strategy['key']}_raw_summary.csv"
            if out_csv.exists():
                print(f"[{combo_index}/{total_combos}] seed={seed} strategy={strategy['key']} "
                      f"already done ({out_csv}) -- skipping.")
                all_frames.append(pd.read_csv(out_csv))
                continue

            print(f"[{combo_index}/{total_combos}] Running seed={seed} strategy={strategy['key']} "
                  f"({len(fc.CAPITALS_PER_FINANCIER)} capitals x {len(fc.DEFAULT_SCENARIOS)} scenarios) ...")
            strategy_frames = []
            for capital in fc.CAPITALS_PER_FINANCIER:
                for scenario in fc.DEFAULT_SCENARIOS:
                    strategy_frames.append(run_one_strategy(seed, scenario, capital, strategy))
            strategy_combined = pd.concat(strategy_frames, ignore_index=True)
            strategy_combined.to_csv(out_csv, index=False)
            all_frames.append(strategy_combined)
            print(f"[{combo_index}/{total_combos}] seed={seed} strategy={strategy['key']} done -> {out_csv}")

    combined = pd.concat(all_frames, ignore_index=True)
    combined_csv = BASE_OUTPUT_DIR / "stage1_full_combined_raw_summary.csv"
    combined.to_csv(combined_csv, index=False)

    summary_table = build_summary_table(combined)
    by_scenario_table = build_breakdown_table(combined, "default_scenario")
    by_capital_table = build_breakdown_table(combined, "capital_per_financier")
    matched = matched_pairs(combined, FOCAL_KEY, BASELINE_KEY)

    report_lines = []
    report_lines.append("Stage 1 (full): RL APR + RL screening vs. fixed-rate baselines")
    report_lines.append("=" * 70)
    report_lines.append(f"Days: {fc.DAYS} | Seeds: {fc.SEEDS} | Financiers per group: {fc.NUM_FINANCIERS_PER_GROUP}")
    report_lines.append(f"Capital levels: {fc.CAPITALS_PER_FINANCIER}")
    report_lines.append(f"Default scenarios: {[s['name'] for s in fc.DEFAULT_SCENARIOS]}")
    report_lines.append("")
    report_lines.append("--- Overall summary (pooled across all seeds, capitals, scenarios) ---")
    report_lines.append(summary_table.to_string(index=False))
    report_lines.append("")
    report_lines.append(
        "--- Avg APR / return / default / utilisation BY DEFAULT SCENARIO, all strategies side by side ---"
    )
    report_lines.append(
        "(fixed arms' avg_apr should stay pinned at 6.0/8.0/10.0 in every scenario; "
        "the RL arms' avg_apr should move across scenarios -- that movement is the adaptivity evidence)"
    )
    report_lines.append(by_scenario_table.to_string(index=False))
    report_lines.append("")
    report_lines.append(
        "--- Avg APR / return / default / utilisation BY CAPITAL LEVEL, all strategies side by side ---"
    )
    report_lines.append(by_capital_table.to_string(index=False))
    report_lines.append("")
    focal_label = next(s["label"] for s in STRATEGIES if s["key"] == FOCAL_KEY)
    baseline_label = next(s["label"] for s in STRATEGIES if s["key"] == BASELINE_KEY)
    report_lines.append(f"--- Matched-pair significance: {focal_label} vs. {baseline_label} ---")
    report_lines.append(significance_block(matched))
    report_lines.append("")
    report_lines.append(f"Elapsed: {time.time() - start:.1f}s")

    report_text = "\n".join(report_lines)
    print()
    print(report_text)
    (BASE_OUTPUT_DIR / "stage1_full_report.txt").write_text(report_text, encoding="utf-8")
    print(f"\nSaved: {BASE_OUTPUT_DIR / 'stage1_full_report.txt'}")
    print(f"Saved: {combined_csv}")

    try:
        write_excel(
            {
                "Overall_Summary": summary_table,
                "By_Default_Scenario": by_scenario_table,
                "By_Capital_Level": by_capital_table,
                "Matched_Pairs": matched,
                "Raw_Summary": combined,
            },
            BASE_OUTPUT_DIR / "stage1_full_results.xlsx",
        )
        print(f"Saved: {BASE_OUTPUT_DIR / 'stage1_full_results.xlsx'}")
    except ImportError as exc:
        print(f"WARNING: skipped .xlsx export ({exc}). The .csv and .txt above are all that's needed.")
