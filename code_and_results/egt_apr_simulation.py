#!/usr/bin/env python
"""EGT-based APR determination simulation for loan financing."""

from __future__ import annotations

import argparse
import json
import math
import random
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Generator

import pandas as pd
import simpy


DEFAULT_APR_STRATEGIES = ["pure_rl", "pure_rl", "pure_rl", "pure_rl"]
DEFAULT_WHOLESALER_POLICIES = ["rl", "egt", "none"]
DEFAULT_FINANCIER_NAMES = [
    "Fin_RL_Wholesaler",
    "Fin_EGT_Wholesaler",
    "Fin_No_Wholesaler_ID",
]
VALID_APR_STRATEGIES = {
    "pure_rl",
    "fixed_6",
    "fixed_8",
    "fixed_10",
}
BORROWER_EGT_POLICIES = {
    "egt",
    "egt_replicator",
    "egt_linear_reinforcement",
    "egt_fermi",
    "egt_best_response",
    "egt_polynomial",
    "fl_egt",
    "local_egt",
}
VALID_WHOLESALER_POLICIES = {
    "rl",
    "fl_rl",
    "fl_rl_prox",
    "fl_rl_scaffold",
    "fl_rl_visitweighted",
    *BORROWER_EGT_POLICIES,
    "none",
}

# Wholesaler policies that select borrower risk premiums via the
# borrower_premium_q Q-table (as opposed to the borrower.score-based
# formula used by the EGT-family policies).
Q_LEARNING_WHOLESALER_POLICIES = {
    "rl",
    "fl_rl",
    "fl_rl_prox",
    "fl_rl_scaffold",
    "fl_rl_visitweighted",
}

# Federated (multi-financier) Q-learning policies specifically. These are
# the policies that participate in periodic Q-table aggregation.
FEDERATED_RL_WHOLESALER_POLICIES = {
    "fl_rl",
    "fl_rl_prox",
    "fl_rl_scaffold",
    "fl_rl_visitweighted",
}


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def logit(p: float) -> float:
    p = clamp(p, 1e-6, 1.0 - 1e-6)
    return math.log(p / (1.0 - p))


def bucket(value: float, cuts: tuple[float, ...]) -> int:
    for index, cut in enumerate(cuts):
        if value < cut:
            return index
    return len(cuts)


def parse_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def parse_float_csv(value: str) -> list[float]:
    return [float(item) for item in parse_csv(value)]


