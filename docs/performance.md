# Performance

CPU timings use a counting output sink and exclude terminal display latency and model throughput. The fixture covers native Pi components, not custom renderers.

## Recorded results

Linux, Node.js 26.8.1, Pi 0.85.1; 100 columns × 36 rows; 5,000 completed messages, about 46,000 lines. The fixture includes native messages, Markdown, read-tool rows, input, and footer. Each workload measures 80 frames after warmup; streaming includes active-message Markdown processing.

| Mode       | Workload       | Native median | Optimized median |
| ---------- | -------------- | ------------: | ---------------: |
| Regular    | Typing         |     190.26 ms |          0.63 ms |
| Regular    | Streaming      |     192.67 ms |          3.16 ms |
| Regular    | Status updates |     190.95 ms |          0.84 ms |
| Fullscreen | Typing         |      48.93 ms |          0.87 ms |
| Fullscreen | Streaming      |      50.16 ms |          5.52 ms |
| Fullscreen | Status updates |      38.53 ms |          1.25 ms |

Optimized regular typing rendered one live component and processed 36 lines per frame. Status updates avoided session-entry scans.

Cold regular rendering took **8.27 seconds optimized versus 5.49 seconds native**. This includes attachment and initial rendering, excluding fixture construction and session loading. Resizes and full invalidations process history.

## Reproduce

```sh
npm ci --ignore-scripts
npm run bench -- --sizes=5000 --frames=80 --mode=both
```

Use `--sizes=100,1000,5000` for scaling and `--json` for structured results, including p95 and work counts. See [recorded data](../bench/results.json).

## Live sessions

Unknown custom components retain their render costs. Cache work inside the component or follow the [generic invalidation contract](architecture.md#custom-cache-controls).

After updates, run `/reload` and check `/render-opt` for the loaded version, frame CPU, line counts, and live components. Profile the affected session if lag remains; keep cold rendering, active Markdown, and terminal latency separate from unchanged-history costs.
