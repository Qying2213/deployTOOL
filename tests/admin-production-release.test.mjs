import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { commandPlan, parseArgs as combinedArgs } from '../admin-release.mjs'
import { parseArgs as backendArgs, loadConfig as backendConfig } from '../admin-backend/admin-backend-release.mjs'
import { validateProductionState } from '../admin-backend/production-release.mjs'
import { adminHelperSource, loadConfig as frontendConfig, normalizeAdminArtifact, parseArgs as frontendArgs } from '../admin-frontend/admin-frontend-release.mjs'
import { ADMIN_BACKEND_ROOT, ADMIN_FRONTEND_ROOT, productionOrigin, TOOL_ROOT } from '../admin-production.mjs'

const origin = 'https://admin.loumai.cn'
const hash = (value) => createHash('sha256').update(value).digest('hex')
function fixture(callback) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'loumai-admin-production-test-')))
  try { callback(root) } finally { rmSync(root, { recursive: true, force: true }) }
}
function frontendEnv(root, overrides = {}) {
  const key = join(root, 'key')
  writeFileSync(key, 'fake-key-not-used-for-ssh')
  return { ADMIN_FRONTEND_ENVIRONMENT: 'production', ADMIN_FRONTEND_DEPLOY_TARGET: 'loumai-deploy@production.loumai.cn',
    ADMIN_FRONTEND_SSH_IDENTITY_FILE: key, ADMIN_FRONTEND_PUBLIC_URL: origin, ...overrides }
}
function writeEnv(root, values, name = 'production.env') {
  const path = join(root, name)
  writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'))
  return path
}
function artifact(root, api) {
  const output = join(root, 'web')
  mkdirSync(join(output, 'assets'), { recursive: true })
  writeFileSync(join(output, 'index.html'), '<title>工位有方管理后台</title><script type="module" src="/assets/index-Hash123.js"></script>')
  writeFileSync(join(output, 'assets/index-Hash123.js'), `const api=${JSON.stringify(api)};`)
  for (let index = 0; index < 9; index += 1) writeFileSync(join(output, `assets/chunk-${index}.js`), `export default ${index}`)
  return output
}

test('生产后台域名拒绝占位符、测试服、明文、IP、凭据和路径', () => {
  for (const value of ['https://admin.example.com', 'https://admin-test.yinlizhangyu.com', 'http://admin.loumai.cn',
    'https://127.0.0.1', 'https://10.0.0.2', 'https://admin.loumai.cn/path', 'https://user:password@admin.loumai.cn']) {
    assert.throws(() => productionOrigin(value))
  }
  assert.equal(productionOrigin(origin), origin)
})

test('前后端 production 自动选择独立配置且禁止跳过测试和无确认变更', () => {
  assert.match(backendArgs(['status', '--env', 'production']).config, /admin-backend.production.local.env$/)
  assert.match(frontendArgs(['status', '--env', 'production']).config, /admin-frontend.production.local.env$/)
  for (const argv of [['deploy', '--env', 'production'], ['deploy', '--env', 'production', '--yes', '--skip-tests'],
    ['rollback', '--env', 'production', '--release', '20260828T120000Z-0123456789', '--yes']]) assert.throws(() => backendArgs(argv))
  assert.throws(() => backendArgs(['status', '--env', '--yes']), /缺少/)
  assert.throws(() => frontendArgs(['prepare', '--env', 'production']), /--yes/)
})

test('正式前端配置绑定隔离 helper/目录，缺失时不回落到测试服', () => fixture((root) => {
  const values = frontendEnv(root)
  const config = frontendConfig(writeEnv(root, values), 'production')
  assert.equal(config.environment, 'production')
  assert.equal(config.publicUrl, origin)
  assert.equal(config.remoteStagingRoot, `${ADMIN_FRONTEND_ROOT}/incoming`)
  assert.match(config.remoteHelper, /admin-frontend-production-release$/)
  assert.equal(config.remoteHelperFingerprint, hash(adminHelperSource('production')))
  assert.throws(() => frontendConfig(join(root, 'missing'), 'production'), /缺少/)
  for (const overrides of [{ ADMIN_FRONTEND_ENVIRONMENT: 'test' }, { ADMIN_FRONTEND_DEPLOY_TARGET: 'ubuntu@production.loumai.cn' },
    { ADMIN_FRONTEND_DEPLOY_TARGET: 'loumai-deploy@132.232.220.115' }, { SECRET_KEY: 'not-real' },
    { ADMIN_FRONTEND_PUBLIC_URL: 'https://test.yinlizhangyu.com' }]) {
    assert.throws(() => frontendConfig(writeEnv(root, { ...values, ...overrides }), 'production'))
  }
}))

