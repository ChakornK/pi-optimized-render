# Contributing

Use Node.js 22.19.0+, npm, Python 3, and Unix with `tar` and pseudo-terminal support.

```sh
npm ci --ignore-scripts
npm run format
npm run verify
```

`verify` checks TypeScript, formatting, tests, and the packed runtime. CLI tests cover both renderer modes, cache opt-in, invalidation, and live components without model requests or changes to your Pi settings.

Run subsets with `npm test`, `npm run test:cli`, or `npm run test:cli:history`. To replay a saved chat:

```sh
PI_TEST_SESSION=/path/to/session.jsonl npm run test:cli:history
```

The harness copies the session with a fresh ID and test directory, then appends generated entries. It leaves the source unchanged and loads no other extensions. Release checks ignore this setting.

## Renderer changes

- Preserve native output and state; add parity tests and render-count assertions.
- Keep unknown components live. Use the shared invalidation contract, without plugin-specific adapters or hooks.
- Keep host packages in `peerDependencies` with `"*"` and pin tested versions in `devDependencies`. Inspect native APIs and pass parity and packed-CLI tests before changing `SUPPORTED_PI` in `src/index.ts`.

Use [benchmarks](docs/performance.md) for scaling. Investigate live lag with the affected extensions; native fixtures can miss their costs.

## Writing and privacy

Keep prose direct. Comments explain current behavior, constraints, and local rationale; preserve useful details and leave good comments alone. Avoid filler, change narratives, decorative dividers, and stale benchmark counts.

Keep chats, raw profiles, credentials, local configuration, and raw benchmark results out of commits. Use generated fixtures for tests and put benchmark summaries in the README. `results.json` and `bench/*.json` stay local and must not enter release archives.
