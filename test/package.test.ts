import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function rejectedPackage(
  mutate: (directory: string) => void,
  diagnostic: RegExp,
  env: NodeJS.ProcessEnv = {},
): void {
  const directory = mkdtempSync(join(tmpdir(), "pi-render-package-test-"));
  try {
    for (const file of [
      "src",
      "docs",
      "bench",
      "scripts",
      "package.json",
      "package-lock.json",
      "README.md",
      "LICENSE",
      "CONTRIBUTING.md",
    ]) {
      cpSync(join(root, file), join(directory, file), { recursive: true });
    }
    mutate(directory);
    const result = spawnSync(process.execPath, [join(directory, "scripts/check-package.mjs")], {
      cwd: directory,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 1);
    assert.match(result.stderr, diagnostic);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("package gate rejects a mismatched runtime version", () => {
  rejectedPackage((directory) => {
    const file = join(directory, "src/index.ts");
    const source = readFileSync(file, "utf8").replace(
      /const PLUGIN_VERSION = "[^"]+";/,
      'const PLUGIN_VERSION = "0.0.0-test";',
    );
    writeFileSync(file, source);
  }, /Runtime status and package versions differ/);
});

test("package gate rejects a missing runtime file", () => {
  rejectedPackage((directory) => {
    rmSync(join(directory, "src/lines.ts"));
  }, /Missing release file: src\/lines\.ts/);
});

test("package gate rejects a private file in the archive", () => {
  rejectedPackage((directory) => {
    const file = join(directory, "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.files.push("private.session.jsonl");
    writeFileSync(file, JSON.stringify(manifest));
    writeFileSync(join(directory, "private.session.jsonl"), '{"fixture":true}\n');
  }, /Unexpected release file: private\.session\.jsonl/);
});

test("package gate rejects a broken documentation link", () => {
  rejectedPackage((directory) => {
    appendFileSync(join(directory, "README.md"), "\n[Missing guide](missing.md)\n");
  }, /README\.md references a missing file: missing\.md/);
});

test("package gate inspects archive contents during a publication dry run", () => {
  rejectedPackage(
    (directory) => {
      appendFileSync(join(directory, "README.md"), "\n[Missing guide](missing.md)\n");
    },
    /README\.md references a missing file: missing\.md/,
    { npm_config_dry_run: "true" },
  );
});
