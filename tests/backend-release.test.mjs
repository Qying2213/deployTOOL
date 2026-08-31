import assert from 'node:assert/strict'
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
	createReleaseId,
	DEFAULT_CONFIG_PATH,
	DEFAULT_CONSTRAINTS_PATH,
	main,
	parseArgs,
	parseDotEnv,
	PRODUCTION_CONFIG_PATH,
	PRODUCTION_CONSTRAINTS_PATH,
	remoteHelperContractSource,
	shellQuote,
	TOOL_ROOT,
	validateRuntimeConstraints,
	validateSourceArtifact
} from '../backend/backend-release.mjs'
import {
	buildEnvironmentAudit,
	ENV_RUNNER_KEYS,
	inspectEnvironmentText,
	parseRemoteEnvironmentAudit,
	renderEnvironmentAudit
} from '../backend/env-audit.mjs'

const VALID_CONSTRAINTS = [
	'alembic==1.16.5',
	'fastapi==0.116.1',
	'httpx==0.28.1',
	'passlib==1.7.4',
	'psycopg==3.2.9',
	'pydantic==2.11.7',
	'pydantic-settings==2.10.1',
	'python-dotenv==1.1.1',
	'sqlalchemy==2.0.43',
	'uvicorn==0.35.0'
]

function writeConstraints(path, lines = VALID_CONSTRAINTS) {
	writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

function createBackendArtifact() {
	const root = mkdtempSync(join(tmpdir(), 'loumai-backend-release-test-'))
	for (const directory of ['app', 'alembic/versions', 'scripts']) {
		mkdirSync(join(root, directory), { recursive: true })
	}
	writeFileSync(join(root, 'app/main.py'), 'app = object()\n', 'utf8')
	writeFileSync(join(root, 'alembic/env.py'), '# alembic env\n', 'utf8')
	writeFileSync(join(root, 'alembic.ini'), '[alembic]\nscript_location=alembic\n', 'utf8')
	writeFileSync(join(root, 'pyproject.toml'), '[project]\nname="fixture"\nversion="1.0.0"\n', 'utf8')
	writeFileSync(join(root, 'scripts/run_alembic_upgrade.py'), '# upgrade\n', 'utf8')
	writeFileSync(join(root, 'scripts/verify_database_schema.py'), '# verify\n', 'utf8')
	writeConstraints(join(root, 'runtime-constraints.txt'))
	for (let index = 0; index < 25; index += 1) {
		writeFileSync(join(root, 'app', `module_${index}.py`), `VALUE = ${index}\n`, 'utf8')
	}
	writeFileSync(
		join(root, 'release.json'),
		`${JSON.stringify({
			release_id: '20260810T123456Z-0123456789',
			commit: 'a'.repeat(40),
			artifact_db_head: '20260810_0072'
		})}\n`,
		'utf8'
	)
	return root
}

test('部署配置按 dotenv 文本解析，不执行 shell 表达式', () => {
	assert.deepEqual(
		parseDotEnv([
			'# comment',
			'BACKEND_REPO=/workspace/loumai-ai',
			'export BACKEND_EXPECTED_BRANCH="master"',
			"BACKEND_REMOTE_USE_SUDO='true'",
			'BACKEND_DEPLOY_TARGET=$(touch /tmp/never-execute)'
		].join('\n')),
		{
			BACKEND_REPO: '/workspace/loumai-ai',
			BACKEND_EXPECTED_BRANCH: 'master',
			BACKEND_REMOTE_USE_SUDO: 'true',
			BACKEND_DEPLOY_TARGET: '$(touch /tmp/never-execute)'
		}
	)
	assert.throws(() => parseDotEnv('not a valid line'), /格式错误/)
})

test('发布参数默认保守，并要求回滚数据库兼容确认', () => {
	assert.deepEqual(parseArgs(['deploy', '--dry-run']), {
		ackDbSchemaCompatible: false,
		all: false,
		command: 'deploy',
		configPath: DEFAULT_CONFIG_PATH,
		databaseProfile: '',
		dryRun: true,
		environment: 'test',
		help: false,
		releaseId: '',
		skipTests: false,
		yes: false
	})
	assert.equal(
		parseArgs(['rollback', '--release', '20260810T123456Z-0123456789']).releaseId,
		'20260810T123456Z-0123456789'
	)
	assert.throws(() => parseArgs(['deploy', '--config']), /缺少文件路径/)
	assert.throws(() => parseArgs(['rollback', '--release', '--yes']), /缺少 release_id/)
	assert.throws(() => parseArgs(['deploy', '--unknown']), /未知参数/)
	assert.throws(() => main(['deploy', '--yes', '--skip-tests']), /deploy 禁止 --skip-tests/)
	assert.throws(() => main(['deploy-cloud', '--yes', '--skip-tests']), /deploy-cloud 禁止 --skip-tests/)
	assert.throws(() => main(['bootstrap', '--env', 'production', '--yes', '--skip-tests']), /bootstrap 禁止 --skip-tests/)
	assert.throws(() => main(['bootstrap', '--env', 'test', '--dry-run']), /bootstrap 只用于全新正式服/)
	assert.throws(() => main(['deploy']), /必须显式提供 --yes/)
	assert.throws(() => main(['deploy-cloud']), /必须显式提供 --yes/)
	assert.equal(parseArgs(['deploy-cloud', '--dry-run']).command, 'deploy-cloud')
	assert.equal(parseArgs(['status', '--database-profile', 'cloud']).databaseProfile, 'cloud')
	assert.throws(() => parseArgs(['status', '--database-profile', 'invalid']), /数据库 profile 非法/)
	assert.throws(() => main(['deploy', '--database-profile', 'cloud', '--yes']), /只能用于 status/)
	assert.throws(() => main(['rollback', '--release', '20260810T123456Z-0123456789', '--yes']), /ack-db-schema-compatible/)
	assert.deepEqual(parseArgs(['env-audit', '--env', 'test', '--all']), {
		ackDbSchemaCompatible: false,
		all: true,
		command: 'env-audit',
		configPath: DEFAULT_CONFIG_PATH,
		databaseProfile: '',
		dryRun: false,
		environment: 'test',
		help: false,
		releaseId: '',
		skipTests: false,
		yes: false
	})
	assert.throws(() => parseArgs(['env-audit', '--env']), /缺少环境名称/)
	assert.equal(parseArgs(['status', '--env', 'production']).configPath, PRODUCTION_CONFIG_PATH)
	assert.equal(parseArgs(['bootstrap', '--env', 'production']).configPath, PRODUCTION_CONFIG_PATH)
	assert.equal(
		parseArgs(['status', '--env', 'production', '--config', 'config/custom.env']).configPath,
		join(TOOL_ROOT, 'config/custom.env')
	)
	assert.throws(() => parseArgs(['status', '--env', 'staging']), /不支持的部署环境/)
	assert.throws(() => main(['env-audit', '--yes']), /只读命令/)
})

test('状态查询兼容旧 helper 且不会伪造数据库 profile', () => {
	const source = readFileSync(join(TOOL_ROOT, 'backend/backend-release.mjs'), 'utf8')
	assert.match(source, /function showRemoteStatus\(config, databaseProfile = 'active'\)/)
	assert.match(source, /version === '1' && databaseProfile === 'active'/)
	assert.match(source, /remoteHelper\(config, \['status'\]\)/)
	assert.match(source, /版本 1 不支持查询 \$\{databaseProfile\} 数据库 profile/)
})

test('本地与远端发布命令强制禁用交互式分页器', () => {
	const localSource = readFileSync(join(TOOL_ROOT, 'backend/backend-release.mjs'), 'utf8')
	const remoteSource = remoteHelperContractSource()

	assert.match(localSource, /GIT_PAGER: 'cat'/)
	assert.match(localSource, /PAGER: 'cat'/)
	assert.match(localSource, /SYSTEMD_PAGER: 'cat'/)
	assert.match(localSource, /\['--no-pager', 'diff', '--check'\]/)
	assert.match(remoteSource, /export GIT_PAGER=cat PAGER=cat SYSTEMD_PAGER=cat SYSTEMD_COLORS=0/)
})

test('环境审计详细说明本地与测试服差异，但永不输出敏感值', () => {
	const secretCanary = 'secret-canary-must-never-appear'
	const local = inspectEnvironmentText([
		'APP_ENVIRONMENT=development',
		`JWT_SECRET_KEY=${secretCanary}`,
		'VIDEO_TRANSCODE_ENABLED=true',
		'VIDEO_TRANSCODE_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg',
		'TIANDITU_WEB_SERVICE_KEY=local-map-secret'
	].join('\n'))
	const remote = parseRemoteEnvironmentAudit([
		'ENV_AUDIT_PROTOCOL=1',
		'ENV_FILE_COUNT=2',
		'ENV_TARGET_MATCH=1',
		'ENV_SETTINGS_VALID=1',
		`ENV_KEY\tAPP_ENVIRONMENT\tSET\tPUBLIC\t${Buffer.from('test').toString('base64')}\t${Buffer.from('/etc/loumai/backend.env:1').toString('base64')}`,
		`ENV_KEY\tJWT_SECRET_KEY\tSET\tHIDDEN\t-\t${Buffer.from('/etc/loumai/backend.env:2').toString('base64')}`,
		`ENV_KEY\tVIDEO_TRANSCODE_ENABLED\tSET\tPUBLIC\t${Buffer.from('false').toString('base64')}\t${Buffer.from('/etc/loumai/backend.env:3').toString('base64')}`,
		`ENV_KEY\tTIANDITU_WEB_SERVICE_KEY\tEMPTY\tHIDDEN\t-\t${Buffer.from('/etc/loumai/backend.env:4').toString('base64')}`
	].join('\n'))
	const audit = buildEnvironmentAudit({
		all: true,
		catalogKeys: [
			'APP_ENVIRONMENT',
			'JWT_SECRET_KEY',
			'TIANDITU_WEB_SERVICE_KEY',
			'VIDEO_TRANSCODE_ENABLED',
			'VIDEO_TRANSCODE_FFMPEG_PATH'
		],
		local,
		localSettings: { errors: [], valid: true },
		remote,
		targetEnvironment: 'test'
	})
	const report = renderEnvironmentAudit(audit)
	assert.match(report, /VIDEO_TRANSCODE_ENABLED/)
	assert.match(report, /本地：已配置（值："true"）/)
	assert.match(report, /测试服：已配置（值："false"）/)
	assert.match(report, /功能行为可能不一致/)
	assert.match(report, /来源 \.env:3/)
	assert.match(report, /来源 \/etc\/loumai\/backend\.env:3/)
	assert.match(report, /VIDEO_TRANSCODE_FFMPEG_PATH/)
	assert.match(report, /测试服：未定义/)
	assert.match(report, /TIANDITU_WEB_SERVICE_KEY/)
	assert.match(report, /测试服：已配置，但值为空/)
	assert.match(report, /JWT_SECRET_KEY/)
	assert.match(report, /敏感值已隐藏/)
	assert.doesNotMatch(report, new RegExp(secretCanary))
	assert.doesNotMatch(report, /local-map-secret/)
})

test('环境审计协议拒绝越权公开密钥、重复记录和非法状态', () => {
	const headers = [
		'ENV_AUDIT_PROTOCOL=1',
		'ENV_FILE_COUNT=2',
		'ENV_TARGET_MATCH=1',
		'ENV_SETTINGS_VALID=1'
	]
	assert.throws(
		() => parseRemoteEnvironmentAudit([
			...headers,
			`ENV_KEY\tJWT_SECRET_KEY\tSET\tPUBLIC\t${Buffer.from('leak').toString('base64')}\t${Buffer.from('/etc/loumai/backend.env:1').toString('base64')}`
		].join('\n')),
		/公开非白名单变量/
	)
	assert.throws(
		() => parseRemoteEnvironmentAudit([
			...headers,
			`ENV_KEY\tVIDEO_TRANSCODE_ENABLED\tSET\tPUBLIC\tdHJ1ZQ==\t${Buffer.from('/etc/loumai/backend.env:1').toString('base64')}`,
			`ENV_KEY\tVIDEO_TRANSCODE_ENABLED\tSET\tPUBLIC\tdHJ1ZQ==\t${Buffer.from('/etc/loumai/backend.env:2').toString('base64')}`
		].join('\n')),
		/重复返回变量/
	)
	assert.throws(
		() => parseRemoteEnvironmentAudit([
			...headers,
			`ENV_KEY\tVIDEO_TRANSCODE_ENABLED\tUNKNOWN\tHIDDEN\t-\t${Buffer.from('/etc/loumai/backend.env:1').toString('base64')}`
		].join('\n')),
		/状态非法/
	)
})

test('环境文件审计发现重复变量，且不执行其中的 shell 表达式', () => {
	const inspected = inspectEnvironmentText([
		'VIDEO_TRANSCODE_ENABLED=true',
		'VIDEO_TRANSCODE_ENABLED=false',
		'DATABASE_URL=$(id)'
	].join('\n'), '.env')
	assert.deepEqual(inspected.duplicates, [{
		key: 'VIDEO_TRANSCODE_ENABLED',
		locations: ['.env:1', '.env:2']
	}])
	assert.equal(inspected.entries.get('DATABASE_URL').value, '$(id)')
})

test('远端环境审计只豁免活动数据库 profile 的两项精确覆盖', () => {
	const helper = remoteHelperContractSource()
	const scriptMatch = helper.match(
		/\/usr\/bin\/python3 - "\$SELECTED_DATABASE_ENV" "\$\{ENV_FILES\[@\]\}" <<'PY'\n([\s\S]*?)\nPY/
	)
	assert.ok(scriptMatch, '应能提取远端 env 审计脚本')
	const root = mkdtempSync(join(tmpdir(), 'loumai-env-profile-audit-'))
	try {
		const basePath = join(root, 'backend.env')
		const profilePath = join(root, 'local.env')
		writeFileSync(basePath, [
			'APP_ENVIRONMENT=test',
			'DATABASE_URL=postgresql://base',
			'MIGRATION_DATABASE_URL=postgresql://base-migration'
		].join('\n'))
		writeFileSync(profilePath, [
			'LOUMAI_DATABASE_PROFILE=local',
			'LOUMAI_DATABASE_NAME=loumai_test_server',
			'DATABASE_URL=postgresql://profile',
			'MIGRATION_DATABASE_URL=postgresql://profile-migration'
		].join('\n'))
		const allowed = spawnSync('/usr/bin/python3', ['-', profilePath, basePath, profilePath], {
			encoding: 'utf8',
			input: scriptMatch[1]
		})
		assert.equal(allowed.status, 0, allowed.stderr)
		assert.doesNotMatch(allowed.stdout, /^ENV_DUPLICATE\t/m)

		writeFileSync(basePath, [
			'APP_ENVIRONMENT=test',
			'DATABASE_URL=postgresql://base-one',
			'DATABASE_URL=postgresql://base-two',
			'MIGRATION_DATABASE_URL=postgresql://base-migration',
			'VIDEO_TRANSCODE_ENABLED=true'
		].join('\n'))
		writeFileSync(profilePath, [
			'LOUMAI_DATABASE_PROFILE=local',
			'LOUMAI_DATABASE_NAME=loumai_test_server',
			'DATABASE_URL=postgresql://profile',
			'MIGRATION_DATABASE_URL=postgresql://profile-migration',
			'VIDEO_TRANSCODE_ENABLED=false'
		].join('\n'))
		const blocked = spawnSync('/usr/bin/python3', ['-', profilePath, basePath, profilePath], {
			encoding: 'utf8',
			input: scriptMatch[1]
		})
		assert.equal(blocked.status, 0, blocked.stderr)
		assert.match(blocked.stdout, /^ENV_DUPLICATE\tDATABASE_URL\t/m)
		assert.match(blocked.stdout, /^ENV_DUPLICATE\tVIDEO_TRANSCODE_ENABLED\t/m)
		assert.doesNotMatch(blocked.stdout, /^ENV_DUPLICATE\tMIGRATION_DATABASE_URL\t/m)
	} finally {
		rmSync(root, { force: true, recursive: true })
	}
})

test('release id、shell 引用和默认路径保持确定', () => {
	assert.equal(
		createReleaseId('0123456789', new Date('2026-08-10T12:34:56.000Z')),
		'20260810T123456Z-0123456789'
	)
	assert.equal(shellQuote("a'b"), `'a'"'"'b'`)
	assert.equal(DEFAULT_CONFIG_PATH, join(TOOL_ROOT, 'config/backend.test.local.env'))
	assert.equal(DEFAULT_CONSTRAINTS_PATH, join(TOOL_ROOT, 'backend/runtime-constraints.test.txt'))
	assert.equal(
		PRODUCTION_CONSTRAINTS_PATH,
		join(TOOL_ROOT, 'backend/runtime-constraints.production.txt')
	)
	assert.deepEqual(
		validateRuntimeConstraints(PRODUCTION_CONSTRAINTS_PATH),
		validateRuntimeConstraints(DEFAULT_CONSTRAINTS_PATH)
	)
})

test('运行时依赖必须逐项精确锁版本，且不能重复或引用 URL', () => {
	const root = mkdtempSync(join(tmpdir(), 'loumai-backend-constraints-test-'))
	try {
		const validPath = join(root, 'valid.txt')
		writeConstraints(validPath)
		assert.deepEqual(validateRuntimeConstraints(validPath), VALID_CONSTRAINTS)

		const rangedPath = join(root, 'ranged.txt')
		writeConstraints(rangedPath, [...VALID_CONSTRAINTS.slice(0, -1), 'uvicorn>=0.35.0'])
		assert.throws(() => validateRuntimeConstraints(rangedPath), /必须精确锁版本/)

		const urlPath = join(root, 'url.txt')
		writeConstraints(urlPath, [...VALID_CONSTRAINTS.slice(0, -1), 'uvicorn @ https://example.com/pkg.whl'])
		assert.throws(() => validateRuntimeConstraints(urlPath), /禁止 URL/)

		const duplicatePath = join(root, 'duplicate.txt')
		writeConstraints(duplicatePath, [...VALID_CONSTRAINTS, 'SQLAlchemy==2.0.42'])
		assert.throws(() => validateRuntimeConstraints(duplicatePath), /重复包/)
	} finally {
		rmSync(root, { force: true, recursive: true })
	}
})

test('后端源码产物必须完整、匹配 commit/head，且不能夹带环境文件或软链接', () => {
	const artifact = createBackendArtifact()
	try {
		const result = validateSourceArtifact(artifact, {
			expectedCommit: 'a'.repeat(40),
			expectedHead: '20260810_0072'
		})
		assert.ok(result.fileCount >= 30)
		assert.throws(
			() => validateSourceArtifact(artifact, { expectedCommit: 'b'.repeat(40) }),
			/release\.json commit 不匹配/
		)

		writeFileSync(join(artifact, '.env'), 'DATABASE_URL=must-not-ship\n', 'utf8')
		assert.throws(() => validateSourceArtifact(artifact), /包含禁止内容：\.env/)
		unlinkSync(join(artifact, '.env'))

		symlinkSync(join(artifact, 'app/main.py'), join(artifact, 'app/link.py'))
		assert.throws(() => validateSourceArtifact(artifact), /包含软链接/)
	} finally {
		rmSync(artifact, { force: true, recursive: true })
	}
})

test('本地发布器从干净且已同步的精确 Git commit 打包，并避免重复执行质量门禁', () => {
	const source = readFileSync(join(TOOL_ROOT, 'backend/backend-release.mjs'), 'utf8')
	assert.match(source, /\['status', '--porcelain'\]/)
	assert.match(source, /\['rev-parse', '@\{upstream\}'\]/)
	assert.match(source, /'archive', '--format=tar'/)
	assert.match(source, /gitState\.commit/)
	assert.match(source, /scripts\/verify_migrations_in_shadow_db\.py/)
	assert.match(source, /scripts\/run_tests_in_shadow_db\.py/)
	assert.match(source, /\['bootstrap', 'deploy', 'deploy-cloud', 'recover'\]\.includes\(args\.command\)/)
	assert.match(source, /\[dry-run\] \$\{databaseProfile\} 数据库只读预检通过；未测试、未打包、未上传、未迁移、未切换/)
	assert.match(source, /args\.environment === 'production' \|\| args\.command === 'deploy-cloud'/)
	assert.match(source, /remotePreflight\(config, databaseProfile, \{ mode: operationMode \}\)/)
	assert.match(source, /目标服尚未初始化；首次正式发布必须使用 backend bootstrap/)
	assert.match(source, /BACKUP_ROOT_STATUS/)
	assert.match(source, /正式发布会在上传前自动修复为备份专用用户私有目录/)

	const deployStart = source.indexOf('function deploy(')
	const rollbackStart = source.indexOf('function rollback(', deployStart)
	assert.ok(deployStart > 0 && rollbackStart > deployStart)
	assert.doesNotMatch(source.slice(deployStart, rollbackStart), /runQualityGates/)
	assert.equal((source.match(/runQualityGates\(config/g) || []).length, 2)
})

test('后端长时间发布为 SSH 与 SCP 配置保活，避免依赖安装期间空闲断线', () => {
	const source = readFileSync(join(TOOL_ROOT, 'backend/backend-release.mjs'), 'utf8')
	assert.equal((source.match(/'ServerAliveInterval=15'/g) || []).length, 2)
	assert.equal((source.match(/'ServerAliveCountMax=12'/g) || []).length, 2)
	assert.equal((source.match(/'TCPKeepAlive=yes'/g) || []).length, 2)
})

test('服务器激活器具备 root 信任边界、验签、并发锁和原子切换', () => {
	const helper = remoteHelperContractSource()
	assert.match(helper, /^#!\/bin\/bash/)
	assert.match(helper, /set -euo pipefail/)
	assert.match(helper, /export PATH="\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"/)
	assert.match(helper, /unset BASH_ENV ENV CDPATH TAR_OPTIONS PYTHONPATH PYTHONHOME/)
	assert.match(helper, /assert_root_owned_file "\$CONFIG_FILE"/)
	assert.match(helper, /runtime 必须完全归 root 所有/)
	assert.match(helper, /uv\/Python 必须位于受控 runtime 根目录/)
	assert.match(helper, /flock -w 120/)
	assert.match(helper, /cp --no-dereference --reflink=never/)
	assert.match(helper, /sha256sum -c --strict SHA256SUMS/)
	assert.match(helper, /expected_archive/)
	assert.match(helper, /expected_checksums/)
	assert.match(helper, /backend-current 已被其他发布修改/)
	assert.match(helper, /数据库 revision 已被其他发布修改/)
	assert.match(helper, /mv -Tf -- "\$next" "\$CURRENT_LINK"/)
	assert.match(helper, /服务运行目录不是目标版本/)
	assert.match(helper, /walk_revisions\(current,target\)/)
	assert.match(helper, /SELECT to_regclass\(:table_name\) IS NOT NULL/)
	assert.match(helper, /unversioned non-empty database; refusing automatic migration/)
	assert.match(helper, /print\("base"\)/)
	assert.match(helper, /current=="base"/)
	assert.doesNotMatch(helper, /walk_revisions\(target,"base"\)/)
	assert.match(helper, /trap activation_failure EXIT/)
	assert.match(helper, /trap rollback_failure EXIT/)
	assert.doesNotMatch(helper, /trap (?:activation_failure|rollback_failure) ERR/)
	assert.doesNotMatch(helper, /chown -R "\$SERVICE_USER:\$SERVICE_USER" "\$backend"/)
	assert.match(helper, /依赖安装期间源码清单被修改/)
	assert.match(helper, /构建用户 UID 必须非 root 且与部署用户、服务用户分离/)
	assert.match(helper, /build_uid="\$\(id -u "\$BUILD_USER"\)"/)
	assert.match(helper, /构建用户 HOME 所有权错误/)
	assert.match(helper, /构建用户必须禁止交互登录/)
	assert.match(helper, /run_as_clean "\$BUILD_USER"/)
	assert.equal(
		(helper.match(/\/usr\/bin\/env -i --chdir="\$build_home"/g) || []).length,
		4,
		'所有 uv 子进程都必须从构建用户可访问的 HOME 启动',
	)
	assert.match(helper, /正式服部署用户与服务用户必须使用不同 UID/)
	assert.match(helper, /production runtime, migration and backup database users must all be different/)
	assert.match(helper, /migration credentials are intentionally excluded/)
	assert.match(helper, /production active database env contains a forbidden key/)
	assert.match(helper, /production database credentials must exist only in the root-owned database profile/)
	assert.match(helper, /revision="bootstrap"/)
	assert.match(helper, /首次发布要求所有 writer 预先停止/)
	assert.match(helper, /expected_db_revision" == "bootstrap"/)
	assert.match(helper, /enable_persistent_units/)
	assert.match(helper, /verify_persistent_units/)
	assert.match(helper, /"\$state" == "enabled"/)
	assert.match(helper, /首次发布要求所有持久 writer 预先 disabled/)
	assert.match(helper, /实际触发单元不是/)
	assert.match(helper, /正式服进程 UID 必须隔离/)
	assert.match(helper, /正式服发布用户不能属于通用提权组/)
	assert.match(helper, /validate_service_user_contract/)
	assert.match(helper, /validate_database_ca_service_contract/)
	assert.match(helper, /validate_offsite_backup_evidence/)
	assert.match(helper, /restore drill must be successful within the last 90 days/)
	assert.match(helper, /sslmode=verify-full/)
	assert.match(helper, /production connection is not using TLS/)
	assert.match(helper, /--constraint "\$backend\/runtime-constraints\.txt" \\\n\s+setuptools/)
	assert.match(helper, /def environment_string_list\(name: str\) -> list\[str\]:/)
	assert.match(helper, /allowed_hosts = environment_string_list\("BACKEND_ALLOWED_HOSTS"\)/)
	assert.match(helper, /origins = environment_string_list\("BACKEND_CORS_ORIGINS"\)/)
	assert.match(helper, /if \[\[ -n "\$main_pid" && "\$main_pid" != "0" \]\]; then/)
	assert.match(helper, /not audit\['can_temp'\] or not audit\['schema_create'\]/)
	assert.match(helper, /'rolbypassrls','can_create_db','dangerous_membership'\) if audit\[key\]/)
	assert.match(helper, /uv_cache="\$build_home\/\.cache\/uv"/)
	assert.doesNotMatch(helper, /UV_CACHE_DIR="\$build_dir\/cache"/)
	assert.match(helper, /venv --python "\$BASE_PYTHON" --seed "\$backend\/\.venv"/)
	assert.match(helper, /chmod -R a\+rX,go-w "\$backend\/\.venv"/)
	assert.match(helper, /无法执行新版本虚拟环境/)
	assert.doesNotMatch(helper, /mv -- "\$build_dir\/venv" "\$backend\/\.venv"/)
	assert.doesNotMatch(helper, /ln -sfn/)
})

test('writer 启动函数遇到中途故障立即返回失败，不继续启动后续单元', () => {
	const helper = remoteHelperContractSource()
	const services = helper.slice(
		helper.indexOf('start_services()'),
		helper.indexOf('start_timers()', helper.indexOf('start_services()')),
	)
	const timers = helper.slice(
		helper.indexOf('start_timers()'),
		helper.indexOf('assert_initial_units_stopped()', helper.indexOf('start_timers()')),
	)
	const serviceCanary = spawnSync('/bin/bash', ['-c', `
set -u
SERVICES=(should-not-start.service fail.service)
AUXILIARY_DATABASE_SERVICES=()
calls=""
systemctl() {
  calls="\${calls} \$1:\$2"
  [[ "\$2" != "fail.service" ]]
}
${services}
if start_services; then exit 91; fi
[[ "\$calls" == " start:fail.service" ]]
`], { encoding: 'utf8' })
	assert.equal(serviceCanary.status, 0, serviceCanary.stderr)

	const timerCanary = spawnSync('/bin/bash', ['-c', `
set -u
TIMERS=(ok.timer fail.timer should-not-start.timer)
calls=""
systemctl() {
  calls="\${calls} \$1:\$2"
  if [[ "\$1" == "start" && "\$2" == "fail.timer" ]]; then return 1; fi
  return 0
}
${timers}
if start_timers; then exit 92; fi
[[ "\$calls" == " start:ok.timer is-active:--quiet start:fail.timer" ]]
`], { encoding: 'utf8' })
	assert.equal(timerCanary.status, 0, timerCanary.stderr)
})

test('首次发布与持久化门禁动态拒绝 enabled-runtime', () => {
	const helper = remoteHelperContractSource()
	const initial = helper.slice(
		helper.indexOf('assert_initial_units_stopped()'),
		helper.indexOf('enable_persistent_units()', helper.indexOf('assert_initial_units_stopped()')),
	)
	const disable = helper.slice(
		helper.indexOf('disable_persistent_units()'),
		helper.indexOf('verify_persistent_units()', helper.indexOf('disable_persistent_units()')),
	)
	const verify = helper.slice(
		helper.indexOf('verify_persistent_units()'),
		helper.indexOf('stop_all_units()', helper.indexOf('verify_persistent_units()')),
	)
	const canary = spawnSync('/bin/bash', ['-c', `
SERVICES=(loumai-api.service)
AUXILIARY_DATABASE_SERVICES=()
ONESHOT_SERVICES=()
TIMERS=()
fail() { exit 1; }
systemctl() {
  case "\$1" in
    is-active) return 1 ;;
    is-enabled) printf 'enabled-runtime\\n'; return 0 ;;
    disable) return 0 ;;
  esac
  return 1
}
${initial}
${disable}
${verify}
if ( assert_initial_units_stopped ); then exit 93; fi
if disable_persistent_units; then exit 94; fi
if ( verify_persistent_units ); then exit 95; fi
`], { encoding: 'utf8' })
	assert.equal(canary.status, 0, canary.stderr)
})

test('runtime 与 migration 运行器动态隔离 DDL URL 和系统 UID', () => {
	const helper = remoteHelperContractSource()
	const runnerSource = helper.slice(
		helper.indexOf('clear_runner_environment()'),
		helper.indexOf('db_revision_for_release()', helper.indexOf('clear_runner_environment()')),
	).replaceAll('/usr/sbin/runuser', 'capture_runuser')
	const canary = spawnSync('/bin/bash', ['-c', `
SERVICE_USER=loumai-api
MIGRATION_USER=loumai-migrate
load_app_environment() {
  export DATABASE_URL='postgresql://runtime'
  export MIGRATION_DATABASE_URL='postgresql://ddl'
  export APP_SECRET='runtime-secret'
}
getent() { printf 'user:x:1000:1000::/tmp:/usr/sbin/nologin\\n'; }
capture_runuser() {
  printf '%s|%s|%s\\n' "\$2" "\${DATABASE_URL:-missing}" "\${MIGRATION_DATABASE_URL-unset}"
}
${runnerSource}
runtime="\$(run_in_release /tmp /bin/true)"
migration="\$(run_migration_in_release /tmp /bin/true)"
[[ "\$runtime" == 'loumai-api|postgresql://runtime|unset' ]]
[[ "\$migration" == 'loumai-migrate|postgresql://ddl|unset' ]]
`], { encoding: 'utf8' })
	assert.equal(canary.status, 0, canary.stderr)
})

test('正式服 Redis 接受私网 TLS，且本地 TLS 必须显式批准', async (t) => {
	const helper = remoteHelperContractSource()
	const marker = `/usr/bin/python3 - "$PUBLIC_HEALTH_URL" "$LOCAL_REDIS_APPROVED" <<'PY'\n`
	const start = helper.indexOf(marker)
	const end = helper.indexOf('\nPY\n)', start)
	assert.ok(start > 0 && end > start)
	const policy = helper.slice(start + marker.length, end)
	const baseEnvironment = {
		PATH: process.env.PATH,
		BACKEND_ALLOWED_HOSTS: 'api.yinlizhangyu.com',
		BACKEND_CORS_ORIGINS: 'https://gongweiyoufang.yinlizhangyu.com',
		DATABASE_URL: 'postgresql://runtime@172.27.0.3/loumai_production',
		MIGRATION_DATABASE_URL: 'postgresql://migrate@172.27.0.3/loumai_production',
		BACKUP_DATABASE_URL: 'postgresql://backup@172.27.0.3/loumai_production',
	}
	const runPolicy = (redisUrl, localApproved = 'false') => spawnSync('/usr/bin/python3', [
		'-',
		'https://api.yinlizhangyu.com/health',
		localApproved,
	], {
		encoding: 'utf8',
		env: { ...baseEnvironment, REDIS_URL: redisUrl },
		input: policy,
	})

	assert.equal(runPolicy('rediss://:secret@172.27.0.9:6379/0').status, 0)
	assert.notEqual(runPolicy('rediss://:secret@127.0.0.1:6379/0').status, 0)
	assert.equal(runPolicy('rediss://:secret@127.0.0.1:6379/0', 'true').status, 0)
	for (const redisUrl of [
		'redis://:secret@172.27.0.9:6379/0',
		'rediss://:secret@1.1.1.1:6379/0',
		'rediss://:secret@redis.example.com:6379/0',
	]) {
		await t.test(redisUrl, () => {
			const result = runPolicy(redisUrl)
			assert.notEqual(result.status, 0)
			assert.match(result.stderr, /private VPC rediss endpoint/)
		})
	}
})

test('正式资源录入工具不回显密钥并原子更新待激活配置', () => {
	const installerPath = join(
		TOOL_ROOT,
		'backend/remote/loumai-production-resources-install',
	)
	const installer = readFileSync(installerPath, 'utf8')
	const syntax = spawnSync('/bin/bash', ['-n', installerPath], { encoding: 'utf8' })
	assert.equal(syntax.status, 0, syntax.stderr)
	assert.doesNotMatch(installer, /set -x|printf[^\n]*(?:REDIS_AUTH|COS_SECRET_KEY)/)
	assert.match(installer, /read -r -s -p 'Redis 鉴权串/)
	assert.match(installer, /read -r -s -p 'COS CAM SecretKey/)
	assert.match(installer, /ssl_cert_reqs=required/)
	assert.match(installer, /ssl_check_hostname=True/)
	assert.match(installer, /ipaddress\.ip_network\("172\.27\.0\.0\/16"\)/)
	assert.match(installer, /--cos-only/)
	assert.match(installer, /existing_redis\.hostname != "127\.0\.0\.1"/)
	assert.match(installer, /os\.replace\(temporary, path\)/)
	assert.match(installer, /os\.chmod\(temporary, 0o600\)/)
})

test('正式服本地 Redis 安装器强制 TLS、回环监听、持久化与随机凭据', () => {
	const installerPath = join(TOOL_ROOT, 'backend/remote/loumai-local-redis-install')
	const installer = readFileSync(installerPath, 'utf8')
	const syntax = spawnSync('/bin/bash', ['-n', installerPath], { encoding: 'utf8' })
	assert.equal(syntax.status, 0, syntax.stderr)
	assert.doesNotMatch(installer, /set -x|requirepass|redis:\/\/127\.0\.0\.1/)
	assert.match(installer, /bind 127\.0\.0\.1/)
	assert.match(installer, /port 0/)
	assert.match(installer, /tls-port 6379/)
	assert.match(installer, /tls-protocols "TLSv1\.2 TLSv1\.3"/)
	assert.match(installer, /appendonly yes/)
	assert.match(installer, /appendfsync everysec/)
	assert.match(installer, /maxmemory 512mb/)
	assert.match(installer, /maxmemory-policy noeviction/)
	assert.match(installer, /openssl rand -base64 48/)
	assert.match(installer, /user default off/)
	assert.match(installer, /rediss:\/\/loumai:/)
	assert.match(installer, /ssl_cert_reqs=required/)
	assert.match(installer, /ssl_check_hostname=True/)
	assert.match(installer, /os\.replace\(temporary, path\)/)
})

test('迁移发布先停写与备份，迁移后故障保持服务停止且不自动回滚数据库', () => {
	const helper = remoteHelperContractSource()
	const activateStart = helper.indexOf('action_activate()')
	const rollbackStart = helper.indexOf('action_rollback()', activateStart)
	assert.ok(activateStart > 0 && rollbackStart > activateStart)
	const activate = helper.slice(activateStart, rollbackStart)
	const happyPath = activate.slice(activate.indexOf('trap activation_failure'))
	const orderedCalls = [
		'stop_writers',
		'switch_active_database_profile',
		'create_database_backup "$release_id"',
		'ACTIVATION_MIGRATION_ATTEMPTED=1',
		'run_migrations "$backend"',
		'switch_current "$backend"',
		'start_services',
		'wait_for_health',
		'verify_service_release "$backend"',
		'start_timers'
	]
	let cursor = -1
	for (const call of orderedCalls) {
		const next = happyPath.indexOf(call, cursor + 1)
		assert.ok(next > cursor, `${call} 应在发布主路径中按安全顺序出现`)
		cursor = next
	}
	assert.match(helper, /pg_dump -Fc --no-owner --no-acl/)
	assert.match(helper, /pg_restore --list/)
	assert.match(helper, /backup_root_status\(\)/)
	assert.match(helper, /prepare_backup_root\(\)/)
	assert.match(helper, /chown "\$BACKUP_USER:\$backup_group" "\$BACKUP_ROOT"/)
	assert.match(helper, /chmod 0700 "\$BACKUP_ROOT"/)
	assert.match(helper, /run_as_clean "\$BACKUP_USER" \/usr\/bin\/mktemp "\$BACKUP_ROOT\/\.write-check\.XXXXXX"/)
	assert.match(helper, /BACKUP_ROOT_STATUS=%s/)
	assert.match(helper, /数据库备份目录尚未准备完成/)
	const prepareStart = helper.indexOf('action_prepare()')
	const abortStart = helper.indexOf('action_abort()', prepareStart)
	const prepare = helper.slice(prepareStart, abortStart)
	assert.ok(prepare.indexOf('prepare_backup_root') < prepare.indexOf('install -d -m 0700'))
	assert.match(helper, /verify_database_schema\.py/)
	assert.match(helper, /application and migration database targets differ/)
	assert.match(helper, /is not the configured local PostgreSQL target/)
	assert.match(helper, /is not the configured TencentDB PostgreSQL target/)
	assert.match(helper, /forbidden connection-routing query parameters/)
	assert.match(helper, /inet_server_addr\(\)::text, inet_server_port\(\)/)
	assert.match(helper, /configured_port = url\.port or 5432/)
	assert.match(helper, /configured_host != cloud_host/)
	assert.match(helper, /ip_address\(normalized_address\)\.is_loopback/)
	assert.doesNotMatch(helper, /normalized_address != cloud_host/)
	assert.match(helper, /TencentDB may sit behind a proxy\/NAT endpoint/)
	assert.match(helper, /PGPASSFILE="\$passfile"/)
	assert.match(helper, /pg_dump -Fc --no-owner --no-acl --host "\$host"/)
	assert.match(helper, /if ! \{[\s\S]*IFS= read -r -d '' host[\s\S]*\} < "\$metadata"; then/)
	assert.doesNotMatch(helper, /while IFS= read -r -d '' host/)
	assert.match(helper, /数据库备份连接元数据读取不完整/)
	assert.match(helper, /invalid control byte in PostgreSQL backup target/)
	assert.match(helper, /LOUMAI_DATABASE_PROFILE/)
	assert.match(helper, /selected_database_env = sys\.argv\[1\]/)
	assert.match(helper, /key in \{"DATABASE_URL", "MIGRATION_DATABASE_URL"\}/)
	assert.match(helper, /len\(key_locations\) == 2/)
	assert.match(helper, /key_locations\[-1\]\.rsplit\(":"/)
	assert.match(helper, /EnvironmentFiles/)
	assert.match(helper, /服务实际数据库目标与活动 profile 不一致/)
	assert.match(helper, /\/proc\/\{pid\}\/environ/)
	assert.match(helper, /target_environment == "production" and \([\s\S]*"MIGRATION_DATABASE_URL" in environment or "BACKUP_DATABASE_URL" in environment/)
	assert.match(helper, /run_migration_in_release\(\)/)
	assert.match(helper, /unset MIGRATION_DATABASE_URL/)
	assert.match(helper, /run_migration_in_release "\$backend" "\$backend\/\.venv\/bin\/python"/)
	assert.match(helper, /EnvironmentFiles must exactly match the approved runtime-only files/)
	assert.match(helper, /禁止通过 Environment 直接注入数据库字段/)
	assert.match(helper, /run_as_clean "\$BACKUP_USER" \/usr\/bin\/env -i/)
	assert.match(helper, /tencentdb-postgresql\/\[a-z0-9-\]/)
	assert.match(helper, /run_as_clean "\$user" \/usr\/bin\/head -c 1 "\$DATABASE_CA_FILE"/)
	assert.doesNotMatch(helper, /run_as_clean "\$user" \/usr\/bin\/test -r "\$DATABASE_CA_FILE"/)
	assert.match(activate, /发布未能安全恢复；所有 writer 已确认停止且持久禁用/)
	assert.match(activate, /ACTIVATION_PARTIAL_CREATED=0/)
	assert.match(activate, /ACTIVATION_WRITERS_STOPPED=0/)
	assert.match(activate, /ACTIVATION_MIGRATION_ATTEMPTED=0/)
	assert.doesNotMatch(activate, /local migration_required=0 writers_stopped=/)
	assert.match(activate, /禁止自动 downgrade\/restore/)
	assert.doesNotMatch(helper, /alembic\s+downgrade/)
	assert.doesNotMatch(helper, /pg_restore\s+(?:--clean|--create|--dbname|-d)\b/)
	assert.match(activate, /stop_all_units && \([\s\S]*verify_service_release "\$ACTIVATION_PREVIOUS_CURRENT"/)
	assert.match(activate, /ACTIVATION_PERSISTENT_DISABLED=1\n\s+disable_persistent_units/)
	assert.match(helper, /fingerprint\)/)
	assert.match(helper, /sha256sum "\$0"/)
	assert.match(helper, /printf 'REMOTE_ROOT=%s\\n'/)
	assert.match(helper, /printf 'PUBLIC_HEALTH_URL=%s\\n'/)
	assert.match(helper, /-H "Host: \$PUBLIC_HEALTH_AUTHORITY" "\$LOCAL_HEALTH_URL"/)
	assert.ok(
		helper.indexOf('upload_tencent_cos_object(') <
			helper.indexOf('os.getenv("PROPERTY_VIDEO_DIRECT_UPLOAD_ENABLED", "false")'),
		'multipart COS upload and physical deletion must be verified even when direct upload is disabled'
	)
	assert.match(helper, /list_tencent_cos_object_versions/)
	assert.doesNotMatch(helper, /assert_tencent_cos_bucket_unversioned/)
	const statusStart = helper.indexOf('action_status()')
	const statusActivateStart = helper.indexOf('action_activate()', statusStart)
	const status = helper.slice(statusStart, statusActivateStart)
	assert.match(status, /if \[\[ "\$initialized" == "true" \]\]; then/)
	assert.match(status, /"\$current" == "\$RELEASES_ROOT\/"\*\/backend/)
	assert.match(status, /-f "\$current\/release\.json" && ! -L "\$current\/release\.json"/)
	assert.doesNotMatch(status, /if \[\[ -f "\$current\/release\.json" \]\]/)
	const localRelease = readFileSync(join(TOOL_ROOT, 'backend/backend-release.mjs'), 'utf8')
	assert.match(localRelease, /remoteHelper\(config, \['fingerprint'\]/)
	assert.match(localRelease, /远端 helper 与本地源码不一致/)
	const preflightStart = localRelease.indexOf('function remotePreflight')
	const preflightEnd = localRelease.indexOf('function showRemoteStatus', preflightStart)
	const preflightSource = localRelease.slice(preflightStart, preflightEnd)
	assert.match(preflightSource, /values\.REMOTE_ROOT !== expectedRemoteRoot/)
	assert.match(preflightSource, /values\.PUBLIC_HEALTH_URL !== `\$\{config\.publicUrl\}\/health`/)
})

test('应用回滚要求显式兼容确认，只切应用且继续验证当前数据库祖先关系', () => {
	const helper = remoteHelperContractSource()
	const rollbackStart = helper.indexOf('action_rollback()')
	const dispatchStart = helper.indexOf('case "${1:-}" in', rollbackStart)
	const rollback = helper.slice(rollbackStart, dispatchStart)
	assert.match(rollback, /ACK_DB_SCHEMA_COMPATIBLE/)
	assert.match(rollback, /assert_revision_path "\$actual_current" "\$target_head" "\$actual_db"/)
	assert.match(rollback, /switch_current "\$target"/)
	assert.match(rollback, /wait_for_health/)
	assert.match(rollback, /数据库从未被回滚/)
	assert.match(rollback, /ROLLBACK_WRITERS_STOPPED=0/)
	assert.match(rollback, /ROLLBACK_SWITCHED=0/)
	assert.match(rollback, /stop_all_units && \([\s\S]*verify_service_release "\$ROLLBACK_PREVIOUS_CURRENT"/)
	assert.doesNotMatch(rollback, /run_migrations|create_database_backup/)
})

test('运行账号仅取得序列取号权限且不能重置房源公开编号序列', () => {
	const helper = remoteHelperContractSource()
	assert.match(helper, /GRANT USAGE, SELECT ON SEQUENCES TO \{runtime\}/)
	assert.match(helper, /REVOKE UPDATE ON SEQUENCES FROM \{runtime\}/)
	assert.match(helper, /GRANT USAGE, SELECT ON SEQUENCE \{qualified\} TO \{runtime\}/)
	assert.match(helper, /REVOKE UPDATE ON SEQUENCE \{qualified\} FROM \{runtime\}/)
	assert.match(helper, /has_sequence_privilege\(current_user,c\.oid,'UPDATE'\)/)
	assert.doesNotMatch(helper, /GRANT USAGE, SELECT, UPDATE ON SEQUENCE/)
})

test('前后端分离配置模板不保存凭据内容，并声明后端仓库、远端与固定运行时', () => {
	const localTemplate = readFileSync(join(TOOL_ROOT, 'config/backend.test.example.env'), 'utf8')
	const productionLocalTemplate = readFileSync(
		join(TOOL_ROOT, 'config/backend.production.example.env'),
		'utf8'
	)
	const remoteTemplate = readFileSync(
		join(TOOL_ROOT, 'backend/remote/loumai-backend-release.env.example'),
		'utf8'
	)
	const productionRemoteTemplate = readFileSync(
		join(TOOL_ROOT, 'backend/remote/loumai-backend-release.production.env.example'),
		'utf8'
	)
	for (const template of [localTemplate, productionLocalTemplate, remoteTemplate, productionRemoteTemplate]) {
		assert.doesNotMatch(template, /(?:PASSWORD|TOKEN|PRIVATE_KEY|ACCESS_KEY)=/)
	}
	assert.match(localTemplate, /^BACKEND_ENVIRONMENT=test$/m)
	assert.match(productionLocalTemplate, /^BACKEND_ENVIRONMENT=production$/m)
	assert.match(productionLocalTemplate, /^BACKEND_PUBLIC_URL=https:\/\/api\.yinlizhangyu\.com$/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_ENVIRONMENT=test$/m)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_ENVIRONMENT=production$/m)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_DATABASE_CA_FILE=/m)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_DATABASE_CA_GROUP=loumai-db-ca$/m)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_OFFSITE_BACKUP_EVIDENCE_FILE=/m)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_BACKUP_USER=loumai-backup$/m)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_MIGRATION_USER=loumai-migrate$/m)
	assert.match(
		productionRemoteTemplate,
		/^LOUMAI_BACKEND_MONOLITHIC_SETTINGS_SECRET_SCOPE_APPROVED=false$/m,
	)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_LOCAL_REDIS_APPROVED=false$/m)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_ONESHOT_SERVICES=.*file-storage-cleanup/m)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_TIMERS=.*file-storage-cleanup\.timer/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_ONESHOT_SERVICES=.*file-storage-cleanup/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_TIMERS=.*file-storage-cleanup\.timer/m)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_AUXILIARY_DATABASE_SERVICES=""$/m)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_VIDEO_SERVICE_USER=loumai-video$/m)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_IM_SERVICE_USER=loumai-im$/m)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_JOB_SERVICE_USER=loumai-jobs$/m)
	assert.match(productionRemoteTemplate, /^LOUMAI_BACKEND_DEPLOY_USER=loumai-deploy$/m)
	const productionSudoers = readFileSync(
		join(TOOL_ROOT, 'backend/remote/production-deploy.sudoers.example'),
		'utf8'
	)
	assert.match(productionSudoers, /^loumai-deploy ALL=\(root\) NOPASSWD:/m)
	assert.match(productionSudoers, /loumai-backend-release \*/)
	assert.match(productionSudoers, /loumai-h5-release \*/)
	assert.match(localTemplate, /^BACKEND_REPO=/m)
	assert.match(localTemplate, /^BACKEND_PYTHON_BIN=/m)
	assert.match(localTemplate, /^BACKEND_RUNTIME_CONSTRAINTS=/m)
	assert.match(localTemplate, /^BACKEND_REQUIRE_UPSTREAM_MATCH=true$/m)
	assert.match(localTemplate, /^BACKEND_REMOTE_HELPER=\/usr\/local\/sbin\/loumai-backend-release$/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_CURRENT_LINK=/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_BUILD_USER=loumai-build$/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_UV_BIN=/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_BASE_PYTHON=/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_RUNTIME_ROOT=\/opt\/loumai-runtime$/m)
	assert.match(
		remoteTemplate,
		/^LOUMAI_BACKEND_SERVICES="loumai-video-worker\.service loumai-im-worker\.service loumai-api\.service"$/m
	)
	assert.match(
		remoteTemplate,
		/^LOUMAI_BACKEND_AUXILIARY_DATABASE_SERVICES="loumai-company-management\.service"$/m
	)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_VIDEO_SERVICE=loumai-video-worker\.service$/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_FFMPEG_BIN=\/opt\/loumai-runtime\/ffmpeg\/bin\/ffmpeg$/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_FFPROBE_BIN=\/opt\/loumai-runtime\/ffmpeg\/bin\/ffprobe$/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_VIDEO_TEMP_ROOT=\/var\/lib\/loumai-video\/tmp$/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_DATABASE_PROFILE_DIR=\/etc\/loumai\/database-profiles$/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_ACTIVE_DATABASE_ENV=\/etc\/loumai\/database-active\.env$/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_CLOUD_DATABASE_HOST=172\.27\.0\.3$/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_TIMERS=/m)
	assert.ok(validateRuntimeConstraints(DEFAULT_CONSTRAINTS_PATH).length >= 10)
})