def parse_profile_counts(value: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in parse_csv(value):
        if ":" not in item:
            raise ValueError("Shock profile counts must use name:count entries.")
        profile, count_text = item.split(":", 1)
        profile = profile.strip()
        if profile not in {"none", "medium", "high"}:
            raise ValueError(f"Invalid shock profile: {profile}. Valid profiles: none, medium, high.")
        count = int(count_text.strip())
        if count < 0:
            raise ValueError("Shock profile counts cannot be negative.")
        counts[profile] = count
    return counts


def expand_shock_profiles(profile_counts: dict[str, int]) -> list[str]:
    profiles: list[str] = []
    for profile in ("none", "medium", "high"):
        profiles.extend([profile] * profile_counts.get(profile, 0))
    if not profiles:
        raise ValueError("At least one borrower shock profile is required.")
    return profiles


def parse_float_pair(value: str, label: str) -> tuple[float, float]:
    parts = parse_float_csv(value)
    if len(parts) != 2:
        raise ValueError(f"{label} must contain exactly two comma-separated numbers.")
    return parts[0], parts[1]


def scheduled_timeout_range(
    current_day: int,
    base_low: int,
    base_high: int,
    demand_schedule: list[tuple[int, float]] | None = None,
) -> tuple[int, int]:
    multiplier = 1.0
    if demand_schedule:
        for threshold_day, scheduled_multiplier in sorted(demand_schedule, key=lambda item: item[0]):
            if current_day >= threshold_day:
                multiplier = scheduled_multiplier
            else:
                break
    low = max(1, int(round(base_low * multiplier)))
    high = max(low, int(round(base_high * multiplier)))
    return low, high


def scheduled_value_range(
    current_day: int,
    base_range: tuple[float, float],
    schedule: list[tuple[int, tuple[float, float]]] | None = None,
) -> tuple[float, float]:
    current_range = base_range
    if schedule:
        for threshold_day, scheduled_range in sorted(schedule, key=lambda item: item[0]):
            if current_day >= threshold_day:
                current_range = scheduled_range
            else:
                break
    low, high = current_range
    if high < low:
        low, high = high, low
    return float(low), float(high)


def validate_strategy_list(kind: str, values: list[str], valid_values: set[str]) -> None:
    invalid_values = sorted(
        value
        for value in set(values)
        if value not in valid_values
    )
    if invalid_values:
        valid_display = ", ".join(sorted(valid_values))
        invalid_display = ", ".join(invalid_values)
        raise ValueError(f"Invalid {kind}: {invalid_display}. Valid values: {valid_display}")


def expand_or_validate(values: list[Any], count: int, label: str) -> list[Any]:
    if len(values) == 1 and count > 1:
        return values * count
    if len(values) != count:
        raise ValueError(f"{label} must contain either 1 value or {count} comma-separated values.")
    return values


def default_financier_name(apr_strategy: str, wholesaler_policy: str, index: int) -> str:
    return f"Fin_{index}_{apr_strategy}_apr_{wholesaler_policy}_wholesaler"


def safe_annualized_roi_pct(profit: float, principal: float, duration: int) -> float:
    if principal <= 0:
        return 0.0
    gross_return = 1.0 + profit / principal
    if gross_return <= 0:
        return -100.0
    exponent = 365.0 / max(1, duration)
    log_value = math.log(gross_return) * exponent
    if log_value > 700:
        return float("inf")
    return (math.exp(log_value) - 1.0) * 100.0


def state_key(state: tuple[int, ...]) -> str:
    return "|".join(str(part) for part in state)


def parse_state_key(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split("|"))


@dataclass
class Financier:
    name: str
    wallet: float
    capital: float
    initial_capital: float
    prev_capital: float
    prev_utilization: float=0
    previous_raw_return: float=0
    prev_net_profit: float = 0.0
    base_apr: float = 30.0
    apr_strategy: str = "rl"
    wholesaler_policy: str = "rl"
    penalty_pct: float = 3.0
    min_apr: float = 6.0
    max_apr: float = 36.0
    min_offer_apr: float = 6.0
    max_offer_apr: float = 36.0
    target_utilization: float = 0.70
    utilization_quadratic_weight: float = 12.0
    cash_pressure_weight: float = 10.0
    target_return_on_capital: float = 0.0
    apr_learning_weight: float = 300.0
    max_apr_step: float = 2.0
    egt_alpha: float = 0.3
    egt_eta: float = 200.0
    score: float = 0.5
    pi_bar: float = 0.0
    prev_payoff: float = 0.0
    latest_apr_rl_reward: float = 0.0
    prev_capital_for_reward: float = 0.0
    prev_loan_count_for_reward: int = 0
    utilization: float = 0.0
    last_offered_apr: float = 0.0
    last_risk_premium: float = 0.0
    last_borrower_score: float = 0.5
    last_score_apr_adjustment: float = 0.0
    loans: list["Loan"] = field(default_factory=list)
    history: list[dict[str, Any]] = field(default_factory=list)
    borrower_stats: dict[str, dict[str, float]] = field(default_factory=dict)
    pure_rl_apr_actions: tuple[float, ...] = (
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
    pure_rl_q: dict[tuple[int, ...], dict[float, float]] = field(default_factory=dict)
    last_pure_rl_state_action: tuple[tuple[int, ...], float] | None = None

    borrower_egt_state: dict[str, dict[str, float]] = field(
        default_factory=lambda: defaultdict(lambda: {"score": 0.5, "pi_bar": 0.0, "n": 0.0})
    )
    borrower_premium_actions: tuple[float, ...] = (-2.0, 0.0, 4.0, 8.0, 12.0, 16.0)
    borrower_premium_q: dict[tuple[int, ...], dict[float, float]] = field(default_factory=dict)
    borrower_current_risk_premium: dict[str, float] = field(default_factory=dict)
    borrower_min_risk_premium: float = -2.0
    borrower_max_risk_premium: float = 16.0
    borrower_premium_default_loss_weight: float = 1.0

    # --- Non-IID segmentation knob ---
    # When set, this financier only serves borrowers whose name is in this
    # set; borrowers outside it are screened out (see screen_borrower).
    # Used to give fl_rl-family financiers genuinely different local data
    # distributions so FedProx / SCAFFOLD have real client drift to correct.
    eligible_borrowers: frozenset[str] | None = None

    # --- FedProx (fl_rl_prox) state ---
    # mu controls how strongly local Q-updates are pulled back toward the
    # last aggregated global Q-table between federation rounds.
    fedprox_mu: float = 0.1
    borrower_premium_q_global_snapshot: dict[tuple[int, ...], dict[float, float]] = field(
        default_factory=dict
    )

    # --- SCAFFOLD (fl_rl_scaffold) state ---
    # Tabular adaptation of SCAFFOLD's control variates. c_local tracks this
    # financier's own drift; c_global is the group-average control variate,
    # broadcast by the aggregator alongside the averaged Q-table. This is an
    # adapted analogue for tabular TD updates, not a literal reproduction of
    # the SGD-based algorithm in Karimireddy et al. (2020).
    scaffold_c_lr: float = 0.5
    borrower_premium_c_local: dict[tuple[int, ...], dict[float, float]] = field(default_factory=dict)
    borrower_premium_c_global: dict[tuple[int, ...], dict[float, float]] = field(default_factory=dict)

    # --- Visit-weighted aggregation (fl_rl_visitweighted) state ---
    # Counts how many times this financier has personally updated each
    # (state, action) cell. Used only at aggregation time, as a per-cell
    # confidence weight: a financier with more local experience in a given
    # borrower-risk state carries more influence over the shared estimate
    # for that state. This is a tabular-specific signal with no direct
    # analogue in gradient-based FedAvg/FedProx/SCAFFOLD. The local TD
    # update itself is unchanged (identical to plain FedAvg's local step);
    # only the aggregation step (see aggregate_federated_rl_visitweighted)
    # differs.
    borrower_premium_visits: dict[tuple[int, ...], dict[float, int]] = field(default_factory=dict)

    apr_alpha: float = 0.25
    apr_gamma: float = 0.95
    apr_epsilon: float = 0.08
    apr_epsilon_min: float = 0.01
    apr_epsilon_decay: float = 0.85

    borrower_alpha: float = 0.10
    borrower_gamma: float = 0.70
    borrower_epsilon: float = 0.05
    borrower_epsilon_min: float = 0.01
    borrower_epsilon_decay: float = 0.85
    borrower_accepted_loan_reward: float = 0.0
    borrower_utilization_reward_weight: float = 0.0
    borrower_capital_growth_reward_weight: float = 0.0
    borrower_overpricing_penalty_weight: float = 0.0
    borrower_default_penalty: float = 1.0
    borrower_delay_penalty_weight: float = 0.25

    def quote_apr(self, borrower_score: float) -> float:
        """Return the base APR clamped to the allowed offered APR range."""
        return clamp(self.base_apr, self.min_offer_apr, self.max_offer_apr)

    def utilization_based_apr(self, utilization: float) -> float:
        utilization = clamp(utilization, 0.0, 1.0)

        apr = self.min_apr + (self.max_apr - self.min_apr) * (utilization**2)

        return clamp(apr, self.min_apr, self.max_apr)


    # =========================================================================
    # TABULAR Q-LEARNING IMPLEMENTATION
    # =========================================================================
    # Algorithm: Tabular Q-Learning (Off-policy TD control)
    # State Space: 2D Discrete (Utilization bucket, Payoff bucket) -> 9 states total
    # Action Space: Discrete relative offsets applied to `utilization_apr` baseline
    # Exploration: Epsilon-Greedy with exponential temporal decay
    # Initialization: Q-values initialized to 0.0 (slightly pessimistic/neutral)
    # Reward: Soft-normalized composite of Return, Utilization, Growth, Decline
    # =========================================================================
    def apr_rl_state(self, perf: dict[str, float], wallet_ratio: float) -> tuple[int, ...]:
        utilization_state = bucket(perf["utilization"], (0.333, 0.667))
        return (utilization_state,)


    def effective_apr_epsilon(self, current_day: int) -> float:
        years_elapsed = max(0.0, current_day / 365.0)
        return max(self.apr_epsilon_min, self.apr_epsilon * (self.apr_epsilon_decay**years_elapsed))


    def pure_rl_actions(self) -> dict[float, float]:
        return {
            apr: 0.0
            for apr in self.pure_rl_apr_actions
        }

    def choose_pure_rl_apr(
        self,
        state: tuple[int, ...],
        current_day: int,
        allowed_actions: set[float] | None = None,
    ) -> float:
        actions = self.pure_rl_q.setdefault(state, self.pure_rl_actions())
        candidate_actions = [
            action
            for action in actions
            if allowed_actions is None or action in allowed_actions
        ]
        if not candidate_actions:
            candidate_actions = list(actions)
        if random.random() < self.effective_apr_epsilon(current_day):
            return random.choice(candidate_actions)
        best_value = max(actions[action] for action in candidate_actions)
        best_actions = [action for action in candidate_actions if actions[action] == best_value]
        return min(best_actions)

    def update_pure_rl_q_value(self, state: tuple[int, ...] | None, action: float | None, reward: float) -> None:
        if state is None or action is None:
            return
        self.latest_apr_rl_reward = reward
        actions = self.pure_rl_q.setdefault(state, self.pure_rl_actions())
        if action not in actions:
            actions[action] = 0.0
        old_q = actions[action]
        actions[action] = old_q + self.apr_alpha * (reward - old_q)

    def normalize_loan_reward(self, reward_amount: float, principal: float) -> float:
        raw_reward = reward_amount / max(1.0, principal)
        return clamp(raw_reward / (1.0 + abs(raw_reward)), -1.0, 1.0)

    def borrower_premium_rl_actions(self) -> dict[float, float]:
        return {premium: 0.0 for premium in self.borrower_premium_actions}

    def effective_borrower_epsilon(self, borrower: "Borrower") -> float:
        stats = self.borrower_stats.get(borrower.name, {})
        closed_loans = stats.get("closed", 0.0)
        return max(self.borrower_epsilon_min, self.borrower_epsilon * (self.borrower_epsilon_decay ** (closed_loans / 10.0)))

    def borrower_rl_state(self, borrower: "Borrower") -> tuple[int, ...]:
        stats = self.borrower_stats.get(borrower.name)
        if not stats or stats["closed"] == 0:
            return (2,)
        net_profit_ratio = stats.get("ewma_profit_ratio", 0.0)
        return (bucket(net_profit_ratio, (-0.20, -0.05, 0.0, 0.05, 0.15)),)

    def choose_borrower_risk_premium(self, borrower: "Borrower") -> tuple[float, float, tuple[int, ...]]:
        state = self.borrower_rl_state(borrower)
        actions = self.borrower_premium_q.setdefault(state, self.borrower_premium_rl_actions())
        candidate_actions = list(actions)
        if random.random() < self.effective_borrower_epsilon(borrower):
            premium_action = random.choice(candidate_actions)
        else:
            best_value = max(actions[action] for action in candidate_actions)
            best_actions = [action for action in candidate_actions if actions[action] == best_value]
            premium_action = random.choice(best_actions)
        risk_premium = clamp(
            premium_action,
            self.borrower_min_risk_premium,
            self.borrower_max_risk_premium,
        )
        self.borrower_current_risk_premium[borrower.name] = risk_premium
        return risk_premium, premium_action, state

    def export_q_tables(self) -> dict[str, Any]:
        return {
            "financier": self.name,
            "apr_strategy": self.apr_strategy,
            "pure_rl_q": {
                state_key(state): {f"{action:g}": value for action, value in actions.items()}
                for state, actions in self.pure_rl_q.items()
            },

            "borrower_premium_q": {
                state_key(state): {f"{action:g}": value for action, value in actions.items()}
                for state, actions in self.borrower_premium_q.items()
            },
            "borrower_egt_state": {
                borrower_name: {
                    "score": state["score"],
                    "pi_bar": state["pi_bar"],
                    "n": state["n"]
                }
                for borrower_name, state in self.borrower_egt_state.items()
            }
        }

    def import_q_tables(self, data: dict[str, Any]) -> None:
        pure_rl_q = data.get("pure_rl_q", {})

        borrower_premium_q = data.get("borrower_premium_q", {})
        self.pure_rl_q = {
            parse_state_key(state): {float(action): float(value) for action, value in actions.items()}
            for state, actions in pure_rl_q.items()
        }

        self.borrower_premium_q = {
            parse_state_key(state): {float(action): float(value) for action, value in actions.items()}
            for state, actions in borrower_premium_q.items()
        }

        borrower_egt_state = data.get("borrower_egt_state", {})
        for borrower_name, state in borrower_egt_state.items():
            self.borrower_egt_state[borrower_name] = {
                "score": float(state["score"]),
                "pi_bar": float(state["pi_bar"]),
                "n": float(state["n"])
            }


    def record_borrower_request(self, borrower: "Borrower", approved: bool) -> None:
        stats = self.borrower_stats.setdefault(
            borrower.name,
            {
                "requests": 0.0,
                "approved": 0.0,
                "closed": 0.0,
                "defaults": 0.0,
                "profit": 0.0,
                "principal": 0.0,
                "default_amount": 0.0,
                "avg_delay_ratio": 0.0,
            },
        )
        stats["requests"] += 1.0
        if approved:
            stats["approved"] += 1.0

    def borrower_strategy_score(self, borrower: "Borrower") -> float:
        return borrower.score

    def estimate_borrower_score(self, borrower: "Borrower") -> tuple[float, str]:
        if self.wholesaler_policy == "none":
            return 0.5, "No borrower screening"
        if self.wholesaler_policy in Q_LEARNING_WHOLESALER_POLICIES:
            return self.borrower_strategy_score(borrower), f"{self.wholesaler_policy.upper()} borrower score"
        if self.wholesaler_policy in ("fl_egt", "local_egt"):
            local_score = self.borrower_egt_state[borrower.name]["score"]
            return local_score, f"Local {self.wholesaler_policy} borrower score"
        if self.wholesaler_policy in BORROWER_EGT_POLICIES:
            return self.borrower_strategy_score(borrower), f"{self.wholesaler_policy} borrower score"
        return 0.5, "Neutral borrower score"

    def screen_borrower(self, borrower: "Borrower", requested_amount: float) -> dict[str, Any]:
        if self.eligible_borrowers is not None and borrower.name not in self.eligible_borrowers:
            # Non-IID segmentation knob: this financier does not serve this
            # borrower's segment, so it is excluded from the auction for
            # this borrower (same effect as a screening rejection).
            return {
                "score": 0.5,
                "risk_premium": 0.0,
                "reject": True,
                "reason": "OUT_OF_SEGMENT",
                "borrower_rl_state": None,
                "borrower_rl_action": None,
                "borrower_risk_premium_step": None,
            }

        score, reason = self.estimate_borrower_score(borrower)
        borrower_rl_state = None
        borrower_rl_action = None
        borrower_risk_premium_step = None
        if self.wholesaler_policy == "none":
            risk_premium = 0.0
        elif self.wholesaler_policy in Q_LEARNING_WHOLESALER_POLICIES:
            # NOTE: previously this branch only matched wholesaler_policy ==
            # "rl", so "fl_rl" (and the fl_rl_prox / fl_rl_scaffold variants
            # added alongside it) silently fell through to the score-based
            # formula below and never touched borrower_premium_q. That made
            # the federated Q-table aggregation a no-op (it was averaging an
            # empty table). Fixed so all Q-learning policies actually learn.
            risk_premium, borrower_risk_premium_step, borrower_rl_state = (
                self.choose_borrower_risk_premium(borrower)
            )
            borrower_rl_action = borrower_risk_premium_step
        else:
            risk_premium = clamp(
                (0.5 - score) * 32.0,
                self.borrower_min_risk_premium,
                self.borrower_max_risk_premium,
            )
        reject = False
        if requested_amount > self.wallet:
            reject = True
            reason = "Capital shortage"
        return {
            "score": score,
            "risk_premium": risk_premium,
            "reject": reject,
            "reason": reason if reject else f"{reason}; accepted",
            "borrower_rl_state": borrower_rl_state,
            "borrower_rl_action": borrower_rl_action,
            "borrower_risk_premium_step": borrower_risk_premium_step,
        }

    def quote_apr_for_borrower(self, borrower: "Borrower", requested_amount: float) -> tuple[float, dict[str, Any]]:
        screen = self.screen_borrower(borrower, requested_amount)
        strategy_score = self.borrower_strategy_score(borrower)
        offered_apr = clamp(
            self.base_apr + screen["risk_premium"],
            self.min_offer_apr,
            self.max_offer_apr,
        )
        self.last_offered_apr = offered_apr
        self.last_risk_premium = screen["risk_premium"]
        self.last_borrower_score = strategy_score
        self.last_score_apr_adjustment = 0.0
        return offered_apr, screen

    def issue_loan(self, borrower: "Borrower", request: dict[str, Any], start_day: int) -> "Loan":
        principal = float(request["principal"])
        if self.wallet < principal:
            raise ValueError(f"{self.name} does not have enough funds.")
        offered_apr = float(request.get("offered_apr", self.quote_apr(borrower.score)))
        apr_rl_state_at_issue = None
        apr_rl_action_at_issue = None
        projected_interest_at_issue = 0.0
        projected_apr_rl_reward = 0.0
        if self.apr_strategy == "pure_rl":
            if self.last_pure_rl_state_action is not None:
                apr_rl_state_at_issue, apr_rl_action_at_issue = self.last_pure_rl_state_action
            tenor_days = int(request["tenorDays"])
            projected_interest_at_issue = principal * (offered_apr / 100.0) * (tenor_days / 365.0)
            projected_apr_rl_reward = self.normalize_loan_reward(projected_interest_at_issue, principal)
            self.latest_apr_rl_reward = projected_apr_rl_reward
            self.update_pure_rl_q_value(
                apr_rl_state_at_issue,
                apr_rl_action_at_issue,
                projected_apr_rl_reward,
            )

        loan = Loan(
            borrower=borrower,
            financier=self,
            principal=principal,
            apr=offered_apr,
            base_apr_at_issue=self.base_apr,
            borrower_score_at_issue=borrower.score,
            tenor_days=int(request["tenorDays"]),
            penalty_pct=self.penalty_pct,
            start_day=start_day,
            request_id=request["request_id"],
            borrower_rl_state=request.get("borrower_rl_state"),
            borrower_rl_action=request.get("borrower_rl_action"),
            borrower_risk_premium_step=request.get("borrower_risk_premium_step"),
            apr_rl_state_at_issue=apr_rl_state_at_issue,
            apr_rl_action_at_issue=apr_rl_action_at_issue,
            projected_interest_at_issue=projected_interest_at_issue,
            opportunity_loss_at_issue=0.0,
            projected_apr_rl_reward=projected_apr_rl_reward,
        )

        self.wallet -= principal
        borrower.wallet += principal
        self.loans.append(loan)
        borrower.loans.append(loan)
        return loan

    def compute_portfolio_performance(self, current_day: int, window: int = 30) -> dict[str, float]:
        window_start = current_day - window
        closed_loans = [
            loan for loan in self.loans
            if loan.closed and loan.closed_day is not None and loan.closed_day >= window_start
        ]

        earned_interest = sum(loan.total_interest_paid for loan in closed_loans)
        earned_penalty = sum(loan.total_penalty_paid for loan in closed_loans)
        earned = earned_interest + earned_penalty
        default_loss = sum(
            max(0.0, loan.principal - loan.total_principal_paid)
            for loan in closed_loans if loan.is_default
        )
        total_principal_all = sum(loan.principal for loan in closed_loans)
        net_profit = earned - default_loss
        profit_pct = net_profit / max(1.0, total_principal_all)

        previous_capital = getattr(self, "prev_capital", self.initial_capital)
        total_earned_all = sum(
            loan.total_interest_paid + loan.total_penalty_paid
            for loan in self.loans
        )
        total_default_all = sum(
            max(0.0, loan.principal - loan.total_principal_paid)
            for loan in self.loans if loan.closed and loan.is_default
        )
        self.capital = self.initial_capital + total_earned_all - total_default_all
        capital_delta = self.capital - previous_capital
        capital_growth_reward = capital_delta / max(1.0, previous_capital)
        capital_return_on_initial = (
            (self.capital - self.initial_capital) / self.initial_capital
            if self.initial_capital
            else 0.0
        )
        capital_decline_penalty = max(0.0, -capital_return_on_initial)
        self.prev_capital = self.capital

        deployed = sum(loan.outstanding_principal for loan in self.loans if not loan.closed)
        previous_util = getattr(self, "prev_utilization", 0.0)
        self.utilization = deployed / max(1.0, self.capital)
        utilization_delta = self.utilization - previous_util
        self.prev_utilization = self.utilization

        idle_capital = max(0.0, self.capital - deployed)
        idle_opportunity_loss = idle_capital * (self.base_apr / 100.0)
        economic_profit = net_profit - idle_opportunity_loss
        previous_raw_return = getattr(self, "previous_raw_return", 0.0)
        raw_return = economic_profit / max(1.0, self.capital)
        raw_return_delta = raw_return - previous_raw_return
        self.previous_raw_return = raw_return

        return {
            "earned": earned,
            "default_loss": default_loss,
            "net_profit": net_profit,
            "profit_pct": profit_pct,
            "capital": self.capital,
            "capital_delta": capital_delta,
            "capital_growth_reward": capital_growth_reward,
            "capital_return_on_initial": capital_return_on_initial,
            "capital_decline_penalty": capital_decline_penalty,
            "utilization": self.utilization,
            "utilization_delta": utilization_delta,
            "deployed": deployed,
            "idle_capital": idle_capital,
            "idle_opportunity_loss": idle_opportunity_loss,
            "economic_profit": economic_profit,
            "raw_return_on_capital": raw_return,
            "raw_return_delta": raw_return_delta,
        }

    def update_apr(self, current_day: int) -> dict[str, float]:
        perf = self.compute_portfolio_performance(current_day)
        raw_payoff = clamp(self.latest_apr_rl_reward, -1.0, 1.0)
        payoff = clamp(0.7 * self.prev_payoff + 0.3 * raw_payoff, -1.0, 1.0)
        self.prev_payoff = payoff
        perf["payoff"] = payoff
        self.pi_bar = (1.0 - self.egt_alpha) * self.pi_bar + self.egt_alpha * payoff
        payoff_gap = payoff - self.pi_bar
        wallet_ratio = self.wallet / max(1.0, self.capital)
        old_apr = self.base_apr

        if self.apr_strategy == "pure_rl":
            state = self.apr_rl_state(perf, wallet_ratio)
            rl_state = str(state)
            action = self.choose_pure_rl_apr(state, current_day)
            self.last_pure_rl_state_action = (state, action)
            rl_apr_action = action
            self.base_apr = clamp(action, self.min_apr, self.max_apr)
        elif self.apr_strategy.startswith("fixed_"):
            rl_state = None
            rl_apr_action = None
            fixed_apr = float(self.apr_strategy.split("_")[1])
            self.base_apr = clamp(fixed_apr, self.min_offer_apr, self.max_offer_apr)
        else:
            rl_state = None
            rl_apr_action = None
            self.base_apr = clamp(old_apr, self.min_apr, self.max_apr)

        self.history.append(
            {
                "day": current_day,
                "financier": self.name,
                "payoff": payoff,
                "pi_bar": self.pi_bar,
                "payoff_gap": payoff_gap,
                "utilization": self.utilization,
                "apr": old_apr,
                "old_apr": old_apr,
                "new_apr": self.base_apr,
                "offered_apr": self.last_offered_apr,
                "risk_premium": self.last_risk_premium,
                "borrower_score": self.last_borrower_score,
                "score_apr_adjustment": self.last_score_apr_adjustment,
                "egt_pressure": 0.0,
                "rl_state": rl_state,
                "rl_apr_action": rl_apr_action,
                "capital_return_on_initial": perf["capital_return_on_initial"],
                "capital_decline_penalty": perf["capital_decline_penalty"],
                "latest_apr_rl_reward": self.latest_apr_rl_reward,
                "effective_apr_epsilon": self.effective_apr_epsilon(current_day),
                "target_utilization": self.target_utilization,
                "wallet_ratio": wallet_ratio,
                "apr_strategy": self.apr_strategy,
                "wholesaler_policy": self.wholesaler_policy,
                "net_profit": perf["net_profit"],
                "idle_opportunity_loss": perf["idle_opportunity_loss"],
                "economic_profit": perf["economic_profit"],
                "raw_return_on_capital": perf["raw_return_on_capital"],
            }
        )
        return perf

    def update_borrower_learning(
        self,
        loan: "Loan",
        summary: dict[str, Any],
        borrower_egt_alpha: float = 0.3,
        borrower_egt_eta: float = 200.0,
    ) -> None:
        stats = self.borrower_stats.setdefault(
            loan.borrower.name,
            {
                "requests": 0.0,
                "approved": 0.0,
                "closed": 0.0,
                "defaults": 0.0,
                "profit": 0.0,
                "principal": 0.0,
                "default_amount": 0.0,
                "avg_delay_ratio": 0.0,
                "ewma_profit_ratio": 0.0,
            },
        )
        stats["closed"] += 1.0
        stats["defaults"] += 1.0 if summary["is_default"] else 0.0
        stats["profit"] += summary["fin_profit"]
        stats["principal"] += summary["principal"]
        stats["default_amount"] += max(0.0, summary["principal"] - summary["principal_paid"])
        delay_ratio = max(0, (loan.closed_day or loan.due_day()) - loan.due_day()) / max(1, loan.tenor_days)
        stats["avg_delay_ratio"] = (
            (stats["avg_delay_ratio"] * (stats["closed"] - 1.0)) + delay_ratio
        ) / max(1.0, stats["closed"])
        
        loan_profit_pct = summary["fin_profit_pct"]
        if stats["closed"] <= 1.0:
            stats["ewma_profit_ratio"] = loan_profit_pct
        else:
            stats["ewma_profit_ratio"] = 0.8 * stats["ewma_profit_ratio"] + 0.2 * loan_profit_pct

        if self.wholesaler_policy in ("fl_egt", "local_egt"):
            state = self.borrower_egt_state[loan.borrower.name]
            borrower_loan_payoff = summary["borrower_profit_pct"]
            state["pi_bar"] = (1.0 - borrower_egt_alpha) * state["pi_bar"] + borrower_egt_alpha * borrower_loan_payoff
            payoff_gap = borrower_loan_payoff - state["pi_bar"]
            z = logit(state["score"]) + borrower_egt_eta * 4.0 * payoff_gap
            state["score"] = clamp(1.0 / (1.0 + math.exp(-z)), 0.0, 1.0)
            state["n"] += 1.0

        if self.wholesaler_policy in Q_LEARNING_WHOLESALER_POLICIES and loan.borrower_rl_state is not None and loan.borrower_rl_action is not None:
            premium_actions = self.borrower_premium_q.setdefault(
                loan.borrower_rl_state,
                self.borrower_premium_rl_actions(),
            )
            next_state = self.borrower_rl_state(loan.borrower)
            next_best = max(
                self.borrower_premium_q.setdefault(
                    next_state,
                    self.borrower_premium_rl_actions(),
                ).values()
            )
            old_q = premium_actions[loan.borrower_rl_action]
            visit_counts = self.borrower_premium_visits.setdefault(loan.borrower_rl_state, {})
            visit_counts[loan.borrower_rl_action] = visit_counts.get(loan.borrower_rl_action, 0) + 1
            premium_reward = summary["fin_profit_pct"]
            if summary["is_default"]:
                default_ratio = max(0.0, summary["principal"] - summary["principal_paid"]) / max(1.0, summary["principal"])
                premium_reward -= (0.05 * default_ratio)
            premium_reward = clamp(premium_reward, -1.0, 1.0)
            td_error = premium_reward + self.borrower_gamma * next_best - old_q

            if self.wholesaler_policy == "fl_rl_prox":
                # FedProx: pull the local update back toward the last
                # aggregated global Q-value for this (state, action) cell.
                global_actions = self.borrower_premium_q_global_snapshot.get(loan.borrower_rl_state, {})
                global_q = global_actions.get(loan.borrower_rl_action, old_q)
                proximal_term = self.fedprox_mu * (old_q - global_q)
                new_q = old_q + self.borrower_alpha * td_error - self.borrower_alpha * proximal_term
            elif self.wholesaler_policy == "fl_rl_scaffold":
                # SCAFFOLD (tabular analogue): correct the local TD update
                # using the gap between the group control variate and this
                # financier's own control variate for the cell.
                c_global = self.borrower_premium_c_global.get(loan.borrower_rl_state, {}).get(
                    loan.borrower_rl_action, 0.0
                )
                c_local = self.borrower_premium_c_local.get(loan.borrower_rl_state, {}).get(
                    loan.borrower_rl_action, 0.0
                )
                new_q = old_q + self.borrower_alpha * (td_error + (c_global - c_local))
            else:
                new_q = old_q + self.borrower_alpha * td_error

            premium_actions[loan.borrower_rl_action] = new_q


@dataclass
class Borrower:
    name: str
    wallet: float
    margin: float = 0.20
    shock_profile: str = "medium"
    medium_shock_range: tuple[float, float] = (-0.02, -0.08)
    high_shock_range: tuple[float, float] = (-0.09, -0.20)
    score: float = 0.5
    pi_bar: float = 0.0
    n: int = 0
    loans: list["Loan"] = field(default_factory=list)
    history: list[dict[str, Any]] = field(default_factory=list)

    def request_loan(
        self,
        lot_amount: float,
        default_days: int,
        financier: Financier,
        offered_apr: float,
    ) -> dict[str, Any]:
        return {
            "request_id": str(uuid.uuid4()),
            "borrower": self.name,
            "principal": float(lot_amount),
            "tenorDays": int(default_days),
            "financier_id": financier.name,
            "financier": financier,
            "offered_apr": float(offered_apr),
        }

    @property
    def shock_probability(self) -> float:
        return {"none": 0.0, "medium": 1.0, "high": 1.0}[self.shock_profile]

    @property
    def shock_multiplier_range(self) -> tuple[float, float]:
        return {
            "none": (0.0, 0.0),
            "medium": self.medium_shock_range,
            "high": self.high_shock_range,
        }[self.shock_profile]

    def decide_accept_loan(self, tenor: int, lot_amount: float, offered_apr: float) -> tuple[bool, str, float]:
        interest = offered_apr * lot_amount / 100.0 * tenor / 365.0
        gross_profit = self.margin * lot_amount
        net_profit = gross_profit - interest
        profit_ratio = net_profit / lot_amount if lot_amount > 0 else 0.0

        score_adjusted_threshold = 0.08 - 0.06 * self.score
        if net_profit <= 0:
            return False, "Negative net profit", profit_ratio
        if profit_ratio <= score_adjusted_threshold:
            return False, "Below score-adjusted threshold", profit_ratio
        return True, "Profitable", profit_ratio

    def compute_portfolio_performance(self) -> dict[str, float]:
        closed_loans = [loan for loan in self.loans if loan.closed]
        if not closed_loans:
            return {
                "gross_profit": 0.0,
                "finance_cost": 0.0,
                "default_amount": 0.0,
                "default_rate": 0.0,
                "avg_delay_ratio": 0.0,
                "net_profit": 0.0,
                "profit_pct": 0.0,
                "payoff": 0.0,
            }

        total_principal = sum(loan.principal for loan in closed_loans)
        interest_paid = sum(loan.total_interest_paid for loan in closed_loans)
        penalty_paid = sum(loan.total_penalty_paid for loan in closed_loans)
        financier_profit = interest_paid + penalty_paid
        default_amount = sum(
            max(0.0, loan.principal - loan.total_principal_paid)
            for loan in closed_loans
            if loan.is_default
        )
        default_rate = default_amount / total_principal if total_principal > 0 else 0.0
        avg_delay_ratio = sum(
            max(0, (loan.closed_day or loan.due_day()) - loan.due_day()) / max(1, loan.tenor_days)
            for loan in closed_loans
        ) / len(closed_loans)

        net_profit = financier_profit - default_amount
        profit_pct = net_profit / total_principal if total_principal > 0 else 0.0
        payoff = clamp(profit_pct, -1.0, 1.0)

        return {
            "gross_profit": financier_profit,
            "finance_cost": 0.0,
            "interest_paid": interest_paid,
            "penalty_paid": penalty_paid,
            "default_amount": default_amount,
            "default_rate": default_rate,
            "avg_delay_ratio": avg_delay_ratio,
            "net_profit": net_profit,
            "profit_pct": profit_pct,
            "payoff": payoff,
        }

    def update_egt(
        self,
        payoff: float,
        current_day: int,
        alpha: float = 0.3,
        eta: float = 200.0,
        model: str = "egt",
    ) -> float:
        self.pi_bar = (1.0 - alpha) * self.pi_bar + alpha * payoff
        payoff_gap = payoff - self.pi_bar
        if model in {"egt", "egt_single", "fl_egt", "local_egt"}:
            z = logit(self.score) + eta * payoff_gap
            self.score = clamp(1.0 / (1.0 + math.exp(-z)), 0.0, 1.0)
        elif model == "egt_replicator":
            self.score = clamp(
                self.score + eta * self.score * (1.0 - self.score) * payoff_gap,
                0.0,
                1.0,
            )
        elif model == "egt_linear_reinforcement":
            target = clamp(payoff, 0.0, 1.0)
            self.score = clamp(self.score + eta * (target - self.score), 0.0, 1.0)
        elif model == "egt_fermi":
            imitation_prob = 1.0 / (1.0 + math.exp(-eta * payoff_gap))
            self.score = clamp(self.score + alpha * (imitation_prob - self.score), 0.0, 1.0)
        elif model == "egt_best_response":
            step = eta * (1.0 if payoff_gap > 0.0 else -1.0 if payoff_gap < 0.0 else 0.0)
            self.score = clamp(self.score + step, 0.0, 1.0)
        elif model == "egt_polynomial":
            self.score = clamp(
                self.score + eta * payoff_gap * self.score * (1.0 - self.score),
                0.0,
                1.0,
            )
        else:
            z = logit(self.score) + eta * payoff_gap
            self.score = clamp(1.0 / (1.0 + math.exp(-z)), 0.0, 1.0)
        self.n += 1
        self.history.append(
            {
                "day": current_day,
                "borrower": self.name,
                "score": self.score,
                "payoff": payoff,
                "pi_bar": self.pi_bar,
                "payoff_gap": payoff_gap,
                "egt_model": model,
            }
        )
        return self.score


@dataclass
class Loan:
    borrower: Borrower
    financier: Financier
    principal: float
    apr: float
    base_apr_at_issue: float
    borrower_score_at_issue: float
    tenor_days: int
    penalty_pct: float
    start_day: int
    request_id: str
    borrower_rl_state: tuple[int, ...] | None = None
    borrower_rl_action: float | None = None
    borrower_risk_premium_step: float | None = None
    apr_rl_state_at_issue: tuple[int, ...] | None = None
    apr_rl_action_at_issue: float | None = None
    projected_interest_at_issue: float = 0.0
    opportunity_loss_at_issue: float = 0.0
    projected_apr_rl_reward: float = 0.0
    realized_apr_rl_reward: float = 0.0
    outstanding_principal: float = field(init=False)
    total_interest_paid: float = 0.0
    total_penalty_paid: float = 0.0
    total_principal_paid: float = 0.0
    total_paid: float = 0.0
    realized_margin: float = 0.0
    accrued_interest_due: float = 0.0
    accrued_penalty_due: float = 0.0
    last_accrual_day: int = field(init=False)
    payment_count: int = 0
    scheduled_daily_payment: float = 0.0
    closed: bool = False
    closed_day: int | None = None
    is_default: bool = False

    def __post_init__(self) -> None:
        self.outstanding_principal = self.principal
        self.realized_margin = self.borrower.margin
        self.last_accrual_day = self.start_day

    @property
    def borrower_score_apr_adjustment(self) -> float:
        return self.apr - self.base_apr_at_issue

    def due_day(self) -> int:
        return self.start_day + self.tenor_days

    def accrue_to_day(self, day: int) -> None:
        if day <= self.last_accrual_day or self.outstanding_principal <= 0:
            self.last_accrual_day = max(self.last_accrual_day, day)
            return

        regular_days = max(0, min(day, self.due_day()) - self.last_accrual_day)
        overdue_days = max(0, day - max(self.last_accrual_day, self.due_day()))
        self.accrued_interest_due += self.outstanding_principal * (self.apr / 100.0) * (regular_days / 365.0)
        self.accrued_penalty_due += self.outstanding_principal * (self.penalty_pct / 100.0) * (overdue_days / 365.0)
        self.last_accrual_day = day

    def apply_partial_payment(self, day: int, amount: float, realized_margin: float) -> None:
        if self.closed or amount <= 0:
            return

        self.realized_margin = realized_margin
        self.accrue_to_day(day)
        remaining = amount

        interest_paid = min(remaining, self.accrued_interest_due)
        self.accrued_interest_due -= interest_paid
        self.total_interest_paid += interest_paid
        remaining -= interest_paid

        penalty_paid = min(remaining, self.accrued_penalty_due)
        self.accrued_penalty_due -= penalty_paid
        self.total_penalty_paid += penalty_paid
        remaining -= penalty_paid

        principal_paid = min(remaining, self.outstanding_principal)
        self.outstanding_principal -= principal_paid
        self.total_principal_paid += principal_paid
        remaining -= principal_paid

        paid = amount - remaining
        self.total_paid += paid
        self.payment_count += 1
        self.financier.wallet += paid
        self.financier.capital += interest_paid + penalty_paid

        if self.outstanding_principal <= 1e-6 and self.accrued_interest_due <= 1e-6 and self.accrued_penalty_due <= 1e-6:
            self.outstanding_principal = 0.0
            self.closed = True
            self.closed_day = day
            self.is_default = False

    def close_as_default(self, day: int) -> None:
        if self.closed:
            return
        self.accrue_to_day(day)
        self.closed = True
        self.closed_day = day
        self.is_default = self.outstanding_principal > 1e-6 or self.accrued_interest_due > 1e-6 or self.accrued_penalty_due > 1e-6

    def summary(self) -> dict[str, Any]:
        duration = max(1, (self.closed_day or self.start_day + 1) - self.start_day)
        principal_loss = max(0.0, self.principal - self.total_principal_paid)

        financier_profit = (
            self.total_interest_paid
            + self.total_penalty_paid
            - principal_loss
        )
        borrower_gross_profit = self.realized_margin * self.principal
        borrower_net_profit = borrower_gross_profit - financier_profit
        financier_roi_annual_pct = safe_annualized_roi_pct(financier_profit, self.principal, duration)

        return {
            "borrower": self.borrower.name,
            "financier": self.financier.name,
            "principal": self.principal,
            "duration_days": duration,
            "fin_profit": financier_profit,
            "fin_profit_pct": financier_profit / self.principal if self.principal > 0 else 0.0,
            "fin_roi_annual_pct": financier_roi_annual_pct,
            "borrower_gross_profit": borrower_gross_profit,
            "borrower_net_profit": borrower_net_profit,
            "borrower_profit_pct": borrower_net_profit / self.principal if self.principal > 0 else 0.0,
            "interest_paid": self.total_interest_paid,
            "penalty_paid": self.total_penalty_paid,
            "principal_paid": self.total_principal_paid,
            "outstanding_principal": self.outstanding_principal,
            "accrued_interest_due": self.accrued_interest_due,
            "accrued_penalty_due": self.accrued_penalty_due,
            "payment_count": self.payment_count,
            "scheduled_daily_payment": self.scheduled_daily_payment,
            "is_default": self.is_default,
            "loan_status": "DEFAULT" if self.is_default else "REPAID",
            "recovery_ratio": self.total_paid / self.principal if self.principal > 0 else 0.0,
        }


def borrower_process(
    env: simpy.Environment,
    borrower: Borrower,
    financiers: list[Financier],
    results: list[dict[str, Any]],
    loans_log: list[dict[str, Any]],
    request_until: int,
    borrower_egt_alpha: float = 0.3,
    borrower_egt_eta: float = 200.0,
    borrower_request_timeout_range: tuple[int, int] = (10, 20),
    borrower_demand_schedule: list[tuple[int, float]] | None = None,
    borrower_lot_amount_range: tuple[float, float] = (20_000.0, 50_000.0),
    borrower_lot_amount_schedule: list[tuple[int, tuple[float, float]]] | None = None,
    borrower_tenor_range: tuple[int, int] = (200, 300),
) -> Any:
    while True:
        timeout_low, timeout_high = scheduled_timeout_range(
            env.now,
            borrower_request_timeout_range[0],
            borrower_request_timeout_range[1],
            borrower_demand_schedule,
        )
        yield env.timeout(random.randint(timeout_low, timeout_high))
        if env.now >= request_until:
            break

        lot_low, lot_high = scheduled_value_range(
            env.now,
            borrower_lot_amount_range,
            borrower_lot_amount_schedule,
        )
        lot_amount = random.uniform(lot_low, lot_high)
        tenor_low, tenor_high = borrower_tenor_range
        tenor = random.randint(int(tenor_low), int(tenor_high))

        for financier in financiers:
            financier.update_apr(env.now)

        quotes = []
        for financier in financiers:
            offered_apr, screen = financier.quote_apr_for_borrower(borrower, lot_amount)
            quotes.append((financier, offered_apr, screen))

        eligible_quotes = [
            (financier, quoted_apr, screen)
            for financier, quoted_apr, screen in quotes
            if not screen["reject"]
        ]
        if not eligible_quotes:
            for financier, offered_apr, screen in quotes:
                financier.record_borrower_request(borrower, approved=False)
                perf = financier.compute_portfolio_performance(env.now)
                results.append(
                    {
                        "day": env.now,
                        "borrower": borrower.name,
                        "borrower_shock_profile": borrower.shock_profile,
                        "financier": financier.name,
                        "apr_strategy": financier.apr_strategy,
                        "wholesaler_policy": financier.wholesaler_policy,
                        "decision": "FINANCIER_REJECTED",
                        "amount": lot_amount,
                        "apr": offered_apr,
                        "base_apr": financier.base_apr,
                        "screen_score": screen["score"],
                        "risk_premium": screen["risk_premium"],
                        "borrower_score_apr_adjustment": offered_apr - financier.base_apr,
                        "tenor": tenor,
                        "payoff": financier.prev_payoff,
                        "net_profit": perf["net_profit"],
                        "idle_opportunity_loss": perf["idle_opportunity_loss"],
                        "economic_profit": perf["economic_profit"],
                        "raw_return_on_capital": perf["raw_return_on_capital"],
                        "utilization": perf["utilization"],
                        "fin_wallet": financier.wallet,
                        "fin_capital": financier.capital,
                        "wholesaler_score": financier.borrower_strategy_score(borrower),
                        "reason": screen["reason"],
                    }
                )
            continue

        best_apr = min(quoted_apr for _, quoted_apr, _ in eligible_quotes)
        candidates = [
            (financier, quoted_apr, screen)
            for financier, quoted_apr, screen in eligible_quotes
            if quoted_apr == best_apr
        ]
        financier, offered_apr, screen = random.choice(candidates)
        financier.record_borrower_request(borrower, approved=True)
        request = borrower.request_loan(
            lot_amount=lot_amount,
            default_days=tenor,
            financier=financier,
            offered_apr=offered_apr,
        )
        request["borrower_rl_state"] = screen.get("borrower_rl_state")
        request["borrower_rl_action"] = screen.get("borrower_rl_action")
        request["borrower_risk_premium_step"] = screen.get("borrower_risk_premium_step")

        if financier.wallet < lot_amount:
            perf = financier.compute_portfolio_performance(env.now)
            results.append(
                {
                    "day": env.now,
                    "borrower": borrower.name,
                    "borrower_shock_profile": borrower.shock_profile,
                    "financier": financier.name,
                    "apr_strategy": financier.apr_strategy,
                    "wholesaler_policy": financier.wholesaler_policy,
                    "decision": "FINANCIER_REJECTED",
                    "amount": lot_amount,
                    "apr": offered_apr,
                    "base_apr": financier.base_apr,
                    "screen_score": screen["score"],
                    "risk_premium": screen["risk_premium"],
                    "borrower_score_apr_adjustment": offered_apr - financier.base_apr,
                    "tenor": tenor,
                    "payoff": financier.prev_payoff,
                    "net_profit": perf["net_profit"],
                    "idle_opportunity_loss": perf["idle_opportunity_loss"],
                    "economic_profit": perf["economic_profit"],
                    "raw_return_on_capital": perf["raw_return_on_capital"],
                    "utilization": perf["utilization"],
                    "fin_wallet": financier.wallet,
                    "fin_capital": financier.capital,
                    "reason": "Capital shortage",
                }
            )
            continue

        accepted, reason, profit_ratio = borrower.decide_accept_loan(tenor, lot_amount, offered_apr)
        if not accepted:
            perf = financier.compute_portfolio_performance(env.now)
            results.append(
                {
                    "day": env.now,
                    "borrower": borrower.name,
                    "borrower_shock_profile": borrower.shock_profile,
                    "financier": financier.name,
                    "apr_strategy": financier.apr_strategy,
                    "wholesaler_policy": financier.wholesaler_policy,
                    "decision": "WHOLESALER_REJECTED",
                    "amount": lot_amount,
                    "apr": offered_apr,
                    "base_apr": financier.base_apr,
                    "screen_score": screen["score"],
                    "risk_premium": screen["risk_premium"],
                    "borrower_score_apr_adjustment": offered_apr - financier.base_apr,
                    "tenor": tenor,
                    "payoff": financier.prev_payoff,
                    "net_profit": perf["net_profit"],
                    "idle_opportunity_loss": perf["idle_opportunity_loss"],
                    "economic_profit": perf["economic_profit"],
                    "raw_return_on_capital": perf["raw_return_on_capital"],
                    "utilization": perf["utilization"],
                    "fin_wallet": financier.wallet,
                    "fin_capital": financier.capital,
                    "wholesaler_score": financier.borrower_strategy_score(borrower),
                    "expected_profit_ratio": profit_ratio,
                    "reason": reason,
                }
            )
            continue

        loan = financier.issue_loan(borrower=borrower, request=request, start_day=env.now)
        fin_perf = financier.update_apr(env.now)
        wh_perf = borrower.compute_portfolio_performance()
        borrower.update_egt(
            wh_perf["payoff"],
            env.now,
            alpha=borrower_egt_alpha,
            eta=borrower_egt_eta,
            model=financier.wholesaler_policy,
        )

        results.append(
            {
                "day": env.now,
                "borrower": borrower.name,
                "borrower_shock_profile": borrower.shock_profile,
                "financier": financier.name,
                "apr_strategy": financier.apr_strategy,
                "wholesaler_policy": financier.wholesaler_policy,
                "decision": "WHOLESALER_ACCEPTED",
                "amount": lot_amount,
                "apr": loan.apr,
                "base_apr": loan.base_apr_at_issue,
                "screen_score": screen["score"],
                "risk_premium": screen["risk_premium"],
                "borrower_rl_state": screen.get("borrower_rl_state"),
                "borrower_rl_action": screen.get("borrower_rl_action"),
                "borrower_risk_premium_step": screen.get("borrower_risk_premium_step"),
                "apr_rl_state_at_issue": loan.apr_rl_state_at_issue,
                "apr_rl_action_at_issue": loan.apr_rl_action_at_issue,
                "projected_interest_at_issue": loan.projected_interest_at_issue,
                "opportunity_loss_at_issue": loan.opportunity_loss_at_issue,
                "projected_apr_rl_reward": loan.projected_apr_rl_reward,
                "borrower_score_at_issue": loan.borrower_score_at_issue,
                "borrower_score_apr_adjustment": loan.borrower_score_apr_adjustment,
                "tenor": tenor,
                "payoff": fin_perf["payoff"],
                "net_profit": fin_perf["net_profit"],
                "idle_opportunity_loss": fin_perf["idle_opportunity_loss"],
                "economic_profit": fin_perf["economic_profit"],
                "raw_return_on_capital": fin_perf["raw_return_on_capital"],
                "utilization": fin_perf["utilization"],
                "fin_wallet": financier.wallet,
                "fin_capital": financier.capital,
                "financier_score": financier.score,
                "wholesaler_payoff": wh_perf["payoff"],
                "wholesaler_score": financier.borrower_strategy_score(borrower),
                "wholesaler_default_rate": wh_perf["default_rate"],
                "wholesaler_profit_pct": wh_perf["profit_pct"],
                "expected_profit_ratio": profit_ratio,
                "reason": reason,
            }
        )

        repay_delay = int(tenor * random.uniform(0.9, 1.02))
        env.process(repayment_process(env, loan, repay_delay, loans_log, borrower_egt_alpha, borrower_egt_eta))


def delayed_borrower_process(
    env: simpy.Environment,
    start_day: int,
    borrower: Borrower,
    financiers: list[Financier],
    results: list[dict[str, Any]],
    loans_log: list[dict[str, Any]],
    request_until: int,
    borrower_egt_alpha: float = 0.3,
    borrower_egt_eta: float = 200.0,
    borrower_request_timeout_range: tuple[int, int] = (10, 20),
    borrower_demand_schedule: list[tuple[int, float]] | None = None,
    borrower_lot_amount_range: tuple[float, float] = (20_000.0, 50_000.0),
    borrower_lot_amount_schedule: list[tuple[int, tuple[float, float]]] | None = None,
    borrower_tenor_range: tuple[int, int] = (200, 300),
) -> Any:
    if start_day > 0:
        yield env.timeout(start_day)
    if env.now >= request_until:
        return
    env.process(
        borrower_process(
            env,
            borrower,
            financiers,
            results,
            loans_log,
            request_until,
            borrower_egt_alpha=borrower_egt_alpha,
            borrower_egt_eta=borrower_egt_eta,
            borrower_request_timeout_range=borrower_request_timeout_range,
            borrower_demand_schedule=borrower_demand_schedule,
            borrower_lot_amount_range=borrower_lot_amount_range,
            borrower_lot_amount_schedule=borrower_lot_amount_schedule,
            borrower_tenor_range=borrower_tenor_range,
        )
    )


def repayment_process(
    env: simpy.Environment,
    loan: Loan,
    delay: int,
    loans_log: list[dict[str, Any]],
    borrower_egt_alpha: float = 0.3,
    borrower_egt_eta: float = 200.0,
) -> Any:
    realized_margin = loan.borrower.margin
    shock_hit = random.random() < loan.borrower.shock_probability
    shock_multiplier = 1.0
    if shock_hit:
        low, high = loan.borrower.shock_multiplier_range
        shock_multiplier = random.uniform(low, high)
        realized_margin = shock_multiplier

    repayment_days = max(1, delay)
    total_cash_available = max(0.0, (1.0 + realized_margin) * loan.principal)
    loan.scheduled_daily_payment = total_cash_available / repayment_days

    for _ in range(repayment_days):
        yield env.timeout(1)
        loan.apply_partial_payment(env.now, loan.scheduled_daily_payment, realized_margin)
        if loan.closed:
            break

    if not loan.closed:
        loan.close_as_default(env.now)

    summary = loan.summary()
    default_amount = max(0.0, summary["principal"] - summary["principal_paid"])
    if (
        loan.financier.apr_strategy == "pure_rl"
    ):
        realized_reward_amount = (
            summary["interest_paid"]
            + summary["penalty_paid"]
            - default_amount
        )
        loan.realized_apr_rl_reward = loan.financier.normalize_loan_reward(
            realized_reward_amount,
            loan.principal,
        )
        loan.financier.latest_apr_rl_reward = loan.realized_apr_rl_reward
        if loan.financier.apr_strategy == "pure_rl":
            loan.financier.update_pure_rl_q_value(
                loan.apr_rl_state_at_issue,
                loan.apr_rl_action_at_issue,
                loan.realized_apr_rl_reward,
            )
    loan.financier.update_borrower_learning(
        loan,
        summary,
        borrower_egt_alpha=borrower_egt_alpha,
        borrower_egt_eta=borrower_egt_eta,
    )
    fin_perf = loan.financier.update_apr(env.now)
    wh_perf = loan.borrower.compute_portfolio_performance()
    loan.borrower.update_egt(
        wh_perf["payoff"],
        env.now,
        alpha=borrower_egt_alpha,
        eta=borrower_egt_eta,
        model=loan.financier.wholesaler_policy,
    )

    loans_log.append(
        {
            "day": env.now,
            "borrower": loan.borrower.name,
            "borrower_shock_profile": loan.borrower.shock_profile,
            "financier": loan.financier.name,
            "apr_strategy": loan.financier.apr_strategy,
            "wholesaler_policy": loan.financier.wholesaler_policy,
            "decision": "DEFAULT" if summary["is_default"] else "WHOLESALER_REPAID",
            "amount": loan.principal,
            "apr": loan.apr,
            "base_apr": loan.base_apr_at_issue,
            "borrower_score_at_issue": loan.borrower_score_at_issue,
            "borrower_score_apr_adjustment": loan.borrower_score_apr_adjustment,
            "borrower_rl_state": loan.borrower_rl_state,
            "borrower_rl_action": loan.borrower_rl_action,
            "borrower_risk_premium_step": loan.borrower_risk_premium_step,
            "apr_rl_state_at_issue": loan.apr_rl_state_at_issue,
            "apr_rl_action_at_issue": loan.apr_rl_action_at_issue,
            "projected_interest_at_issue": loan.projected_interest_at_issue,
            "opportunity_loss_at_issue": loan.opportunity_loss_at_issue,
            "projected_apr_rl_reward": loan.projected_apr_rl_reward,
            "realized_apr_rl_reward": loan.realized_apr_rl_reward,
            "tenor": loan.tenor_days,
            "repay_day": env.now,
            "profit_financier": summary["fin_profit_pct"],
            "fin_profit_abs": summary["fin_profit"],
            "profit_wholesaler": summary["borrower_profit_pct"],
            "wh_profit_abs": summary["borrower_net_profit"],
            "is_default": summary["is_default"],
            "loan_status": summary["loan_status"],
            "recovery_ratio": summary["recovery_ratio"],
            "payoff": fin_perf["payoff"],
            "net_profit": fin_perf["net_profit"],
            "idle_opportunity_loss": fin_perf["idle_opportunity_loss"],
            "economic_profit": fin_perf["economic_profit"],
            "raw_return_on_capital": fin_perf["raw_return_on_capital"],
            "utilization": fin_perf["utilization"],
            "wholesaler_payoff": wh_perf["payoff"],
            "wholesaler_score": loan.financier.borrower_strategy_score(loan.borrower),
            "wholesaler_default_rate": wh_perf["default_rate"],
            "wholesaler_profit_pct": wh_perf["profit_pct"],
            "fin_wallet": loan.financier.wallet,
            "fin_capital": loan.financier.capital,
            "outstanding_principal": loan.outstanding_principal,
            "realized_margin": loan.realized_margin,
            "shock_hit": shock_hit,
            "shock_multiplier": shock_multiplier,
            "scheduled_daily_payment": summary["scheduled_daily_payment"],
            "payment_count": summary["payment_count"],
            "principal_paid": summary["principal_paid"],
            "accrued_interest_due": summary["accrued_interest_due"],
            "accrued_penalty_due": summary["accrued_penalty_due"],
            "interest_paid": summary["interest_paid"],
            "penalty_paid": summary["penalty_paid"],
        }
    )


def build_financiers(
    apr_strategies: list[str] | None = None,
    wholesaler_policies: list[str] | None = None,
    financier_names: list[str] | None = None,
    base_aprs: list[float] | None = None,
    apr_alphas: list[float] | None = None,
    apr_gammas: list[float] | None = None,
    apr_epsilons: list[float] | None = None,
    financier_egt_alphas: list[float] | None = None,
    financier_egt_etas: list[float] | None = None,
    borrower_alphas: list[float] | None = None,
    borrower_gammas: list[float] | None = None,
    borrower_epsilons: list[float] | None = None,
    borrower_premium_default_loss_weights: list[float] | None = None,
    borrower_accepted_loan_rewards: list[float] | None = None,
    borrower_utilization_reward_weights: list[float] | None = None,
    borrower_overpricing_penalty_weights: list[float] | None = None,
    borrower_default_penalties: list[float] | None = None,
    borrower_delay_penalty_weights: list[float] | None = None,
    borrower_premium_action_sets: list[tuple[float, ...]] | None = None,
    apr_curve_power_sets: list[tuple[float, ...]] | None = None,
    apr_multiplier_sets: list[tuple[float, ...]] | None = None,
    pure_rl_apr_action_sets: list[tuple[float, ...]] | None = None,
    q_table_path: Path | None = None,
    uncapped_apr: bool = False,
    initial_wallet: float = 10_000_000.0,
    initial_capital: float = 10_000_000.0,
) -> list[Financier]:
    apr_strategies = apr_strategies or DEFAULT_APR_STRATEGIES
    wholesaler_policies = wholesaler_policies or DEFAULT_WHOLESALER_POLICIES
    validate_strategy_list("APR strategies", apr_strategies, VALID_APR_STRATEGIES)
    validate_strategy_list("wholesaler policies", wholesaler_policies, VALID_WHOLESALER_POLICIES)

    financier_count = max(len(apr_strategies), len(wholesaler_policies))
    apr_strategies = expand_or_validate(apr_strategies, financier_count, "APR strategies")
    wholesaler_policies = expand_or_validate(wholesaler_policies, financier_count, "Wholesaler policies")
    financier_names = (
        DEFAULT_FINANCIER_NAMES
        if financier_names is None and financier_count == len(DEFAULT_FINANCIER_NAMES)
        else financier_names
    )
    if financier_names is None:
        financier_names = [
            default_financier_name(apr_strategy, wholesaler_policy, index)
            for index, (apr_strategy, wholesaler_policy) in enumerate(
                zip(apr_strategies, wholesaler_policies), start=1
            )
        ]
    financier_names = expand_or_validate(financier_names, financier_count, "Financier names")
    base_aprs = expand_or_validate(base_aprs or [24.0], financier_count, "Base APRs")
    apr_alphas = expand_or_validate(apr_alphas or [0.25], financier_count, "APR alphas")
    apr_gammas = expand_or_validate(apr_gammas or [0.95], financier_count, "APR gammas")
    apr_epsilons = expand_or_validate(apr_epsilons or [0.08], financier_count, "APR epsilons")
    financier_egt_alphas = expand_or_validate(
        financier_egt_alphas or [0.3], financier_count, "Financier EGT alphas"
    )
    financier_egt_etas = expand_or_validate(
        financier_egt_etas or [200.0], financier_count, "Financier EGT etas"
    )
    borrower_alphas = expand_or_validate(borrower_alphas or [0.10], financier_count, "Borrower RL alphas")
    borrower_gammas = expand_or_validate(borrower_gammas or [0.70], financier_count, "Borrower RL gammas")
    borrower_epsilons = expand_or_validate(borrower_epsilons or [0.05], financier_count, "Borrower RL epsilons")
    borrower_premium_default_loss_weights = expand_or_validate(
        borrower_premium_default_loss_weights or [1.0],
        financier_count,
        "Borrower premium default-loss weights",
    )
    borrower_accepted_loan_rewards = expand_or_validate(
        borrower_accepted_loan_rewards or [0.0],
        financier_count,
        "Borrower accepted-loan rewards",
    )
    borrower_utilization_reward_weights = expand_or_validate(
        borrower_utilization_reward_weights or [0.0],
        financier_count,
        "Borrower utilization reward weights",
    )
    borrower_overpricing_penalty_weights = expand_or_validate(
        borrower_overpricing_penalty_weights or [0.0],
        financier_count,
        "Borrower overpricing penalty weights",
    )
    borrower_default_penalties = expand_or_validate(
        borrower_default_penalties or [1.0],
        financier_count,
        "Borrower default penalties",
    )
    borrower_delay_penalty_weights = expand_or_validate(
        borrower_delay_penalty_weights or [0.25],
        financier_count,
        "Borrower delay penalty weights",
    )
    borrower_premium_action_sets = expand_or_validate(
        borrower_premium_action_sets or [(-2.0, 0.0, 4.0, 8.0, 12.0, 16.0)],
        financier_count,
        "Borrower premium action sets",
    )

    pure_rl_apr_action_sets = expand_or_validate(
        pure_rl_apr_action_sets or [tuple(float(apr) for apr in range(6, 37))],
        financier_count,
        "Pure RL APR action sets",
    )

    min_apr = -1_000_000.0 if uncapped_apr else 6.0
    max_apr = 1_000_000.0 if uncapped_apr else 36.0
    min_offer_apr = -1_000_000.0 if uncapped_apr else 6.0
    max_offer_apr = 1_000_000.0 if uncapped_apr else 36.0

    financiers: list[Financier] = []
    for (
        name,
        apr_strategy,
        wholesaler_policy,
        base_apr,
        apr_alpha,
        apr_gamma,
        apr_epsilon,
        financier_egt_alpha,
        financier_egt_eta,
        borrower_alpha,
        borrower_gamma,
        borrower_epsilon,
        borrower_premium_default_loss_weight,
        borrower_accepted_loan_reward,
        borrower_utilization_reward_weight,
        borrower_overpricing_penalty_weight,
        borrower_default_penalty,
        borrower_delay_penalty_weight,
        borrower_premium_actions,

        pure_rl_apr_actions,
    ) in zip(
        financier_names,
        apr_strategies,
        wholesaler_policies,
        base_aprs,
        apr_alphas,
        apr_gammas,
        apr_epsilons,
        financier_egt_alphas,
        financier_egt_etas,
        borrower_alphas,
        borrower_gammas,
        borrower_epsilons,
        borrower_premium_default_loss_weights,
        borrower_accepted_loan_rewards,
        borrower_utilization_reward_weights,
        borrower_overpricing_penalty_weights,
        borrower_default_penalties,
        borrower_delay_penalty_weights,
        borrower_premium_action_sets,

        pure_rl_apr_action_sets,
    ):
        apr_learning_weight = 300.0
        max_apr_step = 2.0
        financiers.append(
            Financier(
                name,
                wallet=initial_wallet,
                capital=initial_capital,
                initial_capital=initial_capital,
                prev_capital=initial_capital,
                prev_capital_for_reward=initial_capital,
                base_apr=base_apr,
                apr_strategy=apr_strategy,
                wholesaler_policy=wholesaler_policy,
                min_apr=min_apr,
                max_apr=max_apr,
                min_offer_apr=min_offer_apr,
                max_offer_apr=max_offer_apr,
                apr_learning_weight=apr_learning_weight,
                max_apr_step=max_apr_step,
                egt_alpha=financier_egt_alpha,
                egt_eta=financier_egt_eta,
                apr_alpha=apr_alpha,
                apr_gamma=apr_gamma,
                apr_epsilon=apr_epsilon,
                borrower_alpha=borrower_alpha,
                borrower_gamma=borrower_gamma,
                borrower_epsilon=borrower_epsilon,
                borrower_premium_default_loss_weight=borrower_premium_default_loss_weight,
                borrower_accepted_loan_reward=borrower_accepted_loan_reward,
                borrower_utilization_reward_weight=borrower_utilization_reward_weight,
                borrower_overpricing_penalty_weight=borrower_overpricing_penalty_weight,
                borrower_default_penalty=borrower_default_penalty,
                borrower_delay_penalty_weight=borrower_delay_penalty_weight,
                borrower_premium_actions=borrower_premium_actions,

                pure_rl_apr_actions=pure_rl_apr_actions,
            )
        )
    return financiers


def load_q_tables(financiers: list[Financier], q_table_path: Path | None) -> None:
    if q_table_path is None:
        return
    payload = json.loads(q_table_path.read_text(encoding="utf-8"))
    for financier in financiers:
        if financier.name in payload:
            financier.import_q_tables(payload[financier.name])


def aggregate_federated_egt(financiers: list[Financier]) -> None:
    fl_egt_financiers = [f for f in financiers if f.wholesaler_policy == "fl_egt"]
    if not fl_egt_financiers:
        return
    
    sum_score = {}
    sum_pi_bar = {}
    count = {}
    
    for f in fl_egt_financiers:
        for borrower_name, egt_state in f.borrower_egt_state.items():
            if borrower_name not in sum_score:
                sum_score[borrower_name] = 0.0
                sum_pi_bar[borrower_name] = 0.0
                count[borrower_name] = 0
            sum_score[borrower_name] += egt_state["score"]
            sum_pi_bar[borrower_name] += egt_state["pi_bar"]
            count[borrower_name] += 1
            
    for borrower_name, cnt in count.items():
        if cnt > 0:
            avg_score = sum_score[borrower_name] / cnt
            avg_pi_bar = sum_pi_bar[borrower_name] / cnt
            for f in fl_egt_financiers:
                state = f.borrower_egt_state[borrower_name]
                state["score"] = avg_score
                state["pi_bar"] = avg_pi_bar


def aggregate_federated_rl(financiers: list[Financier]) -> None:
    fl_rl_financiers = [f for f in financiers if f.wholesaler_policy == "fl_rl"]
    if not fl_rl_financiers:
        return
    
    sum_q = {}
    count_q = {}
    
    for f in fl_rl_financiers:
        for state, actions in f.borrower_premium_q.items():
            if state not in sum_q:
                sum_q[state] = {}
                count_q[state] = {}
            for action, q_value in actions.items():
                if action not in sum_q[state]:
                    sum_q[state][action] = 0.0
                    count_q[state][action] = 0
                sum_q[state][action] += q_value
                count_q[state][action] += 1
                
    for state in sum_q:
        for action in sum_q[state]:
            avg_val = sum_q[state][action] / count_q[state][action]
            for f in fl_rl_financiers:
                if state not in f.borrower_premium_q:
                    f.borrower_premium_q[state] = {}
                f.borrower_premium_q[state][action] = avg_val


def aggregate_federated_rl_prox(financiers: list[Financier]) -> None:
    """FedProx aggregation for wholesaler_policy == 'fl_rl_prox'.

    Aggregation step itself is the same uniform FedAvg-style averaging as
    aggregate_federated_rl; FedProx's difference is entirely in the local
    update (see the proximal term applied in update_borrower_learning).
    What this function adds on top of plain FedAvg is refreshing each
    financier's borrower_premium_q_global_snapshot to the freshly averaged
    table, so the proximal term next round pulls toward the latest global
    model rather than a stale one.
    """
    group = [f for f in financiers if f.wholesaler_policy == "fl_rl_prox"]
    if not group:
        return

    sum_q: dict[tuple[int, ...], dict[float, float]] = {}
    count_q: dict[tuple[int, ...], dict[float, int]] = {}

    for f in group:
        for state, actions in f.borrower_premium_q.items():
            sum_q.setdefault(state, {})
            count_q.setdefault(state, {})
            for action, q_value in actions.items():
                sum_q[state].setdefault(action, 0.0)
                count_q[state].setdefault(action, 0)
                sum_q[state][action] += q_value
                count_q[state][action] += 1

    global_q: dict[tuple[int, ...], dict[float, float]] = {}
    for state in sum_q:
        global_q[state] = {}
        for action in sum_q[state]:
            global_q[state][action] = sum_q[state][action] / count_q[state][action]

    for f in group:
        for state, actions in global_q.items():
            f.borrower_premium_q.setdefault(state, {})
            for action, avg_val in actions.items():
                f.borrower_premium_q[state][action] = avg_val
        # Deep-ish copy is unnecessary here since values are floats.
        f.borrower_premium_q_global_snapshot = {
            state: dict(actions) for state, actions in global_q.items()
        }


def aggregate_federated_rl_scaffold(financiers: list[Financier]) -> None:
    """SCAFFOLD aggregation for wholesaler_policy == 'fl_rl_scaffold'.

    Adapted tabular analogue of SCAFFOLD (Karimireddy et al., 2020) for
    federated Q-learning. The original algorithm corrects client-drift in
    gradient-based (SGD) local steps using control variates; here the same
    idea is applied to TD updates on Q-table cells:

      1. Before averaging, record each financier's pre-aggregation local Q
         value per (state, action) cell.
      2. Average Q across the group (the FedAvg "download" step).
      3. Update each financier's local control variate c_local by the drift
         between its pre-aggregation Q and the new global average, scaled by
         scaffold_c_lr.
      4. Average the updated c_local values into a group c_global and
         broadcast it to every financier in the group, alongside the
         averaged Q-table.

    This is a research-comparison adaptation, not a literal reproduction of
    the SGD-based proof in the original paper.
    """
    group = [f for f in financiers if f.wholesaler_policy == "fl_rl_scaffold"]
    if not group:
        return

    # Step 1: snapshot pre-aggregation local Q values.
    pre_agg_q = [
        {state: dict(actions) for state, actions in f.borrower_premium_q.items()}
        for f in group
    ]

    # Step 2: FedAvg-style averaging of Q across the group.
    sum_q: dict[tuple[int, ...], dict[float, float]] = {}
    count_q: dict[tuple[int, ...], dict[float, int]] = {}
    for f in group:
        for state, actions in f.borrower_premium_q.items():
            sum_q.setdefault(state, {})
            count_q.setdefault(state, {})
            for action, q_value in actions.items():
                sum_q[state].setdefault(action, 0.0)
                count_q[state].setdefault(action, 0)
                sum_q[state][action] += q_value
                count_q[state][action] += 1

    global_q: dict[tuple[int, ...], dict[float, float]] = {}
    for state in sum_q:
        global_q[state] = {}
        for action in sum_q[state]:
            global_q[state][action] = sum_q[state][action] / count_q[state][action]

    # Step 3: update each financier's local control variate from its
    # pre-aggregation drift relative to the new global average.
    for f, local_q in zip(group, pre_agg_q):
        for state, actions in local_q.items():
            f.borrower_premium_c_local.setdefault(state, {})
            global_actions = global_q.get(state, {})
            for action, local_val in actions.items():
                global_val = global_actions.get(action, local_val)
                drift = local_val - global_val
                prev_c = f.borrower_premium_c_local[state].get(action, 0.0)
                f.borrower_premium_c_local[state][action] = prev_c + f.scaffold_c_lr * drift

    # Step 4: average local control variates into a group control variate
    # and broadcast both the averaged Q-table and the group control variate.
    sum_c: dict[tuple[int, ...], dict[float, float]] = {}
    count_c: dict[tuple[int, ...], dict[float, int]] = {}
    for f in group:
        for state, actions in f.borrower_premium_c_local.items():
            sum_c.setdefault(state, {})
            count_c.setdefault(state, {})
            for action, c_val in actions.items():
                sum_c[state].setdefault(action, 0.0)
                count_c[state].setdefault(action, 0)
                sum_c[state][action] += c_val
                count_c[state][action] += 1

    global_c: dict[tuple[int, ...], dict[float, float]] = {}
    for state in sum_c:
        global_c[state] = {}
        for action in sum_c[state]:
            global_c[state][action] = sum_c[state][action] / count_c[state][action]

    for f in group:
        for state, actions in global_q.items():
            f.borrower_premium_q.setdefault(state, {})
            for action, avg_val in actions.items():
                f.borrower_premium_q[state][action] = avg_val
        f.borrower_premium_c_global = {
            state: dict(actions) for state, actions in global_c.items()
        }


def aggregate_federated_rl_visitweighted(financiers: list[Financier]) -> None:
    """Visit-count-weighted aggregation for wholesaler_policy ==
    'fl_rl_visitweighted'.

    Unlike FedAvg's uniform averaging (every financier's Q-value counts
    equally), each financier's contribution to a given (state, action) cell
    is weighted by how many times that financier has personally visited
    (i.e. updated) that cell since the simulation began. A financier with
    more local experience in a given borrower-risk state therefore carries
    proportionally more influence over the shared estimate for that state,
    while a financier that has barely seen that state contributes little.

    This is a tabular-specific idea: per-cell visit counts are a natural
    confidence signal available in tabular Q-learning that has no direct
    analogue in gradient-based FedAvg/FedProx/SCAFFOLD, none of which weight
    contributions by anything resembling per-parameter sample counts. The
    local TD update itself is unchanged from plain FedAvg; only this
    aggregation step differs.
    """
    group = [f for f in financiers if f.wholesaler_policy == "fl_rl_visitweighted"]
    if not group:
        return

    weighted_sum: dict[tuple[int, ...], dict[float, float]] = {}
    weight_total: dict[tuple[int, ...], dict[float, float]] = {}

    for f in group:
        for state, actions in f.borrower_premium_q.items():
            visits_for_state = f.borrower_premium_visits.get(state, {})
            weighted_sum.setdefault(state, {})
            weight_total.setdefault(state, {})
            for action, q_value in actions.items():
                # A cell present in borrower_premium_q but never visited
                # (e.g. created only via the next-state max() lookahead)
                # still gets a minimum weight of 1 so it is not dropped
                # entirely from the average.
                weight = max(1, visits_for_state.get(action, 0))
                weighted_sum[state].setdefault(action, 0.0)
                weight_total[state].setdefault(action, 0.0)
                weighted_sum[state][action] += weight * q_value
                weight_total[state][action] += weight

    for state in weighted_sum:
        for action in weighted_sum[state]:
            total_weight = weight_total[state][action]
            if total_weight <= 0:
                continue
            avg_val = weighted_sum[state][action] / total_weight
            for f in group:
                f.borrower_premium_q.setdefault(state, {})
                f.borrower_premium_q[state][action] = avg_val


def assign_non_iid_borrower_segments(
    financiers: list[Financier],
    borrowers: list["Borrower"],
    group_policies: tuple[str, ...] = ("fl_rl", "fl_rl_prox", "fl_rl_scaffold", "fl_rl_visitweighted"),
    primary_share: float = 0.8,
    seed: int | None = None,
) -> None:
    """Give each federated financier a skewed (non-IID) borrower segment.

    Without this, every financier in a federated policy group quotes to the
    same shared borrower pool, so there is little genuine "client drift" for
    FedProx / SCAFFOLD to correct. This partitions borrowers by
    shock_profile (risk tier) and assigns each financier in the group a
    primary tier (primary_share of that tier's borrowers) plus a minority
    share of the other tiers, so different financiers see different
    borrower-risk mixes -- a label-skew non-IID setup.

    primary_share=1.0 reproduces the fully-shared/IID market (equivalent to
    not calling this function at all, since eligible_borrowers stays None
    unless assigned here). Call with a lower primary_share for stronger
    heterogeneity.
    """
    rng = random.Random(seed)
    by_profile: dict[str, list[str]] = defaultdict(list)
    for b in borrowers:
        by_profile[b.shock_profile].append(b.name)
    profiles = sorted(by_profile.keys())
    if not profiles:
        return

    # Partition per policy (not across the combined pool of all policies) so
    # that financier index i has the same *primary* risk tier in every
    # policy group -- e.g. the 1st fl_rl financier, 1st fl_rl_prox financier,
    # and 1st fl_rl_scaffold financier all primarily see the same tier. That
    # keeps FedAvg vs FedProx vs SCAFFOLD comparisons matched: the only
    # difference between groups is the aggregation algorithm, not which
    # borrowers happen to be assigned to which group.
    for policy in group_policies:
        policy_financiers = [f for f in financiers if f.wholesaler_policy == policy]
        for i, f in enumerate(policy_financiers):
            primary_profile = profiles[i % len(profiles)]
            eligible: set[str] = set(by_profile[primary_profile])
            for profile in profiles:
                if profile == primary_profile:
                    continue
                pool = by_profile[profile]
                minority_count = max(1, round(len(pool) * (1.0 - primary_share)))
                minority_count = min(minority_count, len(pool))
                eligible.update(rng.sample(pool, minority_count))
            f.eligible_borrowers = frozenset(eligible)


def federated_aggregation_process(
    env: simpy.Environment,
    financiers: list[Financier],
    interval: int,
) -> Generator[None, None, None]:
    while True:
        yield env.timeout(interval)
        aggregate_federated_egt(financiers)
        aggregate_federated_rl(financiers)
        aggregate_federated_rl_prox(financiers)
        aggregate_federated_rl_scaffold(financiers)
        aggregate_federated_rl_visitweighted(financiers)


def run_simulation(
    days: int,
    seed: int,
    drain_outstanding: bool = True,
    apr_strategies: list[str] | None = None,
    wholesaler_policies: list[str] | None = None,
    financier_names: list[str] | None = None,
    base_aprs: list[float] | None = None,
    apr_alphas: list[float] | None = None,
    apr_gammas: list[float] | None = None,
    apr_epsilons: list[float] | None = None,
    financier_egt_alphas: list[float] | None = None,
    financier_egt_etas: list[float] | None = None,
    borrower_alphas: list[float] | None = None,
    borrower_gammas: list[float] | None = None,
    borrower_epsilons: list[float] | None = None,
    borrower_premium_default_loss_weights: list[float] | None = None,
    borrower_accepted_loan_rewards: list[float] | None = None,
    borrower_utilization_reward_weights: list[float] | None = None,
    borrower_overpricing_penalty_weights: list[float] | None = None,
    borrower_default_penalties: list[float] | None = None,
    borrower_delay_penalty_weights: list[float] | None = None,
    borrower_premium_action_sets: list[tuple[float, ...]] | None = None,

    pure_rl_apr_action_sets: list[tuple[float, ...]] | None = None,
    q_table_path: Path | None = None,
    uncapped_apr: bool = False,
    initial_wallet: float = 10_000_000.0,
    initial_capital: float = 10_000_000.0,
    disable_defaults: bool = False,
    borrower_margin: float = 0.20,
    shock_profile_counts: dict[str, int] | None = None,
    medium_shock_range: tuple[float, float] = (-0.02, -0.08),
    high_shock_range: tuple[float, float] = (-0.09, -0.20),
    borrower_egt_alpha: float = 0.3,
    borrower_egt_eta: float = 200.0,
    borrower_request_timeout_range: tuple[int, int] = (10, 20),
    borrower_demand_schedule: list[tuple[int, float]] | None = None,
    borrower_lot_amount_range: tuple[float, float] = (20_000.0, 50_000.0),
    borrower_lot_amount_schedule: list[tuple[int, tuple[float, float]]] | None = None,
    borrower_tenor_range: tuple[int, int] = (200, 300),
    extra_borrower_process_interval: int | None = None,
    non_iid_primary_share: float | None = None,
    non_iid_group_policies: tuple[str, ...] = ("fl_rl", "fl_rl_prox", "fl_rl_scaffold", "fl_rl_visitweighted"),
) -> dict[str, pd.DataFrame]:
    random.seed(seed)
    env = simpy.Environment()

    financiers = build_financiers(
        apr_strategies=apr_strategies,
        wholesaler_policies=wholesaler_policies,
        financier_names=financier_names,
        base_aprs=base_aprs,
        apr_alphas=apr_alphas,
        apr_gammas=apr_gammas,
        apr_epsilons=apr_epsilons,
        financier_egt_alphas=financier_egt_alphas,
        financier_egt_etas=financier_egt_etas,
        borrower_alphas=borrower_alphas,
        borrower_gammas=borrower_gammas,
        borrower_epsilons=borrower_epsilons,
        borrower_premium_default_loss_weights=borrower_premium_default_loss_weights,
        borrower_accepted_loan_rewards=borrower_accepted_loan_rewards,
        borrower_utilization_reward_weights=borrower_utilization_reward_weights,
        borrower_overpricing_penalty_weights=borrower_overpricing_penalty_weights,
        borrower_default_penalties=borrower_default_penalties,
        borrower_delay_penalty_weights=borrower_delay_penalty_weights,
        borrower_premium_action_sets=borrower_premium_action_sets,

        pure_rl_apr_action_sets=pure_rl_apr_action_sets,
        q_table_path=q_table_path,
        uncapped_apr=uncapped_apr,
        initial_wallet=initial_wallet,
        initial_capital=initial_capital,
    )
    load_q_tables(financiers, q_table_path)
    if disable_defaults:
        borrower_count = sum(shock_profile_counts.values()) if shock_profile_counts else 39
        shock_profiles = ["none"] * borrower_count
    else:
        shock_profiles = expand_shock_profiles(
            shock_profile_counts or {"none": 13, "medium": 13, "high": 13}
        )
    borrowers = [
        Borrower(
            f"Wholesaler_{i}",
            wallet=50_000,
            margin=borrower_margin,
            shock_profile=shock_profile,
            medium_shock_range=medium_shock_range,
            high_shock_range=high_shock_range,
        )
        for i, shock_profile in enumerate(shock_profiles, start=1)
    ]

    if non_iid_primary_share is not None:
        assign_non_iid_borrower_segments(
            financiers,
            borrowers,
            group_policies=non_iid_group_policies,
            primary_share=non_iid_primary_share,
            seed=seed,
        )

    results: list[dict[str, Any]] = []
    loans_log: list[dict[str, Any]] = []

    for borrower in borrowers:
        env.process(
            borrower_process(
                env,
                borrower,
                financiers,
                results,
                loans_log,
                days,
                borrower_egt_alpha=borrower_egt_alpha,
                borrower_egt_eta=borrower_egt_eta,
                borrower_request_timeout_range=borrower_request_timeout_range,
                borrower_demand_schedule=borrower_demand_schedule,
                borrower_lot_amount_range=borrower_lot_amount_range,
                borrower_lot_amount_schedule=borrower_lot_amount_schedule,
                borrower_tenor_range=borrower_tenor_range,
            )
        )
        if extra_borrower_process_interval is not None and extra_borrower_process_interval > 0:
            extra_start_day = extra_borrower_process_interval
            while extra_start_day < days:
                env.process(
                    delayed_borrower_process(
                        env,
                        extra_start_day,
                        borrower,
                        financiers,
                        results,
                        loans_log,
                        days,
                        borrower_egt_alpha=borrower_egt_alpha,
                        borrower_egt_eta=borrower_egt_eta,
                        borrower_request_timeout_range=borrower_request_timeout_range,
                        borrower_demand_schedule=borrower_demand_schedule,
                        borrower_lot_amount_range=borrower_lot_amount_range,
                        borrower_lot_amount_schedule=borrower_lot_amount_schedule,
                        borrower_tenor_range=borrower_tenor_range,
                    )
                )
                extra_start_day += extra_borrower_process_interval

    env.process(federated_aggregation_process(env, financiers, 30))

    if drain_outstanding:
        env.run(until=days)
        while True:
            outstanding_loans = [
                loan
                for financier in financiers
                for loan in financier.loans
                if not loan.closed
            ]
            if not outstanding_loans:
                break
            if env.now > days + 500:
                break
            env.run(until=env.now + 1)
    else:
        env.run(until=days)

    df_results = pd.DataFrame(results)
    df_loans = pd.DataFrame(loans_log)
    df_financier_history = pd.DataFrame(
        row for financier in financiers for row in financier.history
    )
    df_borrower_history = pd.DataFrame(
        row for borrower in borrowers for row in borrower.history
    )
    def financier_summary_row(financier: Financier) -> dict[str, Any]:
        loans_issued = len(financier.loans)
        closed_loans = sum(loan.closed for loan in financier.loans)
        defaults = sum(loan.is_default for loan in financier.loans)
        total_issued_principal = sum(loan.principal for loan in financier.loans)
        default_amount = sum(
            max(0.0, loan.principal - loan.total_principal_paid)
            for loan in financier.loans
            if loan.closed and loan.is_default
        )
        capital_change = financier.capital - financier.initial_capital
        capital_loss = max(0.0, -capital_change)
        return {
            "financier": financier.name,
            "apr_strategy": financier.apr_strategy,
            "wholesaler_policy": financier.wholesaler_policy,
            "final_wallet": financier.wallet,
            "initial_capital": financier.initial_capital,
            "final_capital": financier.capital,
            "capital_change": capital_change,
            "capital_loss": capital_loss,
            "capital_loss_rate": capital_loss / financier.initial_capital if financier.initial_capital else 0.0,
            "final_apr": financier.base_apr,
            "final_utilization": financier.utilization,
            "loans_issued": loans_issued,
            "closed_loans": closed_loans,
            "defaults": defaults,
            "default_count_rate": defaults / loans_issued if loans_issued else 0.0,
            "total_issued_principal": total_issued_principal,
            "default_amount": default_amount,
            "default_amount_to_issued_rate": (
                default_amount / total_issued_principal if total_issued_principal else 0.0
            ),
            "default_amount_to_initial_capital_rate": (
                default_amount / financier.initial_capital if financier.initial_capital else 0.0
            ),
            "outstanding_loans": sum(not loan.closed for loan in financier.loans),
            "simulation_end_day": env.now,
        }

    df_financier_summary = pd.DataFrame(
        financier_summary_row(financier)
        for financier in financiers
    )
    borrower_by_name = {borrower.name: borrower for borrower in borrowers}
    df_borrower_stats = pd.DataFrame(
        {
            "financier": financier.name,
            "wholesaler_policy": financier.wholesaler_policy,
            "borrower": borrower_name,
            "borrower_shock_profile": borrower_by_name[borrower_name].shock_profile,
            "requests": stats["requests"],
            "approved": stats["approved"],
            "closed": stats["closed"],
            "defaults": stats["defaults"],
            "default_rate": stats["defaults"] / max(1.0, stats["closed"]),
            "profit": stats["profit"],
            "principal": stats.get("principal", 0.0),
            "profit_rate": stats["profit"] / max(1.0, stats.get("principal", 0.0)),
            "avg_delay_ratio": stats["avg_delay_ratio"],
        }
        for financier in financiers
        for borrower_name, stats in financier.borrower_stats.items()
    )
    df_shock_summary = (
        df_loans.groupby(["financier", "wholesaler_policy", "borrower_shock_profile"], dropna=False)
        .agg(
            loans=("borrower", "count"),
            defaults=("is_default", "sum"),
            avg_apr=("apr", "mean"),
            avg_profit=("profit_financier", "mean"),
            shock_hits=("shock_hit", "sum"),
        )
        .reset_index()
        if not df_loans.empty
        else pd.DataFrame()
    )
    df_q_tables = pd.DataFrame(
        row
        for financier in financiers
        for table_name, table in [
            ("pure_rl_q", financier.export_q_tables()["pure_rl_q"]),
            ("borrower_premium_q", financier.export_q_tables()["borrower_premium_q"]),
        ]
        for state, actions in table.items()
        for action, value in actions.items()
        if table
        for row in [
            {
                "financier": financier.name,
                "apr_strategy": financier.apr_strategy,
                "table": table_name,
                "state": state,
                "action": action,
                "q_value": value,
            }
        ]
    )

    return {
        "Results": df_results,
        "Loans": df_loans,
        "Financier_History": df_financier_history,
        "Borrower_History": df_borrower_history,
        "Financier_Summary": df_financier_summary,
        "Borrower_Stats": df_borrower_stats,
        "Shock_Summary": df_shock_summary,
        "Q_Tables": df_q_tables,
    }


def save_q_tables(frames: dict[str, pd.DataFrame], output_path: Path) -> None:
    q_table = frames.get("Q_Tables", pd.DataFrame())
    payload: dict[str, dict[str, Any]] = {}
    if q_table.empty:
        output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return
    for _, row in q_table.iterrows():
        financier = row["financier"]
        table_name = row["table"]
        state = row["state"]
        action = row["action"]
        q_value = float(row["q_value"])
        financier_payload = payload.setdefault(
            financier,
            {"pure_rl_q": {}, "hybrid_rl_q": {}, "borrower_premium_q": {}},
        )
        table = financier_payload[table_name]
        table.setdefault(state, {})[action] = q_value
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def write_excel(frames: dict[str, pd.DataFrame], output_path: Path) -> None:
    with pd.ExcelWriter(output_path, engine="xlsxwriter") as writer:
        for sheet_name, frame in frames.items():
            frame.to_excel(writer, sheet_name=sheet_name[:31], index=False)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the EGT APR loan simulation.")
    parser.add_argument("--days", type=int, default=4000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=Path, default=Path("simulation_results.xlsx"))
    parser.add_argument(
        "--apr-strategies",
        default=",".join(DEFAULT_APR_STRATEGIES),
        help=(
            "Comma-separated base APR strategies per financier. "
            f"Valid: {', '.join(sorted(VALID_APR_STRATEGIES))}."
        ),
    )
    parser.add_argument(
        "--wholesaler-policies",
        default=",".join(DEFAULT_WHOLESALER_POLICIES),
        help=(
            "Comma-separated wholesaler-side adjustment/screening policies per financier. "
            f"Valid: {', '.join(sorted(VALID_WHOLESALER_POLICIES))}."
        ),
    )
    parser.add_argument(
        "--financier-names",
        default=None,
        help="Optional comma-separated financier names. Use one name or one per configured financier.",
    )
    parser.add_argument(
        "--base-aprs",
        default="24.0",
        help="Optional comma-separated starting base APRs. Use one APR for all financiers or one per financier.",
    )
    parser.add_argument(
        "--uncapped-apr",
        action="store_true",
        help="Remove normal APR floor/ceiling for experimental runs.",
    )
    parser.add_argument(
        "--initial-wallet",
        type=float,
        default=10_000_000.0,
        help="Starting wallet for each financier.",
    )
    parser.add_argument(
        "--initial-capital",
        type=float,
        default=10_000_000.0,
        help="Capital denominator used for each financier's utilization.",
    )
    parser.add_argument(
        "--disable-defaults",
        action="store_true",
        help="Assign all wholesalers the no-shock profile so repayment shocks cannot create defaults.",
    )
    parser.add_argument(
        "--borrower-margin",
        type=float,
        default=0.20,
        help="Base wholesaler margin used for borrower profitability decisions.",
    )
    parser.add_argument(
        "--shock-profile-counts",
        default="none:13,medium:13,high:13",
        help=(
            "Comma-separated borrower shock profile counts, e.g. "
            "'none:20,medium:10,high:9'. Ignored by --disable-defaults except for total count."
        ),
    )
    parser.add_argument(
        "--medium-shock-range",
        default="-0.02,-0.08",
        help="Comma-separated realized-margin shock range for medium borrowers.",
    )
    parser.add_argument(
        "--high-shock-range",
        default="-0.09,-0.20",
        help="Comma-separated realized-margin shock range for high-risk borrowers.",
    )
    parser.add_argument(
        "--save-q-tables",
        type=Path,
        default=None,
        help="Optional JSON path to save trained pure/hybrid RL Q-tables after the run.",
    )
    parser.add_argument(
        "--load-q-tables",
        type=Path,
        default=None,
        help="Optional JSON path to load trained pure/hybrid RL Q-tables before the run.",
    )
    args = parser.parse_args()

    apr_strategies = parse_csv(args.apr_strategies)
    wholesaler_policies = parse_csv(args.wholesaler_policies)
    financier_names = parse_csv(args.financier_names) if args.financier_names else None
    try:
        base_aprs = parse_float_csv(args.base_aprs)
        shock_profile_counts = parse_profile_counts(args.shock_profile_counts)
        medium_shock_range = parse_float_pair(args.medium_shock_range, "Medium shock range")
        high_shock_range = parse_float_pair(args.high_shock_range, "High shock range")
        frames = run_simulation(
            days=args.days,
            seed=args.seed,
            apr_strategies=apr_strategies,
            wholesaler_policies=wholesaler_policies,
            financier_names=financier_names,
            base_aprs=base_aprs,
            q_table_path=args.load_q_tables,
            uncapped_apr=args.uncapped_apr,
            initial_wallet=args.initial_wallet,
            initial_capital=args.initial_capital,
            disable_defaults=args.disable_defaults,
            borrower_margin=args.borrower_margin,
            shock_profile_counts=shock_profile_counts,
            medium_shock_range=medium_shock_range,
            high_shock_range=high_shock_range,
        )
    except ValueError as exc:
        parser.error(str(exc))

    write_excel(frames, args.output)
    if args.save_q_tables is not None:
        save_q_tables(frames, args.save_q_tables)

    summary = frames["Financier_Summary"]
    print(f"Simulation completed for {args.days} days.")
    print(f"Excel written to: {args.output.resolve()}")
    if args.save_q_tables is not None:
        print(f"Q-tables written to: {args.save_q_tables.resolve()}")
    print(summary.to_string(index=False))


if __name__ == "__main__":
    main()
