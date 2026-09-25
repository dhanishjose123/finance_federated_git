#!/usr/bin/env python
"""Power-boosting re-run of Stage B3 (FedAvg vs. FedProx vs. SCAFFOLD,
c_lr=0.25) with additional seeds, to be pooled with the original 3-seed run
for a higher-powered significance test.

Why: the original Stage B3 comparison (stage_b3_scaffold_lr025_comparison/)
used 3 seeds x 3 capitals x 4 default scenarios = 36 matched pairs per
comparison. Power analysis on the observed effects shows very different
seed requirements per comparison, since the effects are small and differ in
size:
  - FedProx vs. FedAvg: effects are tiny (p>0.16 on all four tests already);
    reaching significance would need on the order of 100+ seeds. Not a
    realistic target for this script -- treat FedProx as settled-null.
  - SCAFFOLD vs. FedAvg, pooled return: paired-t p=0.60 (very small effect,
    would need on the order of 40+ total seeds) but Wilcoxon p=0.018 (already
    significant at n=36, though not corroborated by the t-test or the
    stressed-only subset). More seeds mainly serve here to check whether the
    Wilcoxon signal is real or a multiple-comparisons artefact, not to chase
    t-test significance.

Given that, this script is a lower priority than stage_a_extra_seeds.py --
run Stage A's extra seeds first if compute time is limited.

CHECKPOINTING: like the rewritten stage_a_extra_seeds.py, this script runs
and saves ONE SEED AT A TIME, writing that seed's raw CSV to disk
immediately after it completes (stage_b3_extra_seeds/seed_<seed>/). If
interrupted (power loss, crash, manual stop), everything up to the last
fully-completed seed is safe on disk. Re-running this script skips any seed
whose output file already exists, so it resumes automatically.

Same simulation design as the original Stage B3 run in every other respect:
4000-day horizon, 3 capital levels, 4 default severity profiles, non-IID
borrower segmentation applied to all three policy groups, matched
counterfactual (separate_policy_runs=True) design, SCAFFOLD correction rate
patched to c_lr=0.25. Only SEEDS differs.

Run with: python stage_b3_extra_seeds.py
Output: stage_b3_extra_seeds/seed_<seed>/stage_b3_extra_seed<seed>_raw_summary.csv
  (one subfolder per seed; combine_and_retest_significance.py reads all of
  them automatically)

Estimated runtime: 36 runs per seed (3 capitals x 4 scenarios x 3 policies).
The original Stage B3 run averaged ~78s/run, so budget roughly 45-50 minutes
per additional seed on comparable hardware. With the 14 seeds below, budget
~10-12 hours total, safely resumable if interrupted partway through.
"""

from __future__ import annotations

from pathlib import Path

import egt_apr_simulation as sim
import federated_comparison_common as fc

SCAFFOLD_C_LR = 0.25

# Same 14 seeds as stage_a_extra_seeds.py, so a seed's Stage A and Stage B3
# runs use the identical random draw if you choose to run both -- not
# required for validity, but keeps the overall extra-seed experiment tidy.
EXTRA_SEEDS = [
    100237, 148832, 205617, 259901, 314159,
    371828, 426404, 482321, 538907, 591237,
    647701, 703909, 758243, 812077,
]

POLICY_GROUPS = ["fl_rl", "fl_rl_prox", "fl_rl_scaffold"]
POLICY_LABELS = {
    "fl_rl": "FedAvg (baseline)",
    "fl_rl_prox": "FedProx",
    "fl_rl_scaffold": f"SCAFFOLD (c_lr={SCAFFOLD_C_LR:.2f})",
}
NON_IID_GROUP_POLICIES = ("fl_rl", "fl_rl_prox", "fl_rl_scaffold")
BASE_OUTPUT_DIR = Path("stage_b3_extra_seeds")

_original_build_financiers = sim.build_financiers


def _patched_build_financiers(*args, **kwargs):
    """Same technique as stage_b3_scaffold_lr025_comparison.py: force every
    fl_rl_scaffold financier onto c_lr=0.25 instead of the class default."""
    financiers = _original_build_financiers(*args, **kwargs)
    for financier in financiers:
        if financier.wholesaler_policy == "fl_rl_scaffold":
            financier.scaffold_c_lr = SCAFFOLD_C_LR
    return financiers


if __name__ == "__main__":
    sim.build_financiers = _patched_build_financiers
    try:
        for i, seed in enumerate(EXTRA_SEEDS, start=1):
            seed_dir = BASE_OUTPUT_DIR / f"seed_{seed}"
            prefix = f"stage_b3_extra_seed{seed}"
            done_marker = seed_dir / f"{prefix}_raw_summary.csv"

            if done_marker.exists():
                print(f"[{i}/{len(EXTRA_SEEDS)}] seed={seed} already done ({done_marker}) -- skipping.")
                continue

            print(f"[{i}/{len(EXTRA_SEEDS)}] Running seed={seed} ...")
            fc.SEEDS = [seed]  # monkeypatch: run exactly this one seed
            fc.run_experiment(
                title=f"Stage B3 EXTRA SEED {seed}: FedAvg vs. FedProx vs. SCAFFOLD (c_lr={SCAFFOLD_C_LR:.2f})",
                policy_groups=POLICY_GROUPS,
                policy_labels=POLICY_LABELS,
                non_iid_group_policies=NON_IID_GROUP_POLICIES,
                baseline_policy="fl_rl",
                other_policies=["fl_rl_prox", "fl_rl_scaffold"],
                output_dir=seed_dir,
                output_prefix=prefix,
                separate_policy_runs=True,
            )
            print(f"[{i}/{len(EXTRA_SEEDS)}] seed={seed} done and saved to {done_marker}.")
    finally:
        sim.build_financiers = _original_build_financiers

    print(f"\nAll {len(EXTRA_SEEDS)} extra seeds complete (or already were). "
          f"Run combine_and_retest_significance.py next.")
