# References Fact-Check Report

Target checked: `references.bib`  
Total entries: 36  
DOI-bearing entries checked: 32  
Non-DOI entries checked structurally: 4  

## Executive Summary

The bibliography is mostly sound: all manuscript citation keys resolve to entries, there are no unused entries, and most DOI metadata matches title/year/journal/volume/pages. The previously identified Nature DOI issue has been corrected in the active bibliography files. A few entries may still benefit from page/article-number cleanup, and one 2025/2026 publication-year mismatch should be corrected depending on whether the manuscript wants online-first year or formal issue year.

## Corrected

### 1. `integrating2026` DOI, URL, and article number

Current entry:
- DOI: `10.1038/s41598-026-35594-3`
- URL: `https://www.nature.com/articles/s41598-026-35594-3`
- Pages/article number: `5574`

Verified metadata:
- Correct DOI: `10.1038/s41598-026-35594-3`
- Correct Nature URL: `https://www.nature.com/articles/s41598-026-35594-3`
- Journal: `Scientific Reports`
- Volume: `16`
- Article number: `5574`
- Published: `16 January 2026`

Applied fields:

```bibtex
pages = {5574},
doi = {10.1038/s41598-026-35594-3},
url = {https://www.nature.com/articles/s41598-026-35594-3},
```

## Should Fix

### 2. `Yu_2025` year conflicts with DOI metadata

Current entry:
- Key/year: `Yu_2025`, `year={2025}`
- DOI: `10.1080/00207543.2025.2604309`

Verified DOI metadata:
- Title matches.
- Journal and volume/issue/page range match.
- Formal metadata year resolves as `2026` for `International Journal of Production Research`, volume 64, issue 8, pages 3244-3270.

Recommended action:
- Use `year={2026}` for formal bibliographic accuracy.
- If you want to preserve online-first timing, add a note such as `note = {Published online 2025}` only if the publisher page shows that date.
- Optionally rename the key later to `Yu_2026`; not required for LaTeX correctness, but cleaner.

### 3. Add missing article/page numbers

The following DOI metadata supplies article/page numbers that are missing locally:

| Key | Current issue | Recommended field |
|---|---|---|
| `sudha_trackchain_2024` | no `pages` field | `pages = {e23250}` |
| `li_three-level_2023` | no `pages` field | `pages = {5367}` |

### 4. `Guo_2025` has no pages and triggers BibTeX warning

Build log warning:
- `Warning--empty pages in Guo_2025`

Verified DOI:
- DOI resolves and title matches.
- I did not find a page range from the DOI metadata used in the automated check.

Recommended action:
- If the publisher page gives a page range or article number, add it.
- If no page/article number exists, the warning is low risk and can be ignored, but the entry will look slightly incomplete.

## Validated DOI Entries

These entries matched DOI metadata at the core level: title, year, venue, volume, and page/article identifier where available.

- `caniato_supply_2019`
- `chou_implementing_2023`
- `hu_acsarf_2025`
- `janan_electric_2025`
- `liu_when_2024`
- `moretto_can_2021`
- `murugan_governance_2024`
- `rajan_covenants_1995`
- `reddy_electronic_2019`
- `sudha_trackchain_2024`, except missing article number locally
- `wang_stability_2024`
- `zhang_blockchain-based_2024`
- `chen_hyperledger_2023`
- `li_three-level_2023`, except missing article number locally
- `modgil_blockchain-enabled_2024`
- `ye_anonymous_2023`
- `guo_evolutionary_2024`
- `zhang_evolutionary_2019`
- `zhu_evolutionary_2018`
- `Kotecha_2025`
- `ma2019`
- `shakila2024`
- `hasnain2023`
- `khan2022`
- `shih2022`

## Valid but Not Crossref-Indexed

The arXiv DOI entries failed in Crossref but resolved through DataCite, which is normal for arXiv DOIs.

### `qu2025rules`

Verified:
- DOI: `10.48550/arxiv.2506.00505`
- Title: `From Rules to Rewards: Reinforcement Learning for Interest Rate Adjustment in DeFi Lending`
- Authors and year match.
- URL: `https://arxiv.org/abs/2506.00505`

Recommended optional cleanup:

```bibtex
url = {https://arxiv.org/abs/2506.00505},
```

### `genetti2025evolutionary`

Verified:
- DOI: `10.48550/arxiv.2504.12023`
- Title: `Evolutionary Reinforcement Learning for Interpretable Decision-Making in Supply Chain Management`
- Authors and year match.
- URL: `https://arxiv.org/abs/2504.12023`

Recommended optional cleanup:

```bibtex
url = {https://arxiv.org/abs/2504.12023},
```

## Non-DOI Entries

### `acharya_agricultural_2004`

Current:
- Entry key says `2004`, but the entry year is `2019`.
- Uses an Amazon product page as URL.

Recommendation:
- The metadata may be acceptable if citing the 7th edition, but the key is misleading. Consider renaming key to `acharya_agricultural_2019`.
- Replace the Amazon URL with a publisher/library/catalog URL if available. Amazon is weaker as a scholarly bibliographic source.

### `stiglitz_credit_1981`

Current:
- No DOI.

Status:
- This is a classic article and the metadata is enough for citation: title, journal, volume, issue, pages, authors, year.

Optional:
- Add a stable JSTOR URL or DOI if required by the journal style.

### `spicesboard2023annual`

Current:
- Generic URL: `https://www.indianspices.com`

Recommendation:
- Replace with the exact annual report PDF/page URL if possible. The generic homepage is weak and may not lead readers to the cited report.
- Also check access date: `16 December 2025` is valid as of this audit date, but it precedes some later manuscript updates. That is acceptable if the source was actually accessed then.

### `dgcis2023export`

Current:
- URL points to the Export-Import Data Bank.

Status:
- Acceptable as a database citation, though a full query path or downloaded dataset title would be stronger.

## BibTeX Hygiene

### Encoding/artifact cleanup

Several displayed strings show mojibake in some terminal output, such as `â€“` and `â€™`. The compiled manuscript may still render correctly depending on file encoding, but check the PDF output. If these appear visibly in the PDF, replace them with proper LaTeX-safe punctuation:

- `--` for en dash in page ranges or prose
- straight apostrophe or `{\textquoteright}` where needed

Likely affected entries:
- `sudha_trackchain_2024`
- `guo_evolutionary_2024`
- single-line 2025 entries with page ranges

### DOI capitalization

DOIs are case-insensitive, but for consistency use publisher/DataCite casing:

- `10.48550/arXiv.2506.00505`
- `10.48550/arXiv.2504.12023`

The current lowercase forms resolve through DataCite, so this is stylistic.

## Checks Performed

- Parsed all 36 BibTeX entries.
- Confirmed every manuscript citation key exists in `references.bib`.
- Confirmed no unused bibliography entries.
- Checked LaTeX build output for undefined citations: none found.
- Queried DOI metadata through Crossref for standard DOI entries.
- Queried DataCite for arXiv DOI entries.
- Verified the corrected Nature DOI by direct DOI resolution.

## External Metadata Sources Used

- Crossref Works API: `https://api.crossref.org/works/{doi}`
- DataCite DOI API: `https://api.datacite.org/dois/10.48550/arxiv.2506.00505`
- DataCite DOI API: `https://api.datacite.org/dois/10.48550/arxiv.2504.12023`
- Nature DOI page: `https://www.nature.com/articles/s41598-026-35594-3`
- arXiv page: `https://arxiv.org/abs/2506.00505`
- arXiv page: `https://arxiv.org/abs/2504.12023`
