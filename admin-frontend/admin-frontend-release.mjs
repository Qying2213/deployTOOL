#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ADMIN_FRONTEND_HELPER, ADMIN_FRONTEND_ROOT, assertConfigKeys,
  productionOrigin, productionSsh, writeSetupBundle,
} from '../admin-production.mjs'
import {
  createReleaseId, deployRelease, extractExternalPackage, inspectExternalPackage,
  parseDotEnv, remoteHelperContractSource, remotePreflight,
  resolveExternalPackageFrontendRoot, rollback, shellQuote, status,
  validateArtifact, validateExternalPackageArtifact,
} from '../frontend/h5-release.mjs'

export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PUBLIC_URL = 'https://admin-test.yinlizhangyu.com'
export const REMOTE_ROOT = '/srv/loumai-admin-frontend'
export const LEGACY_API = 'https://test.yinlizhangyu.com/admin-api/api/v1'
export const PRODUCTION_API = 'https://admin.yinlizhangyu.com/admin-api/api/v1'
export const API_BASE = '/admin-api/api/v1'
const CONFIG = join(TOOL_ROOT, 'config/admin-frontend.test.local.env')
const REMOTE_HELPER = '/usr/local/sbin/loumai-admin-frontend-release'
const BUILD_ROOT = join(TOOL_ROOT, 'dist/admin-frontend-releases')
const TEXT_FILE = /\.(?:m?js|html|css|json|txt|xml|svg|webmanifest)$/i
const RELEASE_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,12}$/

const fail = (message) => { throw new Error(message) }
const info = (message) => process.stdout.write(`[admin-frontend] ${message}\n`)
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

export function parseArgs(argv) {
  const result = { command: argv[0] || 'help', file: '', releaseId: '', environment: 'test', config: '', yes: false, dryRun: false }
  if (['--help', '-h'].includes(result.command)) result.command = 'help'
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--yes') result.yes = true
    else if (arg === '--dry-run') result.dryRun = true
    else if (['--file', '--release', '--config', '--env'].includes(arg)) {
      const value = argv[++index]
      if (!value || value.startsWith('--')) fail(`${arg} 缺少参数`)
      if (arg === '--file') result.file = resolve(value)
      if (arg === '--release') result.releaseId = value
      if (arg === '--config') result.config = resolve(value)
      if (arg === '--env') result.environment = value
    } else fail(`未知参数：${arg}`)
  }
  if (!['test', 'production'].includes(result.environment)) fail('--env 只能为 test 或 production')
  if (!result.config) result.config = join(TOOL_ROOT, `config/admin-frontend.${result.environment}.local.env`)
  if (!['help', 'check-package', 'deploy-package', 'prepare', 'status', 'rollback'].includes(result.command)) {
    fail(`未知命令：${result.command}`)
  }
  if (['check-package', 'deploy-package'].includes(result.command) && !result.file) fail('必须提供 --file ZIP绝对路径')
  if (result.command === 'rollback' && !RELEASE_ID.test(result.releaseId)) fail('rollback 必须提供合法 --release')
  if (result.file && !['check-package', 'deploy-package'].includes(result.command)) fail('--file 只能用于压缩包命令')
  if (result.releaseId && result.command !== 'rollback') fail('--release 只能用于 rollback')
  if (['prepare', 'deploy-package', 'rollback'].includes(result.command) && !result.dryRun && !result.yes) {
    fail('修改服务器必须显式提供 --yes；只检查请使用 --dry-run')
  }
  return result
}

