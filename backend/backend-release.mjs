#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
	buildEnvironmentAudit,
	ENV_RUNNER_KEYS,
	inspectEnvironmentText,
	parseRemoteEnvironmentAudit,
	renderEnvironmentAudit
} from './env-audit.mjs'

export const BACKEND_RELEASE_TOOL_VERSION = '5'
export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_CONFIG_PATH = join(TOOL_ROOT, 'config/backend.test.local.env')
export const PRODUCTION_CONFIG_PATH = join(TOOL_ROOT, 'config/backend.production.local.env')
export const DEFAULT_CONSTRAINTS_PATH = join(TOOL_ROOT, 'backend/runtime-constraints.test.txt')
export const PRODUCTION_CONSTRAINTS_PATH = join(
	TOOL_ROOT,
	'backend/runtime-constraints.production.txt'
)

const DEFAULT_EXPECTED_BRANCH = 'master'
const DEFAULT_REMOTE_HELPER = '/usr/local/sbin/loumai-backend-release'
const SUPPORTED_ENVIRONMENTS = new Set(['test', 'production'])
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/
const SAFE_REMOTE_TARGET = /^[A-Za-z0-9._-]+(?:@[A-Za-z0-9.-]+)?$/
const SAFE_RELEASE_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,12}$/
const SAFE_REVISION = /^[A-Za-z0-9_]+$/
const SAFE_ARTIFACT_PATH = /^[A-Za-z0-9._/-]+$/
const SECRET_KEY_PATTERN = /SECRET|PASSWORD|TOKEN|PRIVATE_KEY|ACCESS_KEY/i
const NON_INTERACTIVE_CHILD_ENV = Object.freeze({
	GIT_PAGER: 'cat',
	GIT_TERMINAL_PROMPT: '0',
	PAGER: 'cat',
	SYSTEMD_COLORS: '0',
	SYSTEMD_PAGER: 'cat'
})
const REQUIRED_SOURCE_FILES = [
	'app/main.py',
	'alembic/env.py',
	'alembic.ini',
	'pyproject.toml',
	'scripts/run_alembic_upgrade.py',
	'scripts/verify_database_schema.py',
	'runtime-constraints.txt'
]

class ReleaseError extends Error {
	constructor(message) {
		super(message)
		this.name = 'ReleaseError'
	}
}

function fail(message) {
	throw new ReleaseError(message)
}

function info(message) {
	process.stdout.write(`[backend-release] ${message}\n`)
}

function warn(message) {
	process.stderr.write(`[backend-release] 警告：${message}\n`)
}

function expandHome(value = '') {
	const normalized = String(value || '').trim()
	if (normalized === '~') return homedir()
	if (normalized.startsWith('~/')) return join(homedir(), normalized.slice(2))
	return normalized
}

export function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function displayCommand(command, args = []) {
	return [command, ...args].map(shellQuote).join(' ')
}

function run(command, args = [], options = {}) {
	const {
		capture = false,
		cwd = TOOL_ROOT,
		dryRun = false,
		env = process.env,
		maxBuffer = 256 * 1024 * 1024,
		quiet = false
	} = options
	if (!quiet) info(`${dryRun ? '[dry-run] ' : ''}${displayCommand(command, args)}`)
	if (dryRun) return { status: 0, stdout: '', stderr: '' }
	const result = spawnSync(command, args, {
		cwd,
		env: { ...env, ...NON_INTERACTIVE_CHILD_ENV },
		encoding: 'utf8',
		maxBuffer,
		stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit']
	})
	if (result.error) fail(`命令无法启动：${command}（${result.error.message}）`)
	if (result.status !== 0) {
		const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
		fail(`命令执行失败（exit ${result.status}）：${displayCommand(command, args)}${detail ? `\n${detail}` : ''}`)
	}
	return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

function runText(command, args = [], options = {}) {
	return run(command, args, { ...options, capture: true }).stdout.trim()
}

function git(repoRoot, args, options = {}) {
	return runText('git', ['--no-pager', ...args], {
		...options,
		cwd: repoRoot,
		quiet: options.quiet ?? true
	})
}

export function parseDotEnv(text = '') {
	const result = {}
	String(text).split(/\r?\n/).forEach((line, index) => {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) return
		const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
		if (!match) fail(`配置第 ${index + 1} 行格式错误`)
		let value = match[2].trim()
		if (
			(value.startsWith('"') && value.endsWith('"'))
			|| (value.startsWith("'") && value.endsWith("'"))
		) value = value.slice(1, -1)
		result[match[1]] = value
	})
	return result
}

function loadDotEnvFile(path, { required = true } = {}) {
	if (!existsSync(path)) {
		if (required) fail(`找不到配置文件：${path}`)
		return {}
	}
	return parseDotEnv(readFileSync(path, 'utf8'))
}

