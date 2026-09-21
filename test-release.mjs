#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)))
export const DEFAULT_CONFIG = join(TOOL_ROOT, 'config/test.local.env')
const ALLOWED_CONFIG_KEYS = new Set(['TEST_H5_PACKAGE', 'TEST_ADMIN_PACKAGE'])

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
    fail('test 只支持 preflight、status、deploy')
  }
  if (args.command === 'help') return args
  if (args.command !== 'deploy' && (args.yes || args.dryRun)) {
    fail('--yes 和 --dry-run 只用于 test deploy')
  }
  if (args.command === 'status' && (args.h5File || args.adminFile)) {
    fail('status 不读取发布包')
  }
  if (args.command === 'deploy' && !args.yes && !args.dryRun) {
    fail('测试服全量发布必须显式提供 --yes；仅预演请提供 --dry-run')
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
    if (!ALLOWED_CONFIG_KEYS.has(key)) fail(`测试服总入口配置禁止字段：${key}`)
    if (Object.hasOwn(values, key)) fail(`测试服总入口配置重复字段：${key}`)
    values[key] = value.trim()
  }
  return values
}

function verifiedPackage(path, label) {
  if (!path) fail(`缺少${label}测试 ZIP`)
  if (!isAbsolute(path)) fail(`${label} 测试 ZIP 必须是绝对路径`)
  if (!existsSync(path)) fail(`找不到${label}测试 ZIP：${path}`)
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink()) {
    fail(`${label} 测试 ZIP 必须是本机真实普通文件，不能是软链接`)
  }
  if (!path.toLowerCase().endsWith('.zip')) fail(`${label} 测试包必须是 ZIP`)
  return realpathSync(path)
}

export function loadPackages(args) {
  let values = {}
  if ((!args.h5File || !args.adminFile) && existsSync(args.config)) {
    values = parseConfig(readFileSync(args.config, 'utf8'))
  }
  return {
    h5: verifiedPackage(args.h5File || values.TEST_H5_PACKAGE, '业务 H5'),
    admin: verifiedPackage(args.adminFile || values.TEST_ADMIN_PACKAGE, '管理后台前端'),
  }
}

export function statusPlan() {
  return [
    ['backend', 'status', '--env', 'test', '--database-profile', 'active'],
    ['admin-backend', 'status', '--env', 'test'],
    ['frontend', 'status', '--env', 'test'],
    ['admin-frontend', 'status', '--env', 'test'],
  ]
}

export function preflightPlan(packages) {
  return [
    ['test-backend', '--dry-run-only'],
    ['admin-backend', 'deploy', '--env', 'test', '--dry-run'],
    ['frontend', 'deploy-package', '--env', 'test', '--file', packages.h5, '--dry-run'],
    ['admin-frontend', 'deploy-package', '--env', 'test', '--file', packages.admin, '--dry-run'],
  ]
}

export function deployPlan(packages) {
  return [
    ['test-backend'],
    ['admin-backend', 'deploy', '--env', 'test', '--yes'],
    ['frontend', 'deploy-package', '--env', 'test', '--file', packages.h5, '--yes'],
    ['admin-frontend', 'deploy-package', '--env', 'test', '--file', packages.admin, '--yes'],
  ]
}

function commandLabel(command) {
  return command[0] === 'test-backend'
    ? 'deploy-test-backend'
    : command.slice(0, 2).join(' ')
}

function runCommand(command) {
  const testBackend = command[0] === 'test-backend'
  const script = join(TOOL_ROOT, testBackend ? 'deploy-test-backend' : 'loumai-deploy')
  const args = testBackend ? command.slice(1) : command
  return spawnSync('/bin/bash', [script, ...args], { cwd: TOOL_ROOT, stdio: 'inherit' })
}

function runPlan(plan, phase) {
  for (const command of plan) {
    const label = commandLabel(command)
    console.log(`[test] ${phase}: ${label}`)
    const result = runCommand(command)
    if (result.error || result.status !== 0) {
      fail(`${phase}失败：${label}。后续步骤已停止；已成功组件不会自动回滚。`)
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.command === 'help') {
    console.log(`工位有方测试服四目标一键发布
  ./loumai-deploy test preflight
  ./loumai-deploy test status
  ./loumai-deploy test deploy --dry-run
  ./loumai-deploy test deploy --yes

默认从 config/test.local.env 读取业务 H5 和管理后台前端 ZIP。
真实发布固定顺序：主后端 → 管理后台后端 → 业务 H5 → 管理后台前端。
微信小程序不在计划中，不会构建或上传。
任一步失败立即停止，不自动降级数据库或回滚已成功组件。`)
    return
  }
  if (args.command === 'status') {
    runPlan(statusPlan(), '状态检查')
    return
  }
  const packages = loadPackages(args)
  runPlan(preflightPlan(packages), '发布预检')
  if (args.command === 'preflight' || args.dryRun) {
    console.log('[test] 四目标发布预检通过；没有上传、迁移、重启或切换版本。')
    return
  }
  runPlan(deployPlan(packages), '真实发布')
  runPlan(statusPlan(), '发布后验收')
  console.log('[test] 主后端、业务 H5、管理后台后端和管理后台前端发布并验收完成。')
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  try { main() } catch (error) {
    console.error(`[test] ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
