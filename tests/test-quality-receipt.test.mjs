import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { main } from '../backend/backend-release.mjs'

const modulePath = new URL('../backend/test-quality-receipt.mjs', import.meta.url)

async function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), 'verified-test-gates-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	const repo = join(root, 'source'), tool = join(root, 'tool'), bin = join(root, 'python')
	mkdirSync(repo); mkdirSync(join(tool, 'backend'), { recursive: true })
	writeFileSync(join(repo, '.gitignore'), '.env\n')
	writeFileSync(join(repo, 'source.py'), 'version=1\n')
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
	git('init', '-b', 'feature'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture')
	git('add', '.'); git('commit', '-m', 'initial')
	writeFileSync(bin, '#!/bin/sh\nprintf "dependency-version-1"\n', { mode: 0o755 })
	const constraints = join(root, 'constraints.txt')
	writeFileSync(constraints, 'package==1\n')
	cpSync(modulePath, join(tool, 'backend/test-quality-receipt.mjs'))
	writeFileSync(join(tool, 'backend/backend-release.mjs'), '// controller v1\n')
	const { testQualityGates } = await import(pathToFileURL(join(tool, 'backend/test-quality-receipt.mjs')))
	let calls = 0
	const env = { MIGRATION_CHECK_DATABASE_URL: 'local-isolated-database', PRIVATE_SETTING: 'never-store-this-value' }
	const config = { environment: 'test', repoRoot: repo, pythonBin: bin, constraintsPath: constraints }
	const run = (options = {}, gates = () => calls++) => testQualityGates(config, 'revision_1', gates, { environment: env, report: () => {}, ...options })
	const directory = join(repo, '.git/verified-test-gates')
	const receipt = () => join(directory, readdirSync(directory).find(path => path.endsWith('.json')))
	return { root, repo, tool, bin, constraints, git, config, env, run, directory, receipt, calls: () => calls }
}

test('full gates run once and same-tree merge commits reuse private signed evidence', async t => {
	const f = await fixture(t)
	assert.equal(f.run(), false)
	f.git('checkout', '-b', 'test'); f.git('commit', '--allow-empty', '-m', 'merge-equivalent tree')
	assert.equal(f.run(), true)
	assert.equal(f.calls(), 1)
	const text = readFileSync(f.receipt(), 'utf8')
	assert.ok(!text.includes(f.env.PRIVATE_SETTING))
	assert.equal(spawnSync('stat', process.platform === 'darwin' ? ['-f', '%Lp', f.receipt()] : ['-c', '%a', f.receipt()], { encoding: 'utf8' }).stdout.trim(), '600')
})

for (const changed of ['source', 'constraints', 'python', 'settings', 'dotenv', 'controller']) {
	test(`changed ${changed} invalidates the previous success`, async t => {
		const f = await fixture(t); f.run()
		if (changed === 'source') { writeFileSync(join(f.repo, 'source.py'), 'version=2\n'); f.git('add', '.'); f.git('commit', '-m', 'changed') }
		if (changed === 'constraints') writeFileSync(f.constraints, 'package==2\n')
		if (changed === 'python') writeFileSync(f.bin, '#!/bin/sh\nprintf "dependency-version-2"\n')
		if (changed === 'settings') f.env.PRIVATE_SETTING = 'different'
		if (changed === 'dotenv') writeFileSync(join(f.repo, '.env'), 'PRIVATE=changed\n')
		if (changed === 'controller') writeFileSync(join(f.tool, 'backend/backend-release.mjs'), '// controller v2\n')
		assert.equal(f.run(), false); assert.equal(f.calls(), 2)
	})
}

for (const invalid of ['tampered', 'malformed', 'expired', 'future', 'permissions']) {
	test(`${invalid} receipt cannot skip gates`, async t => {
		const f = await fixture(t), now = Date.now()
		f.run({ now: () => now })
		let later = now
		if (invalid === 'tampered') { const value = JSON.parse(readFileSync(f.receipt())); value.payload.tree = 'forged'; writeFileSync(f.receipt(), JSON.stringify(value)) }
		if (invalid === 'malformed') writeFileSync(f.receipt(), '{invalid')
		if (invalid === 'expired') later += 2 * 60 * 60 * 1000 + 1
		if (invalid === 'future') later--
		if (invalid === 'permissions') chmodSync(f.receipt(), 0o644)
		assert.equal(f.run({ now: () => later }), false); assert.equal(f.calls(), 2)
	})
}

