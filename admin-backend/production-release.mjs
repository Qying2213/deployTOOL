import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  ADMIN_BACKEND_HELPER, ADMIN_BACKEND_ROOT, TOOL_ROOT, assertConfigKeys,
  productionOrigin, productionSsh, writeSetupBundle,
} from '../admin-production.mjs'

const HELPER_SOURCE = join(TOOL_ROOT, 'admin-backend/remote/loumai-company-management-production-release')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) throw new Error(`${command} 失败：${result.stderr || result.stdout || result.error?.message}`)
  return (result.stdout || '').trim()
}

export function loadProductionConfig(path, parseDotEnv) {
  if (!existsSync(path)) throw new Error('缺少 config/admin-backend.production.local.env，请先填写正式配置')
  const raw = parseDotEnv(readFileSync(path, 'utf8'))
  assertConfigKeys(raw, ['ADMIN_BACKEND_ENVIRONMENT', 'ADMIN_BACKEND_REPO', 'ADMIN_BACKEND_PYTHON_BIN',
    'ADMIN_BACKEND_EXPECTED_BRANCH', 'ADMIN_BACKEND_DEPLOY_TARGET', 'ADMIN_BACKEND_SSH_PORT',
    'ADMIN_BACKEND_SSH_IDENTITY_FILE', 'ADMIN_BACKEND_PUBLIC_URL'])
  if (raw.ADMIN_BACKEND_ENVIRONMENT !== 'production') throw new Error('配置必须显式声明 ADMIN_BACKEND_ENVIRONMENT=production')
  const publicUrl = raw.ADMIN_BACKEND_PUBLIC_URL || ''
  if (!publicUrl.endsWith('/admin-api')) throw new Error('ADMIN_BACKEND_PUBLIC_URL 必须以 /admin-api 结尾')
  const origin = productionOrigin(publicUrl.slice(0, -10))
  const source = raw.ADMIN_BACKEND_REPO || ''
  if (!source.startsWith('/') || !existsSync(source) || realpathSync(source) !== source
    || !existsSync(join(source, '.git')) || !existsSync(join(source, 'app/main.py'))) throw new Error('正式后台源码必须是无软链接的 Git 仓库绝对路径')
  const pythonBin = raw.ADMIN_BACKEND_PYTHON_BIN || join(source, '.venv/bin/python')
  if (!existsSync(pythonBin)) throw new Error('管理后台测试 Python 不存在')
  const expectedBranch = raw.ADMIN_BACKEND_EXPECTED_BRANCH || ''
  if (!expectedBranch || /\s/.test(expectedBranch)) throw new Error('必须明确正式发布分支')
  return { ...productionSsh(raw, 'ADMIN_BACKEND'), source, pythonBin, expectedBranch,
    environment: 'production', publicUrl: `${origin}/admin-api`, origin,
    root: ADMIN_BACKEND_ROOT, helper: ADMIN_BACKEND_HELPER,
    constraints: join(TOOL_ROOT, 'admin-backend/runtime-constraints.production.txt') }
}

export function inspectProductionGit(config) {
  const git = (args) => run('git', ['--no-pager', ...args], { cwd: config.source })
  if (git(['status', '--porcelain'])) throw new Error('正式后台源码工作区不干净')
  const branch = git(['branch', '--show-current'])
  if (branch !== config.expectedBranch) throw new Error(`正式后台分支必须为 ${config.expectedBranch}`)
  for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) {
    const path = git(['rev-parse', '--git-path', marker])
    if (existsSync(path.startsWith('/') ? path : join(config.source, path))) throw new Error('Git 操作尚未完成')
  }
  const commit = git(['rev-parse', 'HEAD'])
  if (!/^[a-f0-9]{40}$/.test(commit) || git(['rev-parse', '@{upstream}']) !== commit) throw new Error('正式后台提交必须与 upstream 一致')
  return { commit, branch }
}

