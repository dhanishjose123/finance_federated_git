# Manuscript Fact-Check Report

Target checked: `manuscript/manuscript.tex`  
Checked against: local simulation workbooks/reports, local Caliper CSV outputs, LaTeX build logs, bibliography, and targeted web verification for suspicious references.

## Executive Summary

Most final finance-performance claims in the abstract and Stage 4 comparison are internally supported by `summary_across_capitals_seed_averaged.xlsx` when interpreted as totals across 36 seed-level runs. The previously identified EGT model-selection, Caliper benchmark, and bibliography DOI issues have been corrected in the manuscript variants.

## Previously Checked Corrections

### 1. EGT model-selection table/text conflicts with current result files

Location: `manuscript.tex`, around lines 576 and 602-612.

Manuscript claim:
- Regular EGT is the best EGT model.
- Regular EGT total final capital is `199.86M`.

Current local evidence:
- `egt_model_selection/egt_model_selection_results.xlsx`, sheet `EGT_Model_Ranking`, ranks `egt_linear_reinforcement` first.
- Current values are approximately:
  - `egt_linear_reinforcement`: `194.638M`
  - regular `egt`: `194.617M`
  - `egt_fermi`: `194.595M`
- `egt_model_selection/egt_model_selection_detailed_report.md` also says the best EGT borrower model is `egt_linear_reinforcement`, while regular EGT may still be selected for simplicity/explainability because the gap is small.

Recommended correction:
- Either update Table `EGT borrower model-selection results` to the current workbook values, or explicitly state that regular EGT was selected for interpretability despite being narrowly second in the latest ranking.
- Suggested wording:
  > The latest EGT-family comparison ranked the linear-reinforcement variant marginally first, while regular EGT was a very close second. Because the gap among EGT variants was small and regular EGT is simpler to justify analytically, regular EGT was retained for subsequent parameter tuning.

### 2. Caliper `bulkPurchasePacket` benchmark row now matches local CSV

Location: `manuscript.tex`, Table `caliper-500tps-results`, around lines 885-927.

Current manuscript row:
- `bulkPurchasePacket`: success `4764`, fail `236`, throughput `160.4`.

Current local evidence:
- `hyperledger/throughput_results_all (1).csv`
- `github_review_upload/hyperledger/throughput_results_all.csv`
- For function `purchase`, load `500`: success `4764`, fail `236`, send rate `279.3`, avg latency `10.56`, throughput `160.4`, payload `38`.

Status:
- Corrected. The text now reports `4764` successful and `236` failed transactions and explains the failures as concurrent MVCC contention in the packet-purchase workload.

### 3. Bibliography DOI typo for `integrating2026`

Location: `references.bib`, entry `integrating2026`.

Current entry:
- Previously used the wrong `33594` article identifier in the DOI/URL.

Verified source:
- Nature page gives DOI `10.1038/s41598-026-35594-3` for "Integrating transparency and privacy in grievance redressal through Hyperledger Fabric with multi-organization support".

Status:
- Corrected. The bibliography entries now use `10.1038/s41598-026-35594-3`.

## Supported Claims

### Final RL+EGT comparison is supported

Location: abstract and Table `stage4-final-results`.

Local calculation from `summary_across_capitals_seed_averaged.xlsx`, sheet `Financier_Averages`, multiplied across three seeds:

| Model | Manuscript final capital | Checked value | Manuscript default ratio | Checked value |
|---|---:|---:|---:|---:|
| Optimised RL APR + EGT screening | 252.45M | 252.4457M | 0.83% | 0.8345% |
| Optimised RL APR + RL screening | 241.85M | 241.8507M | 2.44% | 2.4352% |
| Optimised RL APR + no screening | 227.30M | 227.3009M | 12.20% | 12.2024% |
| Fixed 10% + none | 201.89M | 201.8885M | 3.55% | 3.5522% |
| Fixed 6% + none | 196.87M | 196.8720M | 30.52% | 30.5165% |
| Fixed 8% + none | 195.40M | 195.4016M | 6.82% | 6.8228% |

The abstract claim that RL+EGT wins `9/12` averaged scenarios is also supported. It wins all low-, medium-, and high-default scenarios across 1M, 5M, and 10M. It loses the no-default scenarios to RL+RL at 1M and fixed 6% at 5M and 10M.

