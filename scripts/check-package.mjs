import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const entry = readFileSync(join(root, "src/index.ts"), "utf8");
const version = entry.match(/const PLUGIN_VERSION = "([^"]+)";/)?.[1];
const supportedPi = entry.match(/const SUPPORTED_PI = "([^"]+)";/)?.[1];

assert.equal(version, manifest.version, "Runtime status and package versions differ");
assert.equal(lock.name, manifest.name, "Lockfile package name differs");
assert.equal(lock.version, manifest.version, "Lockfile version differs from package.json");
assert.equal(lock.packages[""].name, manifest.name, "Lockfile root name differs");
assert.equal(lock.packages[""].version, manifest.version, "Lockfile root version differs");
assert.ok(readFileSync(join(root, "README.md"), "utf8").includes(`v${manifest.version}`));
assert.equal(manifest.devDependencies["@earendil-works/pi-coding-agent"], supportedPi);
assert.equal(manifest.devDependencies["@earendil-works/pi-tui"], supportedPi);
assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
assert.ok(manifest.keywords.includes("pi-package"));
assert.equal(manifest.license, "MIT");
assert.notEqual(manifest.private, true);
assert.equal(manifest.publishConfig.access, "public");
assert.equal(manifest.scripts.prepublishOnly, "npm run verify");
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, "Unexpected npm runtime dependency");
for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
  assert.equal(manifest.peerDependencies[name], "*");
  assert.equal(manifest.peerDependenciesMeta[name].optional, true);
}

const required = new Set([
  "package.json",
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "docs/architecture.md",
  "docs/performance.md",
  "src/index.ts",
  "src/renderer.ts",
  "src/tree.ts",
  "src/lines.ts",
  "src/footer.ts",
  "src/patch.ts",
]);

function run(command, args, { capture = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    timeout: 300_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\n${result.stderr ?? ""}`);
  return result.stdout;
}

function localTarget(directory, parent, target) {
  const path = resolve(dirname(join(directory, parent)), decodeURIComponent(target));
  const relativePath = relative(directory, path);
  assert.ok(
    relativePath && !relativePath.startsWith(".."),
    `${parent} points outside the package: ${target}`,
  );
  assert.ok(existsSync(path), `${parent} references a missing file: ${target}`);
}

const temporary = mkdtempSync(join(tmpdir(), "pi-render-release-"));
try {
  // Inspect a real temporary archive even when npm publish sets dry-run for its lifecycle hooks.
  const report = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--dry-run=false", "--json", "--pack-destination", temporary], {
      capture: true,
    }),
  );
  const archives = Array.isArray(report) ? report : Object.values(report);
  assert.equal(archives.length, 1, "Expected one packed archive");
  const [archive] = archives;
  assert.equal(archive.name, manifest.name);
  assert.equal(archive.version, manifest.version);
  assert.equal(basename(archive.filename), archive.filename);
  const files = new Set(archive.files.map((file) => file.path));
  for (const file of required) assert.ok(files.has(file), `Missing release file: ${file}`);
  for (const file of files) {
    assert.ok(
      required.has(file) ||
        /^src\/[a-zA-Z0-9_/-]+\.ts$/.test(file) ||
        /^docs\/[a-zA-Z0-9_/-]+\.md$/.test(file),
      `Unexpected release file: ${file}`,
    );
  }

  run("tar", ["-xzf", join(temporary, archive.filename), "-C", temporary]);
  const directory = join(temporary, "package");
  assert.ok(!existsSync(join(directory, "node_modules")), "Release contains development dependencies");

  for (const file of files) {
    if (file.endsWith(".md")) {
      const text = readFileSync(join(directory, file), "utf8");
      for (const [, link] of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(link)) continue;
        localTarget(directory, file, link.split("#")[0]);
      }
    }
    if (file.startsWith("src/") && file.endsWith(".ts")) {
      const text = readFileSync(join(directory, file), "utf8");
      for (const [, specifier] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*["'](\.[^"']+)["']/g)) {
        localTarget(directory, file, specifier);
      }
    }
  }

  const env = { ...process.env, PI_RENDER_EXTENSION: join(directory, "src/index.ts") };
  delete env.PI_TEST_SESSION;
  run("python3", ["test/cli-smoke.py"], { env });
  run("python3", ["test/cli-smoke.py", "--history"], { env });
  console.log(
    `PASS package ${manifest.name}@${manifest.version}: ${files.size} files, links, imports, and CLI checks`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
