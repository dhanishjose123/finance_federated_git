# Initial-Capital and Default-Scenario Analysis

This experiment evaluates the selected `RL APR + EGT borrower-screening` model under different capital availability and repayment-stress conditions.

The model parameters are fixed at the selected optimum:

| Component | Parameter | Value |
|---|---|---:|
| Financier RL APR | alpha | 0.25 |
| Financier RL APR | gamma | 0.95 |
| Financier RL APR | epsilon | 0.08 |
| Borrower EGT screening | alpha | 0.30 |
| Borrower EGT screening | eta | 200 |

The experiment is run in the full tournament setting:

| Finance model | APR strategy | Borrower-screening strategy |
|---|---|---|
| RL + RL | RL APR | RL screening |
| RL + EGT | RL APR | EGT screening |
| RL + none | RL APR | No screening |
| Fixed 6 + none | Fixed 6% APR | No screening |
| Fixed 8 + none | Fixed 8% APR | No screening |
| Fixed 10 + none | Fixed 10% APR | No screening |

The scenario dimensions are:

| Dimension | Values |
|---|---|
| Initial capital per financier | 100K, 1M, 5M, 10M |
| Default scenario | zero, low, medium, high, very high |
| Seed | 42 |
| Simulation length | 4000 days |

The default scenarios use the following wholesaler shock profiles:

| Default scenario | No-shock wholesalers | Medium-shock wholesalers | High-shock wholesalers |
|---|---:|---:|---:|
| Zero | 39 | 0 | 0 |
| Low | 34 | 4 | 1 |
| Medium | 30 | 7 | 2 |
| High | 25 | 10 | 4 |
| Very high | 20 | 12 | 7 |

Total runs: `4 capitals x 5 default scenarios x 1 seed = 20`.

Run from the `basics` folder:

```powershell
python capital_default_analysis\run_capital_default_analysis.py
```

Outputs:

| File | Contents |
|---|---|
| `capital_default_analysis_results.xlsx` | Scenario summaries, winner summaries, financier summaries, and run details |
| `capital_default_analysis_report.txt` | Short report with total runs and aggregate target results |
