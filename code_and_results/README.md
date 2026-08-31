# Adaptive Supply-Chain Finance with Federated Reinforcement Learning

This folder contains the manuscript, simulation code, figures, benchmark material, and checked results for the study:

**Adaptive Supply-Chain Finance under Fragmented Borrower Information: Federated Learning Evidence from a High-Value Agricultural Supply Chain**

The study evaluates a blockchain-enabled supply-chain finance workflow in which financiers use reinforcement learning (RL) to set finance terms and federated RL to aggregate borrower-screening Q-tables without pooling raw borrower records.

## Main Components

- `manuscript/`: current LaTeX manuscript, bibliography, compiled PDF, supplementary material, and final figure PDFs.
- `latex/`: editable LaTeX/TikZ figure sources used to generate the manuscript figures.
- `egt_apr_simulation.py`: core discrete-event simulation engine for APR selection, borrower screening, defaults, repayment, and federated aggregation.
- `federated_comparison_common.py`: shared utilities for staged federated comparison experiments.
- `stage_b_fedavg_fedprox_scaffold.py`: Stage 2 aggregation-rule comparison among FedAvg, FedProx, and SCAFFOLD.
- `stage_b2_visitweighted_comparison.py`: additional comparison for the visit-count-weighted Q-table aggregation rule.
- `scaffold_sensitivity_50_borrowers.py`: 50-borrower SCAFFOLD correction-rate sensitivity test against isolated RL.
- `run_multiple_capitals.py`: older multi-capital finance simulation runner retained for reproducibility.
- `fabric_integration/`: Python service material for linking RL finance decisions with the Fabric workflow.
- `hyperledger/`: Caliper and blockchain benchmark artifacts retained from earlier experiments.
- `chaincode/cardamom_11.js`: Hyperledger Fabric smart contract included in the GitHub-ready package.
- `checked_results_20260816/`: curated checked result folders used for the manuscript tables.
- `finance_federated_git/`: compact reviewer-facing package prepared for repository upload.

## Experimental Structure

The manuscript uses a staged evaluation design.

1. **Preparatory parameter selection**  
   Selects the RL base-APR learner and borrower-side RL screening parameters. This is not treated as a numbered experimental stage in the manuscript.

2. **Stage 1: isolated versus federated borrower screening**  
   Compares isolated RL borrower screening with federated RL borrower screening under matched seed, capital, and default-severity settings.

3. **Stage 2: federated aggregation-rule comparison**  
   Compares FedAvg, FedProx, a tabular SCAFFOLD adaptation, and a visit-count-weighted aggregation rule under non-IID borrower portfolios.

4. **SCAFFOLD sensitivity check**  
   Tests SCAFFOLD correction rates `0.25`, `0.50`, `0.75`, and `1.00` against isolated RL with 50 borrowers. The completed run is stored in `scaffold_sensitivity_50_borrowers/`.

5. **Stage 3: fixed-capital scalability**  
   Increases the number of wholesalers while keeping per-financier capital fixed. The checked results are in `checked_results_20260816/stage_c_fixed_2000d_scalability/`.

6. **Blockchain benchmarking**  
   Uses Hyperledger Caliper to test the main smart-contract functions, including auction, finance, sale, repayment, and federated Q-table update operations.

The folder also contains proportional-capital scalability outputs in `checked_results_20260816/stage_d_proportional_results_checked_20260816/`. These are retained as additional checked material, but they are not presented as a numbered stage in the current manuscript.

## Key Result Locations

- Stage 1 isolated-vs-federated results: `checked_results_20260816/stage_a_isolated_vs_federated/`
- Stage 2 FedAvg/FedProx/SCAFFOLD results: `checked_results_20260816/stage_b_fedavg_fedprox_scaffold/`
- Stage 2 visit-weighted results: `stage_b2_visitweighted_comparison/`
- SCAFFOLD 50-borrower sensitivity results: `scaffold_sensitivity_50_borrowers/`
- Stage 3 fixed-capital scalability results: `checked_results_20260816/stage_c_fixed_2000d_scalability/`
- Additional proportional-capital scalability outputs: `checked_results_20260816/stage_d_proportional_results_checked_20260816/`
- Compact reviewer results: `checked_results_20260816/simulation_results_for_reviewers/`

## Running the Main Scripts

Install the Python dependencies:

```bash
pip install pandas openpyxl simpy
```

Run the 50-borrower SCAFFOLD sensitivity test:

```bash
python scaffold_sensitivity_50_borrowers.py
```

Run the Stage 2 FedAvg/FedProx/SCAFFOLD comparison:

```bash
python stage_b_fedavg_fedprox_scaffold.py
```

Run the visit-weighted aggregation comparison:

```bash
python stage_b2_visitweighted_comparison.py
```

The experiment scripts write checkpoint CSV files and final Excel summaries where applicable. Several full-scale simulations are computationally heavy, so the checked result folders are included for manuscript verification.

## Manuscript Build

The active manuscript is:

```text
manuscript/manuscript.tex
```

Build from the `manuscript/` folder:

```bash
pdflatex -interaction=nonstopmode manuscript.tex
bibtex manuscript
pdflatex -interaction=nonstopmode manuscript.tex
pdflatex -interaction=nonstopmode manuscript.tex
```

The figure PDFs used by the manuscript are already present in `manuscript/`. Editable figure sources are in `latex/`.

## Notes on Federated Learning Claims

The project implements ledger-mediated federated Q-table aggregation. Raw borrower records remain local to each financier. The shared objects are model-level Q-table updates and aggregated Q-table versions. The prototype should be described as privacy-conscious, not as formally privacy-preserving, because it does not implement differential privacy, secure aggregation, or secure multiparty computation.

## Reviewer Package

The folder `finance_federated_git/` is a compact package for reviewers and repository upload. It intentionally excludes large raw workbooks, local caches, and intermediate files. Use the full working folder when checking the latest scripts and checked results.
