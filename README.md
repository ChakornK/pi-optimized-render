# pi-optimized-render

Cache unchanged transcript rows and reduce rendering work in long Pi sessions.

**Requires Pi 0.85.1 and Node.js 22.19.0+.** Use regular or fullscreen mode. Other Pi versions retain native rendering because the optimizer uses private APIs.

## Install

```sh
pi install npm:pi-optimized-render
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
- Unknown custom components stay live. Their authors can use the [generic cache contract](docs/architecture.md#custom-cache-controls); the optimizer has no plugin-specific adapters.
- Cold rendering, resizing, full invalidation, active-message Markdown, and search can scale with history. Cache memory grows with the transcript.
- Code that mutates old array aliases or cached inputs in place must call `invalidate()`. Use `/render-opt clear` for stale output.

See [architecture](docs/architecture.md) for cache guards and [benchmarks](docs/performance.md) for CPU measurements and cold-render costs. Native-component benchmarks exclude custom renderer costs and terminal display latency.

## Development

```sh
npm ci --ignore-scripts
npm run verify
```

Verification requires Python 3 and Unix pseudo-terminals. See [CONTRIBUTING.md](CONTRIBUTING.md) and [RELEASING.md](RELEASING.md).

[MIT license](LICENSE)
