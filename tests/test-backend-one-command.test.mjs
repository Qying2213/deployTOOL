import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sameHealthyTestRelease, verifyApiReference, verifyPublicHealth } from "../backend/test-release-precheck.mjs";

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

const commit = "a".repeat(40);
const constraintsHash = createHash("sha256").update(readFileSync(join(repositoryRoot, "backend/runtime-constraints.test.txt"))).digest("hex");

function statusSnapshot() {
  const fields = {
    ENVIRONMENT: "test", INITIALIZED: "true", DATABASE_PROFILE: "cloud",
    ACTIVE_DATABASE_PROFILE: "cloud", RECOVERY_REQUIRED: "false",
    DEPLOYMENT_STATE: "HEALTHY", DATABASE_WRITERS: "verified", DB_REVISION: "20261015_0127",
    CURRENT: "/srv/loumai-backend/backend-releases/20261027T000000Z-aaaaaaaaaa/backend",
  };
  for (const name of ["api", "im_worker", "video_worker", "landlord_persona_refresh", "company_management"]) {
    fields[`UNIT_loumai_${name}_service`] = "active";
  }
  for (const name of ["file_storage_cleanup", "app_push_dispatcher"]) {
    fields[`UNIT_loumai_${name}_service`] = "inactive";
    fields[`UNIT_loumai_${name}_timer`] = "active";
  }
  return Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("\n") + "\n" + JSON.stringify({
    schema_version: 1, release_id: "20261027T000000Z-aaaaaaaaaa", commit,
    branch: "test", environment: "test", artifact_db_head: "20261015_0127",
    constraints_sha256: constraintsHash, tool: { backend_release_tool: "6" },
  }, null, 2) + "\n";
}

function writeDocuments(root) {
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs/apifox-openapi.json"), JSON.stringify({
    paths: { "/api/v1/example": { get: {} } }, components: { schemas: { Example: {} } },
  }));
  writeFileSync(join(root, "docs/楼脉全量API接口文档_v1.0.md"),
    "当前真实路径：**1**\n当前 HTTP 操作：**1**\nOpenAPI 数据模型：**1**\n#### 1. `GET /api/v1/example`\n");
}