// Derive an isolated, fingerprinted helper. Never replace the business H5 helper/config.
export function adminHelperSource(environment = 'test') {
  if (!['test', 'production'].includes(environment)) fail('后台 helper 环境非法')
  const production = environment === 'production'
  let source = remoteHelperContractSource()
  const oldConfig = 'readonly CONFIG_FILE="/etc/loumai/h5-release.env"'
  if (!source.includes(oldConfig)) fail('共享 H5 helper 配置锚点变化，请检查管理后台适配器')
  source = source.replace(oldConfig, `readonly CONFIG_FILE="/etc/loumai/admin-frontend${production ? '-production' : ''}-release.env"`)
  const anchor = 'ROLLBACK_ARMED=0\n'
  if (!source.includes(anchor)) fail('共享 H5 helper 作用域锚点变化')
  const targetGuard = production
    ? `[[ "$DEPLOY_ENVIRONMENT" == "production" && "$DEPLOY_USER" == "loumai-deploy" && "$REMOTE_ROOT" == "${ADMIN_FRONTEND_ROOT}" && "$STAGING_ROOT" == "${ADMIN_FRONTEND_ROOT}/incoming" ]] || fail "正式后台前端环境、账号或目录不匹配"`
    : `[[ "$DEPLOY_ENVIRONMENT" == "test" && "$REMOTE_ROOT" == "${REMOTE_ROOT}" && "$STAGING_ROOT" == "${REMOTE_ROOT}/incoming" && "$PUBLIC_URL" == "${PUBLIC_URL}" ]] || fail "管理后台前端目标不匹配，禁止接管业务 H5 或正式服"`
  source = source.replace(anchor, `${targetGuard}\n\n${anchor}`)
  // Vue emits _...all_-HASH.js. Reject traversal components, not dots inside filenames.
  const oldPathGuard = '[[ "$relative" != *".."* ]]'
  if (!source.includes(oldPathGuard)) fail('共享 H5 helper 路径校验锚点变化')
  source = source.replace(oldPathGuard, '[[ "/$relative/" != *"/../"* && "/$relative/" != *"/./"* ]]')
  if (production) {
    // Root must validate every tar header before extracting an uploaded archive.
    const extraction = '  tar --extract --file "$archive_path"'
    if (!source.includes(extraction)) fail('共享 H5 archive 安装锚点变化')
    source = source.replace(extraction, `  /usr/bin/python3 - "$archive_path" <<'ADMIN_TAR_CHECK'
import pathlib, sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    members = []
    total = 0
    for item in archive:
        members.append(item)
        total += item.size
        if len(members) > 20000 or total > 536870912:
            raise SystemExit("admin archive exceeds limits")
    seen = set()
    for item in members:
        path = pathlib.PurePosixPath(item.name)
        if (path.is_absolute() or ".." in path.parts or "\\\\" in item.name
            or not (item.isfile() or item.isdir()) or path.as_posix() in seen):
            raise SystemExit("unsafe admin archive member")
        seen.add(path.as_posix())
ADMIN_TAR_CHECK
${extraction}`)
    // Metadata binding is checked for activation, current-state reads and rollback.
    const checkAnchor = 'verify_release_metadata() {\n'
    if (!source.includes(checkAnchor)) fail('共享 H5 metadata 校验锚点变化')
    source = source.replace(checkAnchor, `${checkAnchor}  /usr/bin/python3 - "$1/release.json" "$PUBLIC_URL" <<'ADMIN_METADATA_CHECK'
import json, sys
data = json.load(open(sys.argv[1]))
if (data.get("target") != "admin-frontend" or data.get("public_url") != sys.argv[2]
    or data.get("environment") != "production" or data.get("api_base_url") != "/admin-api/api/v1"):
    raise SystemExit("production admin release target mismatch")
ADMIN_METADATA_CHECK
`)
  }
  return source.replaceAll('/tmp/loumai-h5-release.', '/tmp/loumai-admin-frontend-release.')
}

export function loadConfig(path = CONFIG, environment = 'test') {
  if (environment === 'production') {
    if (!existsSync(path)) fail('缺少 config/admin-frontend.production.local.env，请先填写正式配置')
    const raw = parseDotEnv(readFileSync(path, 'utf8'))
    assertConfigKeys(raw, ['ADMIN_FRONTEND_ENVIRONMENT', 'ADMIN_FRONTEND_DEPLOY_TARGET', 'ADMIN_FRONTEND_SSH_PORT',
      'ADMIN_FRONTEND_SSH_IDENTITY_FILE', 'ADMIN_FRONTEND_PUBLIC_URL'])
    if (raw.ADMIN_FRONTEND_ENVIRONMENT !== 'production') fail('配置必须显式声明 ADMIN_FRONTEND_ENVIRONMENT=production')
    const ssh = productionSsh(raw, 'ADMIN_FRONTEND')
    return { target: ssh.target, sshPort: ssh.port, identityFile: ssh.identity, environment,
      publicUrl: productionOrigin(raw.ADMIN_FRONTEND_PUBLIC_URL), remoteHelper: ADMIN_FRONTEND_HELPER,
      remoteStagingRoot: `${ADMIN_FRONTEND_ROOT}/incoming`, useSudo: true,
      remoteHelperFingerprint: sha256(adminHelperSource(environment)) }
  }
  const raw = existsSync(path) ? parseDotEnv(readFileSync(path, 'utf8')) : {}
  const allowed = new Set(['ADMIN_FRONTEND_DEPLOY_TARGET', 'ADMIN_FRONTEND_SSH_PORT', 'ADMIN_FRONTEND_SSH_IDENTITY_FILE'])
  for (const key of Object.keys(raw)) if (!allowed.has(key)) fail(`不支持的管理后台发布配置：${key}`)
  const target = raw.ADMIN_FRONTEND_DEPLOY_TARGET || 'ubuntu@132.232.220.115'
  // This implementation deliberately pins the approved test host, domain and independent paths.
  if (target !== 'ubuntu@132.232.220.115') fail('管理后台前端只允许已确认的测试服务器 ubuntu@132.232.220.115')
  const sshPort = Number(raw.ADMIN_FRONTEND_SSH_PORT || 22)
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) fail('SSH 端口非法')
  const identityFile = raw.ADMIN_FRONTEND_SSH_IDENTITY_FILE || join(homedir(), '.ssh/loumai_test_hexhub')
  if (!identityFile.startsWith('/') || !existsSync(identityFile) || !lstatSync(identityFile).isFile()) fail('SSH 私钥路径无效')
  return {
    target, sshPort, identityFile, environment: 'test', publicUrl: PUBLIC_URL,
    remoteHelper: REMOTE_HELPER, remoteStagingRoot: `${REMOTE_ROOT}/incoming`, useSudo: true,
    remoteHelperFingerprint: sha256(adminHelperSource()),
  }
}

