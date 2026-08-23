import assert from 'node:assert/strict'
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
	createReleaseId,
	DEFAULT_CONFIG_PATH,
	loadConfig,
	parseArgs,
	parseDotEnv,
	shellQuote,
	TOOL_ROOT,
	validateArtifact
} from '../website/site-release.mjs'

const PUBLIC_URL = 'https://yinlizhangyu.com'
const ICP_NUMBER = '蜀ICP备2026032754号-1'

function write(path, value = 'fixture') {
	mkdirSync(join(path, '..'), { recursive: true })
	writeFileSync(path, value, 'utf8')
}

function createWebsiteArtifact({ hiddenFile = false, localAddress = false, localhostPath = false, oldEmbed = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'workway-site-release-test-'))
	for (const directory of [
		'assets',
		'loumai-ui/landlord',
		'loumai-ui/agent'
	]) mkdirSync(join(root, directory), { recursive: true })
	write(
		join(root, 'index.html'),
		`<!doctype html><link href="/assets/main.css"><script src="/assets/main.js"></script>${PUBLIC_URL} ${ICP_NUMBER}`
	)
	write(
		join(root, 'assets/main.js'),
		`const url=${JSON.stringify(PUBLIC_URL)};const icp=${JSON.stringify(ICP_NUMBER)};const ui='/loumai-ui/landlord/channels.html';const lead='lead endpoint not configured';const routerFallback='http://localhost';${localAddress ? "const bad='http://192.168.1.11:5173'" : ''}${localhostPath ? "const localApi='http://localhost/api/leads'" : ''}${oldEmbed ? "const old='/site-embed/landlord-dashboard.html'" : ''}`
	)
	write(join(root, 'assets/main.css'), 'body{background:url("/assets/bg.svg")}')
	write(join(root, 'assets/bg.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
	write(join(root, 'robots.txt'), `Sitemap: ${PUBLIC_URL}/sitemap.xml\n`)
	write(join(root, 'sitemap.xml'), `<loc>${PUBLIC_URL}/</loc>`)
	write(join(root, 'loumai-ui/landlord/channels.html'), '<!doctype html>channels')
	write(join(root, 'loumai-ui/landlord/listings.html'), '<!doctype html>listings')
	write(join(root, 'loumai-ui/agent/explore.html'), '<!doctype html>explore')
	write(join(root, 'loumai-ui/booking.html'), '<!doctype html>booking')
	for (let index = 0; index < 45; index += 1) {
		write(join(root, 'assets', `chunk-${index}.js`), `export default ${index}`)
	}
	if (hiddenFile) write(join(root, 'loumai-ui', '.env'), 'SECRET=do-not-publish')
	return root
}

test('官网配置文本不会执行 shell，参数默认保持安全', () => {
	assert.deepEqual(
		parseDotEnv([
			'SITE_DEPLOY_TARGET=ubuntu@132.232.220.115',
			'SITE_PUBLIC_URL="https://yinlizhangyu.com"',
			"SITE_REQUIRE_UPSTREAM_MATCH='true'"
		].join('\n')),
		{
			SITE_DEPLOY_TARGET: 'ubuntu@132.232.220.115',
			SITE_PUBLIC_URL: 'https://yinlizhangyu.com',
			SITE_REQUIRE_UPSTREAM_MATCH: 'true'
		}
	)
	assert.deepEqual(parseArgs(['prepare', '--dry-run']), {
		command: 'prepare',
		configPath: DEFAULT_CONFIG_PATH,
		dryRun: true,
		help: false,
		releaseId: '',
		skipTests: false,
		yes: false
	})
	assert.equal(
		parseArgs(['rollback', '--release', '20260811T120000Z-abcdef1234', '--dry-run']).releaseId,
		'20260811T120000Z-abcdef1234'
	)
	assert.throws(() => parseArgs(['rollback']), /必须提供 --release/)
	assert.throws(() => parseArgs(['deploy', '--unknown']), /未知参数/)
})

test('官网配置强制独立目录、正式域名和 user@host SSH 目标', () => {
	const root = mkdtempSync(join(tmpdir(), 'workway-site-config-test-'))
	const identity = join(root, 'id_ed25519')
	const config = join(root, 'website.env')
	write(identity, 'not-a-real-key')
	write(config, [
		`SITE_REPO=${root}`,
		'SITE_DEPLOY_TARGET=ubuntu@132.232.220.115',
		`SITE_SSH_IDENTITY_FILE=${identity}`,
		`SITE_PUBLIC_URL=${PUBLIC_URL}`,
		'SITE_WWW_DOMAIN=www.yinlizhangyu.com',
		'SITE_EXPECTED_IPV4=132.232.220.115',
		`SITE_ICP_NUMBER=${ICP_NUMBER}`,
		'SITE_LEAD_ENDPOINT=',
		'SITE_REMOTE_ROOT=/srv/workway-site'
	].join('\n'))
	try {
		const validSource = readFileSync(config, 'utf8')
		const parsed = loadConfig(config)
		assert.equal(parsed.primaryDomain, 'yinlizhangyu.com')
		assert.equal(parsed.remoteRoot, '/srv/workway-site')
		writeFileSync(config, validSource.replace('/srv/workway-site', '/srv/loumai-h5/site'))
		assert.throws(() => loadConfig(config), /禁止复用测试 H5/)
		writeFileSync(config, validSource.replace('ubuntu@132.232.220.115', '132.232.220.115'))
		assert.throws(() => loadConfig(config), /必须是 user@host/)
	} finally {
		rmSync(root, { force: true, recursive: true })
	}
})

test('release id 来自确定时间和完整 commit 前缀', () => {
	assert.equal(
		createReleaseId('abcdef1234567890', new Date('2026-08-11T12:34:56.000Z')),
		'20260811T123456Z-abcdef1234'
	)
	assert.equal(shellQuote("a'b"), `'a'"'"'b'`)
})

test('官网产物必须包含真实 loumai-ui、正式域名、备案号和完整资源', () => {
	const artifact = createWebsiteArtifact()
	try {
		const result = validateArtifact(artifact, { publicUrl: PUBLIC_URL, icpNumber: ICP_NUMBER })
		assert.ok(result.fileCount >= 50)
		assert.ok(result.totalBytes > 0)
	} finally {
		rmSync(artifact, { force: true, recursive: true })
	}
})

test('局域网地址和旧 site-embed 不能进入官网产物', () => {
	const localArtifact = createWebsiteArtifact({ localAddress: true })
	const localhostPathArtifact = createWebsiteArtifact({ localhostPath: true })
	const oldEmbedArtifact = createWebsiteArtifact({ oldEmbed: true })
	try {
		assert.throws(
			() => validateArtifact(localArtifact, { publicUrl: PUBLIC_URL, icpNumber: ICP_NUMBER }),
			/包含本地或局域网地址/
		)
		assert.throws(
			() => validateArtifact(localhostPathArtifact, { publicUrl: PUBLIC_URL, icpNumber: ICP_NUMBER }),
			/包含本地或局域网地址/
		)
		assert.throws(
			() => validateArtifact(oldEmbedArtifact, { publicUrl: PUBLIC_URL, icpNumber: ICP_NUMBER }),
			/仍引用旧 site-embed/
		)
	} finally {
		rmSync(localArtifact, { force: true, recursive: true })
		rmSync(localhostPathArtifact, { force: true, recursive: true })
		rmSync(oldEmbedArtifact, { force: true, recursive: true })
	}
})

test('隐藏文件和敏感配置不能进入官网产物', () => {
	const artifact = createWebsiteArtifact({ hiddenFile: true })
	try {
		assert.throws(
			() => validateArtifact(artifact, { publicUrl: PUBLIC_URL, icpNumber: ICP_NUMBER }),
			/包含隐藏文件/
		)
	} finally {
		rmSync(artifact, { force: true, recursive: true })
	}
})

test('服务器 helper 隔离测试站并具备验签、锁、原子切换和失败恢复', () => {
	const helper = readFileSync(join(TOOL_ROOT, 'website/remote/workway-site-release'), 'utf8')
	assert.match(helper, /^#!\/bin\/bash/)
	assert.match(helper, /flock -w 120/)
	assert.match(helper, /sha256sum -c SHA256SUMS/)
	assert.match(helper, /mv -Tf -- "\$next_link" "\$CURRENT_LINK"/)
	assert.match(helper, /trap restore_previous_current EXIT/)
	assert.match(helper, /arm_current_rollback/)
	assert.match(helper, /snapshot_nginx_state/)
	assert.match(helper, /已恢复原 Nginx 配置/)
	assert.match(helper, /test_site_fingerprint/)
	assert.match(helper, /cp --no-dereference --reflink=never/)
	assert.match(helper, /归档包含软链接、硬链接或特殊文件/)
	assert.match(helper, /PRIMARY_DOMAIN.*test\.yinlizhangyu\.com/)
	assert.match(helper, /location \/loumai-ui\//)
	assert.match(helper, /max-age=31536000, immutable/)
	assert.match(helper, /\/etc\/letsencrypt\/renewal-hooks\/deploy/)
	assert.match(helper, /reload-nginx/)
	assert.ok(helper.includes('try_files \\$uri \\$uri/ /index.html'))
	assert.doesNotMatch(helper, /\/srv\/loumai-h5/)
	const localSource = readFileSync(join(TOOL_ROOT, 'website/site-release.mjs'), 'utf8')
	assert.match(localSource, /sudo -n \/bin\/bash -c \$\{shellQuote\(installCommand\)\}/)
	assert.equal((localSource.match(/StrictHostKeyChecking=yes/g) || []).length, 2)
	assert.equal((localSource.match(/ServerAliveInterval=15/g) || []).length, 2)
	assert.match(localSource, /function assertWebsiteReadyForDeploy/)
	assert.match(localSource, /HTTPS=enabled/)
	assert.doesNotMatch(
		localSource,
		/if \(args\.command === 'deploy'\) remote\(config, \['enable-https'\]/
	)
	const switchStart = helper.indexOf('switch_current()')
	const safetyStart = helper.indexOf('assert_tree_safety()', switchStart)
	assert.doesNotMatch(helper.slice(switchStart, safetyStart), /ln -sfn/)
})

test('统一入口、npm 命令和配置模板均包含 website 且不保存密码', () => {
	const entry = readFileSync(join(TOOL_ROOT, 'loumai-deploy'), 'utf8')
	const packageJson = JSON.parse(readFileSync(join(TOOL_ROOT, 'package.json'), 'utf8'))
	const template = readFileSync(join(TOOL_ROOT, 'config/website.production.example.env'), 'utf8')
	assert.match(entry, /website\)/)
	assert.match(entry, /website prepare --yes/)
	assert.ok(packageJson.scripts['website:deploy'])
	assert.match(template, /^SITE_REPO=/m)
	assert.match(template, /^SITE_REMOTE_ROOT=\/srv\/workway-site$/m)
	assert.doesNotMatch(template, /PASSWORD=|TOKEN=|PRIVATE_KEY=/)
})
