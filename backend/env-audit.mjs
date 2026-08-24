import { Buffer } from 'node:buffer'

export const ENV_AUDIT_PROTOCOL_VERSION = '1'

export const ENV_RUNNER_KEYS = [
	'APP_PUSH_DISPATCH_INTERVAL_SECONDS',
	'BACKUP_DATABASE_URL',
	'FILE_STORAGE_CLEANUP_INTERVAL_SECONDS',
	'LOUMAI_DATABASE_NAME',
	'LOUMAI_DATABASE_PROFILE',
	'MIGRATION_DATABASE_URL',
	'MIGRATION_LOCK_TIMEOUT_SECONDS',
	'RUN_APP_PUSH_DISPATCHER',
	'RUN_FILE_STORAGE_CLEANUP'
]

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const CRITICAL_KEYS = new Set([
	'APP_ENVIRONMENT',
	'DATABASE_URL',
	'JWT_SECRET_KEY'
])
const CRITICAL_PRODUCTION_KEYS = new Set([
	...CRITICAL_KEYS,
	'BACKUP_DATABASE_URL',
	'MIGRATION_DATABASE_URL',
	'BACKEND_ALLOWED_HOSTS',
	'BACKEND_CORS_ORIGINS',
	'ALLOW_INSECURE_TEST_SETTINGS',
	'API_DOCS_ENABLED',
	'ALLOW_MOCK_WECHAT',
	'REGISTRATION_SMS_VERIFICATION_ENABLED',
	'GEO_WEBVIEW_COOKIE_SECURE'
])
const PRODUCTION_BOOLEAN_POLICIES = new Map([
	['ALLOW_INSECURE_TEST_SETTINGS', 'false'],
	['API_DOCS_ENABLED', 'false'],
	['ALLOW_MOCK_WECHAT', 'false'],
	['REGISTRATION_SMS_VERIFICATION_ENABLED', 'true'],
	['GEO_WEBVIEW_COOKIE_SECURE', 'true']
])

function parseValue(raw, sourceName, lineNumber) {
	const value = String(raw).trim()
	if (!value) return ''
	if (value.startsWith("'")) {
		if (value.length < 2 || !value.endsWith("'") || value.slice(1, -1).includes("'")) {
			throw new Error(`${sourceName} 第 ${lineNumber} 行单引号格式错误`)
		}
		return value.slice(1, -1)
	}
	if (value.startsWith('"')) {
		if (value.length < 2 || !value.endsWith('"')) {
			throw new Error(`${sourceName} 第 ${lineNumber} 行双引号格式错误`)
		}
		let parsed = ''
		const inner = value.slice(1, -1)
		for (let index = 0; index < inner.length; index += 1) {
			const character = inner[index]
			if (character === '\\' && ['"', '\\'].includes(inner[index + 1])) {
				parsed += inner[index + 1]
				index += 1
			} else {
				parsed += character
			}
		}
		return parsed
	}
	if (/\s/.test(value)) {
		throw new Error(`${sourceName} 第 ${lineNumber} 行未加引号的值包含空白字符`)
	}
	return value
}

export function inspectEnvironmentText(text = '', sourceName = '.env') {
	const entries = new Map()
	const occurrences = new Map()
	String(text).split(/\r?\n/).forEach((rawLine, offset) => {
		const lineNumber = offset + 1
		const trimmed = rawLine.trim()
		if (!trimmed || trimmed.startsWith('#')) return
		const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
		if (!match) throw new Error(`${sourceName} 第 ${lineNumber} 行格式错误`)
		const [, key, rawValue] = match
		const value = parseValue(rawValue, sourceName, lineNumber)
		const locations = occurrences.get(key) || []
		locations.push(`${sourceName}:${lineNumber}`)
		occurrences.set(key, locations)
		entries.set(key, {
			key,
			source: `${sourceName}:${lineNumber}`,
			state: value === '' ? 'EMPTY' : 'SET',
			value
		})
	})
	const duplicates = [...occurrences.entries()]
		.filter(([, locations]) => locations.length > 1)
		.map(([key, locations]) => ({ key, locations }))
	return { duplicates, entries }
}

export function isSensitiveEnvironmentKey(key) {
	const normalized = String(key).toUpperCase()
	return (
		/(^|_)(SECRET|PASSWORD|TOKEN|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY|APP_KEY)($|_)/.test(normalized)
		|| /(^|_)(DATABASE_URL|MIGRATION_DATABASE_URL|BACKUP_DATABASE_URL|REDIS_URL)$/.test(normalized)
		|| /(_KEY|_SECRET|_PASSWORD|_TOKEN)$/.test(normalized)
	)
}