export function parseArgs(argv = []) {
	let configPathExplicit = false
	const args = {
		ackDbSchemaCompatible: false,
		all: false,
		command: 'help',
		configPath: DEFAULT_CONFIG_PATH,
		databaseProfile: '',
		dryRun: false,
		environment: 'test',
		help: false,
		releaseId: '',
		skipTests: false,
		yes: false
	}
	const values = [...argv]
	if (values[0] && !values[0].startsWith('-')) args.command = values.shift()
	while (values.length) {
		const value = values.shift()
		switch (value) {
			case '--ack-db-schema-compatible':
				args.ackDbSchemaCompatible = true
				break
			case '--all':
				args.all = true
				break
			case '--config': {
				const configPath = values.shift()
				if (!configPath || configPath.startsWith('-')) fail('--config 缺少文件路径')
				args.configPath = resolve(TOOL_ROOT, configPath)
				configPathExplicit = true
				break
			}
			case '--dry-run':
				args.dryRun = true
				break
			case '--database-profile': {
				const databaseProfile = values.shift()
				if (!databaseProfile || databaseProfile.startsWith('-')) {
					fail('--database-profile 缺少 local、cloud 或 active')
				}
				if (!['local', 'cloud', 'active'].includes(databaseProfile)) {
					fail(`数据库 profile 非法：${databaseProfile}`)
				}
				args.databaseProfile = databaseProfile
				break
			}
			case '--env': {
				const environment = values.shift()
				if (!environment || environment.startsWith('-')) fail('--env 缺少环境名称')
				args.environment = environment
				break
			}
			case '--help':
			case '-h':
				args.help = true
				break
			case '--release': {
				const releaseId = values.shift()
				if (!releaseId || releaseId.startsWith('-')) fail('--release 缺少 release_id')
				args.releaseId = releaseId
				break
			}
			case '--skip-tests':
				args.skipTests = true
				break
			case '--yes':
				args.yes = true
				break
			default:
				fail(`未知参数：${value}`)
		}
	}
	if (!SUPPORTED_ENVIRONMENTS.has(args.environment)) {
		fail(`不支持的部署环境：${args.environment}`)
	}
	if (!configPathExplicit) {
		args.configPath = args.environment === 'production'
			? PRODUCTION_CONFIG_PATH
			: DEFAULT_CONFIG_PATH
	}
	return args
}

function usage() {
	return `
楼脉后端可验证发布工具

用法：
  node backend/backend-release.mjs build [--env test|production] [--config FILE] [--skip-tests]
  node backend/backend-release.mjs env-audit --env test|production [--all] [--config FILE]
  node backend/backend-release.mjs deploy --env test|production --dry-run [--config FILE]
  node backend/backend-release.mjs deploy --env test|production --yes [--config FILE]
  node backend/backend-release.mjs bootstrap --env production --dry-run [--config FILE]
  node backend/backend-release.mjs bootstrap --env production --yes [--config FILE]
  node backend/backend-release.mjs recover --env production --dry-run [--config FILE]
  node backend/backend-release.mjs recover --env production --yes [--config FILE]
  node backend/backend-release.mjs deploy-cloud --env test --dry-run [--config FILE]
  node backend/backend-release.mjs deploy-cloud --env test --yes [--config FILE]
  node backend/backend-release.mjs status --env test|production [--database-profile local|cloud|active] [--config FILE]
  node backend/backend-release.mjs rollback --env test|production --release RELEASE_ID --ack-db-schema-compatible --yes [--config FILE]

安全约束：
	- env-audit 只读比较本地与目标服配置；敏感值不显示、不传输、不写入服务器。
  - 测试服 deploy 选择本地 PostgreSQL，deploy-cloud 选择腾讯云 PostgreSQL。
  - 正式服 deploy 强制选择腾讯云 PostgreSQL；远端 helper 会拒绝正式服 local profile。
	- 全新正式服只允许一次 bootstrap；后续必须使用 deploy，两个命令都强制腾讯云数据库。
	- 迁移或切换失败后，普通发布会被恢复标记锁定；只能用 recover 携带新的前向修复产物继续。
	- bootstrap/deploy/deploy-cloud/recover 不允许 --skip-tests；每次从 clean、已同步 upstream 的精确 Git commit 打包。
  - rollback 只切换应用，不执行 Alembic downgrade，也不恢复数据库。
  - 数据库迁移一旦尝试，远端失败路径保持服务停止，等待人工前向修复或恢复决策。
`.trim()
}

