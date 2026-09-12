# pi-optimized-render

> **Disclaimer:** This project was purely vibecoded and will not be maintained.

Cache unchanged transcript rows and reduce rendering work in long Pi sessions.

**Requires Pi 0.85.1 and Node.js 22.19.0+.** Use regular or fullscreen mode. Other Pi versions retain native rendering because the optimizer uses private APIs.

## Install

```sh
pi install git:github.com/ChakornK/pi-optimized-render
```

After installation or updates, run `/reload` or restart Pi. Check `/render-opt` for **v0.1.0**.

From a checkout, use `pi -e ./src/index.ts` to try it or `pi install .` to install it. Pi loads the TypeScript source without a build step or npm runtime dependencies.

## Controls

| Command             | Action                                        |
| ------------------- | --------------------------------------------- |
| `/render-opt`       | Show frame CPU, line counts, and cache status |
| `/render-opt off`   | Restore native rendering and release caches   |
| `/render-opt on`    | Enable optimization                           |
| `/render-opt clear` | Reset caches and request a full redraw        |

Use `pi --no-render-optimization` to start disabled with the extension loaded. Print, JSON, and RPC modes remain unchanged.

## Behavior and limits

- Reversible instance hooks preserve Pi's editor, footer, widgets, and terminal behavior. Installed Pi files and global prototypes remain untouched.
- Unknown custom components stay live. Their authors can use the [generic cache contract](https://github.com/ChakornK/pi-optimized-render/blob/main/docs/architecture.md#custom-cache-controls); the optimizer has no plugin-specific adapters.
- Cold rendering, resizing, full invalidation, active-message Markdown, and search can scale with history. Cache memory grows with the transcript.
- Code that mutates old array aliases or cached inputs in place must call `invalidate()`. Use `/render-opt clear` for stale output.

See [architecture](https://github.com/ChakornK/pi-optimized-render/blob/main/docs/architecture.md) for cache guards.

## Benchmarks

Recorded medians on Linux, Node.js 26.8.1, Pi 0.85.1: 5,000 completed messages (about 46,000 lines), a 100 × 36 terminal, and 80 frames per workload after warmup.

| Mode       | Workload       |    Native | Optimized |
| ---------- | -------------- | --------: | --------: |
| Regular    | Typing         | 190.26 ms |   0.63 ms |
| Regular    | Streaming      | 192.67 ms |   3.16 ms |
| Regular    | Status updates | 190.95 ms |   0.84 ms |
| Fullscreen | Typing         |  48.93 ms |   0.87 ms |
| Fullscreen | Streaming      |  50.16 ms |   5.52 ms |
| Fullscreen | Status updates |  38.53 ms |   1.25 ms |

These are frame CPU times using native Pi components and a counting output sink. They exclude terminal display latency, model throughput, and custom renderer costs.

Cold frames were slower with optimization: **5.49 → 8.27 seconds** in regular mode and **4.49 → 7.65 seconds** in fullscreen mode. See [benchmark methods](https://github.com/ChakornK/pi-optimized-render/blob/main/docs/performance.md) for reproduction and limits.

## Development

```sh
npm ci --ignore-scripts
npm run verify
```

Verification requires Python 3 and Unix pseudo-terminals. See [CONTRIBUTING.md](https://github.com/ChakornK/pi-optimized-render/blob/main/CONTRIBUTING.md).

[MIT license](LICENSE)
