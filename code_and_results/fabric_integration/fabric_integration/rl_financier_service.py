#!/usr/bin/env python3
"""Lightweight RL+RL financier quote service.

This service is designed to run one process per financier. It does not depend
on FastAPI/Flask so it can run in the current WSL Python environment.

Endpoints:
  GET  /health
  GET  /state
  POST /quote
  POST /loan-issued
  POST /loan-closed
"""

from __future__ import annotations

import argparse
import json
import math
import random
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def bucket(value: float, cuts: tuple[float, ...]) -> int:
    for index, cut in enumerate(cuts):
        if value < cut:
            return index
    return len(cuts)


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


@dataclass
class LoanRecord:
    loanId: str
    wholesalerId: str
    principalAmount: float
    tenorDays: int
    aprPct: float
    issuedAt: float
    aprState: str | None = None
    aprAction: float | None = None
    borrowerState: str | None = None
    borrowerAction: float | None = None
    expectedReward: float = 0.0
    status: str = "OPEN"
    closedAt: float | None = None
    realizedReward: float | None = None
    interestPaid: float = 0.0
    penaltyPaid: float = 0.0
    principalPaid: float = 0.0
    defaultAmount: float = 0.0


@dataclass
class WholesalerStats:
    requests: float = 0.0
    approved: float = 0.0
    closed: float = 0.0
    defaults: float = 0.0
    profit: float = 0.0
    principal: float = 0.0
    defaultAmount: float = 0.0


