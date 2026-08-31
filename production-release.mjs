#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)))
export const DEFAULT_CONFIG = join(TOOL_ROOT, 'config/production.local.env')
const ALLOWED_CONFIG_KEYS = new Set(['PRODUCTION_H5_PACKAGE', 'PRODUCTION_ADMIN_PACKAGE'])

function fail(message) { throw new Error(message) }

export function parseArgs(argv = []) {
  const args = {
    command: argv[0] || 'help', config: DEFAULT_CONFIG, h5File: '', adminFile: '', dryRun: false, yes: false,
  }
  if (['-h', '--help'].includes(args.command)) args.command = 'help'
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--yes') args.yes = true
    else if (token === '--dry-run') args.dryRun = true
    else if (['--config', '--h5-file', '--admin-file'].includes(token)) {
      const value = argv[++index]
      if (!value || value.startsWith('--')) fail(`${token} 缺少参数`)
      if (token === '--config') args.config = resolve(value)
      if (token === '--h5-file') args.h5File = resolve(value)
      if (token === '--admin-file') args.adminFile = resolve(value)
    } else fail(`未知参数：${token}`)
  }
  if (!['help', 'preflight', 'status', 'deploy'].includes(args.command)) {
    fail('production 只支持 preflight、status、deploy')
  }
  if (args.command === 'help') return args
  if (args.command !== 'deploy' && (args.yes || args.dryRun)) {
    fail('--yes 和 --dry-run 只用于 production deploy')
  }
  if (args.command === 'status' && (args.h5File || args.adminFile)) {
    fail('status 不读取发布包')
  }
  if (args.command === 'deploy' && !args.yes && !args.dryRun) {
    fail('正式服全量发布必须显式提供 --yes；仅预演请提供 --dry-run')
  }
  return args
}

export function parseConfig(text) {
  const values = {}
  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (/`|\$\(|<\(|>\(/.test(line)) fail(`配置第 ${index + 1} 行包含禁止的 shell 表达式`)
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (!match) fail(`配置第 ${index + 1} 行格式错误`)
    const [, key, value] = match
    if (!ALLOWED_CONFIG_KEYS.has(key)) fail(`总入口配置禁止字段：${key}`)
    if (Object.hasOwn(values, key)) fail(`总入口配置重复字段：${key}`)
    values[key] = value.trim()
  }
  return values
}

function verifiedPackage(path, label) {
  if (!path) fail(`缺少 ${label} 正式 ZIP`)
  if (!isAbsolute(path)) fail(`${label} 正式 ZIP 必须是绝对路径`)
  if (!existsSync(path)) fail(`找不到 ${label} 正式 ZIP：${path}`)
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink()) {
    fail(`${label} 正式 ZIP 必须是本机真实普通文件，不能是软链接`)
  }
  if (!path.toLowerCase().endsWith('.zip')) fail(`${label} 正式包必须是 ZIP`)
  return realpathSync(path)
}

export function loadPackages(args) {
  let values = {}
  if ((!args.h5File || !args.adminFile) && existsSync(args.config)) {
    values = parseConfig(readFileSync(args.config, 'utf8'))
  }
  return {
    h5: verifiedPackage(args.h5File || values.PRODUCTION_H5_PACKAGE, '业务前端'),
    admin: verifiedPackage(args.adminFile || values.PRODUCTION_ADMIN_PACKAGE, '管理后台前端'),
  }
}

export function statusPlan() {
  return [
    ['backend', 'status', '--env', 'production'],
    ['frontend', 'status', '--env', 'production'],
    ['admin', 'status', '--env', 'production'],
  ]
}

export function preflightPlan(packages) {
  return [
    ['backend', 'status', '--env', 'production'],
    ['backend', 'env-audit', '--env', 'production'],
    ['backend', 'deploy', '--env', 'production', '--dry-run'],
    ['frontend', 'deploy-package', '--env', 'production', '--file', packages.h5, '--dry-run'],
    ['admin', 'deploy', '--env', 'production', '--file', packages.admin, '--dry-run'],
  ]
}

export function deployPlan(packages) {
  return [
    ['backend', 'deploy', '--env', 'production', '--yes'],
    ['frontend', 'deploy-package', '--env', 'production', '--file', packages.h5, '--yes'],
    ['admin', 'deploy', '--env', 'production', '--file', packages.admin, '--yes'],
  ]
}

function runPlan(plan, phase) {
  for (const command of plan) {
    console.log(`[production] ${phase}: ${command[0]} ${command[1]}`)
    const result = spawnSync('bash', ['loumai-deploy', ...command], { cwd: TOOL_ROOT, stdio: 'inherit' })
    if (result.error || result.status !== 0) {
      fail(`${phase}失败：${command[0]} ${command[1]}。后续步骤已停止；已成功组件不会自动回滚。`)
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.command === 'help') {
    console.log(`工位有方正式服全量一键发布
  ./loumai-deploy production preflight
  ./loumai-deploy production status
  ./loumai-deploy production deploy --dry-run
  ./loumai-deploy production deploy --yes

默认从 config/production.local.env 读取业务前端和管理后台正式 ZIP。
真实发布固定顺序：业务后端 → 业务前端 → 管理后台后端 → 管理后台前端。
任一步失败立即停止，不自动回滚数据库或已成功组件。`)
    return
  }
  if (args.command === 'status') {
    runPlan(statusPlan(), '状态检查')
    return
  }
  const packages = loadPackages(args)
  runPlan(preflightPlan(packages), '发布预检')
  if (args.command === 'preflight' || args.dryRun) {
    console.log('[production] 全量发布预检通过；没有上传、迁移、重启或切换版本。')
    return
  }
  runPlan(deployPlan(packages), '正式发布')
  runPlan(statusPlan(), '发布后验收')
  console.log('[production] 四个正式服目标发布并验收完成。')
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  try { main() } catch (error) {
    console.error(`[production] ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
