# Benchmark Evidence and Interpretation

The source logs are in `code_and_results/hyperledger/caliper_300tps_logs/`.
The compact table is `code_and_results/hyperledger/caliper_300tps_summary.csv`.

## Configuration

The retained benchmark YAML specifies five local workers, a fixed-rate controller
at 300 TPS, and a count target of 300 transactions. This is not a 300-second test.
Single-request rounds lasted 1.097--1.377 seconds in the saved logs; the compound
aggregation round lasted 3.479 seconds. Latencies are seconds; send rate and
throughput are transactions per second. These are short-burst measurements.

The logs identify Fabric Node SDK 2.2.20. The retained dependency lock identifies
Caliper CLI/core 0.7.1 and deployment instructions specify Fabric 2.5.9, but these
are not a contemporaneous capture of the deployed peer/orderer images. Historical
CPU, RAM, OS version and container resource limits are unverified.

## Why Aggregation Has 384 Outcomes

Each workload iteration sends three `submitLocalModel` requests followed by
one `aggregateGlobalModel` request. Worker payload counts sum to 96 iterations:

- 288 successful local-model submissions.
- 96 aggregation calls: 23 successful and 73 failed.
- Combined totals: 311 successes and 73 failures, or 384 outcomes.

The 73 failure entries name `aggregateGlobalModel` and report
`PHANTOM_READ_CONFLICT`. Do not describe the 311 successes as aggregation
successes. The reported 113.4 TPS and 0.19-second average latency cover the
compound workload, not aggregation alone. Keep the original summary unchanged
as recorded evidence; use this interpretation when reading its aggregation row.

Shared-key policy/offer updates also had failures under concurrent repeated
submission. Their intended periodic use does not remove the need for concurrency
controls. No new benchmark was run while preparing this package.
