import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
	buildCommand,
	createReleaseId,
	DEFAULT_CONFIG_PATH,
	DEFAULT_FRONTEND_REPO_ROOT,
	parseArgs,
	parseDotEnv,
	remoteHelperContractSource,
	shellQuote,
	TOOL_ROOT,
	validateArtifact
} from '../frontend/h5-release.mjs'

const EXPECTED_API = 'https://test.yinlizhangyu.com/api/v1'
const FRONTEND_REPO_ROOT = resolve(
	process.env.H5_FRONTEND_REPO || DEFAULT_FRONTEND_REPO_ROOT
)

function createArtifact({ channelMarkers = true, localAddress = false, localPath = false, otherApi = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'loumai-h5-release-test-'))
	const assets = join(root, 'assets')
	mkdirSync(assets, { recursive: true })
	writeFileSync(
		join(root, 'index.html'),
		[
			'<!doctype html><html><head><title>WorkWay</title>',
			'<link rel="modulepreload" href="/assets/channel-binding-entry.NewHash.js">',
			'</head><body><script type="module" src="/assets/index-NewHash.js"></script></body></html>'
		].join(''),
		'utf8'
	)
	writeFileSync(
		join(assets, 'index-NewHash.js'),
		`const api=${JSON.stringify(EXPECTED_API)};${localAddress ? 'const bad="ws://192.168.1.3:5173/socket";' : ''}${otherApi ? 'const wrong="https://wrong.example.com/api/v1";' : ''}${localPath ? `const root=${JSON.stringify(FRONTEND_REPO_ROOT)};` : ''}`,
		'utf8'
	)
	writeFileSync(
		join(assets, 'channel-binding-entry.NewHash.js'),
		channelMarkers
			? 'const key="loumai_pending_channel_invitation_code";const methods=["removeStorageSync","removeStorage","setStorageSync","setStorage"];'
			: 'const key="loumai_pending_channel_invitation_code";storage.removeStorageSync(key);',
		'utf8'
	)
	for (let index = 0; index < 8; index += 1) {
		writeFileSync(join(assets, `chunk-${index}-Hash.js`), `export default ${index}`, 'utf8')
	}
	return root
}

test('部署配置解析不执行 shell 且保留明确值', () => {
	assert.deepEqual(
		parseDotEnv([
			'# comment',
			'H5_DEPLOY_TARGET=deploy@test-server',
			'H5_PUBLIC_URL="https://test.yinlizhangyu.com"',
			"H5_REMOTE_USE_SUDO='true'"
		].join('\n')),
		{
			H5_DEPLOY_TARGET: 'deploy@test-server',
			H5_PUBLIC_URL: 'https://test.yinlizhangyu.com',
			H5_REMOTE_USE_SUDO: 'true'
		}
	)
	assert.throws(() => parseDotEnv('not a valid line'), /格式错误/)
})

test('发布参数默认安全并要求显式 release', () => {
	assert.deepEqual(
		parseArgs(['deploy', '--env', 'test', '--dry-run', '--config', 'config/frontend.test.local.env']),
		{
			command: 'deploy',
			configPath: DEFAULT_CONFIG_PATH,
			dryRun: true,
			environment: 'test',
			help: false,
			releaseId: '',
			skipTests: false,
			yes: false
		}
	)
	assert.equal(parseArgs(['rollback', '--release', '20260810T120000Z-261cb03']).releaseId, '20260810T120000Z-261cb03')
	assert.throws(() => parseArgs(['deploy', '--env', 'staging']), /不支持的构建环境/)
	assert.throws(() => parseArgs(['deploy', '--config']), /缺少文件路径/)
	assert.throws(() => parseArgs(['deploy', '--env', '--yes']), /缺少环境名称/)
	assert.throws(() => parseArgs(['rollback', '--release', '--yes']), /缺少 release_id/)
})

test('release id 和远端 shell 参数保持确定且可引用', () => {
	assert.equal(
		createReleaseId('261cb03', new Date('2026-08-10T12:34:56.000Z')),
		'20260810T123456Z-261cb03'
	)
	assert.equal(shellQuote("a'b"), `'a'"'"'b'`)
})