function ssh(config, args) {
  return run('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=12',
    '-p', String(config.port), '-i', config.identity, config.target,
    ['sudo', '-n', config.helper, ...args].map(quote).join(' ')])
}

export function validateProductionState(output, config) {
  const state = Object.fromEntries(output.split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
    const offset = line.indexOf('='); return [line.slice(0, offset), line.slice(offset + 1)]
  }))
  if (state.ENVIRONMENT !== 'production' || state.REMOTE_ROOT !== config.root || state.PUBLIC_URL !== config.publicUrl
    || state.DATABASE_PROFILE !== 'cloud' || !state.CURRENT
    || (state.CURRENT !== 'NONE' && !new RegExp(`^${ADMIN_BACKEND_ROOT}/releases/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{10}/backend$`).test(state.CURRENT))) {
    throw new Error('远端正式后台环境、目录、域名、数据库或当前版本不匹配')
  }
  return state
}

function exactHelper(config) {
  if (ssh(config, ['version']) !== '4' || ssh(config, ['fingerprint']) !== sha(readFileSync(HELPER_SOURCE))) {
    throw new Error('正式后台 helper 版本/指纹不一致，须由管理员安装评审后的版本')
  }
}

export function runProduction(args, config, build) {
  if (args.command === 'prepare') {
    writeSetupBundle('admin-backend-production-setup', {
      'loumai-company-management-production-release': HELPER_SOURCE,
      'loumai-backend-release': 'backend/remote/loumai-backend-release',
      'loumai-company-management.service': 'admin-backend/remote/loumai-company-management.production.service.example',
      'company-management-production-release.env': 'admin-backend/remote/company-management-production-release.env.example',
      'company-management-production.env.example': 'admin-backend/remote/company-management-production.env.example',
      'company-management-production-database.env.example': 'admin-backend/remote/company-management-production-database.env.example',
      'sudoers.example': 'admin-backend/remote/admin-production.sudoers.example',
    }, { 'admin.example.com': new URL(config.origin).hostname }, args)
    return
  }
  if (args.command === 'build') { build(config); return }
  exactHelper(config)
  if (args.command === 'status') {
    const output = ssh(config, ['status']); validateProductionState(output, config); console.log(output); return
  }
  const before = validateProductionState(ssh(config, ['preflight']), config)
  if (args.command === 'restart') {
    if (before.CURRENT === 'NONE') throw new Error('后台尚未发布，不能重启')
    console.log(ssh(config, args.dryRun
      ? ['check-release', before.CURRENT.split('/').at(-2), before.CURRENT]
      : ['restart', before.CURRENT]))
    return
  }
  if (args.command === 'rollback') {
    if (!args.ackDbSchemaCompatible) throw new Error('正式回滚必须确认数据库兼容')
    console.log(ssh(config, [args.dryRun ? 'check-release' : 'rollback', args.release, before.CURRENT]))
    return
  }
  inspectProductionGit(config)
  console.log(run(process.execPath, ['--test', 'tests/admin-backend-release.test.mjs', 'tests/admin-production-release.test.mjs'], { cwd: TOOL_ROOT }))
  if (args.dryRun) { console.log('正式后台只读预检通过；未构建、未上传、未迁移或切换。业务测试将在真实发布前运行。'); return }
  const artifact = build(config)
  // Build may take time; refresh the server contract and use CAS under the shared DB lock.
  const current = validateProductionState(ssh(config, ['preflight']), config)
  console.log(ssh(config, ['prepare', artifact.id, current.CURRENT]))
  run('scp', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=12',
    '-P', String(config.port), '-i', config.identity, artifact.archive,
    `${config.target}:${config.root}/incoming/${artifact.id}.partial/backend.tar`])
  console.log(ssh(config, ['activate', artifact.id, artifact.archiveSha, current.CURRENT]))
  console.log(ssh(config, ['status']))
}