@dataclass
class FinancierAgent:
    financier_id: str
    wallet: float
    capital: float
    initial_capital: float
    state_file: str | None = None
    model_version: str = "live-rl-rl-agent-v1"
    base_apr: float = 12.0
    min_offer_apr: float = 6.0
    max_offer_apr: float = 48.0
    penalty_pct: float = 3.0
    apr_alpha: float = 0.25
    apr_epsilon: float = 0.05
    borrower_alpha: float = 0.25
    borrower_epsilon: float = 0.05
    reward_weight_return: float = 10.0
    reward_weight_growth: float = 50.0
    reward_weight_decline: float = 0.0
    reward_weight_utilization: float = 1.0
    borrower_min_risk_premium: float = -2.0
    borrower_max_risk_premium: float = 16.0
    pure_rl_apr_actions: tuple[float, ...] = (
        6.0, 8.0, 10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 24.0, 30.0, 36.0
    )
    borrower_premium_actions: tuple[float, ...] = (-2.0, 0.0, 2.0, 4.0, 8.0, 12.0, 16.0)
    pure_rl_q: dict[str, dict[str, float]] = field(default_factory=dict)
    borrower_premium_q: dict[str, dict[str, float]] = field(default_factory=dict)
    wholesaler_stats: dict[str, WholesalerStats] = field(default_factory=dict)
    active_loans: dict[str, LoanRecord] = field(default_factory=dict)
    quote_history: list[dict[str, Any]] = field(default_factory=list)

    def _save(self) -> None:
        if not self.state_file:
            return
        payload = {
            "financierId": self.financier_id,
            "wallet": self.wallet,
            "capital": self.capital,
            "initialCapital": self.initial_capital,
            "modelVersion": self.model_version,
            "baseApr": self.base_apr,
            "penaltyPct": self.penalty_pct,
            "pure_rl_q": self.pure_rl_q,
            "borrower_premium_q": self.borrower_premium_q,
            "wholesaler_stats": {k: asdict(v) for k, v in self.wholesaler_stats.items()},
            "active_loans": {k: asdict(v) for k, v in self.active_loans.items()},
            "quote_history": self.quote_history[-100:],
        }
        write_json(Path(self.state_file), payload)

    def load_q_tables(self, path: str | None) -> None:
        if not path:
            return
        data = read_json(Path(path))
        pure = data.get("pure_rl_q", {}) if isinstance(data, dict) else {}
        borrower = data.get("borrower_premium_q", {}) if isinstance(data, dict) else {}
        self.pure_rl_q = {
            str(state): {str(action): float(value) for action, value in actions.items()}
            for state, actions in pure.items()
        }
        self.borrower_premium_q = {
            str(state): {str(action): float(value) for action, value in actions.items()}
            for state, actions in borrower.items()
        }

    def load_state(self) -> None:
        if not self.state_file:
            return
        path = Path(self.state_file)
        if not path.exists():
            return
        data = read_json(path)
        self.wallet = safe_float(data.get("wallet"), self.wallet)
        self.capital = safe_float(data.get("capital"), self.capital)
        self.initial_capital = safe_float(data.get("initialCapital"), self.initial_capital)
        self.model_version = str(data.get("modelVersion") or self.model_version)
        self.base_apr = safe_float(data.get("baseApr"), self.base_apr)
        self.penalty_pct = safe_float(data.get("penaltyPct"), self.penalty_pct)
        self.pure_rl_q = {
            str(state): {str(action): float(value) for action, value in actions.items()}
            for state, actions in (data.get("pure_rl_q") or {}).items()
        }
        self.borrower_premium_q = {
            str(state): {str(action): float(value) for action, value in actions.items()}
            for state, actions in (data.get("borrower_premium_q") or {}).items()
        }
        self.wholesaler_stats = {
            str(k): WholesalerStats(**v) for k, v in (data.get("wholesaler_stats") or {}).items()
        }
        self.active_loans = {
            str(k): LoanRecord(**v) for k, v in (data.get("active_loans") or {}).items()
        }
        self.quote_history = list(data.get("quote_history") or [])

    def _apr_state(self) -> str:
        deployed = sum(loan.principalAmount for loan in self.active_loans.values() if loan.status == "OPEN")
        utilization = deployed / max(1.0, self.capital)
        return str(bucket(utilization, (0.2, 0.7)))

    def _borrower_state(self, wholesaler_id: str) -> str:
        stats = self.wholesaler_stats.get(wholesaler_id) or WholesalerStats()
        if stats.principal <= 0:
            return "2|0|0"
        profit_ratio = stats.profit / max(1.0, stats.principal)
        default_rate = stats.defaultAmount / max(1.0, stats.principal)
        approval_rate = stats.approved / max(1.0, stats.requests)
        return "|".join(
            [
                str(bucket(profit_ratio, (-0.20, -0.05, 0.0, 0.05, 0.15))),
                str(bucket(default_rate, (0.01, 0.05, 0.10))),
                str(bucket(approval_rate, (0.25, 0.50, 0.80))),
            ]
        )

    def _choose_action(self, q_table: dict[str, dict[str, float]], state: str, action_space: tuple[float, ...], epsilon: float) -> float:
        actions = q_table.setdefault(state, {str(a): 0.0 for a in action_space})
        if random.random() < epsilon:
            return random.choice(list(action_space))
        best_value = max(actions.get(str(a), 0.0) for a in action_space)
        best_actions = [a for a in action_space if actions.get(str(a), 0.0) == best_value]
        return min(best_actions)

    def _update_q(self, q_table: dict[str, dict[str, float]], state: str | None, action: float | None, alpha: float, reward: float) -> None:
        if state is None or action is None:
            return
        actions = q_table.setdefault(state, {})
        key = str(action)
        old_q = float(actions.get(key, 0.0))
        actions[key] = old_q + alpha * (reward - old_q)

    def _estimate_wholesaler_score(self, wholesaler_id: str, ledger: dict[str, Any] | None) -> float:
        finance_requests = list((ledger or {}).get("financeRequests") or [])
        matching = [fr for fr in finance_requests if str(fr.get("wholesalerId") or "") == wholesaler_id]
        if not matching:
            return 0.5
        repaid = sum(safe_float(fr.get("repaidAmt")) for fr in matching)
        outstanding = sum(max(0.0, safe_float(fr.get("outstanding"))) for fr in matching)
        penalty = sum(safe_float(fr.get("penaltyAccum")) for fr in matching)
        settled = sum(1 for fr in matching if str(fr.get("status") or "").upper() == "SETTLED")
        total = len(matching)
        repayment_strength = repaid / max(1.0, repaid + outstanding + penalty)
        settlement_rate = settled / max(1.0, total)
        score = 0.4 * repayment_strength + 0.4 * settlement_rate + 0.2 * (1.0 - min(1.0, penalty / max(1.0, repaid + penalty)))
        return clamp(score, 0.1, 0.95)

    def quote(self, payload: dict[str, Any]) -> dict[str, Any]:
        wholesaler_id = str(payload.get("wholesalerId") or payload.get("borrowerId") or "")
        principal_amount = safe_float(payload.get("principalAmount"))
        tenor_days = max(1, safe_int(payload.get("tenorDaysRequested"), 30))
        ledger = payload.get("ledger") if isinstance(payload.get("ledger"), dict) else {}
        current_offer = payload.get("currentOffer") if isinstance(payload.get("currentOffer"), dict) else {}

        if not wholesaler_id:
            raise ValueError("wholesalerId is required")
        if principal_amount <= 0:
            raise ValueError("principalAmount must be positive")

        apr_state = self._apr_state()
        borrower_state = self._borrower_state(wholesaler_id)
        wholesaler_score = safe_float(payload.get("wholesalerScore"), self._estimate_wholesaler_score(wholesaler_id, ledger))
        apr_action = self._choose_action(self.pure_rl_q, apr_state, self.pure_rl_apr_actions, self.apr_epsilon)
        risk_action = self._choose_action(self.borrower_premium_q, borrower_state, self.borrower_premium_actions, self.borrower_epsilon)

        fallback_base = safe_float(current_offer.get("baseAPR"), self.base_apr)
        base_apr = apr_action if apr_action > 0 else fallback_base
        risk_premium = clamp(risk_action, self.borrower_min_risk_premium, self.borrower_max_risk_premium)
        apr_pct = clamp(base_apr + risk_premium, self.min_offer_apr, self.max_offer_apr)

        stats = self.wholesaler_stats.setdefault(wholesaler_id, WholesalerStats())
        stats.requests += 1.0

        reward_hint = 0.0
        if principal_amount > 0:
            utilization = sum(loan.principalAmount for loan in self.active_loans.values() if loan.status == "OPEN") / max(1.0, self.capital)
            reward_hint = (
                self.reward_weight_return * (apr_pct / 100.0) * (tenor_days / 365.0)
                + self.reward_weight_utilization * utilization
            )

        response = {
            "financierId": self.financier_id,
            "aprPct": round(apr_pct, 2),
            "baseAPR": round(base_apr, 2),
            "tenorDays": tenor_days,
            "penaltyPct": round(self.penalty_pct, 2),
            "action": {
                "aprAction": apr_action,
                "riskPremiumAction": risk_action,
            },
            "reward": round(reward_hint, 6),
            "state": {
                "aprState": apr_state,
                "borrowerState": borrower_state,
                "wholesalerScore": round(wholesaler_score, 4),
                "riskPremium": round(risk_premium, 4),
                "scoreAprAdjustment": 0.0,
            },
            "modelVersion": self.model_version,
        }
        self.quote_history.append(
            {
                "ts": time.time(),
                "wholesalerId": wholesaler_id,
                "principalAmount": principal_amount,
                "tenorDays": tenor_days,
                "aprPct": response["aprPct"],
                "aprState": apr_state,
                "borrowerState": borrower_state,
                "aprAction": apr_action,
                "riskAction": risk_action,
            }
        )
        self._save()
        return response

    def loan_issued(self, payload: dict[str, Any]) -> dict[str, Any]:
        wholesaler_id = str(payload.get("wholesalerId") or "")
        principal_amount = safe_float(payload.get("principalAmount"))
        tenor_days = max(1, safe_int(payload.get("tenorDays"), safe_int(payload.get("tenorDaysRequested"), 30)))
        apr_pct = safe_float(payload.get("aprPct"))
        if not wholesaler_id:
            raise ValueError("wholesalerId is required")
        if principal_amount <= 0:
            raise ValueError("principalAmount must be positive")
        if apr_pct <= 0:
            raise ValueError("aprPct must be positive")

        loan_id = str(payload.get("loanId") or uuid.uuid4().hex)
        record = LoanRecord(
            loanId=loan_id,
            wholesalerId=wholesaler_id,
            principalAmount=principal_amount,
            tenorDays=tenor_days,
            aprPct=apr_pct,
            issuedAt=time.time(),
            aprState=(payload.get("state") or {}).get("aprState") if isinstance(payload.get("state"), dict) else payload.get("aprState"),
            aprAction=safe_float((payload.get("action") or {}).get("aprAction")) if isinstance(payload.get("action"), dict) else safe_float(payload.get("aprAction")),
            borrowerState=(payload.get("state") or {}).get("borrowerState") if isinstance(payload.get("state"), dict) else payload.get("borrowerState"),
            borrowerAction=safe_float((payload.get("action") or {}).get("riskPremiumAction")) if isinstance(payload.get("action"), dict) else safe_float(payload.get("borrowerAction")),
            expectedReward=safe_float(payload.get("reward")),
        )
        self.active_loans[loan_id] = record
        self.wallet -= principal_amount
        stats = self.wholesaler_stats.setdefault(wholesaler_id, WholesalerStats())
        stats.approved += 1.0
        self._save()
        return {
            "ok": True,
            "loanId": loan_id,
            "wallet": round(self.wallet, 2),
            "capital": round(self.capital, 2),
        }

    def loan_closed(self, payload: dict[str, Any]) -> dict[str, Any]:
        loan_id = str(payload.get("loanId") or "")
        if not loan_id:
            raise ValueError("loanId is required")
        loan = self.active_loans.get(loan_id)
        if not loan:
            raise ValueError(f"Unknown loanId: {loan_id}")

        principal_paid = safe_float(payload.get("principalPaid"))
        interest_paid = safe_float(payload.get("interestPaid"))
        penalty_paid = safe_float(payload.get("penaltyPaid"))
        default_amount = max(0.0, safe_float(payload.get("defaultAmount")))
        if default_amount <= 0:
            default_amount = max(0.0, loan.principalAmount - principal_paid)

        realized_profit = interest_paid + penalty_paid - default_amount
        reward = 0.0
        if loan.principalAmount > 0:
            profit_ratio = realized_profit / loan.principalAmount
            capital_growth = realized_profit / max(1.0, self.capital)
            utilization = sum(
                item.principalAmount for key, item in self.active_loans.items()
                if key != loan_id and item.status == "OPEN"
            ) / max(1.0, self.capital)
            decline_penalty = max(0.0, -capital_growth)
            reward = (
                self.reward_weight_return * profit_ratio
                + self.reward_weight_growth * capital_growth
                - self.reward_weight_decline * decline_penalty
                + self.reward_weight_utilization * utilization
            )
            reward = clamp(reward, -1.0, 1.0)

        self._update_q(self.pure_rl_q, loan.aprState, loan.aprAction, self.apr_alpha, reward)
        self._update_q(self.borrower_premium_q, loan.borrowerState, loan.borrowerAction, self.borrower_alpha, reward)

        self.wallet += principal_paid + interest_paid + penalty_paid
        self.capital = max(0.0, self.capital + realized_profit)

        stats = self.wholesaler_stats.setdefault(loan.wholesalerId, WholesalerStats())
        stats.closed += 1.0
        stats.principal += loan.principalAmount
        stats.profit += realized_profit
        stats.defaultAmount += default_amount
        if default_amount > 0:
            stats.defaults += 1.0

        loan.status = "CLOSED"
        loan.closedAt = time.time()
        loan.realizedReward = reward
        loan.principalPaid = principal_paid
        loan.interestPaid = interest_paid
        loan.penaltyPaid = penalty_paid
        loan.defaultAmount = default_amount

        self._save()
        return {
            "ok": True,
            "loanId": loan_id,
            "reward": round(reward, 6),
            "wallet": round(self.wallet, 2),
            "capital": round(self.capital, 2),
        }

    def state_snapshot(self) -> dict[str, Any]:
        return {
            "financierId": self.financier_id,
            "wallet": round(self.wallet, 2),
            "capital": round(self.capital, 2),
            "initialCapital": round(self.initial_capital, 2),
            "baseApr": round(self.base_apr, 2),
            "penaltyPct": round(self.penalty_pct, 2),
            "modelVersion": self.model_version,
            "openLoans": len([loan for loan in self.active_loans.values() if loan.status == "OPEN"]),
            "pureRlStates": len(self.pure_rl_q),
            "borrowerRlStates": len(self.borrower_premium_q),
            "wholesalers": {k: asdict(v) for k, v in self.wholesaler_stats.items()},
            "recentQuotes": self.quote_history[-10:],
        }


