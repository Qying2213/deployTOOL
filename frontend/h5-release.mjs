#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const H5_RELEASE_TOOL_VERSION = '2'

export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_FRONTEND_REPO_ROOT = resolve(TOOL_ROOT, '../qiye-qianduan')
export const DEFAULT_CONFIG_PATH = join(TOOL_ROOT, 'config/frontend.test.local.env')
const DEFAULT_HBUILDERX_ROOT = '/Applications/HBuilderX.app/Contents/HBuilderX'
const DEFAULT_EXPECTED_HBUILDERX_VERSION = '5.14.2026070214'
const DEFAULT_EXPECTED_UNI_VERSION = '5.14.2026062517.4248'
const DEFAULT_EXPECTED_NODE_VERSION = 'v22.22.2'
const DEFAULT_EXPECTED_SASS_VERSION = '1.43.4'
const DEFAULT_EXPECTED_SASS_PLUGIN_VERSION = '0.0.3'
const DEFAULT_EXPECTED_TITLE = 'WorkWay'
const DEFAULT_EXPECTED_BRANCH = 'feat/test-api-import'
const DEFAULT_REMOTE_HELPER = '/usr/local/sbin/loumai-h5-release'
const BUILD_ERROR_PATTERN = /编译失败|预编译器错误|Preprocessor dependency|error during build|Build failed|Cannot find module|RollupError|SyntaxError|\[uni-app\]\s*Error:/i
const FORBIDDEN_BUNDLE_PATTERN = /(?:\b(?:https?|wss?):\/\/)?(?:0\.0\.0\.0|10(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3}|localhost|host\.docker\.internal|\[::1\])(?::\d+)?(?:[/?#]|$)/i
const API_V1_URL_PATTERN = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/api\/v1\b/g
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/
const SAFE_REMOTE_TARGET = /^[A-Za-z0-9._-]+(?:@[A-Za-z0-9.-]+)?$/
const SAFE_RELEASE_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,12}$/
const SAFE_ARTIFACT_PATH = /^[A-Za-z0-9._/-]+$/
const SECRET_KEY_PATTERN = /SECRET|PASSWORD|TOKEN|PRIVATE_KEY|ACCESS_KEY/i

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
	process.stdout.write(`[h5-release] ${message}\n`)
}

function warn(message) {
	process.stderr.write(`[h5-release] 警告：${message}\n`)
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
		input,
		maxBuffer = 128 * 1024 * 1024,
		quiet = false
	} = options
	if (!quiet) info(`${dryRun ? '[dry-run] ' : ''}${displayCommand(command, args)}`)
	if (dryRun) return { status: 0, stdout: '', stderr: '' }

	const result = spawnSync(command, args, {
		cwd,
		env,
		encoding: 'utf8',
		input,
		maxBuffer,
		stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit']
	})
	if (result.error) fail(`命令无法启动：${command}（${result.error.message}）`)
	if (result.status !== 0) {
		const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
		fail(`命令执行失败（exit ${result.status}）：${displayCommand(command, args)}${detail ? `\n${detail}` : ''}`)
	}
	return {
		status: result.status,
		stdout: result.stdout || '',
		stderr: result.stderr || ''
	}
}

function runText(command, args = [], options = {}) {
	return run(command, args, { ...options, capture: true }).stdout.trim()
}

