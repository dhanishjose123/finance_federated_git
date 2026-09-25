# Supply-Chain Finance: Code and Results

Research code and compact evidence for **Blockchain-Enabled Supply Chain Finance with Reinforcement Learning Interest-Rate Adaptation and Decentralised Q-Table Aggregation**.

This is the project's only GitHub folder. The manuscript, bibliography and manuscript figures are intentionally excluded.

## Organisation

- `code_and_results/`: simulation engine, experiment runners and compact results.
- `code_and_results/rl_optimization/`: Stage 1 base-APR and Stage 2 borrower-screening selection.
- `code_and_results/combined_significance/`: pooled Stage 3 and Stage 4 comparisons.
- `code_and_results/chaincode/`, `code_and_results/hyperledger/`: retained chaincode and Caliper evidence.
- `code_and_results/fabric_integration/`: integration code.
- `docs/MANUSCRIPT_MAP.md`: stage-to-code and evidence map, with supplementary work identified separately.
- `docs/package_manifest.csv`: refreshed file inventory with source paths and SHA-256 hashes.
- `docs/BENCHMARK_NOTES.md`: workload counts, units, software evidence and aggregation interpretation.
- `code_and_results/README.md`: current stage definitions, metric denominators and reproduction instructions.

Run Python scripts from `code_and_results/` to preserve their relative paths:

```sh
cd code_and_results
pip install -r requirements.txt
```

The four stages are base-APR selection, borrower-screening parameter selection, isolated versus federated screening, and aggregation-rule comparison. Older Stage A/B/C/D filenames are retained to avoid breaking paths. Scalability and visit-weighted comparisons are supplementary.

The full-strategy comparison has partial summaries for three strategies at seed 709098, but no final combined report. Do not treat these partial outputs as a completed comparison. See the map for other limitations.

Raw borrower records remain local in the proposed workflow; ledger-mediated aggregation shares model updates. Results should be interpreted under the tested simulation settings.

Older EGT experiments, nested copies and manuscript-review documents are archived outside this repository in the working project's `optional_material/git_archive_*` folder. Relevant supplementary results and Caliper logs are retained. The refresh excludes large per-run workbooks and caches. No experiments, deployment, commits or remote publication are performed by packaging.