class AgentHandler(BaseHTTPRequestHandler):
    agent: FinancierAgent | None = None
    lock = threading.Lock()

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send_json(200, {"ok": True, "financierId": self.agent.financier_id if self.agent else None})
            return
        if parsed.path == "/state":
            with self.lock:
                self._send_json(200, {"ok": True, "data": self.agent.state_snapshot() if self.agent else None})
            return
        self._send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = self._read_json()
            with self.lock:
                if parsed.path == "/quote":
                    result = self.agent.quote(payload)
                elif parsed.path == "/loan-issued":
                    result = self.agent.loan_issued(payload)
                elif parsed.path == "/loan-closed":
                    result = self.agent.loan_closed(payload)
                else:
                    self._send_json(404, {"ok": False, "error": "Not found"})
                    return
            self._send_json(200, {"ok": True, "data": result})
        except Exception as exc:  # noqa: BLE001
            self._send_json(400, {"ok": False, "error": str(exc)})

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a live RL+RL financier quote service.")
    parser.add_argument("--financier-id", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8101)
    parser.add_argument("--wallet", type=float, default=5_000_000.0)
    parser.add_argument("--capital", type=float, default=5_000_000.0)
    parser.add_argument("--base-apr", type=float, default=12.0)
    parser.add_argument("--penalty-pct", type=float, default=3.0)
    parser.add_argument("--state-file")
    parser.add_argument("--q-table-file")
    parser.add_argument("--model-version", default="live-rl-rl-agent-v1")
    parser.add_argument("--min-offer-apr", type=float, default=6.0)
    parser.add_argument("--max-offer-apr", type=float, default=48.0)
    parser.add_argument("--apr-epsilon", type=float, default=0.05)
    parser.add_argument("--borrower-epsilon", type=float, default=0.05)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    agent = FinancierAgent(
        financier_id=args.financier_id,
        wallet=args.wallet,
        capital=args.capital,
        initial_capital=args.capital,
        state_file=args.state_file,
        model_version=args.model_version,
        base_apr=args.base_apr,
        min_offer_apr=args.min_offer_apr,
        max_offer_apr=args.max_offer_apr,
        penalty_pct=args.penalty_pct,
        apr_epsilon=args.apr_epsilon,
        borrower_epsilon=args.borrower_epsilon,
    )
    agent.load_state()
    if args.q_table_file:
        agent.load_q_tables(args.q_table_file)
    agent._save()

    AgentHandler.agent = agent
    server = ThreadingHTTPServer((args.host, args.port), AgentHandler)
    print(
        json.dumps(
            {
                "ok": True,
                "message": "RL financier service started",
                "financierId": args.financier_id,
                "host": args.host,
                "port": args.port,
                "stateFile": args.state_file,
                "qTableFile": args.q_table_file,
            }
        )
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
