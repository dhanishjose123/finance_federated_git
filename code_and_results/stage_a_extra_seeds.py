#!/usr/bin/env python
"""Power-boosting re-run of Stage A (Isolated RL vs. FedAvg) with additional
seeds, to be pooled with the original 3-seed run for a higher-powered
significance test.

Why: the original Stage A comparison (checked_results_20260816/
stage_a_isolated_vs_federated/) used 3 seeds x 3 capitals x 4 default
scenarios = 36 matched pairs. Power analysis on the observed effect (mean
return delta +2.49 pp, paired-t p=0.41) shows that, if the true effect
equals the current point estimate, roughly 17 total seeds (~204 matched
pairs) would be needed to reach p<0.05 on the return-rate delta with a
paired t-test. This script runs ONLY the additional seeds (the original 3
seeds' results already exist and are reused, not re-run).

This is exploratory, not guaranteed: if the true effect is smaller than the
n=36 estimate suggests, the result may still not reach significance even
with the extra seeds -- that would still be a meaningful, more precise
answer (a tighter confidence interval around a genuinely small/null
effect), not a wasted run.

CHECKPOINTING: unlike run_experiment() (which only writes to disk once the
entire multi-seed loop finishes), this script runs and saves ONE SEED AT A
TIME, writing that seed's raw CSV to disk immediately after it completes
(stage_a_extra_seeds/seed_<seed>/). If interrupted (power loss, crash,
manual stop), everything up to the last fully-completed seed is safe on
disk. Re-running this script skips any seed whose output file already
exists, so it resumes automatically rather than redoing finished work.

Same simulation design as the original Stage A run in every other respect:
4000-day horizon, 3 capital levels, 4 default severity profiles, non-IID
borrower segmentation applied to both policy groups, matched counterfactual
(separate_policy_runs=True) design. Only SEEDS differs.

Run with: python stage_a_extra_seeds.py
Output: stage_a_extra_seeds/seed_<seed>/stage_a_extra_seed<seed>_raw_summary.csv
  (one subfolder per seed; combine_and_retest_significance.py reads all of
  them automatically -- you do not need to merge anything by hand)

Estimated runtime: ~24 runs per seed (3 capitals x 4 scenarios x 2 policies).
The original Stage A run averaged ~131s/run, so budget roughly 50-55 minutes
per additional seed on comparable hardware. With the 14 seeds below, budget
~12-13 hours total, safely resumable if interrupted partway through.
"""

from __future__ import annotations

from pathlib import Path

import federated_comparison_common as fc

# 14 additional seeds, chosen once and fixed here (not tuned post-hoc on any
# result) to keep the run pre-registered and auditable. Distinct from the
# original Stage A/B3 seeds [709098, 436570, 831197]. Feel free to truncate
# this list (e.g. to the first 5 or 7) for a cheaper, lower-power first pass.
EXTRA_SEEDS = [
    100237, 148832, 205617, 259901, 314159,
    371828, 426404, 482321, 538907, 591237,
    647701, 703909, 758243, 812077,
]

POLICY_GROUPS = ["rl", "fl_rl"]
POLICY_LABELS = {"rl": "Isolated RL", "fl_rl": "FedAvg (federated)"}
NON_IID_GROUP_POLICIES = ("rl", "fl_rl")
BASE_OUTPUT_DIR = Path("stage_a_extra_seeds")

if __name__ == "__main__":
    for i, seed in enumerate(EXTRA_SEEDS, start=1):
        seed_dir = BASE_OUTPUT_DIR / f"seed_{seed}"
        prefix = f"stage_a_extra_seed{seed}"
        done_marker = seed_dir / f"{prefix}_raw_summary.csv"

        if done_marker.exists():
            print(f"[{i}/{len(EXTRA_SEEDS)}] seed={seed} already done ({done_marker}) -- skipping.")
            continue

        print(f"[{i}/{len(EXTRA_SEEDS)}] Running seed={seed} ...")
        fc.SEEDS = [seed]  # monkeypatch: run exactly this one seed
        fc.run_experiment(
            title=f"Stage A EXTRA SEED {seed}: Isolated RL vs. Federated (FedAvg)",
            policy_groups=POLICY_GROUPS,
            policy_labels=POLICY_LABELS,
            non_iid_group_policies=NON_IID_GROUP_POLICIES,
            baseline_policy="rl",
            other_policies=["fl_rl"],
            output_dir=seed_dir,
            output_prefix=prefix,
            separate_policy_runs=True,
        )
        print(f"[{i}/{len(EXTRA_SEEDS)}] seed={seed} done and saved to {done_marker}.")

    print(f"\nAll {len(EXTRA_SEEDS)} extra seeds complete (or already were). "
          f"Run combine_and_retest_significance.py next.")
