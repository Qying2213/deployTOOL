#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspectProductionGit, loadProductionConfig, runProduction } from './production-release.mjs'

export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_CONFIG = join(TOOL_ROOT, 'config/admin-backend.test.local.env')
const DIST = join(TOOL_ROOT, 'dist/admin-backend-releases')
const REMOTE = join(TOOL_ROOT, 'admin-backend/remote')

function fail(message) { throw new Error(message) }
function info(message) { process.stdout.write(`[admin-backend-release] ${message}\n`) }
function quote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'` }

export function parseDotEnv(text) {
  const out = {}
  String(text).split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (!match) fail(`配置第 ${index + 1} 行格式错误`)
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (/[\r\n`]|\$\(/.test(value)) fail(`配置 ${match[1]} 包含不安全内容`)
    out[match[1]] = value
  })
  return out
}

export function parseArgs(argv) {
  const first = argv[0] || 'help'
  const out = { command: first === '-h' || first === '--help' ? 'help' : first, environment: 'test', config: '', dryRun: false, yes: false, skipTests: false, release: '', ackDbSchemaCompatible: false }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (['--config', '--release', '--env'].includes(arg)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) fail(`${arg} 缺少参数`)
      if (arg === '--config') out.config = resolve(value)
      if (arg === '--release') out.release = value
      if (arg === '--env') out.environment = value
    }
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--yes') out.yes = true
    else if (arg === '--skip-tests') out.skipTests = true
    else if (arg === '--ack-db-schema-compatible') out.ackDbSchemaCompatible = true
    else if (arg === '-h' || arg === '--help') out.command = 'help'
    else fail(`未知参数：${arg}`)
  }
  if (!new Set(['build', 'deploy', 'help', 'prepare', 'restart', 'rollback', 'status']).has(out.command)) fail(`未知命令：${out.command}`)
  if (!['test', 'production'].includes(out.environment)) fail('--env 只能为 test 或 production')
  if (!out.config) out.config = join(TOOL_ROOT, `config/admin-backend.${out.environment}.local.env`)
  if (out.command === 'restart' && out.environment !== 'production') fail('受控 restart 当前仅用于 --env production')
  if (out.command === 'rollback' && !out.release) fail('rollback 必须提供 --release')
  if (out.release && !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{10}$/.test(out.release)) fail('release 格式非法')
  if (out.environment === 'production') {
    if (out.skipTests) fail('正式服禁止 --skip-tests')
    if (out.command === 'rollback' && !out.ackDbSchemaCompatible) fail('正式回滚必须提供 --ack-db-schema-compatible')
    if (['prepare', 'deploy', 'restart', 'rollback'].includes(out.command) && !out.dryRun && !out.yes) fail('正式操作必须提供 --yes 或 --dry-run')
  }
  return out
}

function usage() {
  return `管理后台后端独立发布工具

  ./loumai-deploy admin-backend build
  ./loumai-deploy admin-backend prepare --yes
  ./loumai-deploy admin-backend deploy --dry-run
  ./loumai-deploy admin-backend deploy --yes
  ./loumai-deploy admin-backend status
  ./loumai-deploy admin-backend rollback --release RELEASE_ID --yes`
    + `\n\n正式服：以上命令追加 --env production；rollback 另需 --ack-db-schema-compatible。\n正式服 prepare 只生成本机安装包，不自动安装服务器或申请证书。\n受控重启：./loumai-deploy admin-backend restart --env production --yes`
}

function required(raw, key) { if (!raw[key]) fail(`配置缺少 ${key}`); return raw[key] }
function expandHome(value) { return value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value }
export function loadConfig(path, environment = 'test') {
  if (environment === 'production') return loadProductionConfig(path, parseDotEnv)
  if (!existsSync(path)) fail(`找不到配置：${path}\n请复制 config/admin-backend.test.example.env`)
  const raw = parseDotEnv(readFileSync(path, 'utf8'))
  const config = {
    source: realpathSync(expandHome(raw.ADMIN_BACKEND_SOURCE || required(raw, 'ADMIN_BACKEND_REPO'))),
    target: required(raw, 'ADMIN_BACKEND_DEPLOY_TARGET'),
    port: Number(raw.ADMIN_BACKEND_SSH_PORT || 22),
    identity: expandHome(required(raw, 'ADMIN_BACKEND_SSH_IDENTITY_FILE')),
    helper: raw.ADMIN_BACKEND_REMOTE_HELPER || '/usr/local/sbin/loumai-company-management-release',
    root: raw.ADMIN_BACKEND_REMOTE_ROOT || '/srv/loumai-company-management',
    publicUrl: (raw.ADMIN_BACKEND_PUBLIC_URL || 'https://test.yinlizhangyu.com/admin-api').replace(/\/+$/, ''),
  }
  if (!/^[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+$/.test(config.target)) fail('部署目标非法')
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) fail('SSH 端口非法')
  for (const value of [config.helper, config.root]) if (!/^\/[A-Za-z0-9._/-]+$/.test(value) || value.includes('..')) fail('远端路径非法')
  if (!existsSync(config.identity) || !lstatSync(config.identity).isFile()) fail('SSH 私钥不存在')
  if (!existsSync(join(config.source, 'app/main.py')) || !existsSync(join(config.source, 'pyproject.toml'))) fail('管理后台源码目录不完整')
  return config
}

function run(command, args, options = {}) {
  info(`${options.dryRun ? '[dry-run] ' : ''}${[command, ...args].map(quote).join(' ')}`)
  if (options.dryRun) return ''
  const result = spawnSync(command, args, { cwd: options.cwd || TOOL_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', SYSTEMD_PAGER: 'cat', ...options.env }, stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
  if (result.error) fail(`命令无法启动：${result.error.message}`)
  if (result.status !== 0) fail(`命令失败（exit ${result.status}）${options.capture ? `\n${result.stdout || ''}${result.stderr || ''}` : ''}`)
  return options.capture ? result.stdout.trim() : ''
}

function sshArgs(config) {
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=12', '-o', 'UseKeychain=yes', '-o', 'AddKeysToAgent=yes', '-p', String(config.port), '-i', config.identity]
}
function scpArgs(config) {
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=12', '-o', 'UseKeychain=yes', '-o', 'AddKeysToAgent=yes', '-P', String(config.port), '-i', config.identity]
}
function remote(config, args, options = {}) { return run('ssh', [...sshArgs(config), config.target, ['sudo', '-n', config.helper, ...args].map(quote).join(' ')], options) }

function files(root) {
  const result = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('._')) continue
      if (['.git', '.venv', '.runtime', '.pytest_cache', '.ruff_cache', '__pycache__', 'dist', 'logs'].includes(entry.name)) continue
      if (entry.name === '.env' || entry.name === '.DS_Store') continue
      const path = join(dir, entry.name); const info = lstatSync(path)
      if (info.isSymbolicLink()) fail(`源码包含软链接：${relative(root, path)}`)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) result.push(path)
      else fail(`源码包含特殊文件：${relative(root, path)}`)
    }
  }
  for (const name of ['app', 'tests', 'scripts']) if (existsSync(join(root, name))) visit(join(root, name))
  for (const name of ['pyproject.toml', 'README.md']) if (existsSync(join(root, name))) result.push(join(root, name))
  return result.sort()
}

function sourceHash(root, list) {
  const hash = createHash('sha256')
  for (const path of list) hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0')
  return hash.digest('hex')
}
function sha(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function releaseId(sourceSha, date = new Date()) { return `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${sourceSha.slice(0, 10)}` }

function quality(config, skipTests) {
  if (skipTests) return
  const python = config.pythonBin || join(config.source, '.venv/bin/python')
  if (!existsSync(python)) fail(`缺少虚拟环境：${python}`)
  run(python, ['-m', 'ruff', 'check', 'app', 'tests', 'scripts'], { cwd: config.source })
  run(python, ['-m', 'ruff', 'format', '--check', 'app', 'tests', 'scripts'], { cwd: config.source })
  run(python, ['-m', 'pytest', '-q'], { cwd: config.source })
}

function writeChecksums(root) {
  const list = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name !== 'SHA256SUMS') list.push(path)
      else if (!entry.isFile()) fail(`产物包含特殊文件：${relative(root, path)}`)
    }
  }
  visit(root); list.sort()
  writeFileSync(join(root, 'SHA256SUMS'), `${list.map((path) => `${sha(path)}  ${relative(root, path)}`).join('\n')}\n`, { mode: 0o644 })
}

export function build(config, { skipTests = false } = {}) {
  const production = config.environment === 'production'
  if (production && skipTests) fail('正式服禁止 --skip-tests')
  const gitState = production ? inspectProductionGit(config) : null
  quality(config, skipTests)
  mkdirSync(DIST, { recursive: true, mode: 0o755 })
  const list = files(config.source); const sourceSha = sourceHash(config.source, list); const id = releaseId(sourceSha)
  if (production) {
    const tracked = new Set(run('git', ['ls-tree', '-r', '--name-only', gitState.commit], { cwd: config.source, capture: true }).split('\n'))
    if (list.some((path) => !tracked.has(relative(config.source, path)))) fail('正式发布不能包含未纳入 Git commit 的源码文件（包括 ignored 文件）')
  }
  const releaseRoot = join(DIST, id); const backend = join(releaseRoot, 'backend')
  if (existsSync(releaseRoot)) fail('版本目录已存在，请稍后重试；不会覆盖历史产物')
  mkdirSync(backend, { recursive: true, mode: 0o755 })
  if (production) for (const path of list) {
    if (/(^|\/)(\.[^/]+|[^/]+\.(pem|key|p12|pfx|sql|sqlite|db|bak))$/i.test(relative(config.source, path))) fail('正式源码包含隐藏或敏感文件')
  }
  for (const path of list) { const dest = join(backend, relative(config.source, path)); mkdirSync(dirname(dest), { recursive: true }); cpSync(path, dest) }
  if (production && (sourceHash(backend, files(backend)) !== sourceSha || inspectProductionGit(config).commit !== gitState.commit)) fail('测试或复制期间源码发生变化，拒绝发布')
  cpSync(config.constraints || join(TOOL_ROOT, 'admin-backend/runtime-constraints.test.txt'), join(backend, 'runtime-constraints.txt'))
  const manifest = { schema_version: 1, release_id: id, source_sha256: sourceSha, environment: config.environment || 'test', ...(gitState || {}), built_at: new Date().toISOString(), source_file_count: list.length, tool: { admin_backend_release_tool: production ? '4' : '1' } }
  writeFileSync(join(backend, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeChecksums(backend)
  const archive = join(releaseRoot, 'backend.tar')
  run('tar', ['--no-xattrs', '-C', releaseRoot, '-cf', archive, 'backend'], {
    env: { COPYFILE_DISABLE: '1' },
  })
  info(`构建完成：${id}`)
  return { id, backend, archive, archiveSha: sha(archive) }
}

function prepare(config) {
  const bundle = join(DIST, '.install-bundle'); rmSync(bundle, { recursive: true, force: true }); mkdirSync(bundle, { recursive: true })
  const mapping = {
    'loumai-company-management-release': 'loumai-company-management-release',
    'loumai-company-management-run': 'loumai-company-management-run',
    'loumai-company-management.service.example': 'loumai-company-management.service',
    'nginx-company-management-rate-limit.conf.example': 'nginx-company-management-rate-limit.conf',
    'nginx-company-management-api.conf.example': 'nginx-company-management-api.conf',
    'loumai-company-management-release.env.example': 'company-management-release.env',
    'install-company-management-release': 'install-company-management-release',
  }
  for (const [source, target] of Object.entries(mapping)) cpSync(join(REMOTE, source), join(bundle, target))
  const remotePath = `/tmp/loumai-company-management-install-${process.pid}`
  run('ssh', [...sshArgs(config), config.target, `install -d -m 0700 ${quote(remotePath)}`])
  run('scp', [...scpArgs(config), '-r', `${bundle}/.`, `${config.target}:${remotePath}/`])
  run('ssh', [...sshArgs(config), config.target, `if sudo -n ${quote(`${remotePath}/install-company-management-release`)} ${quote(remotePath)}; then rm -rf ${quote(remotePath)}; else rc=$?; rm -rf ${quote(remotePath)}; exit $rc; fi`])
  remote(config, ['version'], { capture: true })
  remote(config, ['preflight'])
}

function current(config) {
  const output = remote(config, ['status'], { capture: true })
  const match = output.match(/^CURRENT=(.*)$/m)
  return { output, target: match ? match[1].trim() : '' }
}

function deploy(config, args) {
  if (args.skipTests) fail('真实部署禁止 --skip-tests')
  if (args.dryRun) { remote(config, ['preflight']); quality(config, false); info('dry-run 通过，未上传或切换版本'); return }
  if (!args.yes) fail('真实部署必须提供 --yes')
  prepare(config)
  const artifact = build(config); const before = current(config).target
  remote(config, ['prepare', artifact.id, before])
  const destination = `${config.target}:${config.root}/incoming/${artifact.id}.partial/backend.tar`
  run('scp', [...scpArgs(config), artifact.archive, destination])
  remote(config, ['activate', artifact.id, artifact.archiveSha, before])
  remote(config, ['status'])
  info(`发布成功：${artifact.id}`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'help') { console.log(usage()); return }
  const config = loadConfig(args.config, args.environment)
  if (args.environment === 'production') { runProduction(args, config, build); return }
  if (args.command === 'build') build(config, { skipTests: args.skipTests })
  else if (args.command === 'prepare') { if (!args.yes) fail('prepare 必须提供 --yes'); prepare(config) }
  else if (args.command === 'deploy') deploy(config, args)
  else if (args.command === 'status') remote(config, ['status'])
  else if (args.command === 'rollback') { if (!args.yes) fail('rollback 必须提供 --yes'); remote(config, ['rollback', args.release]) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { process.stderr.write(`[admin-backend-release] ERROR: ${error.message}\n`); process.exit(1) }
}
