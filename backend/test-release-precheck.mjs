import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { BACKEND_RELEASE_TOOL_VERSION, DEFAULT_CONSTRAINTS_PATH } from './backend-release.mjs'

// Match the existing backend document exporter's five-method index.
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])

export function verifyApiReference(repoRoot) {
	const docs = join(repoRoot, 'docs')
	const schema = JSON.parse(readFileSync(join(docs, 'apifox-openapi.json'), 'utf8'))
	const reference = readFileSync(join(docs, '楼脉全量API接口文档_v1.0.md'), 'utf8')
	const operations = new Set(Object.entries(schema.paths).flatMap(([path, item]) =>
		Object.keys(item).filter(method => METHODS.has(method)).map(method => `${method.toUpperCase()} ${path}`)
	))
	const counts = {
		'当前真实路径': Object.keys(schema.paths).length,
		'当前 HTTP 操作': operations.size,
		'OpenAPI 数据模型': Object.keys(schema.components.schemas).length
	}
	for (const [label, count] of Object.entries(counts)) {
		if (!reference.includes(`${label}：**${count}**`)) {
			throw new Error(`接口文档不同步：${label}应为${count}；请更新总览后重试`)
		}
	}
	const headings = [...reference.matchAll(/^#### \d+\. `((?:GET|POST|PUT|PATCH|DELETE) [^`]+)`/gm)]
		.map(match => match[1])
	if (headings.length !== operations.size || new Set(headings).size !== operations.size
		|| headings.some(heading => !operations.has(heading))) {
		throw new Error('接口文档目录与Apifox操作清单不一致；请更新总览后重试')
	}
	return counts
}

export function sameHealthyTestRelease(statusText, commit, constraintsSha256) {
	if (!/^[0-9a-f]{40}$/.test(commit)) return false
	if (!/^[0-9a-f]{64}$/.test(constraintsSha256)) return false
	const values = Object.create(null)
	for (const line of statusText.split('\n')) {
		const match = /^([A-Za-z][A-Za-z0-9_]*)=(.*)$/.exec(line)
		if (!match) continue
		if (Object.hasOwn(values, match[1])) return false
		values[match[1]] = match[2]
	}
	const required = {
		ENVIRONMENT: 'test', INITIALIZED: 'true', DATABASE_PROFILE: 'cloud',
		ACTIVE_DATABASE_PROFILE: 'cloud', RECOVERY_REQUIRED: 'false',
		DEPLOYMENT_STATE: 'HEALTHY', DATABASE_WRITERS: 'verified',
		UNIT_loumai_api_service: 'active', UNIT_loumai_im_worker_service: 'active',
		UNIT_loumai_video_worker_service: 'active',
		UNIT_loumai_landlord_persona_refresh_service: 'active',
		UNIT_loumai_company_management_service: 'active',
		UNIT_loumai_file_storage_cleanup_timer: 'active',
		UNIT_loumai_app_push_dispatcher_timer: 'active'
	}
	if (Object.entries(required).some(([key, value]) => values[key] !== value)) return false
	for (const [key, value] of Object.entries(values)) {
		if (!key.startsWith('UNIT_')) continue
		if (['UNIT_loumai_file_storage_cleanup_service', 'UNIT_loumai_app_push_dispatcher_service'].includes(key)) {
			if (!['active', 'inactive', 'activating'].includes(value)) return false
		} else if (value !== 'active') return false
	}
	// The helper emits one root-level, indented release manifest amid its status fields.
	const manifestText = /^\{\n[\s\S]*?^\}/m.exec(statusText)?.[0]
	if (!manifestText) return false
	let manifest
	try {
		manifest = JSON.parse(manifestText)
	} catch {
		return false
	}
	return manifest.schema_version === 1 && manifest.commit === commit
		&& manifest.branch === 'test' && manifest.environment === 'test'
		&& /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,12}$/.test(manifest.release_id)
		&& values.CURRENT?.endsWith(`/backend-releases/${manifest.release_id}/backend`) === true
		&& typeof manifest.artifact_db_head === 'string' && manifest.artifact_db_head.length > 0
		&& values.DB_REVISION === manifest.artifact_db_head
		&& manifest.constraints_sha256 === constraintsSha256
		&& manifest.tool?.backend_release_tool === BACKEND_RELEASE_TOOL_VERSION
}

export function verifyPublicHealth(text) {
	const payload = JSON.parse(text)
	if (payload.status !== 'ok' || payload.database !== 'ok') throw new Error('公网API或数据库健康异常')
	return payload
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
	try {
		const [command, first, commit] = process.argv.slice(2)
		if (command === 'docs' && first && !commit) {
			console.log('接口文档快速预检通过：' + JSON.stringify(verifyApiReference(first)))
		} else if (command === 'unchanged' && first && commit) {
			const constraints = createHash('sha256').update(readFileSync(DEFAULT_CONSTRAINTS_PATH)).digest('hex')
			if (!sameHealthyTestRelease(readFileSync(first, 'utf8'), commit, constraints)) process.exitCode = 3
		} else if (command === 'health' && !first) {
			console.log(JSON.stringify(verifyPublicHealth(readFileSync(0, 'utf8'))))
		} else throw new Error('不支持的测试服发布预检参数')
	} catch (error) {
		console.error(`[test-release-precheck] ${error.message}`)
		process.exitCode = 1
	}
}