export function isPublicComparableEnvironmentKey(key) {
	if (isSensitiveEnvironmentKey(key)) return false
	const normalized = String(key).toUpperCase()
	return (
		normalized === 'APP_ENVIRONMENT'
		|| [
			'BACKEND_ALLOWED_HOSTS',
			'BACKEND_CORS_ORIGINS',
			'BACKEND_CORS_ORIGIN_REGEX',
			'BAILIAN_BASE_URL',
			'DEEPSEEK_BASE_URL',
			'GEO_WEBVIEW_ALLOWED_ORIGINS',
			'TENCENT_IM_REST_BASE_URL',
			'TIANDITU_API_BASE_URL',
			'VIDEO_TRANSCODE_WORKER_ID'
		].includes(normalized)
		|| normalized.startsWith('RUN_')
		|| normalized.startsWith('ALLOW_')
		|| /_ENABLED$/.test(normalized)
		|| /_COOKIE_SECURE$/.test(normalized)
		|| /_(PROVIDER|MODE|REGION|ENGINE|ALGORITHM|PRESET|COORDINATE_SYSTEM)$/.test(normalized)
		|| /_(PATH|ROOT)$/.test(normalized)
		|| /_(SECONDS|MINUTES|HOURS|METERS|BYTES|PIXELS|EDGE|QUALITY|CONCURRENCY|THREADS|ATTEMPTS|RETRIES|FPS|CRF|SIZE)$/.test(normalized)
	)
}

function decodeProtocolValue(value, label) {
	if (value === '-') return ''
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`${label} 不是合法 Base64`)
	return Buffer.from(value, 'base64').toString('utf8')
}

export function parseRemoteEnvironmentAudit(text = '') {
	const result = {
		duplicates: [],
		entries: new Map(),
		fileCount: 0,
		protocol: '',
		settingsErrors: [],
		settingsValid: false,
		targetEnvironmentMatch: false
	}
	for (const [offset, rawLine] of String(text).split(/\r?\n/).entries()) {
		const line = rawLine.trimEnd()
		if (!line) continue
		const fields = line.split('\t')
		if (fields.length === 1) {
			const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
			if (!match) throw new Error(`远端审计协议第 ${offset + 1} 行格式错误`)
			const [, key, value] = match
			if (key === 'ENV_AUDIT_PROTOCOL') result.protocol = value
			else if (key === 'ENV_FILE_COUNT') result.fileCount = Number(value)
			else if (key === 'ENV_SETTINGS_VALID') result.settingsValid = value === '1'
			else if (key === 'ENV_TARGET_MATCH') result.targetEnvironmentMatch = value === '1'
			else throw new Error(`远端审计协议包含未知头字段：${key}`)
			continue
		}
		if (fields[0] === 'ENV_KEY' && fields.length === 6) {
			const [, key, state, visibility, encoded, encodedSource] = fields
			if (!ENV_KEY_PATTERN.test(key)) throw new Error('远端审计返回非法变量名')
			if (!['SET', 'EMPTY'].includes(state)) throw new Error(`远端变量 ${key} 状态非法`)
			if (!['PUBLIC', 'HIDDEN'].includes(visibility)) throw new Error(`远端变量 ${key} 可见性非法`)
			if (result.entries.has(key)) throw new Error(`远端审计重复返回变量：${key}`)
			if (visibility === 'PUBLIC' && !isPublicComparableEnvironmentKey(key)) {
				throw new Error(`远端试图公开非白名单变量：${key}`)
			}
			if (visibility === 'HIDDEN' && encoded !== '-') {
				throw new Error(`远端隐藏变量不应携带值：${key}`)
			}
			const value = visibility === 'PUBLIC' ? decodeProtocolValue(encoded, key) : undefined
			const source = decodeProtocolValue(encodedSource, `${key} source`)
			if (!source.startsWith('/etc/loumai/') || /[\r\n\t]/.test(source)) {
				throw new Error(`远端变量 ${key} 来源路径非法`)
			}
			result.entries.set(key, { key, source, state, value, visibility })
			continue
		}
		if (fields[0] === 'ENV_DUPLICATE' && fields.length === 3) {
			const [, key, encodedLocations] = fields
			if (!ENV_KEY_PATTERN.test(key)) throw new Error('远端重复项包含非法变量名')
			result.duplicates.push({
				key,
				locations: decodeProtocolValue(encodedLocations, `${key} locations`).split('\n').filter(Boolean)
			})
			continue
		}
		if (fields[0] === 'ENV_SETTINGS_ERROR' && fields.length === 3) {
			result.settingsErrors.push({
				field: decodeProtocolValue(fields[1], 'settings field'),
				type: decodeProtocolValue(fields[2], 'settings type')
			})
			continue
		}
		throw new Error(`远端审计协议第 ${offset + 1} 行无法识别`)
	}
	if (result.protocol !== ENV_AUDIT_PROTOCOL_VERSION) {
		throw new Error(`远端 env 审计协议不一致：实际 ${result.protocol || '(empty)'}，要求 ${ENV_AUDIT_PROTOCOL_VERSION}`)
	}
	if (!Number.isInteger(result.fileCount) || result.fileCount < 1) {
		throw new Error('远端 env 文件数量非法')
	}
	return result
}