test('双数据库 profile 模板不保存真实凭据，并要求所有 writer 加载活动配置', () => {
	const helper = remoteHelperContractSource()
	const localProfile = readFileSync(
		join(TOOL_ROOT, 'backend/remote/database-profile.local.env.example'),
		'utf8'
	)
	const cloudProfile = readFileSync(
		join(TOOL_ROOT, 'backend/remote/database-profile.cloud.env.example'),
		'utf8'
	)
	const productionCloudProfile = readFileSync(
		join(TOOL_ROOT, 'backend/remote/database-profile.production.cloud.env.example'),
		'utf8'
	)
	const productionActiveProfile = readFileSync(
		join(TOOL_ROOT, 'backend/remote/database-active.production.env.example'),
		'utf8'
	)
	const serviceDropIn = readFileSync(
		join(TOOL_ROOT, 'backend/remote/loumai-database-profile.conf.example'),
		'utf8'
	)
	for (const profile of [localProfile, cloudProfile]) {
		assert.match(profile, /^LOUMAI_DATABASE_PROFILE=(?:local|cloud)$/m)
		assert.match(profile, /^LOUMAI_DATABASE_NAME=/m)
		assert.match(profile, /^DATABASE_URL=postgresql\+psycopg:\/\//m)
		assert.match(profile, /^MIGRATION_DATABASE_URL=postgresql\+psycopg:\/\//m)
		assert.doesNotMatch(profile, /Zhangyu|sk-|真实密码|password123/i)
	}
	assert.match(localProfile, /@127\.0\.0\.1:5432\//)
	assert.match(cloudProfile, /@172\.27\.0\.3:5432\//)
	assert.match(productionCloudProfile, /^LOUMAI_DATABASE_PROFILE=cloud$/m)
	assert.match(productionCloudProfile, /sslmode=verify-full/)
	assert.match(productionCloudProfile, /sslrootcert=\/etc\/loumai\/certs\/tencentdb-ca\.pem/)
	assert.doesNotMatch(productionCloudProfile, /@(?:127\.|10\.|172\.|192\.168\.)/)
	assert.match(productionActiveProfile, /^DATABASE_URL=.*sslmode=verify-full/m)
	assert.doesNotMatch(productionActiveProfile, /^MIGRATION_DATABASE_URL=/m)
	assert.match(serviceDropIn, /^EnvironmentFile=\/etc\/loumai\/database-active\.env$/m)
	assert.match(helper, /for unit in "\$\{SERVICES\[@\]\}" "\$\{AUXILIARY_DATABASE_SERVICES\[@\]\}"/)
	assert.match(helper, /verify_unit_database_target\(\)/)
	assert.match(helper, /urlsplit\(raw_url\)/)
	assert.match(helper, /independent database service|\u72ec\u7acb数据库服务/)
	assert.match(helper, /DATABASE_WRITERS=verified/)
	assert.match(helper, /DATABASE_WRITERS=not_active_profile/)
	assert.ok(ENV_RUNNER_KEYS.includes('LOUMAI_DATABASE_PROFILE'))
	assert.ok(ENV_RUNNER_KEYS.includes('LOUMAI_DATABASE_NAME'))
	const unifiedEntry = readFileSync(join(TOOL_ROOT, 'loumai-deploy'), 'utf8')
	assert.match(unifiedEntry, /backend deploy --yes/)
	assert.match(unifiedEntry, /backend deploy-cloud --yes/)
})

test('正式服 systemd 合同隔离 UID、固定时区并完整纳管三个 timer', () => {
	const unit = (name) => readFileSync(join(TOOL_ROOT, `backend/remote/${name}`), 'utf8')
	const productionGuide = readFileSync(
		join(TOOL_ROOT, 'docs/production-server-deployment.md'),
		'utf8'
	)
	const api = unit('loumai-api.production.service.example')
	const video = unit('loumai-video-worker.production.service.example')
	const im = unit('loumai-im-worker.production.service.example')
	const jobs = [
		unit('loumai-app-push-dispatcher.production.service.example'),
		unit('loumai-rent-billing.production.service.example'),
		unit('loumai-file-storage-cleanup.production.service.example')
	]
	assert.match(api, /^User=loumai-api$/m)
	assert.match(video, /^User=loumai-video$/m)
	assert.match(im, /^User=loumai-im$/m)
	for (const service of jobs) assert.match(service, /^User=loumai-jobs$/m)
	assert.match(jobs[1], /^Environment=TZ=Asia\/Shanghai$/m)
	for (const service of [api, video, im, ...jobs]) {
		assert.match(service, /^SupplementaryGroups=loumai-db-ca$/m)
		assert.match(service, /^WorkingDirectory=\/srv\/loumai-backend\/backend-current$/m)
		assert.match(service, /^EnvironmentFile=\/etc\/loumai\/database-active\.env$/m)
		assert.match(service, /^ProtectProc=invisible$/m)
	}
	for (const base of ['loumai-app-push-dispatcher', 'loumai-rent-billing', 'loumai-file-storage-cleanup']) {
		const timer = unit(`${base}.production.timer.example`)
		assert.match(timer, new RegExp(`^Unit=${base.replaceAll('-', '\\-')}\\.service$`, 'm'))
		assert.match(timer, /^WantedBy=timers\.target$/m)
	}
	assert.match(productionGuide, /groupadd --system loumai-db-ca/)
	for (const user of ['loumai-api', 'loumai-video', 'loumai-im', 'loumai-jobs', 'loumai-migrate', 'loumai-backup']) {
		assert.match(productionGuide, new RegExp(`usermod --append --groups loumai-db-ca ${user}`))
	}
	assert.match(productionGuide, /install -d -m 0755 -o root -g root \/etc\/loumai/)
	assert.match(productionGuide, /install -d -m 0750 -o root -g loumai-db-ca \/etc\/loumai\/certs/)
	assert.match(productionGuide, /数据库 CA 文件设为 `root:loumai-db-ca 0640`/)
})

test('测试服 systemd 模板纳管文件存储清理并保留本地存储写权限', () => {
	const unit = (name) => readFileSync(join(TOOL_ROOT, `backend/remote/${name}`), 'utf8')
	const service = unit('loumai-file-storage-cleanup.service.example')
	const timer = unit('loumai-file-storage-cleanup.timer.example')
	assert.match(service, /^User=ubuntu$/m)
	assert.match(service, /^ExecStart=.*scripts\/run_file_storage_cleanup\.py$/m)
	assert.match(service, /^ReadWritePaths=\/srv\/loumai\/shared\/uploads$/m)
	assert.match(timer, /^Unit=loumai-file-storage-cleanup\.service$/m)
	assert.match(timer, /^Persistent=true$/m)
	assert.match(timer, /^WantedBy=timers\.target$/m)
})

test('视频转码发布合同固定 FFmpeg、单独 Worker、资源边界与无查询日志', () => {
	const helper = remoteHelperContractSource()
	const service = readFileSync(
		join(TOOL_ROOT, 'backend/remote/loumai-video-worker.service.example'),
		'utf8'
	)
	const nginx = readFileSync(
		join(TOOL_ROOT, 'backend/remote/nginx-no-media-ticket-log.conf.example'),
		'utf8'
	)

	assert.match(helper, /validate_video_runtime\(\)/)
	assert.match(helper, /VIDEO_TRANSCODE_ENABLED=true 时必须把/)
	assert.match(helper, /VIDEO_TRANSCODE_ENABLED=false 时 .* 仍在运行，必须先停止/)
	assert.match(helper, /VIDEO_TRANSCODE_ENABLED=false 时 .* 仍为开机启用，必须先 disable/)
	assert.match(helper, /systemctl is-active "\$VIDEO_SERVICE"/)
	assert.match(helper, /systemctl is-enabled "\$VIDEO_SERVICE"/)
	assert.match(helper, /ffmpeg_encoders="\$\("\$FFMPEG_BIN" -hide_banner -encoders 2>&1\)"/)
	assert.match(helper, /grep -Eq .* <<<"\$ffmpeg_encoders"/)
	assert.doesNotMatch(helper, /-encoders 2>&1\s*\\\s*\n\s*\| grep -Eq/)
	assert.match(helper, /FFmpeg 缺少 libx264 编码器/)
	assert.match(helper, /视频临时目录必须是服务用户私有目录（0700）/)
	assert.match(helper, /CPUQuotaPerSecUSec/)
	assert.match(helper, /for \(\(index=\$\{#SERVICES\[@\]\} - 1; index>=0; index--\)\)/)

	assert.match(service, /^ExecStart=\/srv\/loumai-backend\/backend-current\/\.venv\/bin\/python scripts\/run_video_transcode_worker\.py$/m)
	assert.match(service, /^ExecStartPre=\/usr\/bin\/test -x \/opt\/loumai-runtime\/ffmpeg\/bin\/ffmpeg$/m)
	assert.match(service, /^ExecStartPre=\/usr\/bin\/test -x \/opt\/loumai-runtime\/ffmpeg\/bin\/ffprobe$/m)
	assert.match(service, /^EnvironmentFile=\/etc\/loumai\/database-active\.env$/m)
	assert.match(service, /^ReadWritePaths=\/var\/lib\/loumai-video\/tmp$/m)
	assert.match(service, /^MemoryMax=1200M$/m)
	assert.match(service, /^CPUQuota=150%$/m)
	assert.match(service, /^TasksMax=96$/m)
	assert.match(service, /^ProtectSystem=strict$/m)
	assert.doesNotMatch(service, /(?:\/bin\/(?:ba)?sh|sh -c)/)

	assert.match(nginx, /\$request_method \$uri \$server_protocol/)
	assert.doesNotMatch(nginx, /\$request(?:_uri)?\b|\$args\b|\$query_string\b|\$http_referer\b/)
})