test('正式后台配置强制 Git 源码、明确分支、独立目标和管理 API 前缀', () => fixture((root) => {
  const source = join(root, 'repo')
  mkdirSync(join(source, '.git'), { recursive: true }); mkdirSync(join(source, 'app'))
  writeFileSync(join(source, 'app/main.py'), '')
  writeFileSync(join(root, 'python'), '')
  const frontend = frontendEnv(root)
  const values = { ADMIN_BACKEND_ENVIRONMENT: 'production', ADMIN_BACKEND_REPO: source,
    ADMIN_BACKEND_PYTHON_BIN: join(root, 'python'), ADMIN_BACKEND_EXPECTED_BRANCH: 'master',
    ADMIN_BACKEND_DEPLOY_TARGET: frontend.ADMIN_FRONTEND_DEPLOY_TARGET,
    ADMIN_BACKEND_SSH_IDENTITY_FILE: frontend.ADMIN_FRONTEND_SSH_IDENTITY_FILE,
    ADMIN_BACKEND_PUBLIC_URL: `${origin}/admin-api` }
  const config = backendConfig(writeEnv(root, values), 'production')
  assert.equal(config.origin, origin)
  assert.equal(config.root, ADMIN_BACKEND_ROOT)
  assert.match(config.constraints, /runtime-constraints.production.txt$/)
  assert.throws(() => backendConfig(writeEnv(root, { ...values, ADMIN_BACKEND_EXPECTED_BRANCH: '' }), 'production'))
  assert.throws(() => backendConfig(writeEnv(root, { ...values, DATABASE_URL: 'not-real' }), 'production'))
}))

test('正式包只接受同源或指定正式 API，拒绝自动转换测试包', () => {
  for (const api of ['/admin-api/api/v1', `${origin}/admin-api/api/v1`]) fixture((root) => {
    const output = artifact(root, api)
    normalizeAdminArtifact(output, { environment: 'production', publicUrl: origin })
    assert.match(readFileSync(join(output, 'assets/index-Hash123.js'), 'utf8'), /"\/admin-api\/api\/v1"/)
  })
  for (const api of ['https://test.yinlizhangyu.com/admin-api/api/v1', 'https://admin-test.yinlizhangyu.com/admin-api/api/v1',
    'https://other.loumai.cn/admin-api/api/v1', 'http://127.0.0.1:8100/api/v1']) fixture((root) => {
    assert.throws(() => normalizeAdminArtifact(artifact(root, api), { environment: 'production', publicUrl: origin }))
  })
})

