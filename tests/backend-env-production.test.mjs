import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
	buildEnvironmentAudit,
	ENV_RUNNER_KEYS,
	inspectEnvironmentText,
	isSensitiveEnvironmentKey,
	renderEnvironmentAudit
} from '../backend/env-audit.mjs'

const PRODUCTION_VALUES = Object.freeze({
	APP_ENVIRONMENT: 'production',
	BACKUP_DATABASE_URL: 'postgresql://production-backup-secret',
	DATABASE_URL: 'postgresql://production-database-secret',
	MIGRATION_DATABASE_URL: 'postgresql://production-migration-secret',
	JWT_SECRET_KEY: 'production-jwt-secret',
	BACKEND_ALLOWED_HOSTS: 'api.example.com',
	BACKEND_CORS_ORIGINS: 'https://app.example.com,https://admin.example.com:8443',
	ALLOW_INSECURE_TEST_SETTINGS: 'false',
	API_DOCS_ENABLED: 'false',
	ALLOW_MOCK_WECHAT: 'false',
	REGISTRATION_SMS_VERIFICATION_ENABLED: 'true',
	GEO_WEBVIEW_COOKIE_SECURE: 'true'
})

function remoteEnvironment(values = PRODUCTION_VALUES) {
	return {
		duplicates: [],
		entries: new Map(Object.entries(values).map(([key, value], index) => [key, {
			key,
			source: `/etc/loumai/production.env:${index + 1}`,
			state: value === '' ? 'EMPTY' : 'SET',
			value: isSensitiveEnvironmentKey(key) ? undefined : value,
			visibility: isSensitiveEnvironmentKey(key) ? 'HIDDEN' : 'PUBLIC'
		}])),
		fileCount: 1,
		protocol: '1',
		settingsErrors: [],
		settingsValid: true,
		targetEnvironmentMatch: true
	}
}

function productionAudit(overrides = {}, options = {}) {
	const values = { ...PRODUCTION_VALUES, ...overrides }
	for (const key of options.omit || []) delete values[key]
	return buildEnvironmentAudit({
		all: true,
		catalogKeys: Object.keys(PRODUCTION_VALUES),
		local: inspectEnvironmentText([
			'APP_ENVIRONMENT=development',
			'JWT_SECRET_KEY=local-secret-canary-must-not-appear'
		].join('\n')),
		localSettings: { errors: [], valid: true },
		remote: remoteEnvironment(values),
		targetEnvironment: 'production'
	})
}

test('正式服安全基线通过，报告使用正式服文案且不输出敏感值', () => {
	const audit = productionAudit()
	const report = renderEnvironmentAudit(audit, { targetEnvironment: 'production' })

	assert.equal(audit.blockers, 0)
	assert.match(report, /后端环境审计：正式服（production；敏感值始终隐藏）/)
	assert.match(report, /正式服非空配置：/)
	assert.doesNotMatch(report, /测试服/)
	assert.doesNotMatch(report, /local-secret-canary-must-not-appear/)
	assert.doesNotMatch(report, /production-database-secret/)
	assert.doesNotMatch(report, /production-migration-secret/)
	assert.doesNotMatch(report, /production-backup-secret/)
	assert.doesNotMatch(report, /production-jwt-secret/)
})

test('备份数据库 URL 是正式服关键敏感变量', () => {
	assert.ok(ENV_RUNNER_KEYS.includes('BACKUP_DATABASE_URL'))
	assert.equal(isSensitiveEnvironmentKey('BACKUP_DATABASE_URL'), true)
	const audit = productionAudit({}, { omit: ['BACKUP_DATABASE_URL'] })
	assert.ok(audit.issues.some(({ key, severity }) => (
		key === 'BACKUP_DATABASE_URL' && severity === 'BLOCKER'
	)))
})