test('force verify failure revokes a previous success', async t => {
	const f = await fixture(t); f.run()
	assert.throws(() => f.run({ force: true }, () => { throw new Error('gate failed') }), /gate failed/)
	assert.equal(f.run(), false); assert.equal(f.calls(), 2)
})

test('launcher identity and unused PATH entries do not rerun successful gates', async t => {
	const f = await fixture(t); f.env.PATH = process.env.PATH; f.run()
	f.env.CODEX_TOOL_CALL_ID = 'another-launch'; f.env.FPATH = '/unused/shell/functions'
	f.env.PATH += ':/missing/launcher/path'
	assert.equal(f.run(), true); assert.equal(f.calls(), 1)
})

test('a different resolved executable invalidates the receipt even when Python is unchanged', async t => {
	const f = await fixture(t), bin = join(f.root, 'executables')
	mkdirSync(bin); writeFileSync(join(bin, 'pg_dump'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
	f.env.PATH = bin + ':' + process.env.PATH; f.run()
	writeFileSync(join(bin, 'pg_dump'), '#!/bin/sh\nexit 1\n')
	assert.equal(f.run(), false); assert.equal(f.calls(), 2)
})

test('key permission fallback failure cannot resurrect an earlier success', async t => {
	const f = await fixture(t); f.run()
	const key = join(f.directory, 'signing-key')
	chmodSync(key, 0o644)
	assert.throws(() => f.run({}, () => { throw new Error('fresh failure') }), /fresh failure/)
	chmodSync(key, 0o600)
	assert.equal(f.run(), false); assert.equal(f.calls(), 2)
})

test('source changed during gates cannot create evidence', async t => {
	const f = await fixture(t)
	assert.throws(() => f.run({}, () => {
		writeFileSync(join(f.repo, 'source.py'), 'version=2\n'); f.git('add', '.'); f.git('commit', '-m', 'racing source')
	}), /门禁期间/)
	assert.equal(readdirSync(f.directory).filter(path => path.endsWith('.json')).length, 0)
})

test('production always executes fresh gates and rejects test verify command', async t => {
	const f = await fixture(t); f.run(); f.config.environment = 'production'
	assert.equal(f.run(), false); assert.equal(f.run(), false); assert.equal(f.calls(), 3)
	assert.throws(() => main(['verify', '--env', 'production']), /仅用于测试服/)
	assert.throws(() => main(['verify', '--env', 'test', '--skip-tests']), /不接受/)
})

for (const mode of ['offline', 'miss', 'production']) {
	test(`dependency cache ${mode} retains constrained isolated installation`, t => {
		const source = readFileSync(new URL('../backend/remote/loumai-backend-release', import.meta.url), 'utf8')
		const start = source.indexOf('  if [[ "$ENVIRONMENT" == "test" ]] &&', source.indexOf('install_runtime()'))
		const end = source.indexOf('  run_as_clean', source.indexOf('  fi\n', start) + 5)
		assert.ok(start > 0 && end > start)
		const dir = mkdtempSync(join(tmpdir(), 'offline-install-policy-'))
		t.after(() => rmSync(dir, { recursive: true, force: true }))
		const script = `set -euo pipefail\nENVIRONMENT=${mode === 'production' ? 'production' : 'test'}\nBUILD_USER=fixture\nbuild_home=${JSON.stringify(dir)}\nuv_cache=cache\nUV_BIN=uv\nbackend=backend\nbuild_source=source\nbuild_dir=${JSON.stringify(dir)}\nrun_as_clean() { if [[ " $* " == *" --offline "* ]] && [[ ${mode === 'miss' ? 1 : 0} == 1 ]]; then return 1; fi; printf 'INSTALL:%s\\n' "$*"; }\n` + source.slice(start, end)
		const result = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8' })
		assert.equal(result.status, 0, result.stderr)
		assert.match(result.stdout, /INSTALL:.*--no-build-isolation.*--constraint/)
		assert.equal(result.stdout.includes('INSTALL:fixture /usr/bin/env') && /INSTALL:.* --offline /.test(result.stdout), mode === 'offline')
		assert.equal(result.stdout.includes('TEST_RUNTIME_DEPENDENCIES='), mode !== 'production')
	})
}