function normalizeBoolean(value, fallback = false) {
	if (value === undefined || value === null || value === '') return fallback
	if (['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())) return true
	if (['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())) return false
	fail(`布尔配置值非法：${value}`)
}

function assertSafeAbsolutePath(value, label) {
	if (!SAFE_REMOTE_PATH.test(value) || value === '/' || value.includes('..')) {
		fail(`${label} 不是安全绝对路径：${value}`)
	}
}

export function loadConfiguration(args, { requireRemote = false } = {}) {
	const fileConfig = loadDotEnvFile(args.configPath, { required: true })
	for (const key of Object.keys(fileConfig)) {
		if (SECRET_KEY_PATTERN.test(key)) fail(`部署配置禁止保存密码、Token 或私钥内容：${key}`)
	}
	const values = { ...fileConfig }
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith('BACKEND_') && value !== undefined) {
			if (SECRET_KEY_PATTERN.test(key)) fail(`环境变量禁止传入密码、Token 或私钥内容：${key}`)
			values[key] = value
		}
	}
	const repoValue = expandHome(values.BACKEND_REPO || '')
	if (!repoValue) fail('必须显式配置 BACKEND_REPO')
	const repoRoot = resolve(repoValue)
	if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
		fail(`BACKEND_REPO 不是目录：${repoRoot}`)
	}
	if (realpathSync(repoRoot) !== repoRoot) fail('BACKEND_REPO 不能经过软链接')
	for (const required of ['.git', 'pyproject.toml', 'alembic.ini', 'alembic/versions']) {
		if (!existsSync(join(repoRoot, required))) fail(`BACKEND_REPO 缺少：${required}`)
	}
	const constraintsPath = resolve(
		expandHome(
			values.BACKEND_RUNTIME_CONSTRAINTS
			|| (args.environment === 'production'
				? PRODUCTION_CONSTRAINTS_PATH
				: DEFAULT_CONSTRAINTS_PATH)
		)
	)
	const pythonBin = resolve(
		expandHome(values.BACKEND_PYTHON_BIN || join(repoRoot, '.venv311/bin/python'))
	)
	if (!existsSync(pythonBin)) fail(`后端 Python 不存在：${pythonBin}`)
	if (!existsSync(constraintsPath)) fail(`runtime constraints 不存在：${constraintsPath}`)

	const configuredEnvironment = values.BACKEND_ENVIRONMENT || args.environment
	if (!SUPPORTED_ENVIRONMENTS.has(configuredEnvironment)) {
		fail(`BACKEND_ENVIRONMENT 配置非法：${configuredEnvironment}`)
	}
	if (configuredEnvironment !== args.environment) {
		fail(`配置环境 ${configuredEnvironment} 与命令 --env ${args.environment} 不一致`)
	}

	const config = {
		constraintsPath,
		environment: configuredEnvironment,
		expectedBranch: values.BACKEND_EXPECTED_BRANCH || DEFAULT_EXPECTED_BRANCH,
		identityFile: expandHome(values.BACKEND_SSH_IDENTITY_FILE || ''),
		publicUrl: String(values.BACKEND_PUBLIC_URL || '').replace(/\/+$/, ''),
		pythonBin,
		remoteHelper: values.BACKEND_REMOTE_HELPER || DEFAULT_REMOTE_HELPER,
		remoteStagingRoot: values.BACKEND_REMOTE_STAGING_ROOT || '',
		repoRoot,
		requireUpstreamMatch: normalizeBoolean(values.BACKEND_REQUIRE_UPSTREAM_MATCH, true),
		sshPort: Number(values.BACKEND_SSH_PORT || 22),
		target: values.BACKEND_DEPLOY_TARGET || '',
		useSudo: normalizeBoolean(values.BACKEND_REMOTE_USE_SUDO, true)
	}
	if (!config.expectedBranch || /\s/.test(config.expectedBranch)) {
		fail('BACKEND_EXPECTED_BRANCH 配置非法')
	}
	validateRuntimeConstraints(config.constraintsPath)
	if (requireRemote) {
		if (!SAFE_REMOTE_TARGET.test(config.target)) fail('BACKEND_DEPLOY_TARGET 格式非法')
		if (!Number.isInteger(config.sshPort) || config.sshPort < 1 || config.sshPort > 65535) {
			fail('BACKEND_SSH_PORT 格式非法')
		}
		assertSafeAbsolutePath(config.remoteHelper, 'BACKEND_REMOTE_HELPER')
		assertSafeAbsolutePath(config.remoteStagingRoot, 'BACKEND_REMOTE_STAGING_ROOT')
		let parsed
		try {
			parsed = new URL(config.publicUrl)
		} catch {
			fail('BACKEND_PUBLIC_URL 不是合法 URL')
		}
		if (
			parsed.protocol !== 'https:'
			|| parsed.pathname !== '/'
			|| parsed.username
			|| parsed.password
			|| parsed.search
			|| parsed.hash
		) fail('BACKEND_PUBLIC_URL 必须是无凭据的 HTTPS 根地址')
		if (config.identityFile && !existsSync(config.identityFile)) {
			fail(`SSH identity 文件不存在：${config.identityFile}`)
		}
	}
	return config
}

function resolveGitPath(repoRoot, name) {
	return resolve(repoRoot, git(repoRoot, ['rev-parse', '--git-path', name]))
}

export function inspectGitState(config) {
	const branch = git(config.repoRoot, ['branch', '--show-current'])
	const commit = git(config.repoRoot, ['rev-parse', 'HEAD'])
	const shortCommit = git(config.repoRoot, ['rev-parse', '--short=10', 'HEAD'])
	if (!/^[0-9a-f]{40}$/.test(commit)) fail('无法取得完整 Git commit')
	if (branch !== config.expectedBranch) {
		fail(`当前分支是 ${branch || '(detached)'}，要求 ${config.expectedBranch}`)
	}
	if (git(config.repoRoot, ['status', '--porcelain'])) fail('后端工作区不干净，拒绝构建或部署')
	for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) {
		if (existsSync(resolveGitPath(config.repoRoot, marker))) fail(`Git 操作尚未结束：${marker}`)
	}
	if (config.requireUpstreamMatch) {
		let upstream
		try {
			upstream = git(config.repoRoot, ['rev-parse', '@{upstream}'])
		} catch {
			fail('当前分支没有 upstream，无法确认远端版本')
		}
		if (upstream !== commit) fail('当前提交与 upstream 不一致，请先同步远端')
	}
	return { branch, commit, shortCommit }
}

