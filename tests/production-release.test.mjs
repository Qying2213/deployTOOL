import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  deployPlan, loadPackages, parseArgs, parseConfig, preflightPlan, statusPlan,
} from '../production-release.mjs'

function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'loumai-production-release-'))
  try { callback(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('正式服总入口默认保守且真实发布必须显式确认', () => {
  assert.equal(parseArgs([]).command, 'help')
  assert.throws(() => parseArgs(['deploy']), /--yes/)
  assert.equal(parseArgs(['deploy', '--yes']).yes, true)
  assert.equal(parseArgs(['deploy', '--dry-run']).dryRun, true)
  assert.throws(() => parseArgs(['preflight', '--yes']), /只用于/)
  assert.throws(() => parseArgs(['status', '--h5-file', '/tmp/h5.zip']), /不读取/)
  assert.throws(() => parseArgs(['rollback', '--yes']), /只支持/)
})

test('总入口配置只接受两个绝对正式包路径且不执行 shell 表达式', () => fixture((root) => {
  const h5 = join(root, 'h5.zip')
  const admin = join(root, 'admin.zip')
  writeFileSync(h5, 'h5')
  writeFileSync(admin, 'admin')
  const config = join(root, 'production.env')
  writeFileSync(config, `PRODUCTION_H5_PACKAGE=${h5}\nPRODUCTION_ADMIN_PACKAGE=${admin}\n`)
  assert.deepEqual(loadPackages({ config, h5File: '', adminFile: '' }), {
    h5: realpathSync(h5), admin: realpathSync(admin),
  })
  assert.throws(() => parseConfig('PRODUCTION_H5_PACKAGE=$(id)'), /shell/)
  assert.throws(() => parseConfig('PASSWORD=secret'), /禁止字段/)
  assert.throws(() => parseConfig('PRODUCTION_H5_PACKAGE=/a\nPRODUCTION_H5_PACKAGE=/b'), /重复/)
  mkdirSync(join(root, 'not-a-file.zip'))
  assert.throws(() => loadPackages({ config: '/missing', h5File: join(root, 'not-a-file.zip'), adminFile: admin }), /普通文件/)
}))

test('全量预检和正式发布顺序固定且不提供跳过门禁参数', () => {
  const packages = { h5: '/tmp/h5-production.zip', admin: '/tmp/admin-production.zip' }
  const preflight = preflightPlan(packages)
  assert.deepEqual(preflight.map((command) => command.slice(0, 2)), [
    ['backend', 'status'],
    ['backend', 'env-audit'],
    ['backend', 'deploy'],
    ['frontend', 'deploy-package'],
    ['admin', 'deploy'],
  ])
  assert.ok(preflight.every((command) => !command.includes('--yes') && !command.includes('--skip-tests')))
  assert.deepEqual(deployPlan(packages).map((command) => command.slice(0, 2)), [
    ['backend', 'deploy'],
    ['frontend', 'deploy-package'],
    ['admin', 'deploy'],
  ])
  assert.deepEqual(statusPlan().map((command) => command[0]), ['backend', 'frontend', 'admin'])
})

test('缺少确认时 CLI 在读取配置或连接服务器之前失败', () => {
  const result = spawnSync('bash', ['loumai-deploy', 'production', 'deploy'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--yes/)
  assert.doesNotMatch(result.stderr, /找不到.*ZIP|ssh|SSH/)
})

test('统一帮助和示例配置公开一条正式发布命令且不保存凭据', () => {
  const root = new URL('..', import.meta.url)
  const launcher = readFileSync(new URL('../loumai-deploy', import.meta.url), 'utf8')
  const template = readFileSync(new URL('../config/production.example.env', import.meta.url), 'utf8')
  assert.match(launcher, /production deploy --yes/)
  assert.match(template, /^PRODUCTION_H5_PACKAGE=/m)
  assert.match(template, /^PRODUCTION_ADMIN_PACKAGE=/m)
  assert.doesNotMatch(template, /PASSWORD|TOKEN|SECRET|DATABASE_URL/)
  assert.ok(root)
})
