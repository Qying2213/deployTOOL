import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { inspectTestGit, parseArgs, parseDotEnv } from '../admin-backend/admin-backend-release.mjs'

const helper = readFileSync(new URL('../admin-backend/remote/loumai-company-management-release', import.meta.url), 'utf8')
const runner = readFileSync(new URL('../admin-backend/remote/loumai-company-management-run', import.meta.url), 'utf8')
const installer = readFileSync(new URL('../admin-backend/remote/install-company-management-release', import.meta.url), 'utf8')
const localRelease = readFileSync(new URL('../admin-backend/admin-backend-release.mjs', import.meta.url), 'utf8')
const unit = readFileSync(new URL('../admin-backend/remote/loumai-company-management.service.example', import.meta.url), 'utf8')
const nginx = readFileSync(new URL('../admin-backend/remote/nginx-company-management-api.conf.example', import.meta.url), 'utf8')

test('管理后台参数默认安全且真实操作要求显式确认', () => {
  assert.equal(parseArgs(['--help']).command, 'help')
  assert.equal(parseArgs(['-h']).command, 'help')
  assert.deepEqual(parseArgs(['deploy', '--dry-run']).dryRun, true)
  assert.deepEqual(parseArgs(['deploy', '--yes']).yes, true)
  assert.throws(() => parseArgs(['rollback']), /--release/)
})

test('dotenv 解析拒绝命令替换', () => {
  assert.deepEqual(parseDotEnv('A=one\nB="two"\n'), { A: 'one', B: 'two' })
  assert.throws(() => parseDotEnv('A=$(id)'), /不安全/)
})

test('服务器 helper 使用全局锁、CAS、哈希、原子切换和失败恢复', () => {
  for (const marker of ['GLOBAL_LOCK', 'sha256sum -c', 'current 已变化', 'mv -Tf', '已恢复旧版本', 'flock -w']) {
    assert.match(helper, new RegExp(marker))
  }
  assert.doesNotMatch(helper, /alembic downgrade|git reset --hard/)
  assert.doesNotMatch(helper, /local id=.*\$id/)
  assert.doesNotMatch(helper, /local incoming=.*\$incoming/)
  assert.match(helper, /--no-config venv/)
  assert.match(helper, /--no-config pip sync/)
  assert.match(helper, /UV_CACHE_DIR=/)
  assert.match(helper, /readonly UV_CACHE="\$ROOT\/uv-cache"/)
  assert.match(helper, /0750 -o loumai-admin -g loumai-admin "\$UV_CACHE"/)
  assert.match(helper, /python -m compileall -q app/)
  assert.match(helper, /PYTHONPYCACHEPREFIX=/)
  assert.match(helper, /-name '\._\*'/)
  assert.match(helper, /-path "\$root\/\.runtime" -prune/)
  assert.doesNotMatch(helper, /import app\.main/)
  assert.match(helper, /rm -rf -- \"\$partial\" \"\$incoming\"/)
})

test('构建产物排除 macOS 元数据并禁止 tar 生成 AppleDouble 文件', () => {
  assert.match(localRelease, /entry\.name\.startsWith\('\._'\)/)
  assert.match(localRelease, /COPYFILE_DISABLE: '1'/)
})

test('测试服后台后端固定校验 test 分支、干净工作区和 upstream', () => {
  const template = readFileSync(new URL('../config/admin-backend.test.example.env', import.meta.url), 'utf8')
  assert.match(template, /^ADMIN_BACKEND_EXPECTED_BRANCH=test$/m)
  assert.equal(typeof inspectTestGit, 'function')
  assert.match(localRelease, /status', '--porcelain/)
  assert.match(localRelease, /branch', '--show-current/)
  assert.match(localRelease, /rev-parse', '@\{upstream\}/)
})

test('管理后台随活动数据库 profile 且使用独立受控运行时', () => {
  assert.match(runner, /LOUMAI_DATABASE_PROFILE/)
  assert.match(runner, /company-database-profiles/)
  assert.match(runner, /\.runtime\/venv\/bin\/python/)
  assert.match(runner, /127\.0\.0\.1/)
  assert.doesNotMatch(runner, /\[\[ -f \"\$ACTIVE_PROFILE_FILE\"/)
})

test('安装失败会恢复旧配置且本地调用不会掩盖失败', () => {
  assert.match(installer, /restore_previous_install/)
  assert.match(installer, /trap 'restore_previous_install \$\?' ERR/)
  assert.match(installer, /BACKUP=/)
  assert.match(localRelease, /else rc=\$\?; rm -rf .*; exit \$rc/)
  assert.match(localRelease, /remote\(config, \['preflight'\]\)/)
})

test('systemd 有资源限制和安全沙箱', () => {
  for (const marker of ['CPUQuota=', 'MemoryMax=', 'TasksMax=', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'StandardOutput=journal']) {
    assert.match(unit, new RegExp(marker))
  }
})

test('管理登录有独立限流且后台端口不公开', () => {
  assert.match(nginx, /password-login/)
  assert.match(nginx, /limit_req zone=loumai_admin_login/)
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8100/)
})