export function inspectMigrationHead(config) {
	const source = [
		'import json',
		'from alembic.config import Config',
		'from alembic.script import ScriptDirectory',
		'c=Config("alembic.ini")',
		'c.set_main_option("script_location", "alembic")',
		'print(json.dumps(ScriptDirectory.from_config(c).get_heads()))'
	].join(';')
	const parsed = JSON.parse(runText(config.pythonBin, ['-c', source], {
		cwd: config.repoRoot,
		quiet: true
	}))
	if (!Array.isArray(parsed) || parsed.length !== 1 || !SAFE_REVISION.test(parsed[0])) {
		fail(`Alembic 必须且只能有一个 head：${JSON.stringify(parsed)}`)
	}
	return parsed[0]
}

function runQualityGates(config, { skipTests = false } = {}) {
	run('git', ['--no-pager', 'diff', '--check'], { cwd: config.repoRoot })
	if (skipTests) {
		warn('仅 build 跳过 Ruff、迁移影子库和 pytest；该产物不能由 deploy 默认发布')
		return
	}
	run(config.pythonBin, ['-m', 'ruff', 'check', 'app', 'alembic', 'scripts'], {
		cwd: config.repoRoot
	})
	run(config.pythonBin, ['-m', 'ruff', 'format', '--check', 'app', 'alembic', 'scripts'], {
		cwd: config.repoRoot
	})
	run(config.pythonBin, ['scripts/verify_migrations_in_shadow_db.py'], {
		cwd: config.repoRoot
	})
	run(config.pythonBin, ['scripts/run_tests_in_shadow_db.py', 'app/tests', '-q'], {
		cwd: config.repoRoot
	})
}

