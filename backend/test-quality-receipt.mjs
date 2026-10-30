import { spawnSync } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_AGE_MS = 2 * 60 * 60 * 1000
const IGNORED_ENV = new Set([
	'PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
	'GIT_PAGER', 'GIT_SSH_COMMAND', 'PAGER', 'SYSTEMD_COLORS', 'SYSTEMD_PAGER',
	'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR',
	'BACKEND_REPO', 'BACKEND_PYTHON_BIN', 'LOUMAI_SOURCE_REPO', 'LOUMAI_PROJECT_ROOT', 'LOUMAI_BACKEND_PYTHON'
])
const hash = value => createHash('sha256').update(value).digest('hex')

function output(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
	if (result.error || result.status !== 0) throw new Error('无法生成门禁运行环境指纹')
	return result.stdout.trim()
}

function fingerprint(config, dbHead, environment) {
	if (output('git', ['status', '--porcelain'], config.repoRoot)) throw new Error('门禁源码工作区不干净')
	const tree = output('git', ['rev-parse', 'HEAD^{tree}'], config.repoRoot)
	const common = realpathSync(resolve(config.repoRoot, output('git', ['rev-parse', '--git-common-dir'], config.repoRoot)))
	const python = output(config.pythonBin, ['-c', [
		'import hashlib,importlib.metadata as m,json,sys',
		'rows=sorted((d.metadata.get("Name",""),d.version,hashlib.sha256((d.read_text("RECORD") or "").encode()).hexdigest()) for d in m.distributions())',
		'print(json.dumps({"version":sys.version,"prefix":sys.prefix,"packages":rows},sort_keys=True))'
	].join(';')], config.repoRoot)
	const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !IGNORED_ENV.has(key)).sort(([a], [b]) => a.localeCompare(b)))
	const dotenv = join(config.repoRoot, '.env')
	const identity = {
		version: 1, tree, common, dbHead, environment: config.environment,
		node: [process.version, process.platform, process.arch],
		constraints: hash(readFileSync(config.constraintsPath)),
		python: hash(realpathSync(config.pythonBin) + '\n' + hash(readFileSync(realpathSync(config.pythonBin))) + '\n' + python),
		settings: hash(JSON.stringify(env) + '\n' + (existsSync(dotenv) ? hash(readFileSync(dotenv)) : 'NO_ENV_FILE')),
		tool: hash(['backend/backend-release.mjs', 'backend/test-quality-receipt.mjs'].map(path => hash(readFileSync(join(ROOT, path)))).join('\n'))
	}
	return { identity, key: hash(JSON.stringify(identity)), directory: join(common, 'verified-test-gates') }
}

function privateFile(path) {
	const stat = lstatSync(path)
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
		throw new Error('门禁回执文件权限不安全')
	}
	if (stat.size > 65536) throw new Error('门禁回执文件过大')
	return readFileSync(path)
}

function signingKey(directory) {
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	const stat = lstatSync(directory)
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
		throw new Error('门禁回执目录权限不安全')
	}
	const path = join(directory, 'signing-key')
	try { writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' }) } catch (error) {
		if (error.code !== 'EEXIST') throw error
	}
	const key = privateFile(path)
	if (key.length !== 32) throw new Error('门禁回执密钥无效')
	return key
}

function readReceipt(path, signing, expected, now) {
	try {
		const record = JSON.parse(privateFile(path))
		const digest = createHmac('sha256', signing).update(JSON.stringify(record.payload)).digest('hex')
		if (!/^[0-9a-f]{64}$/.test(record.signature) || !timingSafeEqual(Buffer.from(digest), Buffer.from(record.signature))) return null
		const payload = record.payload
		if (payload.fingerprint !== expected.key || payload.status !== 'PASSED') return null
		if (!Number.isSafeInteger(payload.checkedAt) || now < payload.checkedAt || now - payload.checkedAt > MAX_AGE_MS) return null
		return payload
	} catch { return null } // Missing, damaged or untrusted local cache always falls back to fresh gates.
}

export function testQualityGates(config, dbHead, runGates, {
	force = false, now = () => Date.now(), environment = process.env, report = console.log
} = {}) {
	if (config.environment !== 'test') { runGates(); return false }
	let before, signing, path
	try {
		before = fingerprint(config, dbHead, environment)
		path = join(before.directory, before.key + '.json')
		signing = signingKey(before.directory)
	} catch {
		// A key problem must not leave an older success usable after a fresh failure.
		if (path) {
			try {
				const dir = lstatSync(before.directory)
				if (dir.isDirectory() && !dir.isSymbolicLink() && !(dir.mode & 0o077)
					&& (!process.getuid || dir.uid === process.getuid()) && existsSync(path)) unlinkSync(path)
			} catch { /* Untrusted or inaccessible cache is never consumed. */ }
		}
		report('门禁回执不可用，执行完整检查。')
		runGates()
		return false
	}
	if (!force) {
		const receipt = readReceipt(path, signing, before, now())
		if (receipt) {
			report(`复用已验证测试门禁：tree=${before.identity.tree}，检查时间=${new Date(receipt.checkedAt).toISOString()}；仍执行服务器预检与发布验收。`)
			return true
		}
	}
	// A new failure must invalidate an older success for this exact source/environment.
	if (existsSync(path)) unlinkSync(path)
	runGates()
	const after = fingerprint(config, dbHead, environment)
	if (before.key !== after.key) throw new Error('完整门禁期间源码、依赖或环境变化，不能发布或写入通过回执')
	const payload = { status: 'PASSED', fingerprint: after.key, tree: after.identity.tree, checkedAt: now() }
	const record = { payload, signature: createHmac('sha256', signing).update(JSON.stringify(payload)).digest('hex') }
	const temporary = path + '.' + randomBytes(8).toString('hex')
	writeFileSync(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 })
	renameSync(temporary, path)
	report(`完整测试门禁通过，已保存两小时有效回执：tree=${after.identity.tree}`)
	return false
}
