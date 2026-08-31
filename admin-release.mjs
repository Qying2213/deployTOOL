#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig as loadBackendConfig } from './admin-backend/admin-backend-release.mjs'
import { loadConfig as loadFrontendConfig } from './admin-frontend/admin-frontend-release.mjs'
import { remotePreflight } from './frontend/h5-release.mjs'
import { TOOL_ROOT } from './admin-production.mjs'

export function parseArgs(argv) {
  const args = { command: argv[0] || 'help', environment: '', file: '', yes: false, dryRun: false }
  if (['-h', '--help'].includes(args.command)) args.command = 'help'
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--yes') args.yes = true
    else if (token === '--dry-run') args.dryRun = true
    else if (['--env', '--file'].includes(token)) {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${token} 缺少参数`)
      if (token === '--env') args.environment = value
      else args.file = resolve(value)
    } else throw new Error(`未知参数：${token}`)
  }
  if (!['help', 'prepare', 'deploy', 'status'].includes(args.command)) throw new Error('admin 只支持 prepare、deploy、status；回滚请分别选择前后端版本')
  if (args.command === 'help') return args
  if (args.environment !== 'production') throw new Error('联合正式发布必须显式指定 --env production；测试服请沿用原独立命令')
  if (args.command === 'deploy' && !args.file) throw new Error('必须用 --file 提供管理后台正式 ZIP')
  if (args.command !== 'deploy' && args.file) throw new Error('--file 只用于 deploy')
  if (['prepare', 'deploy'].includes(args.command) && !args.yes && !args.dryRun) throw new Error('必须提供 --yes 或 --dry-run')
  return args
}

export function commandPlan(args) {
  const env = ['--env', 'production']
  const confirmation = args.dryRun ? ['--dry-run'] : ['--yes']
  if (args.command === 'deploy') return [
    ['admin-frontend', 'check-package', ...env, '--file', args.file],
    ['admin-backend', 'deploy', ...env, ...confirmation],
    ['admin-frontend', 'deploy-package', ...env, '--file', args.file, ...confirmation],
  ]
  return ['admin-backend', 'admin-frontend'].map((target) => [target, args.command, ...env,
    ...(args.command === 'prepare' ? confirmation : [])])
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.command === 'help') {
    console.log(`管理后台正式服联合入口（不部署业务 H5/主后端、不迁移数据库）
  ./loumai-deploy admin prepare --env production --yes
  ./loumai-deploy admin deploy --env production --file /绝对路径/admin-production.zip --dry-run
  ./loumai-deploy admin deploy --env production --file /绝对路径/admin-production.zip --yes
  ./loumai-deploy admin status --env production
prepare 仅生成本机安装包；日常 deploy 按后端→前端顺序发布，不是跨组件原子事务。`)
    return
  }
  const backend = loadBackendConfig(resolve(TOOL_ROOT, 'config/admin-backend.production.local.env'), 'production')
  const frontend = loadFrontendConfig(resolve(TOOL_ROOT, 'config/admin-frontend.production.local.env'), 'production')
  if (backend.target !== frontend.target || backend.port !== frontend.sshPort || backend.origin !== frontend.publicUrl) {
    throw new Error('联合发布要求前后端的正式 SSH 目标、端口和管理后台域名一致')
  }
  const plan = commandPlan(args)
  for (const [index, command] of plan.entries()) {
    // Before touching backend, prove the frontend helper/site is already installed.
    // No API health probe here: first install legitimately has no running admin API yet.
    if (args.command === 'deploy' && index === 1) remotePreflight(frontend)
    console.log(`[admin] ${command[0]} ${command[1]} (${args.environment})`)
    const result = spawnSync('bash', ['loumai-deploy', ...command], { cwd: TOOL_ROOT, stdio: 'inherit' })
    if (result.error || result.status !== 0) {
      throw new Error(`${command[0]} ${command[1]} 失败，后续步骤已停止。已成功的组件不会自动回滚；请查询 status 并按文档处理。`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(`[admin] ERROR: ${error.message}`); process.exitCode = 1 }
}