function compactTimestamp(date = new Date()) {
	return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export function createReleaseId(shortCommit, now = new Date()) {
	const releaseId = `${compactTimestamp(now)}-${String(shortCommit).toLowerCase()}`
	if (!SAFE_RELEASE_ID.test(releaseId)) fail(`生成的 release_id 非法：${releaseId}`)
	return releaseId
}

function listFiles(root) {
	const files = []
	function walk(directory) {
		for (const name of readdirSync(directory)) {
			const absolute = join(directory, name)
			const entry = lstatSync(absolute)
			const relativePath = relative(root, absolute).split(sep).join('/')
			if (!SAFE_ARTIFACT_PATH.test(relativePath) || relativePath.includes('..')) {
				fail(`后端产物包含不安全路径：${relativePath}`)
			}
			if (entry.isSymbolicLink()) fail(`后端产物包含软链接：${relativePath}`)
			if (entry.isDirectory()) walk(absolute)
			else if (entry.isFile()) files.push({ absolute, relative: relativePath, stat: entry })
			else fail(`后端产物包含特殊文件：${relativePath}`)
		}
	}
	walk(root)
	return files.sort((left, right) => left.relative.localeCompare(right.relative))
}

function sha256File(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function validateRuntimeConstraints(path) {
	const seen = new Set()
	const lines = readFileSync(path, 'utf8').split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'))
	if (lines.length < 10) fail('runtime constraints 条目过少')
	for (const line of lines) {
		const match = line.match(/^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)$/)
		if (!match) fail(`runtime constraints 必须精确锁版本且禁止 URL/参数：${line}`)
		const normalized = match[1].toLowerCase().replaceAll('_', '-')
		if (seen.has(normalized)) fail(`runtime constraints 重复包：${match[1]}`)
		seen.add(normalized)
	}
	return lines
}

export function validateSourceArtifact(
	backendDir,
	{ expectedCommit = '', expectedEnvironment = '', expectedHead = '' } = {}
) {
	if (!existsSync(backendDir) || !statSync(backendDir).isDirectory()) fail('后端产物目录不存在')
	const files = listFiles(backendDir)
	if (files.length < 30) fail(`后端产物文件过少：${files.length}`)
	for (const required of REQUIRED_SOURCE_FILES) {
		if (!existsSync(join(backendDir, required))) fail(`后端产物缺少：${required}`)
	}
	for (const { relative: path } of files) {
		if (
			path === '.env'
			|| path.startsWith('.git/')
			|| path.startsWith('.venv')
			|| path.includes('/__pycache__/')
			|| path.endsWith('.pyc')
		) fail(`后端产物包含禁止内容：${path}`)
	}
	validateRuntimeConstraints(join(backendDir, 'runtime-constraints.txt'))
	const manifestPath = join(backendDir, 'release.json')
	if (existsSync(manifestPath)) {
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
		if (expectedCommit && manifest.commit !== expectedCommit) fail('release.json commit 不匹配')
		if (expectedEnvironment && manifest.environment !== expectedEnvironment) {
			fail('release.json environment 不匹配')
		}
		if (expectedHead && manifest.artifact_db_head !== expectedHead) {
			fail('release.json artifact_db_head 不匹配')
		}
	}
	return { fileCount: files.length, files }
}

function writeChecksums(backendDir) {
	const files = listFiles(backendDir).filter(({ relative: path }) => path !== 'SHA256SUMS')
	const lines = files.map(({ absolute, relative: path }) => `${sha256File(absolute)}  ${path}`)
	writeFileSync(join(backendDir, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8')
	return sha256File(join(backendDir, 'SHA256SUMS'))
}

function ensureBuildRoot(buildRoot) {
	const distRoot = dirname(buildRoot)
	for (const directory of [TOOL_ROOT, distRoot, buildRoot]) {
		if (!existsSync(directory)) mkdirSync(directory, { mode: 0o755 })
		const entry = lstatSync(directory)
		if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(directory) !== directory) {
			fail(`构建目录必须是真实目录且不能经过软链接：${directory}`)
		}
	}
}

function safeRemovePartial(buildRoot, partialRoot) {
	ensureBuildRoot(buildRoot)
	const name = basename(partialRoot)
	if (
		!/^\.[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,12}\.partial$/.test(name)
		|| dirname(partialRoot) !== buildRoot
	) fail(`拒绝清理越界目录：${partialRoot}`)
	if (!existsSync(partialRoot)) return
	const entry = lstatSync(partialRoot)
	if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`拒绝清理异常 partial：${partialRoot}`)
	rmSync(partialRoot, { force: true, recursive: true })
}

function buildRelease(config, gitState, artifactDbHead) {
	const releaseId = createReleaseId(gitState.shortCommit)
	const buildRoot = join(TOOL_ROOT, 'dist/backend-releases')
	const partialRoot = join(buildRoot, `.${releaseId}.partial`)
	const finalRoot = join(buildRoot, releaseId)
	const backendDir = join(partialRoot, 'backend')
	const sourceTar = join(partialRoot, 'source.tar')
	ensureBuildRoot(buildRoot)
	if (existsSync(partialRoot) || existsSync(finalRoot)) fail(`release_id 已存在：${releaseId}`)
	mkdirSync(partialRoot, { mode: 0o700 })
	mkdirSync(backendDir, { mode: 0o755 })
	try {
		run('git', [
			'archive', '--format=tar', `--output=${sourceTar}`, gitState.commit, '--',
			'app', 'alembic', 'scripts', 'pyproject.toml', 'alembic.ini'
		], { cwd: config.repoRoot })
		run('tar', ['--extract', '--file', sourceTar, '--directory', backendDir], {
			env: { ...process.env, COPYFILE_DISABLE: '1' }
		})
		rmSync(sourceTar)
		copyFileSync(config.constraintsPath, join(backendDir, 'runtime-constraints.txt'))
		const preliminary = validateSourceArtifact(backendDir)
		const manifest = {
			schema_version: 1,
			release_id: releaseId,
			commit: gitState.commit,
			branch: gitState.branch,
			environment: config.environment,
			built_at: new Date().toISOString(),
			artifact_db_head: artifactDbHead,
			constraints_sha256: sha256File(join(backendDir, 'runtime-constraints.txt')),
			source_file_count: preliminary.fileCount,
			database_rollback_policy: 'NO_AUTOMATIC_DOWNGRADE_OR_RESTORE',
			tool: { backend_release_tool: BACKEND_RELEASE_TOOL_VERSION }
		}
		writeFileSync(join(backendDir, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
		const checksumsSha256 = writeChecksums(backendDir)
		validateSourceArtifact(backendDir, {
			expectedCommit: gitState.commit,
			expectedEnvironment: config.environment,
			expectedHead: artifactDbHead
		})
		const archivePath = join(partialRoot, 'backend.tar')
		run('tar', ['--create', '--no-xattrs', '--file', archivePath, '--directory', partialRoot, 'backend'], {
			env: { ...process.env, COPYFILE_DISABLE: '1' }
		})
		const archiveSha256 = sha256File(archivePath)
		renameSync(partialRoot, finalRoot)
		const result = {
			archivePath: join(finalRoot, 'backend.tar'),
			archiveSha256,
			artifactDbHead,
			checksumsSha256,
			manifest,
			releaseId
		}
		info(`构建完成：${finalRoot}`)
		return result
	} catch (error) {
		safeRemovePartial(buildRoot, partialRoot)
		throw error
	}
}

function sshOptions(config) {
	const options = [
		'-o', 'BatchMode=yes',
		'-o', 'StrictHostKeyChecking=yes',
		'-o', 'ConnectTimeout=10',
		'-o', 'ServerAliveInterval=15',
		'-o', 'ServerAliveCountMax=12',
		'-o', 'TCPKeepAlive=yes',
		'-p', String(config.sshPort)
	]
	if (config.identityFile) options.push('-i', config.identityFile)
	return options
}

function remoteHelperCommand(config, args) {
	const command = [config.remoteHelper, ...args].map(shellQuote).join(' ')
	return config.useSudo ? `sudo -n ${command}` : command
}

function remoteHelper(config, args, { capture = false } = {}) {
	return run('ssh', [...sshOptions(config), config.target, remoteHelperCommand(config, args)], {
		capture,
		maxBuffer: 64 * 1024 * 1024
	})
}

function tryRemoteAbort(config, releaseId) {
	try {
		remoteHelper(config, ['abort', releaseId])
	} catch (error) {
		warn(`远端 staging 自动清理失败：${error.message}`)
	}
}

function parseKeyValueOutput(text = '') {
	const result = {}
	for (const line of String(text).split(/\r?\n/)) {
		const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
		if (match) result[match[1]] = match[2]
	}
	return result
}

function assertRemoteHelperExact(config) {
	const version = remoteHelper(config, ['version'], { capture: true }).stdout.trim()
	if (version !== BACKEND_RELEASE_TOOL_VERSION) {
		fail(`远端 helper 版本不一致：实际 ${version || '(empty)'}，要求 ${BACKEND_RELEASE_TOOL_VERSION}`)
	}
	const expectedFingerprint = sha256File(join(TOOL_ROOT, 'backend/remote/loumai-backend-release'))
	let actualFingerprint = ''
	try {
		actualFingerprint = remoteHelper(config, ['fingerprint'], { capture: true }).stdout.trim()
	} catch {
		fail('远端 helper 不支持源码指纹校验，请先安装当前部署仓库中的 helper')
	}
	if (actualFingerprint !== expectedFingerprint) {
		fail('远端 helper 与本地源码不一致，请先更新服务器 helper 后再发布')
	}
}

function remotePreflight(config, databaseProfile = 'active', { mode = 'deploy' } = {}) {
	if (!['bootstrap', 'deploy', 'recover'].includes(mode)) fail(`远端 preflight 模式非法：${mode}`)
	assertRemoteHelperExact(config)
	const output = remoteHelper(config, ['preflight', databaseProfile, mode], { capture: true }).stdout
	process.stdout.write(output)
	const values = parseKeyValueOutput(output)
	const expectedRemoteRoot = dirname(config.remoteStagingRoot)
	if (values.HELPER_VERSION !== BACKEND_RELEASE_TOOL_VERSION) fail('远端 preflight 协议版本不一致')
	if (values.ENVIRONMENT !== config.environment) {
		fail(`远端环境不匹配：实际 ${values.ENVIRONMENT || '(empty)'}，要求 ${config.environment}`)
	}
	if (values.STAGING_ROOT !== config.remoteStagingRoot) fail('本地与远端 staging 配置不一致')
	if (values.REMOTE_ROOT !== expectedRemoteRoot) fail('本地与远端发布根目录不一致')
	if (values.PUBLIC_HEALTH_URL !== `${config.publicUrl}/health`) {
		fail('本地与远端公网健康检查 URL 不一致')
	}
	if (!['true', 'false'].includes(values.INITIALIZED || '')) fail('远端未返回合法 INITIALIZED')
	if (values.OPERATION_MODE !== mode) fail('远端 preflight 操作模式不一致')
	if (mode === 'recover') {
		if (config.environment !== 'production') fail('recover 只允许用于正式服')
		if (values.DEPLOYMENT_STATE !== 'RECOVERY_REQUIRED' || values.RECOVERY_REQUIRED !== 'true') {
			fail('目标服不处于受控恢复状态，不能执行 recover')
		}
		if (!/^[0-9a-f]{64}$/.test(values.RECOVERY_TOKEN || '')) {
			fail('远端未返回合法 RECOVERY_TOKEN')
		}
		if (!['prepared', 'stopped', 'migrating'].includes(values.RECOVERY_PHASE || '')) {
			fail('远端未返回合法 RECOVERY_PHASE')
		}
		if (!SAFE_REVISION.test(values.DB_REVISION || '') || values.DB_REVISION === 'bootstrap') {
			fail('recover 未返回真实数据库 revision')
		}
	} else if (values.INITIALIZED === 'false') {
		if (mode !== 'bootstrap') fail('目标服尚未初始化；首次正式发布必须使用 backend bootstrap --env production')
		if (values.CURRENT !== 'NONE' || values.DB_REVISION !== 'bootstrap') {
			fail('目标服首次发布状态协议异常')
		}
	} else {
		if (mode === 'bootstrap') fail('目标服已经初始化，不能再次执行 bootstrap')
		if (!SAFE_REVISION.test(values.DB_REVISION || '') || values.DB_REVISION === 'bootstrap') {
			fail('远端未返回合法 DB_REVISION')
		}
		if (!values.CURRENT || values.CURRENT === 'NONE') fail('远端未返回当前后端版本')
	}
	if (mode !== 'recover') {
		if (values.RECOVERY_REQUIRED !== 'false' || values.RECOVERY_TOKEN !== 'NONE') {
			fail('普通发布遇到恢复状态，必须改用 backend recover')
		}
		const expectedState = mode === 'bootstrap' ? 'UNINITIALIZED' : 'HEALTHY'
		if (values.DEPLOYMENT_STATE !== expectedState) fail('远端部署状态与操作模式不一致')
	}
	if (values.DATABASE_PROFILE !== databaseProfile && databaseProfile !== 'active') {
		fail(`远端数据库 profile 不匹配：实际 ${values.DATABASE_PROFILE || '(empty)'}，要求 ${databaseProfile}`)
	}
	if (!['local', 'cloud'].includes(values.DATABASE_PROFILE || '')) {
		fail('远端未返回合法 DATABASE_PROFILE')
	}
	if (!['local', 'cloud'].includes(values.ACTIVE_DATABASE_PROFILE || '')) {
		fail('远端未返回合法 ACTIVE_DATABASE_PROFILE')
	}
	if (!['ready', 'repairable'].includes(values.BACKUP_ROOT_STATUS || '')) {
		fail('远端 helper 尚未包含数据库备份目录自动修复能力，请先更新 helper')
	}
	if (values.BACKUP_ROOT_STATUS === 'repairable') {
		warn('数据库备份目录当前权限不满足 pg_dump；正式发布会在上传前自动修复为备份专用用户私有目录')
	}
	return values
}

function showRemoteStatus(config, databaseProfile = 'active') {
	const version = remoteHelper(config, ['version'], { capture: true }).stdout.trim()
	if (version === BACKEND_RELEASE_TOOL_VERSION) {
		const output = remoteHelper(config, ['status', databaseProfile], { capture: true }).stdout
		const values = parseKeyValueOutput(output)
		if (values.ENVIRONMENT !== config.environment) {
			fail(`远端环境不匹配：实际 ${values.ENVIRONMENT || '(empty)'}，要求 ${config.environment}`)
		}
		process.stdout.write(output)
		return
	}
	if (config.environment === 'test' && version === '1' && databaseProfile === 'active') {
		warn('测试服 helper 仍是版本 1：本次按旧协议查询状态，无法显示双数据库 profile；正式切库前必须升级 helper')
		remoteHelper(config, ['status'])
		return
	}
	if (version === '1') {
		fail(`测试服 helper 版本 1 不支持查询 ${databaseProfile} 数据库 profile；请先升级服务器 helper`)
	}
	fail(`远端 helper 版本不一致：实际 ${version || '(empty)'}，要求 ${BACKEND_RELEASE_TOOL_VERSION}`)
}

function uploadArchive(config, releaseId, archivePath, stageDir) {
	const expectedStage = `${config.remoteStagingRoot}/${releaseId}.partial`
	if (stageDir !== expectedStage) fail(`远端 staging 路径异常：${stageDir}`)
	const args = [
		'-o', 'BatchMode=yes',
		'-o', 'StrictHostKeyChecking=yes',
		'-o', 'ConnectTimeout=10',
		'-o', 'ServerAliveInterval=15',
		'-o', 'ServerAliveCountMax=12',
		'-o', 'TCPKeepAlive=yes',
		'-P', String(config.sshPort)
	]
	if (config.identityFile) args.push('-i', config.identityFile)
	args.push(archivePath, `${config.target}:${stageDir}/backend.tar`)
	run('scp', args)
}

function deploy(config, gitState, artifactDbHead, databaseProfile, { mode = 'deploy' } = {}) {
	const preflight = remotePreflight(config, databaseProfile, { mode })
	const artifact = buildRelease(config, gitState, artifactDbHead)
	let prepared = false
	try {
		const prepareOutput = remoteHelper(config, [
			'prepare', artifact.releaseId, databaseProfile, mode, preflight.RECOVERY_TOKEN
		], {
			capture: true
		}).stdout
		process.stdout.write(prepareOutput)
		const stageDir = parseKeyValueOutput(prepareOutput).STAGE_DIR
		prepared = true
		uploadArchive(config, artifact.releaseId, artifact.archivePath, stageDir)
		remoteHelper(config, [
			'activate',
			artifact.releaseId,
			gitState.commit,
			artifact.artifactDbHead,
			artifact.checksumsSha256,
			artifact.archiveSha256,
			preflight.CURRENT,
			preflight.DB_REVISION,
			databaseProfile,
			mode,
			preflight.RECOVERY_TOKEN
		])
		prepared = false
		info(`发布完成：${artifact.releaseId}`)
	} finally {
		if (prepared) tryRemoteAbort(config, artifact.releaseId)
	}
}

function rollback(config, args) {
	if (!SAFE_RELEASE_ID.test(args.releaseId)) fail('rollback release_id 格式非法')
	const preflight = remotePreflight(config, 'active', { mode: 'deploy' })
	remoteHelper(config, [
		'rollback',
		args.releaseId,
		preflight.CURRENT,
		preflight.DB_REVISION,
		'ACK_DB_SCHEMA_COMPATIBLE'
	])
}

function inspectLocalSettings(config) {
	const source = `
import json

from app.core.config import Settings


def normalized_location(error):
    location = error.get("loc") or ("__SETTINGS__",)
    return "_".join(str(item) for item in location).upper()


fields = sorted(str(name).upper() for name in Settings.model_fields)
errors = []
try:
    Settings()
except Exception as exc:
    if hasattr(exc, "errors"):
        for error in exc.errors(include_input=False, include_url=False):
            errors.append({
                "field": normalized_location(error),
                "type": str(error.get("type") or type(exc).__name__),
            })
    else:
        errors.append({"field": "__SETTINGS__", "type": type(exc).__name__})

print(json.dumps({"errors": errors, "fields": fields, "valid": not errors}))
`.trim()
	const minimalEnvironment = {
		LANG: process.env.LANG || 'C.UTF-8',
		PATH: process.env.PATH || '/usr/bin:/bin',
		PYTHONDONTWRITEBYTECODE: '1',
		PYTHONUNBUFFERED: '1'
	}
	let parsed
	try {
		parsed = JSON.parse(runText(config.pythonBin, ['-c', source], {
			cwd: config.repoRoot,
			env: minimalEnvironment,
			quiet: true
		}))
	} catch {
		fail('无法安全读取本地 Settings 元数据；为避免泄露配置内容，原始异常未输出')
	}
	if (
		!parsed
		|| !Array.isArray(parsed.fields)
		|| !Array.isArray(parsed.errors)
		|| typeof parsed.valid !== 'boolean'
	) fail('本地 Settings 审计输出格式错误')
	return parsed
}

export function auditEnvironment(config, args) {
	assertRemoteHelperExact(config)
	const localPath = join(config.repoRoot, '.env')
	const examplePath = join(config.repoRoot, '.env.example')
	if (!existsSync(localPath)) fail(`本地后端环境文件不存在：${localPath}`)
	if (!existsSync(examplePath)) fail(`本地后端环境模板不存在：${examplePath}`)

	let local
	let example
	try {
		local = inspectEnvironmentText(readFileSync(localPath, 'utf8'), '.env')
		example = inspectEnvironmentText(readFileSync(examplePath, 'utf8'), '.env.example')
	} catch (error) {
		fail(`本地环境文件解析失败：${error.message}`)
	}
	if (example.duplicates.length) {
		fail(`.env.example 存在重复变量：${example.duplicates.map(({ key }) => key).join('、')}`)
	}
	const localSettings = inspectLocalSettings(config)
	const catalogKeys = [...new Set([
		...example.entries.keys(),
		...localSettings.fields,
		...ENV_RUNNER_KEYS
	])].sort()

	let remote
	try {
		const output = remoteHelper(config, ['env-audit', args.environment], { capture: true }).stdout
		remote = parseRemoteEnvironmentAudit(output)
	} catch (error) {
		if (/用法：loumai-backend-release/.test(error.message) || /env-audit/.test(error.message)) {
			fail('目标服 helper 尚未安装 env-audit 能力，请先更新 /usr/local/sbin/loumai-backend-release')
		}
		throw error
	}

	const audit = buildEnvironmentAudit({
		all: args.all,
		catalogKeys,
		local,
		localSettings,
		remote,
		targetEnvironment: args.environment
	})
	process.stdout.write(renderEnvironmentAudit(audit, { targetEnvironment: args.environment }))
	if (audit.blockers) fail(`环境审计发现 ${audit.blockers} 个阻断项；未修改本地或目标服配置`)
	return audit
}

export function remoteHelperContractSource() {
	return readFileSync(join(TOOL_ROOT, 'backend/remote/loumai-backend-release'), 'utf8')
}

export function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv)
	if (args.help || args.command === 'help') {
		process.stdout.write(`${usage()}\n`)
		return
	}
	if (!['build', 'bootstrap', 'deploy', 'deploy-cloud', 'recover', 'env-audit', 'status', 'rollback'].includes(args.command)) {
		fail(`未知命令：${args.command}`)
	}
	if (args.command !== 'env-audit' && args.all) fail('--all 只能用于 env-audit')
	if (args.command === 'env-audit') {
		if (
			args.yes
			|| args.dryRun
			|| args.skipTests
			|| args.releaseId
			|| args.ackDbSchemaCompatible
			|| args.databaseProfile
		) {
			fail('env-audit 是只读命令，不能使用发布、跳过测试或回滚参数')
		}
		const config = loadConfiguration(args, { requireRemote: true })
		auditEnvironment(config, args)
		return
	}
	if (['bootstrap', 'deploy', 'deploy-cloud', 'recover'].includes(args.command) && args.skipTests) {
		fail(`${args.command} 禁止 --skip-tests`)
	}
	if (args.command === 'bootstrap' && args.environment !== 'production') {
		fail('bootstrap 只用于全新正式服，必须提供 --env production')
	}
	if (args.command === 'recover' && args.environment !== 'production') {
		fail('recover 只用于正式服故障前向修复，必须提供 --env production')
	}
	if (args.databaseProfile && !['status'].includes(args.command)) {
		fail('--database-profile 只能用于 status；发布请使用 deploy 或 deploy-cloud')
	}
	if (args.command === 'rollback') {
		if (!args.releaseId) fail('rollback 必须提供 --release')
		if (!args.ackDbSchemaCompatible) fail('rollback 必须提供 --ack-db-schema-compatible')
		if (!args.yes) fail('rollback 必须显式提供 --yes')
	}
	if (['bootstrap', 'deploy', 'deploy-cloud', 'recover'].includes(args.command) && !args.dryRun && !args.yes) {
		fail(`正式 ${args.command} 必须显式提供 --yes`)
	}
	const config = loadConfiguration(args, { requireRemote: args.command !== 'build' })
	if (args.command === 'status') {
		showRemoteStatus(config, args.databaseProfile || 'active')
		return
	}
	if (args.command === 'rollback') {
		rollback(config, args)
		return
	}
	const gitState = inspectGitState(config)
	const artifactDbHead = inspectMigrationHead(config)
	info(`锁定后端 commit=${gitState.commit}，alembic_head=${artifactDbHead}`)
	const databaseProfile = args.environment === 'production' || args.command === 'deploy-cloud'
		? 'cloud'
		: 'local'
	const operationMode = args.command === 'bootstrap'
		? 'bootstrap'
		: args.command === 'recover' ? 'recover' : 'deploy'
	if (['bootstrap', 'deploy', 'deploy-cloud', 'recover'].includes(args.command) && args.dryRun) {
		remotePreflight(config, databaseProfile, { mode: operationMode })
		run('git', ['--no-pager', 'diff', '--check'], { cwd: config.repoRoot })
		info(`[dry-run] ${databaseProfile} 数据库只读预检通过；未测试、未打包、未上传、未迁移、未切换`)
		return
	}
	runQualityGates(config, { skipTests: args.skipTests })
	const verifiedGitState = inspectGitState(config)
	const verifiedDbHead = inspectMigrationHead(config)
	if (verifiedGitState.commit !== gitState.commit || verifiedDbHead !== artifactDbHead) {
		fail('质量检查期间源码 commit 或 Alembic head 发生变化，请重新执行')
	}
	if (args.command === 'build') {
		buildRelease(config, gitState, artifactDbHead)
		return
	}
	deploy(config, gitState, artifactDbHead, databaseProfile, { mode: operationMode })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try {
		main()
	} catch (error) {
		process.stderr.write(`[backend-release] ERROR: ${error.message}\n`)
		process.exitCode = 1
	}
}
