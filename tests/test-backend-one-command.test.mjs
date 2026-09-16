import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repositoryRoot, "deploy-test-backend");

test("test backend one-command script is executable and has valid Bash syntax", () => {
  accessSync(scriptPath, constants.X_OK);
  execFileSync("bash", ["-n", scriptPath], { stdio: "pipe" });
});

test("help path is read-only and documents the guarded test-cloud flow", () => {
  const output = execFileSync(scriptPath, ["--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.match(output, /origin\/test/);
  assert.match(output, /--dry-run-only/);
  assert.match(output, /云数据库发布预检/);
});

test("script fixes the target to test and keeps status, audit, dry-run and health gates", () => {
  const source = readFileSync(scriptPath, "utf8");

  assert.match(source, /status --env test --database-profile active/);
  assert.match(source, /env-audit --env test/);
  assert.match(source, /deploy-cloud --env test --dry-run/);
  assert.match(source, /deploy-cloud --env test --yes/);
  assert.match(source, /test\.yinlizhangyu\.com\/health/);
  assert.doesNotMatch(source, /--env production/);
});
