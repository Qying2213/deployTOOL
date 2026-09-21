import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_CONFIG,
  deployPlan,
  loadPackages,
  parseArgs,
  parseConfig,
  preflightPlan,
  statusPlan,
  TOOL_ROOT,
} from '../test-release.mjs'

function withPackages(action) {
  const directory = mkdtempSync(join(tmpdir(), 'loumai-test-release-'))
  const h5 = join(directory, 'h5-test.zip')
  const admin = join(directory, 'admin-test.zip')
  writeFileSync(h5, 'h5 fixture')
  writeFileSync(admin, 'admin fixture')
  try { return action({ admin, h5 }) } finally { rmSync(directory, { force: true, recursive: true }) }
}

test('测试服总入口默认保守，真实发布必须显式确认', () => {
  assert.deepEqual(parseArgs(['deploy', '--dry-run']), {
    command: 'deploy', config: DEFAULT_CONFIG, h5File: '', adminFile: '', dryRun: true, yes: false,
  })
  assert.throws(() => parseArgs(['deploy']), /必须显式提供 --yes/)
  assert.throws(() => parseArgs(['status', '--yes']), /只用于 test deploy/)
  assert.throws(() => parseArgs(['unknown']), /test 只支持/)
})

test('测试服总入口配置只允许两个 ZIP 路径且不执行 shell', () => {
  assert.deepEqual(parseConfig([
    'TEST_H5_PACKAGE=/tmp/h5.zip',
    'TEST_ADMIN_PACKAGE=/tmp/admin.zip',
  ].join('\n')), {
    TEST_H5_PACKAGE: '/tmp/h5.zip',
    TEST_ADMIN_PACKAGE: '/tmp/admin.zip',
  })
  assert.throws(() => parseConfig('DATABASE_URL=secret'), /禁止字段/)
  assert.throws(() => parseConfig('TEST_H5_PACKAGE=$(touch /tmp/never)'), /shell 表达式/)
  assert.throws(() => parseConfig('TEST_H5_PACKAGE=/tmp/a.zip\nTEST_H5_PACKAGE=/tmp/b.zip'), /重复字段/)
})

test('两个前端包必须是本机真实 ZIP，支持配置或命令行覆盖', () => withPackages(({ admin, h5 }) => {
  const config = join(h5, '..', 'test.env')
  writeFileSync(config, `TEST_H5_PACKAGE=${h5}\nTEST_ADMIN_PACKAGE=${admin}\n`)
  const expected = { admin: realpathSync(admin), h5: realpathSync(h5) }
  assert.deepEqual(loadPackages({ config, h5File: '', adminFile: '' }), expected)
  assert.deepEqual(loadPackages({ config: '/missing', h5File: h5, adminFile: admin }), expected)
  assert.throws(
    () => loadPackages({ config: '/missing', h5File: '/tmp/missing.zip', adminFile: admin }),
    /找不到业务 H5/,
  )
}))

test('全量预检在写入前覆盖四目标，发布顺序优先两个共享数据库后端', () => {
  const packages = { h5: '/tmp/h5.zip', admin: '/tmp/admin.zip' }
  assert.deepEqual(preflightPlan(packages).map((command) => command.slice(0, 2)), [
    ['test-backend', '--dry-run-only'],
    ['admin-backend', 'deploy'],
    ['frontend', 'deploy-package'],
    ['admin-frontend', 'deploy-package'],
  ])
  assert.deepEqual(deployPlan(packages).map((command) => command.slice(0, 2)), [
    ['test-backend'],
    ['admin-backend', 'deploy'],
    ['frontend', 'deploy-package'],
    ['admin-frontend', 'deploy-package'],
  ])
  assert.deepEqual(statusPlan().map((command) => command[0]), [
    'backend', 'admin-backend', 'frontend', 'admin-frontend',
  ])
  for (const command of [...preflightPlan(packages), ...deployPlan(packages), ...statusPlan()]) {
    assert.doesNotMatch(command.join(' '), /mp-weixin|mini-program|小程序/i)
  }
})

test('统一入口公开 test 与 production 两条四目标命令', () => {
  const launcher = readFileSync(join(TOOL_ROOT, 'loumai-deploy'), 'utf8')
  const example = readFileSync(join(TOOL_ROOT, 'config/test.example.env'), 'utf8')
  assert.match(launcher, /test deploy --yes/)
  assert.match(launcher, /production deploy --yes/)
  assert.match(example, /TEST_H5_PACKAGE=/)
  assert.match(example, /TEST_ADMIN_PACKAGE=/)
  assert.doesNotMatch(example, /PASSWORD|TOKEN|SECRET|PRIVATE_KEY|ACCESS_KEY/)

  const result = spawnSync('/bin/bash', [join(TOOL_ROOT, 'loumai-deploy'), 'test', 'deploy'], {
    cwd: TOOL_ROOT,
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /必须显式提供 --yes/)
  assert.doesNotMatch(result.stderr, /找不到.*ZIP/)
})
