#!/usr/bin/env python
"""Stage B: given financiers do federate, which aggregation rule is best?

Compares fl_rl (FedAvg -- uniform averaging) vs fl_rl_prox (FedProx -- local
updates pulled toward the last global Q-table via a proximal term) vs
fl_rl_scaffold (a tabular adaptation of SCAFFOLD's control-variate drift
correction, Karimireddy et al. 2020).

Each aggregation strategy is run separately under the same seed, capital,
default scenario, and non-IID borrower segmentation. This keeps Stage B as a
matched counterfactual comparison of federation rules rather than a shared
market competition between rules.

Run with: python stage_b_fedavg_fedprox_scaffold.py
Output: stage_b_fedavg_fedprox_scaffold/
"""

from __future__ import annotations

from pathlib import Path

from federated_comparison_common import run_experiment

POLICY_GROUPS = ["fl_rl", "fl_rl_prox", "fl_rl_scaffold"]
POLICY_LABELS = {
    "fl_rl": "FedAvg (baseline)",
    "fl_rl_prox": "FedProx",
    "fl_rl_scaffold": "SCAFFOLD (tabular adaptation)",
}
NON_IID_GROUP_POLICIES = ("fl_rl", "fl_rl_prox", "fl_rl_scaffold")

if __name__ == "__main__":
    run_experiment(
        title="Stage B: FedAvg vs. FedProx vs. SCAFFOLD",
        policy_groups=POLICY_GROUPS,
        policy_labels=POLICY_LABELS,
        non_iid_group_policies=NON_IID_GROUP_POLICIES,
        baseline_policy="fl_rl",
        other_policies=["fl_rl_prox", "fl_rl_scaffold"],
        output_dir=Path("stage_b_fedavg_fedprox_scaffold"),
        output_prefix="stage_b",
        separate_policy_runs=True,
    )