### EGT parameter-optimization table is supported

Location: `manuscript.tex`, Table `borrower-egt-optimization-results`.

Local evidence:
- `egt_optimization/egt_parameter_optimization_results.xlsx`, sheet `Parameter_Ranking`.

The top row matches:
- alpha `0.30`
- eta `200`
- total final capital `275.69M`
- average APR `12.25%`
- default-to-initial-capital ratio `1.83%`
- utilization `0.544`

### Borrower-side RL optimization table is supported

Location: `manuscript.tex`, Table `borrower-rl-optimization-results`.

Local evidence:
- `rl_optimization/rl_borrower_opt/borrower_rl_parameter_optimization_results.xlsx`, sheet `Parameter_Ranking`.

The top row matches:
- borrower alpha `0.10`
- borrower gamma `0.70`
- borrower epsilon `0.05`
- coarse 4 pp premium grid
- total final capital `243.59M`
- average APR `11.22%`
- default ratio `7.95%`

### Citation integrity is technically clean

Checks:
- All 36 citation keys used in `manuscript.tex` exist in `references.bib`.
- No unused BibTeX entries.
- LaTeX log shows no undefined citations.

Minor issue:
- `manuscript.blg` warns that `Guo_2025` has empty pages. Add page numbers if available.

## Claims That Need Softening or Stronger Evidence

### "No prior study integrates..." is too absolute

Location: `manuscript.tex`, around line 136.

The statement may be defensible as a contribution claim, but it is broad and hard to prove without a systematic review. Safer wording:
> Existing studies rarely integrate blockchain auctions, real-time credit assessment, working-capital support, and adaptive settlement in a single agricultural commodity finance workflow.

### "Most of these studies employ private blockchains requiring high operational costs, rendering them unsuitable..."

Location: `manuscript.tex`, around line 128.

This is risky because the proposed system itself uses Hyperledger Fabric, a permissioned/private blockchain framework. Safer wording:
> Some blockchain auction designs can impose nontrivial deployment and operational costs, so their suitability depends on commodity value, transaction volume, and governance capacity.

### Cardamom cultivation/economic figures need source-specific checking

Location: `manuscript.tex`, lines 79-80.

The cited local bibliography supports the general topic, and a Spices Board cost-of-cultivation PDF supports high cultivation cost. However, the exact combined claim package should be source-checked before submission:
- cost exceeding `Rs. 5.9 lakh/ha`
- market price `Rs. 3,000-5,000`
- average yield `400 kg/ha`
- payment delay `30-50 days`

Recommendation:
- Add more precise citations or split the sentence so each number is tied to its exact source.

## Build/Layout Notes

The compiled manuscript has no undefined citations, but `manuscript.log` reports multiple overfull boxes. The most important layout risks are around wide tables:
- lines 443-444
- lines 474-487
- lines 626-655
- lines 709-740
- line 959-960

These are layout issues rather than factual issues, but they can affect submission polish.

## Sources Checked

Local:
- `manuscript/manuscript.tex`
- `manuscript/references.bib`
- `manuscript/manuscript.log`
- `summary_across_capitals_seed_averaged.xlsx`
- `egt_model_selection/egt_model_selection_results.xlsx`
- `egt_model_selection/egt_model_selection_detailed_report.md`
- `egt_optimization/egt_parameter_optimization_results.xlsx`
- `rl_optimization/rl_fin/fin_rl_parameter_optimization_results.xlsx`
- `rl_optimization/rl_borrower_opt/borrower_rl_parameter_optimization_results.xlsx`
- `sensitivity_analysis/rl_egt_sensitivity_results.xlsx`
- `hyperledger/throughput_results_all (1).csv`
- `github_review_upload/hyperledger/throughput_results_all.csv`

Web:
- Nature: `https://www.nature.com/articles/s41598-026-35594-3`
- Taylor & Francis DOI page: `https://www.tandfonline.com/doi/abs/10.1080/00207543.2025.2604309`
- ScienceDirect IFAC-PapersOnLine page for DOI `10.1016/j.ifacol.2025.07.151`
- arXiv: `https://arxiv.org/abs/2506.00505`
- arXiv: `https://arxiv.org/abs/2504.12023`
- SAGE/IOS DOI page: `https://journals.sagepub.com/doi/10.3233/ATDE250599`