test('构建子进程丢弃外部 VITE 覆盖并显式使用已验证环境', () => {
	const previousApi = process.env.VITE_API_BASE_URL
	const previousUniOutput = process.env.UNI_OUTPUT_DIR
	process.env.VITE_API_BASE_URL = 'https://wrong.example.com/api/v1'
	process.env.UNI_OUTPUT_DIR = '/tmp/wrong-output'
	try {
		const command = buildCommand({
			hbuilderRoot: '/Applications/HBuilderX.app/Contents/HBuilderX',
			hbuilderVersion: '5.14.2026070214',
			nodePath: '/Applications/HBuilderX.app/Contents/HBuilderX/plugins/node/node',
			uniCli: '/Applications/HBuilderX.app/Contents/HBuilderX/plugins/uni.js'
		}, '/tmp/verified-output', 'test', {
			VITE_APP_ENV: 'test',
			VITE_API_BASE_URL: EXPECTED_API,
			VITE_ENABLE_TEST_ACCOUNTS: 'true'
		}, FRONTEND_REPO_ROOT)
		assert.equal(command.env.VITE_API_BASE_URL, EXPECTED_API)
		assert.equal(command.env.VITE_APP_ENV, 'test')
		assert.equal(command.env.UNI_INPUT_DIR, FRONTEND_REPO_ROOT)
		assert.equal(command.env.UNI_OUTPUT_DIR, '/tmp/verified-output')
	} finally {
		if (previousApi === undefined) delete process.env.VITE_API_BASE_URL
		else process.env.VITE_API_BASE_URL = previousApi
		if (previousUniOutput === undefined) delete process.env.UNI_OUTPUT_DIR
		else process.env.UNI_OUTPUT_DIR = previousUniOutput
	}
})

test('全新 H5 产物必须包含目标 API、哈希入口和存储兼容链', () => {
	const artifact = createArtifact()
	try {
		const result = validateArtifact(artifact, {
			apiBaseUrl: EXPECTED_API,
			builtAfter: Date.now() - 5000,
			expectedTitle: 'WorkWay'
		})
		assert.equal(result.fileCount, 11)
		assert.match(result.indexSha256, /^[0-9a-f]{64}$/)
	} finally {
		rmSync(artifact, { force: true, recursive: true })
	}
})

test('旧 removeStorageSync 单点实现不能进入发布产物', () => {
	const artifact = createArtifact({ channelMarkers: false })
	try {
		assert.throws(
			() => validateArtifact(artifact, {
				apiBaseUrl: EXPECTED_API,
				expectedTitle: 'WorkWay'
			}),
			/缺少 H5 存储兼容标记/
		)
	} finally {
		rmSync(artifact, { force: true, recursive: true })
	}
})

test('局域网地址和构建前旧 index 均被发布门禁拒绝', () => {
	const localArtifact = createArtifact({ localAddress: true })
	const wrongApiArtifact = createArtifact({ otherApi: true })
	const localPathArtifact = createArtifact({ localPath: true })
	const staleArtifact = createArtifact()
	try {
		assert.throws(
			() => validateArtifact(localArtifact, {
				apiBaseUrl: EXPECTED_API,
				expectedTitle: 'WorkWay'
			}),
			/包含本地或局域网地址/
		)
		assert.throws(
			() => validateArtifact(localPathArtifact, {
				apiBaseUrl: EXPECTED_API,
				expectedTitle: 'WorkWay'
			}),
			/泄露本机构建路径/
		)
		assert.throws(
			() => validateArtifact(wrongApiArtifact, {
				apiBaseUrl: EXPECTED_API,
				expectedTitle: 'WorkWay'
			}),
			/包含非目标 API/
		)
		const oldTime = new Date('2026-07-10T00:00:00Z')
		utimesSync(join(staleArtifact, 'index.html'), oldTime, oldTime)
		assert.throws(
			() => validateArtifact(staleArtifact, {
				apiBaseUrl: EXPECTED_API,
				builtAfter: Date.now(),
				expectedTitle: 'WorkWay'
			}),
			/拒绝复用旧产物/
		)
	} finally {
		rmSync(localArtifact, { force: true, recursive: true })
		rmSync(wrongApiArtifact, { force: true, recursive: true })
		rmSync(localPathArtifact, { force: true, recursive: true })
		rmSync(staleArtifact, { force: true, recursive: true })
	}
})