test('正式前端 helper 保留回滚并在 root 解包前验证 tar，绑定清单域名和目标', () => {
  const helper = adminHelperSource('production')
  const syntax = spawnSync('bash', ['-n'], { input: helper, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
  assert.match(helper, /admin-frontend-production-release.env/)
  assert.match(helper, /"\$DEPLOY_USER" == "loumai-deploy"/)
  assert.ok(helper.indexOf('ADMIN_TAR_CHECK') < helper.indexOf('tar --extract --file'))
  assert.match(helper, /unsafe admin archive member/)
  assert.match(helper, /data.get\("public_url"\)/)
  assert.match(helper, /data.get\("target"\) != "admin-frontend"/)
  assert.match(helper, /arm_current_rollback/)
})

test('远端状态必须匹配 production/域名/目录/cloud，不能混用测试服', () => {
  const config = { root: ADMIN_BACKEND_ROOT, publicUrl: `${origin}/admin-api` }
  const state = `ENVIRONMENT=production\nREMOTE_ROOT=${config.root}\nPUBLIC_URL=${config.publicUrl}\nDATABASE_PROFILE=cloud\nCURRENT=NONE`
  assert.equal(validateProductionState(state, config).CURRENT, 'NONE')
  for (const output of [state.replace('production\n', 'test\n'), state.replace('cloud', 'local'), state.replace('CURRENT=NONE', 'CURRENT=/tmp/evil')]) {
    assert.throws(() => validateProductionState(output, config), /不匹配/)
  }
})

test('一键命令先校验正式 ZIP，再后端，再前端；预演不出现 yes', () => {
  assert.throws(() => combinedArgs(['deploy', '--file', '/tmp/admin.zip', '--yes']), /显式/)
  assert.throws(() => combinedArgs(['deploy', '--env', 'production', '--yes']), /--file/)
  assert.throws(() => combinedArgs(['deploy', '--env', 'production', '--file', '/tmp/admin.zip']), /--yes/)
  const args = combinedArgs(['deploy', '--env', 'production', '--file', '/tmp/admin.zip', '--dry-run'])
  const plan = commandPlan(args)
  assert.deepEqual(plan.map((command) => command.slice(0, 2)), [['admin-frontend', 'check-package'], ['admin-backend', 'deploy'], ['admin-frontend', 'deploy-package']])
  assert.ok(plan.every((command) => !command.includes('--yes')))
})

test('正式安装仅生成本机资源，不复用测试安装器/通用 sudo', () => {
  const source = readFileSync(new URL('../admin-backend/production-release.mjs', import.meta.url), 'utf8')
  assert.match(source, /writeSetupBundle/)
  assert.doesNotMatch(source, /install-company-management-release|sudo.*python|\.install-bundle/)
  const unit = readFileSync(new URL('../admin-backend/remote/loumai-company-management.production.service.example', import.meta.url), 'utf8')
  assert.match(unit, /User=loumai-admin/)
  assert.match(unit, /SupplementaryGroups=loumai-db-ca/)
  assert.doesNotMatch(unit, /EnvironmentFile=.*(?:\/backend.env|\/sms.env|\/database-active.env)/)
  const businessHelper = readFileSync(new URL('../backend/remote/loumai-backend-release', import.meta.url), 'utf8')
  assert.match(businessHelper, /正式管理后台 writer 未纳入数据库停写栅栏/)
  assert.match(businessHelper, /expected_runtime_files=\(\/etc\/loumai\/company-management-production.env/)
})

test('后台正式服务器 helper 通过隔离的 Python 行为测试', () => {
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_admin_production.py', '-v'], {
    cwd: TOOL_ROOT, encoding: 'utf8', timeout: 30000,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('缺少明确确认时联合命令不会读取配置或连接服务器', () => {
  const result = spawnSync('bash', ['loumai-deploy', 'admin', 'deploy', '--env', 'production', '--file', '/tmp/admin.zip'], { cwd: TOOL_ROOT, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--yes/)
  assert.doesNotMatch(result.stderr, /SSH|缺少 config/)
})

test('受控重启必须明确选择正式服并确认，不提供跳过检查选项', () => {
  assert.throws(() => backendArgs(['restart', '--yes']), /production/)
  assert.throws(() => backendArgs(['restart', '--env', 'production']), /--yes/)
  assert.equal(backendArgs(['restart', '--env', 'production', '--dry-run']).dryRun, true)
  assert.throws(() => backendArgs(['restart', '--env', 'production', '--yes', '--skip-tests']), /禁止/)
})

test('两端 prepare 可离线生成完整安装包，不调用 SSH 或使用真实服务器配置', () => fixture((root) => {
  const front = frontendEnv(root)
  const source = join(root, 'source')
  mkdirSync(join(source, '.git'), { recursive: true }); mkdirSync(join(source, 'app'))
  writeFileSync(join(source, 'app/main.py'), '')
  const python = join(root, 'python'); writeFileSync(python, '')
  const back = { ADMIN_BACKEND_ENVIRONMENT: 'production', ADMIN_BACKEND_REPO: source,
    ADMIN_BACKEND_PYTHON_BIN: python, ADMIN_BACKEND_EXPECTED_BRANCH: 'master',
    ADMIN_BACKEND_DEPLOY_TARGET: front.ADMIN_FRONTEND_DEPLOY_TARGET,
    ADMIN_BACKEND_SSH_IDENTITY_FILE: front.ADMIN_FRONTEND_SSH_IDENTITY_FILE, ADMIN_BACKEND_PUBLIC_URL: `${origin}/admin-api` }
  for (const [target, values, helperName, envName] of [
    ['admin-backend', back, 'loumai-company-management-production-release', 'company-management-production-release.env'],
    ['admin-frontend', front, 'loumai-admin-frontend-production-release', 'admin-frontend-production-release.env'],
  ]) {
    const path = writeEnv(root, values, `${target}.env`)
    const result = spawnSync('bash', ['loumai-deploy', target, 'prepare', '--env', 'production', '--config', path, '--yes'], {
      cwd: TOOL_ROOT, encoding: 'utf8', timeout: 10000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /没有连接服务器/)
    const bundle = result.stdout.match(/本机安装包：(.+)\n/)?.[1]
    assert.ok(bundle?.startsWith(join(TOOL_ROOT, `dist/${target}-production-setup-`)))
    try {
      assert.ok(readFileSync(join(bundle, helperName)).length > 10000)
      assert.match(readFileSync(join(bundle, envName), 'utf8'), /https:\/\/admin.loumai.cn/)
      if (target === 'admin-frontend') assert.match(readFileSync(join(bundle, 'loumai-admin-production.conf'), 'utf8'), /server_name admin.loumai.cn;/)
    } finally { rmSync(bundle, { recursive: true, force: true }) }
  }
}))
