#!/usr/bin/env python
"""Learning-curve / convergence analysis: how quickly and stably do Isolated
RL, FedAvg, FedProx, and SCAFFOLD (c_lr=0.25) converge over the 4000-day
horizon, and how much does SCAFFOLD's control-variate correction actually
reduce cross-financier policy divergence compared to plain FedAvg?

This is NOT a statistical-power experiment -- it runs ONE representative
seed/capital/scenario per policy (not the 36-pair matched design), because
the question here is trajectory shape (how fast/stably each policy
converges), not whether a terminal-value difference is statistically
significant. Runtime is therefore minutes, not hours: 4 single runs at
~80-130s each based on the per-run cost already observed in Stage A/B3.

Representative point chosen to match the paper's existing headline numbers
as closely as possible: seed=709098 (the first of the three original Stage
A/B3 seeds), capital=5,000,000 (the middle of the three capital levels),
scenario=medium_default (a realistic, moderately-stressed scenario, neither
the no-stress floor nor the highest-stress ceiling).

Two complementary views are produced:

1. Economic outcome convergence -- capital_return_on_initial over days,
   averaged across each policy group's 3 financiers, smoothed with a
   100-day rolling mean. Shows how fast/stably each policy's return
   trajectory settles.

2. Cross-financier policy-divergence convergence -- the day-by-day standard
   deviation of risk_premium (the borrower-side agent's federated output)
   ACROSS the 3 financiers within each federated policy group (fl_rl,
   fl_rl_prox, fl_rl_scaffold). This is the more mechanistic evidence for
   SCAFFOLD's "drift correction" motivation: if SCAFFOLD is doing what the
   theory predicts, this spread should shrink faster and/or lower than
   FedAvg's. Isolated RL ('rl') is plotted too as an unfederated reference
   -- with no aggregation at all, this spread has no reason to shrink over
   time, which is the expected contrast baseline.

Requires: pandas, matplotlib (pip install matplotlib --break-system-packages
if missing; pandas should already be installed from the other stage scripts).

Run with: python convergence_analysis.py
Output: convergence_analysis/
  - convergence_raw_history.csv                          (all 4 policies' full daily history)
  - convergence_return_on_initial.pdf / .png              (view 1; .pdf is the vector
  - convergence_risk_premium_spread.pdf / .png            (view 2; version for LaTeX
                                                             \includegraphics, matching the
                                                             existing Figure_1-6.pdf figures
                                                             in manuscript/iop/. The .png is
                                                             just for quick preview.)
"""

from __future__ import annotations

from pathlib import Path

import matplotlib
matplotlib.use("Agg")  # no display needed; just save PNGs
import matplotlib.pyplot as plt
import pandas as pd

# Publication-style defaults: serif font to match the LaTeX manuscript body,
# larger base sizes for print legibility, no embedded titles (captions
# belong in the LaTeX \caption{} when these are placed as figures, not
# baked into the image), tight bounding box, 300 dpi.
plt.rcParams.update({
    "font.family": "serif",
    "font.size": 11,
    "axes.labelsize": 11,
    "axes.titlesize": 11,
    "legend.fontsize": 9.5,
    "xtick.labelsize": 9.5,
    "ytick.labelsize": 9.5,
    "axes.linewidth": 0.8,
    "grid.linewidth": 0.5,
    "lines.linewidth": 1.6,
    "figure.dpi": 300,
    "savefig.dpi": 300,
    "savefig.bbox": "tight",
})

# Colorblind- and grayscale-safe: distinct colors (Okabe-Ito palette) paired
# with distinct line styles/markers, so the lines stay distinguishable even
# if printed in black-and-white.
POLICY_STYLE = {
    "rl":             {"color": "#000000", "linestyle": ":",  "marker": None},
    "fl_rl":          {"color": "#0072B2", "linestyle": "-",  "marker": None},
    "fl_rl_prox":     {"color": "#D55E00", "linestyle": "--", "marker": None},
    "fl_rl_scaffold": {"color": "#009E73", "linestyle": "-.", "marker": None},
}

import egt_apr_simulation as sim
from federated_comparison_common import (
    APR_ALPHA,
    APR_EPSILON,
    APR_GAMMA,
    BORROWER_ALPHA,
    BORROWER_EPSILON,
    BORROWER_GAMMA,
    BORROWER_PREMIUM_ACTIONS,
    DAYS,
    DEFAULT_SCENARIOS,
    NON_IID_PRIMARY_SHARE,
    build_group_lists,
)

SCAFFOLD_C_LR = 0.25
REP_SEED = 709098
REP_CAPITAL = 5_000_000.0
REP_SCENARIO = next(s for s in DEFAULT_SCENARIOS if s["name"] == "medium_default")

POLICIES = ["rl", "fl_rl", "fl_rl_prox", "fl_rl_scaffold"]
POLICY_LABELS = {
    "rl": "Isolated RL",
    "fl_rl": "FedAvg",
    "fl_rl_prox": "FedProx",
    "fl_rl_scaffold": f"SCAFFOLD (c_lr={SCAFFOLD_C_LR:.2f})",
}
ROLLING_WINDOW = 100  # days, for smoothing

