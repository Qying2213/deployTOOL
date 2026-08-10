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
import test from 'node:test'

import {
	createReleaseId,
	DEFAULT_CONFIG_PATH,
	DEFAULT_CONSTRAINTS_PATH,
	main,
	parseArgs,
	parseDotEnv,
	remoteHelperContractSource,
	shellQuote,
	TOOL_ROOT,
	validateRuntimeConstraints,
	validateSourceArtifact
} from '../backend/backend-release.mjs'

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
		command: 'deploy',
		configPath: DEFAULT_CONFIG_PATH,
		dryRun: true,
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
	assert.throws(() => main(['deploy']), /必须显式提供 --yes/)
	assert.throws(() => main(['rollback', '--release', '20260810T123456Z-0123456789', '--yes']), /ack-db-schema-compatible/)
})

test('release id、shell 引用和默认路径保持确定', () => {
	assert.equal(
		createReleaseId('0123456789', new Date('2026-08-10T12:34:56.000Z')),
		'20260810T123456Z-0123456789'
	)
	assert.equal(shellQuote("a'b"), `'a'"'"'b'`)
	assert.equal(DEFAULT_CONFIG_PATH, join(TOOL_ROOT, 'config/backend.test.local.env'))
	assert.equal(DEFAULT_CONSTRAINTS_PATH, join(TOOL_ROOT, 'backend/runtime-constraints.test.txt'))
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
	assert.match(source, /deploy 禁止 --skip-tests/)
	assert.match(source, /\[dry-run\] 只读预检通过；未测试、未打包、未上传、未迁移、未切换/)

	const deployStart = source.indexOf('function deploy(')
	const rollbackStart = source.indexOf('function rollback(', deployStart)
	assert.ok(deployStart > 0 && rollbackStart > deployStart)
	assert.doesNotMatch(source.slice(deployStart, rollbackStart), /runQualityGates/)
	assert.equal((source.match(/runQualityGates\(config/g) || []).length, 2)
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
	assert.match(helper, /trap activation_failure EXIT/)
	assert.match(helper, /trap rollback_failure EXIT/)
	assert.doesNotMatch(helper, /trap (?:activation_failure|rollback_failure) ERR/)
	assert.doesNotMatch(helper, /chown -R "\$SERVICE_USER:\$SERVICE_USER" "\$backend"/)
	assert.match(helper, /依赖安装期间源码清单被修改/)
	assert.match(helper, /构建用户 UID 必须非 root 且与部署用户、服务用户分离/)
	assert.match(helper, /build_uid="\$\(id -u "\$BUILD_USER"\)"/)
	assert.match(helper, /构建用户 HOME 所有权错误/)
	assert.match(helper, /构建用户必须禁止交互登录/)
	assert.match(helper, /runuser -u "\$BUILD_USER"/)
	assert.match(helper, /venv --python "\$BASE_PYTHON" --seed "\$backend\/\.venv"/)
	assert.match(helper, /chmod -R a\+rX,go-w "\$backend\/\.venv"/)
	assert.match(helper, /服务用户无法执行新版本虚拟环境/)
	assert.doesNotMatch(helper, /mv -- "\$build_dir\/venv" "\$backend\/\.venv"/)
	assert.doesNotMatch(helper, /ln -sfn/)
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
		'create_database_backup "$release_id"',
		'migration_attempted=1',
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
	assert.match(helper, /verify_database_schema\.py/)
	assert.match(helper, /application and migration database targets differ/)
	assert.match(helper, /does not match the configured local backup target/)
	assert.match(helper, /forbidden connection-routing query parameters/)
	assert.match(helper, /inet_server_addr\(\)::text, inet_server_port\(\)/)
	assert.match(activate, /数据库迁移已经尝试；所有 writer 保持停止/)
	assert.match(activate, /禁止自动 downgrade\/restore/)
	assert.doesNotMatch(helper, /alembic\s+downgrade/)
	assert.doesNotMatch(helper, /pg_restore\s+(?:--clean|--create|--dbname|-d)\b/)
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
	assert.doesNotMatch(rollback, /run_migrations|create_database_backup/)
})

test('前后端分离配置模板不保存凭据内容，并声明后端仓库、远端与固定运行时', () => {
	const localTemplate = readFileSync(join(TOOL_ROOT, 'config/backend.test.example.env'), 'utf8')
	const remoteTemplate = readFileSync(
		join(TOOL_ROOT, 'backend/remote/loumai-backend-release.env.example'),
		'utf8'
	)
	for (const template of [localTemplate, remoteTemplate]) {
		assert.doesNotMatch(template, /(?:PASSWORD|TOKEN|PRIVATE_KEY|ACCESS_KEY)=/)
	}
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
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_SERVICES=/m)
	assert.match(remoteTemplate, /^LOUMAI_BACKEND_TIMERS=/m)
	assert.ok(validateRuntimeConstraints(DEFAULT_CONSTRAINTS_PATH).length >= 10)
})