test('服务器激活器具备锁、哈希、原子切换、CAS 回滚和旧 chunk 兼容', () => {
	const helper = remoteHelperContractSource()
	assert.match(helper, /^#!\/bin\/bash/)
	assert.match(helper, /export PATH="\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"/)
	assert.match(helper, /flock -w 120/)
	assert.match(helper, /sha256sum -c SHA256SUMS/)
	assert.match(helper, /expected_checksums_sha/)
	assert.match(helper, /expected_archive_sha/)
	assert.match(helper, /frontend\.tar/)
	assert.match(helper, /cp --reflink=never/)
	assert.match(helper, /mv -Tf/)
	assert.match(helper, /frontend-current 已被其他发布修改/)
	assert.match(helper, /merge_previous_assets/)
	assert.match(helper, /allow-inherited-assets/)
	assert.match(helper, /rsync -a[^\n]*--ignore-existing/)
	assert.match(helper, /SHA256SUMS 包含不安全路径/)
	assert.match(helper, /\[\[ "\$relative" != "-" \]\]/)
	assert.match(helper, /同名不同内容冲突/)
	assert.match(helper, /arm_current_rollback/)
	assert.match(helper, /trap restore_previous_current EXIT/)
	assert.match(helper, /connect-timeout 5 --max-time 30/)
	assert.match(helper, /线上校验失败，将按当前指向执行安全回滚/)
	assert.match(helper, /action_prepare/)
	assert.match(helper, /action_abort/)
	assert.match(helper, /暂存产物包含硬链接文件/)
	assert.match(helper, /install -d -m 0700 -o root -g root -- "\$partial_root"/)
	assert.match(helper, /frontend-releases/)
	assert.match(helper, /if \[\[ ! -e "\$CURRENT_LINK" && ! -L "\$CURRENT_LINK" \]\]/)
	assert.doesNotMatch(helper, /LOUMAI_H5_RELEASE_CONFIG/)
	assert.doesNotMatch(helper, /chown -hR -- root:root "\$stage_dir"/)
	assert.doesNotMatch(helper, /ln -sfn/)
	assert.doesNotMatch(helper, /rsync[^\n]*--delete/)
})

test('独立配置模板声明前端仓库且不保存密码和私钥内容', () => {
	const template = readFileSync(join(TOOL_ROOT, 'config/frontend.test.example.env'), 'utf8')
	assert.doesNotMatch(template, /PASSWORD=|TOKEN=|PRIVATE_KEY=/)
	assert.match(template, /^H5_FRONTEND_REPO=/m)
	assert.equal(DEFAULT_CONFIG_PATH, join(TOOL_ROOT, 'config/frontend.test.local.env'))
})

test('构建环境只暴露白名单字段且源码不再注入完整 import.meta.env', () => {
	const sources = [
		readFileSync(join(FRONTEND_REPO_ROOT, 'config/app.js'), 'utf8'),
		readFileSync(join(FRONTEND_REPO_ROOT, 'config/environment.js'), 'utf8'),
		readFileSync(join(FRONTEND_REPO_ROOT, 'utils/tenant-notification.js'), 'utf8')
	]
	const viteConfig = readFileSync(join(FRONTEND_REPO_ROOT, 'vite.config.mjs'), 'utf8')
	assert.doesNotMatch(sources.join('\n'), /import\.meta\.env/)
	assert.match(viteConfig, /__LOUMAI_BUILD_ENV__/)
	assert.doesNotMatch(viteConfig, /VITE_ROOT_DIR/)
})

test('本地构建目录拒绝软链接和越界清理', () => {
	const source = readFileSync(join(TOOL_ROOT, 'frontend/h5-release.mjs'), 'utf8')
	assert.match(source, /function ensureLocalBuildRoot/)
	assert.match(source, /entry\?\.isSymbolicLink\(\)/)
	assert.match(source, /拒绝清理非普通构建目录/)
	assert.match(source, /\^\\\.\[0-9\]\{8\}/)
	assert.match(source, /'--no-xattrs'/)
	assert.match(source, /join\(TOOL_ROOT, 'dist\/h5-releases'\)/)
	assert.doesNotMatch(source, /const PROJECT_ROOT/)
})