function stateOf(entries, key) {
	return entries.get(key)?.state || 'MISSING'
}

function describeEntry(entry, key) {
	if (!entry) return '未定义'
	const source = entry.source ? `；来源 ${entry.source}` : ''
	if (entry.state === 'EMPTY') return `已配置，但值为空${source}`
	if (isSensitiveEnvironmentKey(key)) return `已配置（敏感值已隐藏）${source}`
	if (entry.value !== undefined && isPublicComparableEnvironmentKey(key)) {
		const serialized = JSON.stringify(entry.value)
		return `已配置（值：${serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized}）${source}`
	}
	return `已配置（值已隐藏）${source}`
}

function addIssue(issues, severity, key, localEntry, remoteEntry, reason, suggestion) {
	issues.push({
		key,
		local: describeEntry(localEntry, key),
		reason,
		remote: describeEntry(remoteEntry, key),
		severity,
		suggestion
	})
}

function environmentLabel(targetEnvironment) {
	if (targetEnvironment === 'production') return '正式服'
	if (targetEnvironment === 'test') return '测试服'
	return `${targetEnvironment} 环境`
}

function commaSeparatedValues(value) {
	const raw = String(value).trim()
	if (raw.startsWith('[')) {
		try {
			const parsed = JSON.parse(raw)
			if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return []
			return parsed.map((item) => item.trim()).filter(Boolean)
		} catch {
			return []
		}
	}
	return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

function ipv4Octets(hostname) {
	const match = String(hostname).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
	if (!match) return null
	const octets = match.slice(1).map(Number)
	return octets.every((octet) => octet <= 255) ? octets : null
}

function normalizedHostname(value) {
	let hostname = String(value).trim().toLowerCase()
	if (hostname.startsWith('[')) {
		const closingBracket = hostname.indexOf(']')
		if (closingBracket !== -1) return hostname.slice(1, closingBracket)
	}
	const portMatch = hostname.match(/^([^:]+):\d+$/)
	if (portMatch) hostname = portMatch[1]
	return hostname.replace(/\.$/, '')
}

function unsafeProductionHostname(value) {
	const hostname = normalizedHostname(value)
	if (!hostname || hostname.includes('*')) return true
	if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
	if (hostname === '::' || hostname === '::1' || /^fe[89ab][0-9a-f]:/.test(hostname)) return true
	if (/^f[cd][0-9a-f]{2}:/.test(hostname)) return true
	const mappedIpv4 = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
	if (mappedIpv4) return unsafeProductionHostname(mappedIpv4[1])
	const octets = ipv4Octets(hostname)
	if (!octets) return false
	const [first, second] = octets
	return (
		first === 0
		|| first === 10
		|| first === 127
		|| (first === 169 && second === 254)
		|| (first === 172 && second >= 16 && second <= 31)
		|| (first === 192 && second === 168)
	)
}

function validProductionHostname(value) {
	const hostname = normalizedHostname(value)
	if (!hostname || hostname.length > 253) return false
	if (ipv4Octets(hostname)) return true
	if (/^[0-9.]+$/.test(hostname)) return false
	if (hostname.includes(':')) return /^[0-9a-f:]+$/.test(hostname)
	return hostname.split('.').every((label) => (
		label.length >= 1
		&& label.length <= 63
		&& /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
	))
}

function productionHostPolicyError(value) {
	const hosts = commaSeparatedValues(value)
	if (!hosts.length) return '未配置任何 Host'
	for (const host of hosts) {
		if (host.includes('://') || /[/?#@]/.test(host)) return `Host ${JSON.stringify(host)} 格式非法`
		if (!validProductionHostname(host)) return `Host ${JSON.stringify(host)} 不是合法域名或 IP 地址`
		if (unsafeProductionHostname(host)) {
			return `Host ${JSON.stringify(host)} 不能是通配、localhost 或私网地址`
		}
	}
	return ''
}

function productionCorsPolicyError(value) {
	const origins = commaSeparatedValues(value)
	if (!origins.length) return '未配置任何 CORS Origin'
	for (const origin of origins) {
		if (origin.includes('*')) return `CORS Origin ${JSON.stringify(origin)} 不能包含通配符`
		let parsed
		try {
			parsed = new URL(origin)
		} catch {
			return `CORS Origin ${JSON.stringify(origin)} 不是合法 URL`
		}
		if (
			parsed.protocol !== 'https:'
			|| parsed.username
			|| parsed.password
			|| parsed.pathname !== '/'
			|| parsed.search
			|| parsed.hash
		) {
			return `CORS Origin ${JSON.stringify(origin)} 必须是无凭据、无路径的 HTTPS Origin`
		}
		if (unsafeProductionHostname(parsed.hostname)) {
			return `CORS Origin ${JSON.stringify(origin)} 不能指向 localhost 或私网地址`
		}
	}
	return ''
}

function addProductionPolicyIssues(issues, local, remote) {
	for (const [key, expected] of PRODUCTION_BOOLEAN_POLICIES) {
		const remoteEntry = remote.entries.get(key)
		if (remoteEntry?.state !== 'SET') continue
		if (remoteEntry.visibility !== 'PUBLIC' || remoteEntry.value === undefined) {
			addIssue(
				issues,
				'BLOCKER',
				key,
				local.entries.get(key),
				remoteEntry,
				`正式服 ${key} 没有提供可校验的公开布尔值。`,
				'修正远端审计协议，将该非敏感布尔配置作为 PUBLIC 返回后重新审计。'
			)
			continue
		}
		const actual = String(remoteEntry.value).trim().toLowerCase()
		if (actual !== expected) {
			addIssue(
				issues,
				'BLOCKER',
				key,
				local.entries.get(key),
				remoteEntry,
				`正式服 ${key} 必须明确为 ${expected}，当前为 ${JSON.stringify(remoteEntry.value)}。`,
				`在正式服环境文件中把 ${key} 设为 ${expected}。`
			)
		}
	}

	for (const [key, policy] of [
		['BACKEND_ALLOWED_HOSTS', productionHostPolicyError],
		['BACKEND_CORS_ORIGINS', productionCorsPolicyError]
	]) {
		const remoteEntry = remote.entries.get(key)
		if (remoteEntry?.state !== 'SET') continue
		if (remoteEntry.visibility !== 'PUBLIC' || remoteEntry.value === undefined) {
			addIssue(
				issues,
				'BLOCKER',
				key,
				local.entries.get(key),
				remoteEntry,
				`正式服 ${key} 没有提供可校验的公开域名配置。`,
				'修正远端审计协议，将该非敏感域名配置作为 PUBLIC 返回后重新审计。'
			)
			continue
		}
		const error = policy(remoteEntry.value)
		if (!error) continue
		addIssue(
			issues,
			'BLOCKER',
			key,
			local.entries.get(key),
			remoteEntry,
			`正式服 ${key} 不安全：${error}。`,
			'只保留明确的公网域名；CORS 必须使用无凭据、无路径的 HTTPS Origin。'
		)
	}
}

export function buildEnvironmentAudit({
	all = false,
	catalogKeys = [],
	local,
	localSettings,
	remote,
	targetEnvironment = 'test'
}) {
	const issues = []
	const targetLabel = environmentLabel(targetEnvironment)
	const criticalKeys = targetEnvironment === 'production' ? CRITICAL_PRODUCTION_KEYS : CRITICAL_KEYS
	const catalog = new Set(catalogKeys)
	const recognizedCatalogKeys = new Set([...catalogKeys, ...criticalKeys])
	for (const key of criticalKeys) catalog.add(key)
	for (const key of local.entries.keys()) catalog.add(key)
	for (const key of remote.entries.keys()) catalog.add(key)

	for (const duplicate of local.duplicates) {
		addIssue(
			issues,
			'BLOCKER',
			duplicate.key,
			local.entries.get(duplicate.key),
			remote.entries.get(duplicate.key),
			`本地变量重复定义：${duplicate.locations.join('、')}。最后一项虽然会覆盖前面的值，但结果容易被误判。`,
			'删除重复定义，只保留一处明确配置。'
		)
	}
	for (const duplicate of remote.duplicates) {
		addIssue(
			issues,
			'BLOCKER',
			duplicate.key,
			local.entries.get(duplicate.key),
			remote.entries.get(duplicate.key),
			`${targetLabel}变量重复定义：${duplicate.locations.join('、')}。不同 env 文件的覆盖顺序会造成运行配置含义不清。`,
			'在服务器 env 文件中只保留一处定义，再重新执行审计。'
		)
	}

	if (!localSettings.valid) {
		for (const error of localSettings.errors) {
			addIssue(
				issues,
				'BLOCKER',
				error.field || '__SETTINGS__',
				local.entries.get(error.field),
				remote.entries.get(error.field),
				`本地 Settings 校验失败（${error.type}）。为避免泄露配置内容，错误输入值未显示。`,
				'先修正本地 .env，使后端 Settings 能正常初始化。'
			)
		}
	}
	if (!remote.settingsValid) {
		const errors = remote.settingsErrors.length ? remote.settingsErrors : [{ field: '__SETTINGS__', type: 'unknown' }]
		for (const error of errors) {
			addIssue(
				issues,
				'BLOCKER',
				error.field || '__SETTINGS__',
				local.entries.get(error.field),
				remote.entries.get(error.field),
				`${targetLabel}当前版本 Settings 校验失败（${error.type}）。服务器服务可能无法可靠重启。`,
				'备份服务器 env 后修正该字段，并在重启服务前再次执行审计。'
			)
		}
	}
	if (!remote.targetEnvironmentMatch) {
		addIssue(
			issues,
			'BLOCKER',
			'APP_ENVIRONMENT',
			local.entries.get('APP_ENVIRONMENT'),
			remote.entries.get('APP_ENVIRONMENT'),
			`${targetLabel} APP_ENVIRONMENT 必须明确等于 ${targetEnvironment}，当前不匹配。`,
			`把${targetLabel} APP_ENVIRONMENT 修正为 ${targetEnvironment}。`
		)
	}

	for (const key of [...catalog].sort()) {
		const localEntry = local.entries.get(key)
		const remoteEntry = remote.entries.get(key)
		const localState = stateOf(local.entries, key)
		const remoteState = stateOf(remote.entries, key)
		if (!recognizedCatalogKeys.has(key)) {
			addIssue(
				issues,
				'WARNING',
				key,
				localEntry,
				remoteEntry,
				'该变量不在当前 Settings、.env.example 或部署运行变量白名单中，可能是拼写错误或已经废弃。',
				'确认代码是否仍读取该变量；如不再使用，请从相应 env 文件删除。'
			)
			continue
		}
		if (criticalKeys.has(key) && remoteState !== 'SET') {
			addIssue(
				issues,
				'BLOCKER',
				key,
				localEntry,
				remoteEntry,
				`${targetLabel}关键变量 ${key} ${remoteState === 'EMPTY' ? '已定义但为空' : '没有定义'}，不能依赖开发默认值。`,
				'在服务器对应 env 文件中配置有效值；敏感值不要复制到聊天、日志或 Git。'
			)
			continue
		}
		if (localState === 'SET' && remoteState === 'MISSING') {
			addIssue(
				issues,
				'WARNING',
				key,
				localEntry,
				remoteEntry,
				`本地明确配置了该变量，但${targetLabel}没有定义。${targetLabel}将使用代码默认值，或在功能启用时校验失败。`,
				`核对这是否是本地开发专用配置；若${targetLabel}也需要该能力，请在服务器 env 中显式补充。`
			)
			continue
		}
		if (localState === 'SET' && remoteState === 'EMPTY') {
			addIssue(
				issues,
				'WARNING',
				key,
				localEntry,
				remoteEntry,
				`本地有非空配置，但${targetLabel}只留下了空值。依赖该变量的功能在${targetLabel}可能不可用。`,
				`确认${targetLabel}是否应启用该功能；需要时填写${targetLabel}自己的值，不要直接复制开发密钥。`
			)
			continue
		}
		if (localState === 'MISSING' && remoteState !== 'MISSING') {
			addIssue(
				issues,
				'INFO',
				key,
				localEntry,
				remoteEntry,
				`该变量只在${targetLabel}显式配置，通常属于服务器专用配置，但本地环境无法复现这一行为。`,
				'如果这是预期的环境差异，可以保留；否则在本地补充等价的开发配置。'
			)
			continue
		}
		if (localState === 'EMPTY' && remoteState === 'SET') {
			addIssue(
				issues,
				'INFO',
				key,
				localEntry,
				remoteEntry,
				`本地该变量为空，${targetLabel}已配置非空值，说明${targetLabel}启用了本地未启用或无法模拟的能力。`,
				`确认这是预期的${targetLabel}专用配置，并确保相关密钥只保存在服务器。`
			)
			continue
		}
		if (
			localState === 'SET'
			&& remoteState === 'SET'
			&& isPublicComparableEnvironmentKey(key)
			&& localEntry.value !== undefined
			&& remoteEntry.value !== undefined
			&& localEntry.value !== remoteEntry.value
		) {
			const expectedEnvironmentDifference = key === 'APP_ENVIRONMENT'
			addIssue(
				issues,
				expectedEnvironmentDifference ? 'INFO' : 'WARNING',
				key,
				localEntry,
				remoteEntry,
				expectedEnvironmentDifference
					? `本地开发环境与${targetLabel}环境名称不同，这是正常的环境隔离。`
					: `本地与${targetLabel}的非敏感配置值不同，功能行为可能不一致。`,
				expectedEnvironmentDifference
					? `无需修改；保持本地 development、${targetLabel} ${targetEnvironment}。`
					: '确认差异是否符合预期；如果要保持相同行为，请只修改对应环境自己的配置。'
			)
		}
	}
	if (targetEnvironment === 'production') addProductionPolicyIssues(issues, local, remote)

	const deduplicated = []
	const fingerprints = new Set()
	for (const issue of issues) {
		const fingerprint = `${issue.severity}\0${issue.key}\0${issue.reason}`
		if (!fingerprints.has(fingerprint)) {
			fingerprints.add(fingerprint)
			deduplicated.push(issue)
		}
	}
	const rows = [...catalog].sort().map((key) => ({
		key,
		local: describeEntry(local.entries.get(key), key),
		remote: describeEntry(remote.entries.get(key), key)
	}))
	return {
		all,
		blockers: deduplicated.filter(({ severity }) => severity === 'BLOCKER').length,
		catalogCount: catalog.size,
		infos: deduplicated.filter(({ severity }) => severity === 'INFO').length,
		issues: deduplicated,
		localConfigured: [...local.entries.values()].filter(({ state }) => state === 'SET').length,
		remoteConfigured: [...remote.entries.values()].filter(({ state }) => state === 'SET').length,
		rows,
		warnings: deduplicated.filter(({ severity }) => severity === 'WARNING').length
	}
}

function severityLabel(severity) {
	return { BLOCKER: '阻断', INFO: '提示', WARNING: '警告' }[severity] || severity
}

export function renderEnvironmentAudit(audit, { targetEnvironment = 'test' } = {}) {
	const targetLabel = environmentLabel(targetEnvironment)
	const lines = [
		`后端环境审计：${targetLabel}（${targetEnvironment}；敏感值始终隐藏）`,
		''
	]
	if (audit.all) {
		lines.push('全部变量状态：')
		for (const row of audit.rows) {
			lines.push(`- ${row.key}`)
			lines.push(`  本地：${row.local}`)
			lines.push(`  ${targetLabel}：${row.remote}`)
		}
		lines.push('')
	}
	lines.push('异常与环境差异详情：')
	if (!audit.issues.length) {
		lines.push('- 未发现阻断、警告或需要确认的环境差异。')
	} else {
		for (const issue of audit.issues) {
			lines.push('')
			lines.push(`[${severityLabel(issue.severity)}] ${issue.key}`)
			lines.push(`  本地：${issue.local}`)
			lines.push(`  ${targetLabel}：${issue.remote}`)
			lines.push(`  原因：${issue.reason}`)
			lines.push(`  建议：${issue.suggestion}`)
		}
	}
	lines.push('')
	lines.push('汇总：')
	lines.push(`- 合法及已发现变量：${audit.catalogCount}`)
	lines.push(`- 本地非空配置：${audit.localConfigured}`)
	lines.push(`- ${targetLabel}非空配置：${audit.remoteConfigured}`)
	lines.push(`- 阻断：${audit.blockers}`)
	lines.push(`- 警告：${audit.warnings}`)
	lines.push(`- 提示：${audit.infos}`)
	return `${lines.join('\n')}\n`
}