OUTPUT_DIR = Path("convergence_analysis")

_original_build_financiers = sim.build_financiers


def _patched_build_financiers(*args, **kwargs):
    """Same technique as stage_b3_scaffold_lr025_comparison.py: force every
    fl_rl_scaffold financier onto c_lr=0.25 instead of the class default."""
    financiers = _original_build_financiers(*args, **kwargs)
    for financier in financiers:
        if financier.wholesaler_policy == "fl_rl_scaffold":
            financier.scaffold_c_lr = SCAFFOLD_C_LR
    return financiers


ISOLATED_VS_FEDERATED = ["rl", "fl_rl"]  # Stage 3's exact comparison


def run_one_with_history(policy: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Mirrors federated_comparison_common.run_one's exact simulation call,
    but keeps the full daily Financier_History AND the per-loan Loans log
    (the latter needed to derive a cumulative default-rate-over-time series,
    which Financier_History does not carry directly) instead of only the
    end-of-horizon summary."""
    financier_names, wholesaler_policies, base_aprs = build_group_lists([policy])
    n = len(financier_names)

    frames = sim.run_simulation(
        days=DAYS,
        seed=REP_SEED,
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
        initial_wallet=REP_CAPITAL,
        initial_capital=REP_CAPITAL,
        disable_defaults=REP_SCENARIO["disable_defaults"],
        shock_profile_counts=REP_SCENARIO["shock_profile_counts"],
        medium_shock_range=REP_SCENARIO["medium_shock_range"],
        high_shock_range=REP_SCENARIO["high_shock_range"],
        non_iid_primary_share=NON_IID_PRIMARY_SHARE,
        non_iid_group_policies=(policy,),
    )
    history = frames["Financier_History"].copy()
    history["wholesaler_policy"] = policy

    loans = frames["Loans"].copy()
    loans["wholesaler_policy"] = policy
    return history, loans


# Uniform figure size for both plots, sized for a single full-width LaTeX
# figure (matches \resizebox{\textwidth}{!} table sizing already used
# elsewhere in the manuscript).
FIGSIZE = (6.5, 4.0)


def _plot_series(ax, policies: list[str], series_by_policy: dict[str, pd.Series]) -> None:
    """Shared plotting call so both figures use identical color/linestyle/
    marker per policy -- the whole point being that 'FedAvg' looks the same
    (same blue solid line) in every figure in the paper, not just within
    one."""
    for policy in policies:
        style = POLICY_STYLE[policy]
        series = series_by_policy[policy]
        ax.plot(
            series.index, series.values,
            label=POLICY_LABELS[policy],
            color=style["color"], linestyle=style["linestyle"], marker=style["marker"],
        )


def make_return_plot(all_history: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=FIGSIZE)
    series_by_policy = {}
    for policy in POLICIES:
        subset = all_history[all_history["wholesaler_policy"] == policy]
        daily_mean = subset.groupby("day")["capital_return_on_initial"].mean()
        series_by_policy[policy] = daily_mean.rolling(ROLLING_WINDOW, min_periods=1).mean()
    _plot_series(ax, POLICIES, series_by_policy)
    ax.set_xlabel("Day")
    ax.set_ylabel(f"Return on initial capital (%), {ROLLING_WINDOW}-day rolling mean")
    ax.legend(frameon=False)
    ax.grid(alpha=0.3)
    fig.savefig(OUTPUT_DIR / "convergence_return_on_initial.pdf")  # vector, for LaTeX \includegraphics
    fig.savefig(OUTPUT_DIR / "convergence_return_on_initial.png")  # raster, for quick preview
    plt.close(fig)


def make_spread_plot(all_history: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=FIGSIZE)
    series_by_policy = {}
    for policy in POLICIES:
        subset = all_history[all_history["wholesaler_policy"] == policy]
        daily_spread = subset.groupby("day")["risk_premium"].std()
        series_by_policy[policy] = daily_spread.rolling(ROLLING_WINDOW, min_periods=1).mean()
    _plot_series(ax, POLICIES, series_by_policy)
    ax.set_xlabel("Day")
    ax.set_ylabel(f"Cross-financier std of risk premium, {ROLLING_WINDOW}-day rolling mean")
    ax.legend(frameon=False)
    ax.grid(alpha=0.3)
    fig.savefig(OUTPUT_DIR / "convergence_risk_premium_spread.pdf")  # vector, for LaTeX \includegraphics
    fig.savefig(OUTPUT_DIR / "convergence_risk_premium_spread.png")  # raster, for quick preview
    plt.close(fig)


def make_return_plot_isolated_vs_federated(all_history: pd.DataFrame) -> None:
    """Same view as make_return_plot, but restricted to exactly Stage 3's
    comparison (Isolated RL vs. FedAvg-federated), matching the paper's
    actual Stage 3 result: no confirmed return advantage, so these two lines
    are expected to track closely rather than show a large, stable gap."""
    fig, ax = plt.subplots(figsize=FIGSIZE)
    series_by_policy = {}
    for policy in ISOLATED_VS_FEDERATED:
        subset = all_history[all_history["wholesaler_policy"] == policy]
        daily_mean = subset.groupby("day")["capital_return_on_initial"].mean()
        series_by_policy[policy] = daily_mean.rolling(ROLLING_WINDOW, min_periods=1).mean()
    _plot_series(ax, ISOLATED_VS_FEDERATED, series_by_policy)
    ax.set_xlabel("Day")
    ax.set_ylabel(f"Return on initial capital (%), {ROLLING_WINDOW}-day rolling mean")
    ax.legend(frameon=False)
    ax.grid(alpha=0.3)
    fig.savefig(OUTPUT_DIR / "convergence_isolated_vs_federated_return.pdf")
    fig.savefig(OUTPUT_DIR / "convergence_isolated_vs_federated_return.png")
    plt.close(fig)


def make_default_rate_plot_isolated_vs_federated(all_loans: pd.DataFrame) -> None:
    """Cumulative default rate over time for Isolated RL vs. FedAvg-federated
    -- this is the metric Stage 3 actually confirms as significant (unlike
    return on capital), so it is the more evidentially honest convergence
    diagram for this specific comparison. Computed directly from the
    per-loan Loans log (day of closure, principal, is_default), independent
    of any per-day field in Financier_History."""
    fig, ax = plt.subplots(figsize=FIGSIZE)
    series_by_policy = {}
    for policy in ISOLATED_VS_FEDERATED:
        subset = all_loans[all_loans["wholesaler_policy"] == policy].sort_values("day")
        default_amount = subset["amount"].where(subset["is_default"], 0.0)
        cum_default = default_amount.cumsum()
        cum_principal = subset["amount"].cumsum()
        cum_rate = (100.0 * cum_default / cum_principal.clip(lower=1.0))
        cum_rate.index = subset["day"].values
        # Collapse same-day repayments to the last value that day, then
        # forward-fill so the line is defined at every day in [0, DAYS].
        daily = cum_rate.groupby(level=0).last()
        daily = daily.reindex(range(0, DAYS + 1)).ffill().fillna(0.0)
        series_by_policy[policy] = daily
    _plot_series(ax, ISOLATED_VS_FEDERATED, series_by_policy)
    ax.set_xlabel("Day")
    ax.set_ylabel("Cumulative total default rate (%)")
    ax.legend(frameon=False)
    ax.grid(alpha=0.3)
    fig.savefig(OUTPUT_DIR / "convergence_isolated_vs_federated_default_rate.pdf")
    fig.savefig(OUTPUT_DIR / "convergence_isolated_vs_federated_default_rate.png")
    plt.close(fig)


if __name__ == "__main__":
    OUTPUT_DIR.mkdir(exist_ok=True)
    sim.build_financiers = _patched_build_financiers
    try:
        history_frames = []
        loans_frames = []
        for i, policy in enumerate(POLICIES, start=1):
            print(f"[{i}/{len(POLICIES)}] Running representative history capture for policy={policy} ...")
            history_df, loans_df = run_one_with_history(policy)
            history_frames.append(history_df)
            loans_frames.append(loans_df)
    finally:
        sim.build_financiers = _original_build_financiers

    all_history = pd.concat(history_frames, ignore_index=True)
    all_history.to_csv(OUTPUT_DIR / "convergence_raw_history.csv", index=False)
    print(f"Saved raw history: {OUTPUT_DIR / 'convergence_raw_history.csv'}")

    all_loans = pd.concat(loans_frames, ignore_index=True)
    all_loans.to_csv(OUTPUT_DIR / "convergence_raw_loans.csv", index=False)
    print(f"Saved raw loans log: {OUTPUT_DIR / 'convergence_raw_loans.csv'}")

    make_return_plot(all_history)
    print(f"Saved: {OUTPUT_DIR / 'convergence_return_on_initial.png'}")

    make_spread_plot(all_history)
    print(f"Saved: {OUTPUT_DIR / 'convergence_risk_premium_spread.png'}")

    make_return_plot_isolated_vs_federated(all_history)
    print(f"Saved: {OUTPUT_DIR / 'convergence_isolated_vs_federated_return.png'}")

    make_default_rate_plot_isolated_vs_federated(all_loans)
    print(f"Saved: {OUTPUT_DIR / 'convergence_isolated_vs_federated_default_rate.png'}")

    print("\nDone. Inspect the PNGs -- if SCAFFOLD's spread line in the second "
          "plot drops faster/lower than FedAvg's, that's direct mechanistic evidence "
          "for the drift-correction claim. If it doesn't, that's also worth knowing "
          "honestly before writing it into the manuscript. For the isolated-vs-federated "
          "pair specifically: the return plot is expected to show the two lines tracking "
          "closely (consistent with the paper's null return result), while the default-rate "
          "plot is the one that should show federated (FedAvg) settling below isolated RL "
          "(consistent with the paper's confirmed default-rate reduction). If either plot "
          "contradicts the paper's stated conclusion, report that honestly rather than "
          "omitting the plot.")
