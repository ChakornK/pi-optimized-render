# Benchmark methods

See [recorded results](../README.md#benchmarks) for timings and cold-render costs.

## Workload

The fixture uses native Pi messages, Markdown, read-tool rows, input, and footer. Frame CPU timings use a counting output sink and exclude terminal display latency and model throughput. Streaming includes active-message Markdown processing.

Cold measurements include optimizer attachment and initial rendering, excluding fixture construction and session loading. Resizes and full invalidations process history.

## Reproduce

```sh
npm ci --ignore-scripts
npm run --silent bench -- --sizes=5000 --frames=80 --mode=both --json > results.json
```

Use `--sizes=100,1000,5000` for scaling. JSON output includes medians, p95, and work counts; omit `--json` and the redirect for a terminal summary.

Keep raw results local. `results.json` and `bench/*.json` are ignored and must not be committed or packaged. Put reviewed benchmark summaries in the README.

## Live sessions

Unknown custom components retain their render costs. Cache work inside the component or follow the [generic invalidation contract](architecture.md#custom-cache-controls).

After updates, run `/reload` and check `/render-opt` for the loaded version, frame CPU, line counts, and live components. Profile the affected session if lag remains; separate cold rendering, active Markdown, and terminal latency from unchanged-history costs.