test("API quick check rejects stale statistics, missing, duplicated and wrong same-count paths", t => {
  const root = mkdtempSync(join(tmpdir(), "test-release-docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeDocuments(root);
  assert.equal(verifyApiReference(root)["当前真实路径"], 1);
  const file = join(root, "docs/楼脉全量API接口文档_v1.0.md");
  const original = readFileSync(file, "utf8");
  for (const broken of [
    original.replace("路径：**1**", "路径：**0**"),
    original.replace("#### 1.", "### 1."),
    original.replace("/api/v1/example", "/api/v1/other"),
    original + "#### 2. `GET /api/v1/example`\n",
  ]) {
    writeFileSync(file, broken);
    assert.throws(() => verifyApiReference(root), /文档/);
  }
});

test("same-version decision fails closed for inconsistent commit, DB, dependencies, helper and services", () => {
  const good = statusSnapshot();
  assert.equal(sameHealthyTestRelease(good, commit, constraintsHash), true);
  for (const bad of [
    good.replace(`"commit": "${commit}"`, `"commit": "${"b".repeat(40)}"`),
    good.replace("ENVIRONMENT=test", "ENVIRONMENT=production"),
    good.replace("INITIALIZED=true", "INITIALIZED=false"),
    good.replace("DATABASE_PROFILE=cloud", "DATABASE_PROFILE=local"),
    good.replace("ACTIVE_DATABASE_PROFILE=cloud", "ACTIVE_DATABASE_PROFILE=local"),
    good.replace("RECOVERY_REQUIRED=false", "RECOVERY_REQUIRED=true"),
    good.replace("DEPLOYMENT_STATE=HEALTHY", "DEPLOYMENT_STATE=FAILED"),
    good.replace("DATABASE_WRITERS=verified", "DATABASE_WRITERS=unknown"),
    good.replace("DB_REVISION=20261015_0127", "DB_REVISION=20261001_0001"),
    good.replace("UNIT_loumai_im_worker_service=active", "UNIT_loumai_im_worker_service=failed"),
    good.replace("UNIT_loumai_app_push_dispatcher_timer=active", "UNIT_loumai_app_push_dispatcher_timer=inactive"),
    good.replace("UNIT_loumai_api_service=active\n", ""),
    good.replace('"branch": "test"', '"branch": "master"'),
    good.replace('"environment": "test"', '"environment": "production"'),
    good.replace('"backend_release_tool": "6"', '"backend_release_tool": "5"'),
    good.replace(constraintsHash, "0".repeat(64)),
    good.replace("/backend-releases/", "/other-releases/"),
    good.replace("\n{\n", "\nnot-json\n"),
    good + "ENVIRONMENT=test\n",
    good + "UNIT_other_worker_service=failed\n",
  ]) assert.equal(sameHealthyTestRelease(bad, commit, constraintsHash), false, bad);
  assert.equal(sameHealthyTestRelease(good, "not-a-commit", constraintsHash), false);
  assert.equal(sameHealthyTestRelease(good, commit, "0".repeat(64)), false);
  assert.equal(sameHealthyTestRelease(good, commit, undefined), false);
  assert.equal(sameHealthyTestRelease(good.replace("cleanup_service=inactive", "cleanup_service=activating"), commit, constraintsHash), true);
});

test("HTTP 200 alone does not pass the public API and database health check", () => {
  assert.deepEqual(verifyPublicHealth('{"status":"ok","database":"ok"}'), { status: "ok", database: "ok" });
  for (const payload of ['{}', '{"status":"ok","database":"error"}', 'not-json']) {
    assert.throws(() => verifyPublicHealth(payload));
  }
});

function runEntry(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "test release entry "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = join(root, "tools");
  const source = join(root, "source");
  const worktree = join(root, "test worktree");
  const bin = join(root, "bin");
  for (const path of [join(tools, ".git"), join(source, ".git"), worktree, bin]) mkdirSync(path, { recursive: true });
  cpSync(join(repositoryRoot, "backend"), join(tools, "backend"), { recursive: true });
  cpSync(scriptPath, join(tools, "deploy-test-backend"));
  writeDocuments(worktree);
  if (options.staleDocs) writeFileSync(join(worktree, "docs/楼脉全量API接口文档_v1.0.md"), "stale docs");
  const log = join(root, "calls.jsonl");
  const program = `#!${process.execPath}
const fs = require('node:fs');
let args = process.argv.slice(2);
const name = require('node:path').basename(process.argv[1]);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({name,args,ssh:process.env.GIT_SSH_COMMAND||null})+'\\n');
if(name==='git') {
  if(args[0]==='-C') args=args.slice(2);
  if(args[0]==='config') { if(process.env.CORE_SSH) console.log(process.env.CORE_SSH); else process.exitCode=1; }
  else if(args[0]==='worktree') console.log('worktree '+process.env.TEST_WORKTREE+'\\nHEAD ${commit}\\nbranch refs/heads/test\\n');
  else if(args[0]==='rev-parse') console.log('${commit}');
  else if(args[0]==='status' && args.includes('--porcelain') && process.env.DIRTY_SOURCE && process.argv[3]===process.env.TEST_WORKTREE) console.log(' M changed.py');
} else if(name==='loumai-deploy') {
  if(args[1]==='status') {
    let n=fs.existsSync(process.env.STATUS_COUNTER)?Number(fs.readFileSync(process.env.STATUS_COUNTER)):0;
    fs.writeFileSync(process.env.STATUS_COUNTER,String(n+1));
    let text=fs.readFileSync(process.env.STATUS_SNAPSHOT,'utf8');
    if(process.env.NEW_COMMIT || (n>0 && process.env.CHANGED_SNAPSHOT)) text=text.replaceAll('${commit}','${"b".repeat(40)}');
    process.stdout.write(text);
  }
} else if(name==='curl') console.log(JSON.stringify({status:'ok',database:process.env.BAD_HEALTH?'error':'ok'}));
`;
  for (const name of ["git", "curl"]) writeFileSync(join(bin, name), program, { mode: 0o755 });
  writeFileSync(join(tools, "loumai-deploy"), program, { mode: 0o755 });
  const snapshot = join(root, "status.txt");
  writeFileSync(snapshot, statusSnapshot());
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, LOUMAI_SOURCE_REPO: source,
    LOUMAI_BACKEND_PYTHON: process.execPath, TEST_WORKTREE: worktree,
    CALL_LOG: log, STATUS_SNAPSHOT: snapshot, STATUS_COUNTER: join(root, "counter"),
  };
  delete env.GIT_SSH_COMMAND;
  for (const [key, value] of Object.entries(options.env || {})) env[key] = value;
  const result = spawnSync("bash", [join(tools, "deploy-test-backend"), ...(options.args || [])], { env, encoding: "utf8" });
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { result, calls };
}

test("same healthy deployment completes read-only, fetches once, and preserves the required audits", t => {
  const { result, calls } = runEntry(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NO_DEPLOYMENT_NEEDED=true/);
  const remote = calls.filter(call => call.name === "loumai-deploy");
  assert.equal(remote.filter(call => call.args[1] === "status").length, 2);
  assert.ok(remote.some(call => call.args.includes("env-audit")));
  assert.ok(remote.some(call => call.args.includes("--dry-run")));
  assert.ok(!remote.some(call => call.args.includes("--yes")));
  assert.equal(calls.filter(call => call.name === "git" && call.args.includes("fetch")).length, 1);
  assert.ok(!calls.some(call => call.name === "git" && call.args.includes("pull")));
  const fetch = calls.find(call => call.name === "git" && call.args.includes("fetch"));
  assert.match(fetch.ssh, /ServerAliveInterval=15/);
});

for (const [name, options] of [
  ["new commit", { env: { NEW_COMMIT: "1" } }],
  ["explicit same-version rebuild", { args: ["--force-redeploy"] }],
  ["runtime changes after preflight", { env: { CHANGED_SNAPSHOT: "1" } }],
]) test(`${name} reaches the original full deployment exactly once`, t => {
  const { result, calls } = runEntry(t, options);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /NO_DEPLOYMENT_NEEDED/);
  assert.equal(calls.filter(call => call.name === "loumai-deploy" && call.args.includes("--yes")).length, 1);
});