export function commandFailureMessage(command, result) {
  // Certbot writes challenge details to stdout and its summary to stderr.
  // Keep both streams through SSH, including the installer's rollback/backup report.
  const details = [result.stdout, result.stderr, result.error?.message]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().slice(-16384))
    .join('\n')
  return `${command} 执行失败：${details || `exit=${result.status}, signal=${result.signal || 'none'}`}`
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: TOOL_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    timeout: 240_000, ...options,
  })
  if (result.error || result.status !== 0) fail(commandFailureMessage(command, result))
  return result.stdout || ''
}

function serverSetup(config, action) {
  const script = readFileSync(join(TOOL_ROOT, 'admin-frontend/remote/prepare-admin-frontend.py'), 'utf8')
  const command = ['sudo', '-n', '/usr/bin/python3', '-', action]
  if (action === 'prepare') command.push(Buffer.from(adminHelperSource()).toString('base64'))
  const output = run('ssh', [
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=12',
    '-p', String(config.sshPort), '-i', config.identityFile, config.target,
    command.map(shellQuote).join(' '),
  ], { input: script })
  process.stdout.write(output)
  return Object.fromEntries(output.split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
    const offset = line.indexOf('=')
    return [line.slice(0, offset), line.slice(offset + 1)]
  }))
}

