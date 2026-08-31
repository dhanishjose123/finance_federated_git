# Reviewer Package

This folder contains a compact reviewer-facing package for the study:

**Adaptive Supply-Chain Finance under Fragmented Borrower Information: Federated Learning Evidence from a High-Value Agricultural Supply Chain**

The full working folder contains additional raw simulations, intermediate outputs, and local build files. This package keeps only the files needed to inspect the manuscript, reproduce the main simulation logic, and verify the reported results.

## Folder Contents

- `manuscript/`: manuscript source, bibliography, compiled manuscript PDF, supplementary material, and manuscript figures.
- `review_documents/`: fact-check and reference-check notes used during manuscript preparation.
- `code_and_results/`: simulation code, compact result summaries, trained Q-table examples, Hyperledger/Caliper artifacts, and experiment notes.

## What the Study Evaluates

The study tests a blockchain-enabled supply-chain finance workflow with:

- RL-based base APR selection by financiers.
- Borrower-side RL risk-premium learning.
- Ledger-mediated federated Q-table aggregation across financiers.
- Hyperledger Fabric workflow support for auction, finance request, disbursement, sale, repayment, and federated model-update functions.

Raw borrower records remain local to each financier. The shared objects are Q-table/model updates and aggregated Q-table versions. The implementation should therefore be described as privacy-conscious rather than formally privacy-preserving.

## Experimental Evidence

The manuscript reports:

- preparatory RL parameter selection,
- isolated RL versus federated RL borrower screening,
- aggregation-rule comparison across FedAvg, FedProx, SCAFFOLD, and visit-count-weighted aggregation,
- a 50-borrower SCAFFOLD correction-rate sensitivity check,
- fixed-capital scalability tests,
- Hyperledger Caliper benchmarking of key smart-contract functions.

Large raw simulation workbooks and local cache/build files are intentionally excluded. The included spreadsheets and reports are the compact artifacts used to support the manuscript tables and claims.

## Reproducibility Notes

Python dependencies for the simulation code are listed in:

```text
code_and_results/requirements.txt
```

Install them with:

```bash
pip install -r code_and_results/requirements.txt
```

The main simulation engine in the compact package is:

```text
code_and_results/egt_apr_simulation.py
```

Some experiments are computationally heavy because they use multiple seeds, capital levels, default profiles, and borrower populations. Reviewers can inspect the included result summaries without rerunning every experiment.

## Hyperledger Material

The refreshed Hyperledger chaincode file is available at:

```text
code_and_results/hyperledger/cardamom_11.js
```