test("stale API docs fail before contacting any server", t => {
  const { result, calls } = runEntry(t, { staleDocs: true });
  assert.notEqual(result.status, 0);
  assert.ok(!calls.some(call => call.name === "loumai-deploy" || call.name === "curl"));
});

test("new-version real deploy delegates preflight to the deployer without a redundant outer dry-run", t => {
  const { result, calls } = runEntry(t, { env: { NEW_COMMIT: "1" } });
  assert.equal(result.status, 0, result.stderr);
  const remote = calls.filter(call => call.name === "loumai-deploy");
  assert.equal(remote.filter(call => call.args.includes("--dry-run")).length, 0);
  assert.equal(remote.filter(call => call.args.includes("--yes")).length, 1);
  assert.ok(remote.some(call => call.args.includes("env-audit")));
});

test("dry-run remains read-only and respects the configured SSH command", t => {
  const { result, calls } = runEntry(t, { args: ["--dry-run-only"], env: { CORE_SSH: "ssh -i custom-key" } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!calls.some(call => call.args.includes("--yes")));
  const fetch = calls.find(call => call.name === "git" && call.args.includes("fetch"));
  assert.equal(fetch.ssh, null);
});

test("dry-run of a new commit never starts the full deployment", t => {
  const { result, calls } = runEntry(t, { args: ["--dry-run-only"], env: { NEW_COMMIT: "1" } });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /NO_DEPLOYMENT_NEEDED/);
  assert.ok(!calls.some(call => call.args.includes("--yes")));
});

test("bad health fails without redeploying an unchanged version", t => {
  const { result, calls } = runEntry(t, { env: { BAD_HEALTH: "1" } });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /NO_DEPLOYMENT_NEEDED/);
  assert.ok(!calls.some(call => call.args.includes("--yes")));
});

test("a dirty test worktree never reaches the server", t => {
  const { result, calls } = runEntry(t, { env: { DIRTY_SOURCE: "1" } });
  assert.notEqual(result.status, 0);
  assert.ok(!calls.some(call => call.name === "loumai-deploy"));
});