export function normalizeAdminArtifact(outputDir, config = { environment: 'test', publicUrl: PUBLIC_URL }) {
  const production = config.environment === 'production'
  // A production build may be promoted to the test site, but its API must never
  // remain pointed at production. Only the two pinned, owned origins are rewritten.
  const allowedEndpoints = production
    ? [`${config.publicUrl}${API_BASE}`]
    : [LEGACY_API, `${PUBLIC_URL}${API_BASE}`, PRODUCTION_API]
  const files = validateExternalPackageArtifact(outputDir)
  if (!readFileSync(join(outputDir, 'index.html'), 'utf8').includes('<title>工位有方管理后台</title>')) {
    fail('这不是工位有方管理后台包；拒绝把业务 H5 或其他站点当后台部署')
  }
  let rewrites = 0
  let removedCompressed = 0
  for (const file of files) {
    if (/\.(gz|br)$/i.test(file.relative)) {
      // Deploy a verified uncompressed derivative; nginx does dynamic gzip.
      // Keeping precompressed siblings after URL normalization would serve stale API addresses.
      rmSync(file.absolute)
      removedCompressed += 1
      continue
    }
    if (!TEXT_FILE.test(file.relative)) continue
    const source = readFileSync(file.absolute, 'utf8')
    if (production && /https?:\/\/[^\s"'`<>\\/]*(?:test[.-]|[.-]test)[^\s"'`<>\\/]*/i.test(source)) {
      fail(`正式后台包含测试地址（${file.relative}）；请交付正式构建包，不自动转换测试包`)
    }
    const endpoints = [...source.matchAll(/https?:\/\/[^\s"'`<>\\]+\/admin-api\/api\/v1\b/g)].map((m) => m[0])
    for (const endpoint of endpoints) {
      if (!allowedEndpoints.includes(endpoint)) fail(`产物含非目标后台 API（${file.relative}）`)
    }
    let transformed = source
    for (const endpoint of allowedEndpoints) {
      rewrites += transformed.split(endpoint).length - 1
      transformed = transformed.replaceAll(endpoint, API_BASE)
    }
    if (source !== transformed) writeFileSync(file.absolute, transformed, 'utf8')
  }
  const artifact = validateArtifact(outputDir, {
    apiBaseUrl: API_BASE, expectedTitle: '工位有方管理后台', requireChannelStorageFix: false, environment: config.environment,
  })
  return { artifact, rewrites, removedCompressed }
}

export function importPackage(file, config = { environment: 'test', publicUrl: PUBLIC_URL }) {
  const packageInfo = inspectExternalPackage(file)
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'loumai-admin-package-'))
  try {
    const pinned = join(temporaryRoot, 'package.zip')
    copyFileSync(file, pinned)
    chmodSync(pinned, 0o600)
    if (sha256(readFileSync(pinned)) !== packageInfo.sha256) fail('压缩包在读取期间发生变化')
    const unpack = join(temporaryRoot, 'unpack')
    extractExternalPackage(pinned, unpack)
    const unpackRoot = resolveExternalPackageFrontendRoot(unpack)
    const outputDir = join(temporaryRoot, 'frontend')
    cpSync(unpackRoot, outputDir, { recursive: true, errorOnExist: true, force: false })
    const { artifact, rewrites, removedCompressed } = normalizeAdminArtifact(outputDir, config)
    const releaseId = createReleaseId(packageInfo.sha256.slice(0, 10))
    const metadata = {
      schema_version: 1, release_id: releaseId, commit: packageInfo.sha256.slice(0, 40),
      environment: config.environment, target: 'admin-frontend', public_url: config.publicUrl,
      api_base_url: API_BASE, built_at: new Date().toISOString(), index_sha256: artifact.indexSha256,
      source: { kind: 'external_zip', package_name: packageInfo.basename, package_sha256: packageInfo.sha256 },
      normalization: { version: 1, api_replacements: rewrites, removed_precompressed_files: removedCompressed },
    }
    writeFileSync(join(outputDir, 'release.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    const checksums = [...artifact.files.map(({ relative, absolute }) => `${sha256(readFileSync(absolute))}  ${relative}`),
      `${sha256(readFileSync(join(outputDir, 'release.json')))}  release.json`].sort()
    writeFileSync(join(outputDir, 'SHA256SUMS'), `${checksums.join('\n')}\n`)
    info(`压缩包校验通过：${packageInfo.basename}；${artifact.fileCount} 个发布文件；API 规范化 ${rewrites} 处`)
    info(`原 ZIP SHA256=${packageInfo.sha256}（原文件未修改）`)
    return {
      temporaryRoot, outputDir, releaseId, metadata, artifact, packageInfo,
      checksumsSha256: sha256(readFileSync(join(outputDir, 'SHA256SUMS'))),
    }
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

function persistRelease(release) {
  for (const path of [TOOL_ROOT, join(TOOL_ROOT, 'dist'), BUILD_ROOT]) {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path || !lstatSync(path).isDirectory()) {
      fail(`本地发布目录不是安全独立目录：${path}`)
    }
  }
  const target = join(BUILD_ROOT, release.releaseId)
  if (existsSync(target) || (() => { try { return lstatSync(target).isSymbolicLink() } catch { return false } })()) {
    fail('本地版本已存在，请稍后重试以生成新版本号')
  }
  mkdirSync(target, { mode: 0o700 })
  const outputDir = join(target, 'frontend')
  cpSync(release.outputDir, outputDir, { recursive: true, force: false, errorOnExist: true })
  return { ...release, outputDir }
}

function assertDns(state) {
  if (state.DNS_READY !== 'true') fail('请先在阿里云添加 A 记录：admin-test → 132.232.220.115；不要设置 AAAA。DNS 未就绪，未部署。')
}

function tests() {
  // This ZIP workflow tests shared validators through independent artifact fixtures.
  // It does not depend on the unrelated, possibly older business H5 source checkout.
  process.stdout.write(run(process.execPath, ['--test', 'tests/admin-frontend-release.test.mjs']))
}

function productionApiCheck(config) {
  const url = `${config.publicUrl}/admin-api`
  for (const path of ['/health', '/ready']) {
    const result = JSON.parse(run('curl', ['-fsS', '--connect-timeout', '5', '--max-time', '10', `${url}${path}`]))
    if (path === '/health' && (result.data?.status !== 'UP' || result.data?.service !== 'loumai-company-management')) fail('正式后台后端健康检查失败')
    if (path === '/ready' && (result.data?.status !== 'READY' || result.data?.schema_compatible !== true)) fail('正式后台数据库结构检查失败')
  }
  if (run('curl', ['-sS', '--max-time', '10', '-o', '/dev/null', '-w', '%{http_code}', `${url}/api/v1/admin-auth/me`]).trim() !== '401') fail('正式后台未登录保护必须返回 401')
}

function productionCommand(args, config) {
  if (args.command === 'prepare') {
    writeSetupBundle('admin-frontend-production-setup', {
      'loumai-admin-frontend-production-release': { text: adminHelperSource('production') },
      'admin-frontend-production-release.env': 'admin-frontend/remote/admin-frontend-production-release.env.example',
      'loumai-admin-production.conf': 'admin-frontend/remote/nginx-admin-production.conf.example',
      'loumai-admin-production-rate-limit.conf': 'admin-frontend/remote/nginx-admin-production-rate-limit.conf.example',
    }, { 'admin.example.com': new URL(config.publicUrl).hostname }, args)
    return
  }
  if (args.command === 'status') { status(config); return }
  tests()
  remotePreflight(config)
  productionApiCheck(config)
  if (args.command === 'rollback') { rollback(args, config); return }
  const release = importPackage(args.file, config)
  try {
    if (args.dryRun) { info('正式后台 ZIP 和服务器只读预检通过；未上传或切换版本'); return }
    deployRelease(args, config, persistRelease(release))
    info(`正式后台发布完成：${config.publicUrl}/#/login；release=${release.releaseId}`)
  } finally { rmSync(release.temporaryRoot, { recursive: true, force: true }) }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'help') {
    info(`管理后台前端独立发布（默认测试服；不部署业务 H5、不修改数据库）
  ./loumai-deploy admin-frontend check-package --file /绝对路径/后台.zip
  ./loumai-deploy admin-frontend deploy-package --file /绝对路径/后台.zip --dry-run
  ./loumai-deploy admin-frontend deploy-package --file /绝对路径/后台.zip --yes
  ./loumai-deploy admin-frontend prepare --yes
  ./loumai-deploy admin-frontend status
  ./loumai-deploy admin-frontend rollback --release RELEASE_ID --dry-run
  ./loumai-deploy admin-frontend rollback --release RELEASE_ID --yes
测试服首次发布自动初始化站点；正式服需 --env production 和独立配置。
正式服 prepare 只生成本机安装包；由管理员预装 Nginx、HTTPS、helper 后才可日常发布。`)
    return
  }
  if (args.command === 'check-package') {
    const config = args.environment === 'production' ? loadConfig(args.config, args.environment) : undefined
    const release = importPackage(args.file, config)
    rmSync(release.temporaryRoot, { recursive: true, force: true })
    info('仅本机验证，未连接或修改服务器')
    return
  }
  const config = loadConfig(args.config, args.environment)
  if (args.environment === 'production') { productionCommand(args, config); return }
  if (args.command === 'status') {
    const state = serverSetup(config, 'check')
    if (state.INITIALIZED === 'true') status(config)
    return
  }
  if (args.command === 'prepare') {
    tests()
    const state = serverSetup(config, 'check')
    assertDns(state)
    if (args.dryRun) { info('只读预检完成，未初始化服务器'); return }
    serverSetup(config, 'prepare')
    remotePreflight(config)
    return
  }
  if (args.command === 'rollback') {
    tests()
    const state = serverSetup(config, 'check')
    assertDns(state)
    if (state.INITIALIZED !== 'true') fail('后台前端尚未初始化，无法回滚')
    rollback(args, config)
    return
  }
  tests()
  const release = importPackage(args.file)
  try {
    const state = serverSetup(config, 'check')
    assertDns(state)
    if (args.dryRun) {
      if (state.INITIALIZED === 'true') remotePreflight(config)
      else info('首次发布需要自动初始化独立站点、HTTPS 和 helper')
      info('只读预演完成；未上传、未申请证书、未修改 Nginx 或切换版本')
      return
    }
    if (state.INITIALIZED !== 'true') serverSetup(config, 'prepare')
    // Even when already initialized, exact helper fingerprint + pinned target must match.
    remotePreflight(config)
    deployRelease(args, config, persistRelease(release))
    info(`发布完成：${PUBLIC_URL}/#/login；release=${release.releaseId}`)
  } finally {
    rmSync(release.temporaryRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { process.stderr.write(`[admin-frontend] ERROR: ${error.message}\n`); process.exitCode = 1 }
}