function git(frontendRepoRoot, args, options = {}) {
	return runText('git', args, {
		...options,
		cwd: frontendRepoRoot,
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
		) {
			value = value.slice(1, -1)
		}
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
	const args = {
		command: 'help',
		configPath: DEFAULT_CONFIG_PATH,
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
			case '--config': {
				const configPath = values.shift()
				if (!configPath || configPath.startsWith('-')) fail('--config 缺少文件路径')
				args.configPath = resolve(TOOL_ROOT, configPath)
				break
			}
			case '--dry-run':
				args.dryRun = true
				break
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
	if (!['test', 'production'].includes(args.environment)) {
		fail(`不支持的构建环境：${args.environment}`)
	}
	return args
}

function usage() {
	return `
楼脉 H5 可验证自动发布工具

用法：
  node frontend/h5-release.mjs build [--env test] [--config FILE] [--skip-tests]
  node frontend/h5-release.mjs deploy --yes [--env test] [--config FILE]
  node frontend/h5-release.mjs deploy --dry-run [--config FILE]
  node frontend/h5-release.mjs status [--config FILE]
  node frontend/h5-release.mjs rollback --release RELEASE_ID --yes [--config FILE]

说明：
  - deploy 每次都从当前 Git 提交全新构建，不接受旧 unpackage 产物。
  - deploy/rollback 是外部状态变更，必须显式传入 --yes。
  - --dry-run 只做本地和服务器只读预检，不构建、不上传、不切换。
`.trim()
}

function readPackageVersion(path) {
	const data = JSON.parse(readFileSync(path, 'utf8'))
	return String(data.version || '').trim()
}

function assertSafeAbsolutePath(value, label) {
	if (!SAFE_REMOTE_PATH.test(value) || value === '/' || value.includes('..')) {
		fail(`${label} 不是安全绝对路径：${value}`)
	}
}

function normalizeBoolean(value, fallback = false) {
	if (value === undefined || value === null || value === '') return fallback
	if (['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())) return true
	if (['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())) return false
	fail(`布尔配置值非法：${value}`)
}

function resolveFrontendRepoRoot(value) {
	const expanded = expandHome(value || DEFAULT_FRONTEND_REPO_ROOT)
	if (!isAbsolute(expanded)) fail(`H5_FRONTEND_REPO 必须是绝对路径：${expanded}`)
	const frontendRepoRoot = resolve(expanded)
	if (!existsSync(frontendRepoRoot) || !statSync(frontendRepoRoot).isDirectory()) {
		fail(`前端仓库目录不存在：${frontendRepoRoot}`)
	}
	if (lstatSync(frontendRepoRoot).isSymbolicLink() || realpathSync(frontendRepoRoot) !== frontendRepoRoot) {
		fail(`前端仓库目录不能经过软链接：${frontendRepoRoot}`)
	}
	for (const marker of ['.git', 'package.json', '.env.test', 'manifest.json']) {
		if (!existsSync(join(frontendRepoRoot, marker))) {
			fail(`前端仓库缺少必要文件：${join(frontendRepoRoot, marker)}`)
		}
	}
	return frontendRepoRoot
}

function loadConfiguration(args, { requireRemote = false } = {}) {
	const fileConfig = loadDotEnvFile(args.configPath, { required: requireRemote })
	Object.keys(fileConfig).forEach((key) => {
		if (SECRET_KEY_PATTERN.test(key)) {
			fail(`部署配置禁止保存密码、Token 或私钥内容：${key}`)
		}
	})
	const config = { ...fileConfig }
	Object.entries(process.env).forEach(([key, value]) => {
		if (key.startsWith('H5_') && value !== undefined) {
			if (SECRET_KEY_PATTERN.test(key)) {
				fail(`环境变量禁止传入密码、Token 或私钥内容：${key}`)
			}
			config[key] = value
		}
	})

	const hbuilderRoot = expandHome(config.H5_HBUILDERX_ROOT || DEFAULT_HBUILDERX_ROOT)
	const frontendRepoRoot = resolveFrontendRepoRoot(config.H5_FRONTEND_REPO)
	const remoteStagingRoot = config.H5_REMOTE_STAGING_ROOT || ''
	const publicUrl = String(config.H5_PUBLIC_URL || '').replace(/\/+$/, '')
	const deployment = {
		expectedBranch: config.H5_EXPECTED_BRANCH || DEFAULT_EXPECTED_BRANCH,
		expectedHBuilderVersion:
			config.H5_EXPECTED_HBUILDERX_VERSION || DEFAULT_EXPECTED_HBUILDERX_VERSION,
		expectedNodeVersion: config.H5_EXPECTED_HBUILDERX_NODE_VERSION || DEFAULT_EXPECTED_NODE_VERSION,
		expectedSassVersion: config.H5_EXPECTED_SASS_VERSION || DEFAULT_EXPECTED_SASS_VERSION,
		expectedSassPluginVersion:
			config.H5_EXPECTED_SASS_PLUGIN_VERSION || DEFAULT_EXPECTED_SASS_PLUGIN_VERSION,
		expectedTitle: config.H5_EXPECTED_TITLE || DEFAULT_EXPECTED_TITLE,
		expectedUniVersion: config.H5_EXPECTED_UNI_VERSION || DEFAULT_EXPECTED_UNI_VERSION,
		frontendRepoRoot,
		hbuilderRoot,
		identityFile: expandHome(config.H5_SSH_IDENTITY_FILE || ''),
		publicUrl,
		remoteHelper: config.H5_REMOTE_HELPER || DEFAULT_REMOTE_HELPER,
		remoteStagingRoot,
		requireUpstreamMatch: normalizeBoolean(config.H5_REQUIRE_UPSTREAM_MATCH, true),
		sshPort: Number(config.H5_SSH_PORT || 22),
		target: config.H5_DEPLOY_TARGET || '',
		useSudo: normalizeBoolean(config.H5_REMOTE_USE_SUDO, true)
	}

	if (!deployment.expectedBranch || /\s/.test(deployment.expectedBranch)) {
		fail('H5_EXPECTED_BRANCH 配置非法')
	}
	if (requireRemote) {
		if (!SAFE_REMOTE_TARGET.test(deployment.target)) fail('H5_DEPLOY_TARGET 格式非法')
		if (!Number.isInteger(deployment.sshPort) || deployment.sshPort < 1 || deployment.sshPort > 65535) {
			fail('H5_SSH_PORT 格式非法')
		}
		assertSafeAbsolutePath(deployment.remoteHelper, 'H5_REMOTE_HELPER')
		assertSafeAbsolutePath(deployment.remoteStagingRoot, 'H5_REMOTE_STAGING_ROOT')
		let parsedUrl
		try {
			parsedUrl = new URL(deployment.publicUrl)
		} catch {
			fail('H5_PUBLIC_URL 不是合法 URL')
		}
		if (
			parsedUrl.protocol !== 'https:'
			|| parsedUrl.pathname !== '/'
			|| parsedUrl.username
			|| parsedUrl.password
			|| parsedUrl.search
			|| parsedUrl.hash
		) {
			fail('H5_PUBLIC_URL 必须是 HTTPS 根地址')
		}
		if (deployment.identityFile && !existsSync(deployment.identityFile)) {
			fail(`SSH identity 文件不存在：${deployment.identityFile}`)
		}
	}
	return deployment
}

function resolveGitPath(frontendRepoRoot, name) {
	return git(frontendRepoRoot, ['rev-parse', '--git-path', name])
}

export function inspectGitState(config) {
	const { frontendRepoRoot } = config
	const branch = git(frontendRepoRoot, ['branch', '--show-current'])
	const commit = git(frontendRepoRoot, ['rev-parse', 'HEAD'])
	const shortCommit = git(frontendRepoRoot, ['rev-parse', '--short=10', 'HEAD'])
	if (!/^[0-9a-f]{40}$/.test(commit)) fail('无法取得完整 Git commit')
	if (branch !== config.expectedBranch) {
		fail(`当前分支是 ${branch || '(detached)'}，要求 ${config.expectedBranch}`)
	}
	if (git(frontendRepoRoot, ['status', '--porcelain'])) fail('工作区不干净，拒绝构建或部署')
	for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) {
		if (existsSync(resolveGitPath(frontendRepoRoot, marker))) fail(`Git 操作尚未结束：${marker}`)
	}
	if (config.requireUpstreamMatch) {
		let upstream
		try {
			upstream = git(frontendRepoRoot, ['rev-parse', '@{upstream}'])
		} catch {
			fail('当前分支没有 upstream，无法确认远端版本')
		}
		if (upstream !== commit) fail('当前提交与 upstream 不一致，请先 pull/push 后再发布')
	}
	return { branch, commit, shortCommit }
}

export function inspectBuildTool(config) {
	const aboutPackage = join(config.hbuilderRoot, 'plugins/about/package.json')
	const uniPackage = join(config.hbuilderRoot, 'plugins/uniapp-cli-vite/package.json')
	const sassPackage = join(
		config.hbuilderRoot,
		'plugins/compile-dart-sass/node_modules/sass/package.json'
	)
	const sassPluginPackage = join(config.hbuilderRoot, 'plugins/compile-dart-sass/package.json')
	const nodePath = join(config.hbuilderRoot, 'plugins/node/node')
	const uniCli = join(
		config.hbuilderRoot,
		'plugins/uniapp-cli-vite/node_modules/@dcloudio/vite-plugin-uni/bin/uni.js'
	)
	for (const path of [aboutPackage, uniPackage, sassPackage, sassPluginPackage, nodePath, uniCli]) {
		if (!existsSync(path)) fail(`HBuilderX 构建依赖不存在：${path}`)
	}
	const hbuilderVersion = readPackageVersion(aboutPackage)
	const uniVersion = readPackageVersion(uniPackage)
	const sassVersion = readPackageVersion(sassPackage)
	const sassPluginVersion = readPackageVersion(sassPluginPackage)
	const nodeVersion = runText(nodePath, ['--version'], { quiet: true })
	if (hbuilderVersion !== config.expectedHBuilderVersion) {
		fail(`HBuilderX 版本漂移：实际 ${hbuilderVersion}，要求 ${config.expectedHBuilderVersion}`)
	}
	if (uniVersion !== config.expectedUniVersion) {
		fail(`uni 编译器版本漂移：实际 ${uniVersion}，要求 ${config.expectedUniVersion}`)
	}
	if (nodeVersion !== config.expectedNodeVersion) {
		fail(`HBuilderX Node 版本漂移：实际 ${nodeVersion}，要求 ${config.expectedNodeVersion}`)
	}
	if (sassVersion !== config.expectedSassVersion) {
		fail(`Sass 版本漂移：实际 ${sassVersion}，要求 ${config.expectedSassVersion}`)
	}
	if (sassPluginVersion !== config.expectedSassPluginVersion) {
		fail(`Sass 插件版本漂移：实际 ${sassPluginVersion}，要求 ${config.expectedSassPluginVersion}`)
	}
	return {
		hbuilderRoot: config.hbuilderRoot,
		hbuilderVersion,
		nodePath,
		nodeVersion,
		sassVersion,
		sassPluginVersion,
		uniCli,
		uniVersion
	}
}

function readBuildEnvironment(frontendRepoRoot, environment) {
	const environmentPath = join(frontendRepoRoot, `.env.${environment}`)
	for (const overridePath of [
		join(frontendRepoRoot, '.env'),
		join(frontendRepoRoot, '.env.local'),
		join(frontendRepoRoot, `.env.${environment}.local`)
	]) {
		if (existsSync(overridePath)) {
			fail(`发布时禁止使用可覆盖构建配置的文件：${overridePath}`)
		}
	}
	const values = loadDotEnvFile(environmentPath)
	const appEnvironment = values.VITE_APP_ENV || ''
	const apiBaseUrl = values.VITE_API_BASE_URL || ''
	if (appEnvironment !== environment) {
		fail(`${environmentPath} 的 VITE_APP_ENV 必须为 ${environment}`)
	}
	let parsedApiUrl
	try {
		parsedApiUrl = new URL(apiBaseUrl)
	} catch {
		fail(`${environmentPath} 的 VITE_API_BASE_URL 非法`)
	}
	if (parsedApiUrl.protocol !== 'https:') fail('发布包 API 地址必须使用 HTTPS')
	if (
		parsedApiUrl.pathname !== '/api/v1'
		|| parsedApiUrl.username
		|| parsedApiUrl.password
		|| parsedApiUrl.search
		|| parsedApiUrl.hash
	) fail('发布包 API 地址必须是无凭据、无查询参数的 HTTPS /api/v1 地址')
	normalizeBoolean(values.VITE_ENABLE_TEST_ACCOUNTS, false)
	if (environment === 'production' && values.VITE_ENABLE_TEST_ACCOUNTS !== 'false') {
		fail('生产构建必须关闭 VITE_ENABLE_TEST_ACCOUNTS')
	}
	return { apiBaseUrl, appEnvironment, values }
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
			const item = lstatSync(absolute)
			const relativePath = relative(root, absolute).split(sep).join('/')
			if (!SAFE_ARTIFACT_PATH.test(relativePath) || relativePath.includes('..')) {
				fail(`产物包含不安全文件名：${relativePath}`)
			}
			if (item.isSymbolicLink()) fail(`产物包含软链接：${relativePath}`)
			if (item.isDirectory()) walk(absolute)
			else if (item.isFile()) files.push({ absolute, relative: relativePath, stat: item })
			else fail(`产物包含特殊文件：${relativePath}`)
		}
	}
	walk(root)
	return files.sort((left, right) => left.relative.localeCompare(right.relative))
}

function sha256File(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function textFiles(files) {
	return files.filter(({ relative: path }) => /\.(?:html|m?js|css|json|txt|xml|svg|webmanifest)$/i.test(path))
}

function outputContains(files, expected) {
	return textFiles(files).some(({ absolute }) => readFileSync(absolute, 'utf8').includes(expected))
}

export function validateArtifact(outputDir, options) {
	const {
		apiBaseUrl,
		builtAfter = 0,
		expectedTitle = '',
		frontendRepoRoot = '',
		requireChannelStorageFix = true
	} = options
	if (!existsSync(outputDir) || !statSync(outputDir).isDirectory()) {
		fail(`构建产物目录不存在：${outputDir}`)
	}
	const files = listFiles(outputDir)
	if (files.length < 10) fail(`构建产物文件过少：${files.length}`)
	const indexPath = join(outputDir, 'index.html')
	if (!existsSync(indexPath)) fail('构建产物缺少 index.html')
	if (builtAfter && statSync(indexPath).mtimeMs < builtAfter - 2000) {
		fail('index.html 早于本次构建，拒绝复用旧产物')
	}
	if (files.some(({ relative: path }) => path.endsWith('.map'))) {
		fail('发布产物包含 SourceMap')
	}
	const indexHtml = readFileSync(indexPath, 'utf8')
	if (expectedTitle && !indexHtml.includes(`<title>${expectedTitle}</title>`)) {
		fail(`index.html 标题不是预期值：${expectedTitle}`)
	}
	const references = [...indexHtml.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
		.map((match) => match[1])
		.filter((value) => value && !/^(?:https?:|data:|#)/i.test(value))
	for (const reference of references) {
		const normalized = reference.split('?')[0].replace(/^\//, '')
		if (normalized && !existsSync(join(outputDir, normalized))) {
			fail(`index.html 引用了不存在的本地资源：${reference}`)
		}
	}
	if (!files.some(({ relative: path }) => /^assets\/index-[A-Za-z0-9_-]+\.js$/.test(path))) {
		fail('产物缺少带内容哈希的主入口 JS')
	}
	if (!outputContains(files, apiBaseUrl)) fail(`产物未包含目标 API：${apiBaseUrl}`)
	const discoveredApiUrls = new Set()
	for (const { absolute, relative: path } of files) {
		const content = readFileSync(absolute, 'utf8')
		for (const match of content.matchAll(API_V1_URL_PATTERN)) discoveredApiUrls.add(match[0])
		const match = content.match(FORBIDDEN_BUNDLE_PATTERN)
		if (match) fail(`产物包含本地或局域网地址（${path}）：${match[0]}`)
		for (const localPath of new Set([TOOL_ROOT, frontendRepoRoot, homedir()])) {
			if (localPath && content.includes(localPath)) {
				fail(`产物泄露本机构建路径（${path}）`)
			}
		}
	}
	for (const discoveredApiUrl of discoveredApiUrls) {
		if (discoveredApiUrl !== apiBaseUrl) {
			fail(`产物包含非目标 API：${discoveredApiUrl}`)
		}
	}
	if (requireChannelStorageFix) {
		const channelBundle = textFiles(files).find(({ absolute }) =>
			readFileSync(absolute, 'utf8').includes('loumai_pending_channel_invitation_code')
		)
		if (!channelBundle) fail('产物缺少渠道邀请码工具 bundle')
		const channelContent = readFileSync(channelBundle.absolute, 'utf8')
		for (const marker of ['removeStorageSync', 'removeStorage', 'setStorageSync', 'setStorage']) {
			const markerPattern = new RegExp(`["']${marker}["']`)
			if (!markerPattern.test(channelContent)) {
				fail(`渠道邀请码 bundle 缺少 H5 存储兼容标记：${marker}`)
			}
		}
	}
	return {
		fileCount: files.length,
		files,
		indexPath,
		indexSha256: sha256File(indexPath)
	}
}

function writeReleaseFiles(outputDir, metadata) {
	const manifestPath = join(outputDir, 'release.json')
	writeFileSync(manifestPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
	const files = listFiles(outputDir).filter(({ relative: path }) => path !== 'SHA256SUMS')
	const checksums = files.map(({ absolute, relative: path }) => `${sha256File(absolute)}  ${path}`).join('\n')
	writeFileSync(join(outputDir, 'SHA256SUMS'), `${checksums}\n`, 'utf8')
}

export function buildCommand(
	tool,
	outputDir,
	environment,
	environmentValues,
	frontendRepoRoot = DEFAULT_FRONTEND_REPO_ROOT
) {
	const cliContext = join(tool.hbuilderRoot, 'plugins/uniapp-cli-vite')
	const inheritedEnvironment = Object.fromEntries(
		Object.entries(process.env).filter(([key]) =>
			!key.startsWith('VITE_')
			&& !key.startsWith('VUE_APP_')
			&& !key.startsWith('UNI_')
			&& !key.startsWith('HX_')
			&& !['NODE_ENV', 'RUN_BY_HBUILDERX'].includes(key)
		)
	)
	const viteEnvironment = Object.fromEntries(
		Object.entries(environmentValues).filter(([key]) =>
			key.startsWith('VITE_') || key.startsWith('VUE_APP_')
		)
	)
	return {
		args: [tool.uniCli, 'build', '--platform', 'h5', '--mode', environment],
		command: tool.nodePath,
		env: {
			...inheritedEnvironment,
			...viteEnvironment,
			HX_APP_ROOT: tool.hbuilderRoot,
			HX_Version: tool.hbuilderVersion,
			NODE_ENV: 'production',
			PATH: `${dirname(tool.nodePath)}:${process.env.PATH || ''}`,
			RUN_BY_HBUILDERX: 'true',
			UNI_CLI_CONTEXT: cliContext,
			UNI_CLOUD_SPACES: '[]',
			UNI_HBUILDERX_LANGID: 'zh_CN',
			UNI_HBUILDERX_PLUGINS: join(tool.hbuilderRoot, 'plugins'),
			UNI_INPUT_DIR: frontendRepoRoot,
			UNI_OUTPUT_DIR: outputDir,
			UNI_PLATFORM: 'h5'
		}
	}
}

function runTests(config, { dryRun = false } = {}) {
	run('node', ['--test', join(TOOL_ROOT, 'tests/frontend-h5-release.test.mjs')], {
		cwd: TOOL_ROOT,
		dryRun,
		env: {
			...process.env,
			H5_FRONTEND_REPO: config.frontendRepoRoot
		}
	})
	run('npm', ['test'], { cwd: config.frontendRepoRoot, dryRun })
}

function lstatIfPresent(path) {
	try {
		return lstatSync(path)
	} catch (error) {
		if (error?.code === 'ENOENT') return null
		throw error
	}
}

function ensureLocalBuildRoot(buildRoot) {
	const toolRootReal = realpathSync(TOOL_ROOT)
	if (toolRootReal !== TOOL_ROOT) fail('部署工具根目录不能经过软链接')
	const distRoot = dirname(buildRoot)
	for (const directory of [distRoot, buildRoot]) {
		const entry = lstatIfPresent(directory)
		if (entry?.isSymbolicLink()) fail(`本地构建目录不能是软链接：${directory}`)
		if (entry && !entry.isDirectory()) fail(`本地构建路径不是目录：${directory}`)
		if (!entry) mkdirSync(directory, { mode: 0o755 })
		if (realpathSync(directory) !== directory) {
			fail(`本地构建目录路径包含软链接：${directory}`)
		}
	}
}

function ensureImmediateDirectory(parent, directory, mode = 0o755) {
	if (dirname(directory) !== parent) fail(`本地目录越界：${directory}`)
	const entry = lstatIfPresent(directory)
	if (entry?.isSymbolicLink()) fail(`本地目录不能是软链接：${directory}`)
	if (entry && !entry.isDirectory()) fail(`本地路径不是目录：${directory}`)
	if (!entry) mkdirSync(directory, { mode })
	if (realpathSync(dirname(directory)) !== realpathSync(parent)) {
		fail(`本地目录父路径发生变化：${directory}`)
	}
}

function safeRemovePartial(buildRoot, partialRoot) {
	const relativePath = relative(buildRoot, partialRoot)
	if (
		!/^\.[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,12}\.partial$/.test(basename(partialRoot))
		|| relativePath !== basename(partialRoot)
		|| !partialRoot.startsWith(`${buildRoot}${sep}`)
	) {
		fail(`拒绝清理越界目录：${partialRoot}`)
	}
	ensureLocalBuildRoot(buildRoot)
	const entry = lstatIfPresent(partialRoot)
	if (!entry) return
	if (entry.isSymbolicLink() || !entry.isDirectory()) {
		fail(`拒绝清理非普通构建目录：${partialRoot}`)
	}
	rmSync(partialRoot, { force: true, recursive: true })
}

function buildRelease(args, config, gitState, tool) {
	const environment = readBuildEnvironment(config.frontendRepoRoot, args.environment)
	const releaseId = createReleaseId(gitState.shortCommit)
	const buildRoot = join(TOOL_ROOT, 'dist/h5-releases')
	const partialRoot = join(buildRoot, `.${releaseId}.partial`)
	const finalRoot = join(buildRoot, releaseId)
	const outputDir = join(partialRoot, 'frontend')
	const logDir = join(buildRoot, 'logs')
	const logPath = join(logDir, `${releaseId}.log`)
	if (existsSync(partialRoot) || existsSync(finalRoot)) fail(`release_id 已存在：${releaseId}`)
	const command = buildCommand(
		tool,
		outputDir,
		args.environment,
		environment.values,
		config.frontendRepoRoot
	)

	if (args.dryRun) {
		info(`[dry-run] 将全新构建到 ${outputDir}`)
		run(command.command, command.args, { dryRun: true, env: command.env })
		return { environment, outputDir, releaseId }
	}

	if (!args.skipTests) runTests(config)
	ensureLocalBuildRoot(buildRoot)
	if (lstatIfPresent(partialRoot) || lstatIfPresent(finalRoot)) {
		fail(`release_id 已存在：${releaseId}`)
	}
	mkdirSync(partialRoot, { mode: 0o700 })
	ensureImmediateDirectory(partialRoot, outputDir)
	ensureImmediateDirectory(buildRoot, logDir)
	const builtAfter = Date.now()
	info(`全新构建目录：${outputDir}`)
	const result = spawnSync(command.command, command.args, {
		cwd: config.frontendRepoRoot,
		encoding: 'utf8',
		env: command.env,
		maxBuffer: 256 * 1024 * 1024
	})
	const buildLog = [result.stdout, result.stderr].filter(Boolean).join('\n')
	writeFileSync(logPath, buildLog, 'utf8')
	if (buildLog) process.stdout.write(buildLog)
	if (result.error || result.status !== 0 || BUILD_ERROR_PATTERN.test(buildLog)) {
		safeRemovePartial(buildRoot, partialRoot)
		fail(`H5 构建失败，日志：${logPath}`)
	}

	try {
		const artifact = validateArtifact(outputDir, {
			apiBaseUrl: environment.apiBaseUrl,
			builtAfter,
			expectedTitle: config.expectedTitle,
			frontendRepoRoot: config.frontendRepoRoot
		})
		const metadata = {
			schema_version: 1,
			release_id: releaseId,
			commit: gitState.commit,
			branch: gitState.branch,
			environment: args.environment,
			api_base_url: environment.apiBaseUrl,
			built_at: new Date().toISOString(),
			index_sha256: artifact.indexSha256,
			tool: {
				h5_release_tool: H5_RELEASE_TOOL_VERSION,
				hbuilderx: tool.hbuilderVersion,
				uni_compiler: tool.uniVersion,
				node: tool.nodeVersion,
				sass: tool.sassVersion,
				sass_plugin: tool.sassPluginVersion
			}
		}
		writeReleaseFiles(outputDir, metadata)
		const checksumsSha256 = sha256File(join(outputDir, 'SHA256SUMS'))
		validateArtifact(outputDir, {
			apiBaseUrl: environment.apiBaseUrl,
			builtAfter,
			expectedTitle: config.expectedTitle,
			frontendRepoRoot: config.frontendRepoRoot
		})
		renameSync(partialRoot, finalRoot)
		const finalOutput = join(finalRoot, 'frontend')
		info(`构建完成：${finalOutput}`)
		return {
			artifact,
			checksumsSha256,
			environment,
			metadata,
			outputDir: finalOutput,
			releaseId
		}
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
		'-p', String(config.sshPort)
	]
	if (config.identityFile) options.push('-i', config.identityFile)
	return options
}

function remoteHelperCommand(config, args) {
	const command = [config.remoteHelper, ...args].map(shellQuote).join(' ')
	return config.useSudo ? `sudo -n ${command}` : command
}

function remoteHelper(config, args, { capture = false, dryRun = false } = {}) {
	return run('ssh', [...sshOptions(config), config.target, remoteHelperCommand(config, args)], {
		capture,
		dryRun,
		maxBuffer: 32 * 1024 * 1024
	})
}

function parseKeyValueOutput(text = '') {
	const result = {}
	String(text).split(/\r?\n/).forEach((line) => {
		const match = line.match(/^([A-Z_]+)=(.*)$/)
		if (match) result[match[1]] = match[2]
	})
	return result
}

function remotePreflight(config, { dryRun = false } = {}) {
	const result = remoteHelper(config, ['preflight'], { capture: true, dryRun })
	if (dryRun) return { CURRENT: 'UNKNOWN', STAGING_ROOT: config.remoteStagingRoot }
	const values = parseKeyValueOutput(result.stdout)
	if (values.HELPER_VERSION !== H5_RELEASE_TOOL_VERSION) {
		fail(`服务器激活器版本不匹配：${values.HELPER_VERSION || '(空)'}`)
	}
	if (values.STAGING_ROOT !== config.remoteStagingRoot) {
		fail('本地与服务器的 staging 配置不一致')
	}
	return values
}

function prepareRemoteStaging(config, releaseId, { dryRun = false } = {}) {
	const expectedStageDir = `${config.remoteStagingRoot}/${releaseId}.partial`
	const result = remoteHelper(config, ['prepare', releaseId], { capture: true, dryRun })
	if (dryRun) return expectedStageDir
	const values = parseKeyValueOutput(result.stdout)
	if (values.STAGE_DIR !== expectedStageDir) {
		fail('服务器返回的 staging 路径与本地配置不一致')
	}
	return values.STAGE_DIR
}

function rsyncSshCommand(config) {
	const tokens = ['ssh', ...sshOptions(config)]
	return tokens.map(shellQuote).join(' ')
}

function createUploadArchive(outputDir) {
	const releaseRoot = dirname(outputDir)
	const archivePath = join(releaseRoot, 'frontend.tar')
	if (lstatIfPresent(archivePath)) fail(`上传归档已存在：${archivePath}`)
	const archiveEnvironment = { ...process.env, COPYFILE_DISABLE: '1' }
	delete archiveEnvironment.TAR_OPTIONS
	run('tar', ['--no-xattrs', '-C', outputDir, '-cf', archivePath, '.'], {
		env: archiveEnvironment
	})
	const archive = lstatIfPresent(archivePath)
	if (!archive?.isFile() || archive.isSymbolicLink() || archive.size <= 0) {
		fail('未生成有效的前端上传归档')
	}
	return { archivePath, archiveSha256: sha256File(archivePath) }
}

function uploadArtifact(config, archivePath, stageDir, { dryRun = false } = {}) {
	const args = [
		'-az',
		'--checksum',
		'--itemize-changes',
		'--safe-links',
		'-e', rsyncSshCommand(config)
	]
	if (dryRun) args.push('--dry-run')
	args.push(archivePath, `${config.target}:${stageDir}/frontend.tar`)
	run('rsync', args, { dryRun })
}

function curlBytes(url, maxFileSize = 8 * 1024 * 1024) {
	const result = spawnSync('curl', [
		'-fsSL',
		'--connect-timeout', '5',
		'--max-time', '30',
		'--retry', '2',
		'--retry-delay', '1',
		'--retry-max-time', '60',
		'--max-filesize', String(maxFileSize),
		url
	], {
		encoding: null,
		maxBuffer: 64 * 1024 * 1024
	})
	if (result.error || result.status !== 0) fail(`线上读取失败：${url}`)
	return result.stdout
}

function postDeployVerify(config, release) {
	const cacheBuster = encodeURIComponent(release.releaseId)
	const manifestBytes = curlBytes(
		`${config.publicUrl}/release.json?release_check=${cacheBuster}`,
		1024 * 1024
	)
	let manifest
	try {
		manifest = JSON.parse(manifestBytes.toString('utf8'))
	} catch {
		fail('线上 release.json 不是合法 JSON')
	}
	if (manifest.release_id !== release.releaseId || manifest.commit !== release.metadata.commit) {
		fail('线上 release.json 与本次发布不一致')
	}
	const indexBytes = curlBytes(`${config.publicUrl}/?release_check=${cacheBuster}`)
	const indexSha = createHash('sha256').update(indexBytes).digest('hex')
	if (indexSha !== release.metadata.index_sha256) fail('线上 index.html 哈希与本地不一致')
	info(`线上校验通过：${release.releaseId}`)
}

function deployRelease(args, config, release) {
	const preflight = remotePreflight(config)
	const expectedCurrent = preflight.CURRENT || 'NONE'
	const upload = createUploadArchive(release.outputDir)
	let stagePrepared = false
	try {
		const stageDir = prepareRemoteStaging(config, release.releaseId)
		stagePrepared = true
		uploadArtifact(config, upload.archivePath, stageDir)
		remoteHelper(config, [
			'activate',
			release.releaseId,
			release.metadata.commit,
			release.metadata.index_sha256,
			release.checksumsSha256,
			upload.archiveSha256,
			expectedCurrent
		])
		stagePrepared = false
	} catch (error) {
		if (stagePrepared) {
			try {
				remoteHelper(config, ['abort', release.releaseId], { capture: true })
			} catch (cleanupError) {
				const cleanupDetail = cleanupError instanceof Error
					? cleanupError.message
					: String(cleanupError)
				warn(`远端 staging 自动清理失败，请人工检查：${cleanupDetail}`)
			}
		}
		throw error
	}
	try {
		postDeployVerify(config, release)
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		warn(`服务器已经激活并完成自验，但本机二次验收失败；请运行 h5:status 并用浏览器复核。${detail}`)
	}
}

function dryRunDeploy(args, config, gitState, tool) {
	const environment = readBuildEnvironment(config.frontendRepoRoot, args.environment)
	const releaseId = createReleaseId(gitState.shortCommit)
	const buildRoot = join(TOOL_ROOT, 'dist/h5-releases')
	const outputDir = join(buildRoot, `.${releaseId}.partial`, 'frontend')
	const archivePath = join(dirname(outputDir), 'frontend.tar')
	const command = buildCommand(
		tool,
		outputDir,
		args.environment,
		environment.values,
		config.frontendRepoRoot
	)
	const preflight = remotePreflight(config)
	const stageDir = prepareRemoteStaging(config, releaseId, { dryRun: true })
	info(`[dry-run] commit=${gitState.commit}`)
	info(`[dry-run] API=${environment.apiBaseUrl}`)
	info(`[dry-run] 当前线上版本=${preflight.CURRENT || 'NONE'}`)
	if (!args.skipTests) runTests(config, { dryRun: true })
	run(command.command, command.args, { dryRun: true, env: command.env })
	uploadArtifact(config, archivePath, stageDir, { dryRun: true })
	remoteHelper(config, [
		'activate',
		releaseId,
		gitState.commit,
		'INDEX_SHA256',
		'CHECKSUMS_SHA256',
		'ARCHIVE_SHA256',
		'CURRENT'
	], {
		dryRun: true
	})
	info('[dry-run] 未构建、未上传、未切换线上版本')
}

function status(config) {
	const result = remoteHelper(config, ['status'], { capture: true })
	process.stdout.write(result.stdout)
}

function rollback(args, config) {
	if (!args.releaseId || !SAFE_RELEASE_ID.test(args.releaseId)) {
		fail('rollback 必须通过 --release 指定合法 release_id')
	}
	if (!args.yes) fail('rollback 会切换线上版本，必须显式传入 --yes')
	const preflight = remotePreflight(config)
	const expectedCurrent = preflight.CURRENT || 'NONE'
	remoteHelper(config, ['rollback', args.releaseId, expectedCurrent])
	const result = remoteHelper(config, ['status'], { capture: true })
	process.stdout.write(result.stdout)
}

export function remoteHelperContractSource() {
	return readFileSync(join(TOOL_ROOT, 'frontend/remote/loumai-h5-release'), 'utf8')
}

function main() {
	const args = parseArgs(process.argv.slice(2))
	if (args.help || args.command === 'help') {
		process.stdout.write(`${usage()}\n`)
		return
	}
	if (!['build', 'deploy', 'status', 'rollback'].includes(args.command)) {
		fail(`未知命令：${args.command}`)
	}

	const requireRemote = ['deploy', 'status', 'rollback'].includes(args.command)
	const config = loadConfiguration(args, { requireRemote })
	if (args.command === 'status') {
		status(config)
		return
	}
	if (args.command === 'rollback') {
		rollback(args, config)
		return
	}

	const gitState = inspectGitState(config)
	const tool = inspectBuildTool(config)
	if (args.command === 'deploy' && args.dryRun) {
		dryRunDeploy(args, config, gitState, tool)
		return
	}
	if (args.command === 'deploy' && !args.yes) {
		fail('deploy 会上传并切换线上版本，必须显式传入 --yes')
	}
	const release = buildRelease(args, config, gitState, tool)
	if (args.command === 'deploy') deployRelease(args, config, release)
}

const isMain = process.argv[1]
	&& import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
	try {
		main()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		process.stderr.write(`[h5-release] ERROR: ${message}\n`)
		process.exitCode = 1
	}
}
