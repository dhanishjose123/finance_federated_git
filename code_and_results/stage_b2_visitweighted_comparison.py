#!/usr/bin/env python
"""Stage B2: does visit-count-weighted aggregation beat FedAvg, FedProx, and
SCAFFOLD (the Stage B winner)?

fl_rl_visitweighted is a new tabular-specific aggregation rule: instead of
averaging each financier's Q-value for a (state, action) cell uniformly
(FedAvg) or correcting for drift (FedProx / SCAFFOLD), each financier's
contribution to a cell is weighted by how many times that financier has
personally visited (updated) that cell. Financiers with more local
experience in a given borrower-risk state carry more influence over the
shared estimate for that state. This exploits a per-cell confidence signal
that is only available in tabular Q-learning -- it has no direct analogue in
gradient-based FedAvg/FedProx/SCAFFOLD.

Run design matches Stage B exactly: each aggregation rule is run separately
under the same seed, capital, default scenario, and non-IID borrower
segmentation, so this is a matched counterfactual comparison of four
aggregation rules, not a shared-market competition between them.

Run with: python stage_b2_visitweighted_comparison.py
Output: stage_b2_visitweighted_comparison/
"""

from __future__ import annotations

from pathlib import Path

from federated_comparison_common import run_experiment

POLICY_GROUPS = ["fl_rl", "fl_rl_prox", "fl_rl_scaffold", "fl_rl_visitweighted"]
POLICY_LABELS = {
    "fl_rl": "FedAvg (baseline)",
    "fl_rl_prox": "FedProx",
    "fl_rl_scaffold": "SCAFFOLD (tabular adaptation)",
    "fl_rl_visitweighted": "Visit-weighted (tabular-specific)",
}
NON_IID_GROUP_POLICIES = ("fl_rl", "fl_rl_prox", "fl_rl_scaffold", "fl_rl_visitweighted")

if __name__ == "__main__":
    run_experiment(
        title="Stage B2: FedAvg vs. FedProx vs. SCAFFOLD vs. Visit-Weighted",
        policy_groups=POLICY_GROUPS,
        policy_labels=POLICY_LABELS,
        non_iid_group_policies=NON_IID_GROUP_POLICIES,
        baseline_policy="fl_rl",
        other_policies=["fl_rl_prox", "fl_rl_scaffold", "fl_rl_visitweighted"],
        output_dir=Path("stage_b2_visitweighted_comparison"),
        output_prefix="stage_b2",
        separate_policy_runs=True,
    )