test('正式服数据库模板使用三个不同角色和完全一致的 TLS 数据库目标', () => {
	const template = readFileSync(
		new URL('../backend/remote/database-profile.production.cloud.env.example', import.meta.url),
		'utf8'
	)
	const inspected = inspectEnvironmentText(template, 'database-profile.production.cloud.env.example')
	const keys = ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'BACKUP_DATABASE_URL']
	const urls = keys.map((key) => {
		const value = inspected.entries.get(key)?.value
		assert.ok(value, `${key} 必须在正式服数据库模板中定义`)
		return new URL(value.replace(/^postgresql\+psycopg:/, 'postgresql:'))
	})

	assert.deepEqual(urls.map(({ username }) => username), ['APP_USER', 'MIGRATION_USER', 'BACKUP_USER'])
	assert.equal(new Set(urls.map(({ username }) => username)).size, 3)
	for (const url of urls) {
		assert.equal(url.host, urls[0].host)
		assert.equal(url.pathname, urls[0].pathname)
		assert.equal(url.searchParams.get('sslmode'), 'verify-full')
		assert.equal(url.searchParams.get('sslrootcert'), '/etc/loumai/certs/tencentdb-ca.pem')
	}
	assert.match(template, /read-only backup/)
})

test('正式服缺少任一关键变量都会阻断，即使调用方目录未列出关键键', () => {
	const remote = remoteEnvironment({ APP_ENVIRONMENT: 'production' })
	const audit = buildEnvironmentAudit({
		catalogKeys: [],
		local: inspectEnvironmentText(''),
		localSettings: { errors: [], valid: true },
		remote,
		targetEnvironment: 'production'
	})
	const blockedKeys = new Set(audit.issues
		.filter(({ severity }) => severity === 'BLOCKER')
		.map(({ key }) => key))

	for (const key of Object.keys(PRODUCTION_VALUES).filter((key) => key !== 'APP_ENVIRONMENT')) {
		assert.ok(blockedKeys.has(key), `${key} 缺失时必须阻断`)
	}
})

test('正式服布尔安全策略按 false/false/false/true/true 阻断危险配置', () => {
	const audit = productionAudit({
		ALLOW_INSECURE_TEST_SETTINGS: 'true',
		API_DOCS_ENABLED: 'true',
		ALLOW_MOCK_WECHAT: 'true',
		REGISTRATION_SMS_VERIFICATION_ENABLED: 'false',
		GEO_WEBVIEW_COOKIE_SECURE: 'false'
	})
	const blockedKeys = new Set(audit.issues
		.filter(({ severity }) => severity === 'BLOCKER')
		.map(({ key }) => key))

	for (const key of [
		'ALLOW_INSECURE_TEST_SETTINGS',
		'API_DOCS_ENABLED',
		'ALLOW_MOCK_WECHAT',
		'REGISTRATION_SMS_VERIFICATION_ENABLED',
		'GEO_WEBVIEW_COOKIE_SECURE'
	]) assert.ok(blockedKeys.has(key), `${key} 危险值必须阻断`)
})

test('正式服 Host 拒绝通配、localhost、私网和非法域名', async (t) => {
	for (const value of [
		'*',
		'localhost',
		'api.localhost',
		'127.0.0.1',
		'10.0.0.1',
		'172.16.0.1',
		'192.168.1.1',
		'169.254.1.1',
		'[::1]',
		'[fd00::1]',
		'not a host'
	]) {
		await t.test(value, () => {
			const audit = productionAudit({ BACKEND_ALLOWED_HOSTS: value })
			assert.ok(audit.issues.some(({ key, severity }) => (
				key === 'BACKEND_ALLOWED_HOSTS' && severity === 'BLOCKER'
			)))
		})
	}
})

test('正式服 CORS 只允许明确的公网 HTTPS Origin', async (t) => {
	for (const value of [
		'*',
		'http://app.example.com',
		'https://localhost',
		'https://127.0.0.1',
		'https://10.0.0.1',
		'https://user:password@app.example.com',
		'https://app.example.com/path',
		'https://*.example.com'
	]) {
		await t.test(value, () => {
			const audit = productionAudit({ BACKEND_CORS_ORIGINS: value })
			assert.ok(audit.issues.some(({ key, severity }) => (
				key === 'BACKEND_CORS_ORIGINS' && severity === 'BLOCKER'
			)))
		})
	}
})
