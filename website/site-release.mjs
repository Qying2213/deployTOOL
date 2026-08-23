#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve4, resolve6 } from 'node:dns/promises'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_CONFIG_PATH = join(TOOL_ROOT, 'config', 'website.production.local.env')
export const DEFAULT_SITE_REPO_ROOT = resolve(TOOL_ROOT, '..', 'guanwang')
const REMOTE_HELPER_SOURCE = join(TOOL_ROOT, 'website', 'remote', 'workway-site-release')
const RELEASE_ROOT = join(TOOL_ROOT, 'dist', 'website')
const OLD_PUBLIC_URL = 'https://f.loumai.ai'
const DEFAULT_ICP_PLACEHOLDER = '蜀ICP备XXXXXX号'
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.map', '.svg', '.txt', '.xml'])

function fail(message) {
  throw new Error(message)
}

export function parseDotEnv(source) {
  const values = {}
  source.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (!match) fail(`配置第 ${index + 1} 行格式错误`)
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (/[$`]\(|`|\n|\r/.test(value)) fail(`配置 ${match[1]} 包含不安全内容`)
    values[match[1]] = value
  })
  return values
}

function optionValue(argv, index, option) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) fail(`${option} 缺少参数`)
  return value
}

export function parseArgs(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    return {
      command: 'help',
      configPath: DEFAULT_CONFIG_PATH,
      dryRun: false,
      help: true,
      releaseId: '',
      skipTests: false,
      yes: false,
    }
  }
  const parsed = {
    command: argv[0] || 'help',
    configPath: DEFAULT_CONFIG_PATH,
    dryRun: false,
    help: false,
    releaseId: '',
    skipTests: false,
    yes: false,
  }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--config') {
      parsed.configPath = resolve(optionValue(argv, index, arg))
      index += 1
    } else if (arg === '--release') {
      parsed.releaseId = optionValue(argv, index, arg)
      index += 1
    } else if (arg === '--dry-run') parsed.dryRun = true
    else if (arg === '--yes') parsed.yes = true
    else if (arg === '--skip-tests') parsed.skipTests = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else fail(`未知参数：${arg}`)
  }
  const commands = new Set(['build', 'deploy', 'enable-https', 'help', 'prepare', 'rollback', 'status'])
  if (!commands.has(parsed.command)) fail(`未知命令：${parsed.command}`)
  if (parsed.command === 'rollback' && !parsed.releaseId) fail('rollback 必须提供 --release RELEASE_ID')
  if (parsed.command !== 'rollback' && parsed.releaseId) fail('--release 只能用于 rollback')
  return parsed
}

function required(config, key) {
  const value = config[key]
  if (!value) fail(`配置缺少 ${key}`)
  return value
}

function booleanValue(value, fallback) {
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  fail(`布尔配置只能是 true/false：${value}`)
}

export function loadConfig(configPath) {
  if (!existsSync(configPath)) fail(`找不到配置：${configPath}\n请先复制 website.production.example.env`)
  const raw = parseDotEnv(readFileSync(configPath, 'utf8'))
  const publicUrl = required(raw, 'SITE_PUBLIC_URL').replace(/\/+$/, '')
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(publicUrl)) fail('SITE_PUBLIC_URL 必须是 HTTPS 根地址')
  const primaryDomain = new URL(publicUrl).hostname
  const remoteRoot = required(raw, 'SITE_REMOTE_ROOT')
  if (!/^\/[A-Za-z0-9._/-]+$/.test(remoteRoot) || remoteRoot.includes('..') || remoteRoot === '/') {
    fail('SITE_REMOTE_ROOT 不是安全绝对路径')
  }
  if (remoteRoot.includes('/loumai-h5') || remoteRoot.includes('/loumai-backend')) {
    fail('官网禁止复用测试 H5 或后端发布目录')
  }
  const config = {
    certbotEmail: raw.SITE_CERTBOT_EMAIL || '',
    deployTarget: required(raw, 'SITE_DEPLOY_TARGET'),
    expectedBranch: raw.SITE_EXPECTED_BRANCH || 'main',
    expectedIpv4: required(raw, 'SITE_EXPECTED_IPV4'),
    icpNumber: required(raw, 'SITE_ICP_NUMBER'),
    identityFile: raw.SITE_SSH_IDENTITY_FILE || '',
    leadEndpoint: raw.SITE_LEAD_ENDPOINT || '',
    primaryDomain,
    publicUrl,
    remoteHelper: raw.SITE_REMOTE_HELPER || '/usr/local/sbin/workway-site-release',
    remoteRoot,
    requireUpstreamMatch: booleanValue(raw.SITE_REQUIRE_UPSTREAM_MATCH, true),
    siteRepo: resolve(raw.SITE_REPO || DEFAULT_SITE_REPO_ROOT),
    sshPort: Number(raw.SITE_SSH_PORT || 22),
    wwwDomain: raw.SITE_WWW_DOMAIN || '',
  }
  if (!/^[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+$/.test(config.deployTarget)) {
    fail('SITE_DEPLOY_TARGET 必须是 user@host')
  }
  if (!Number.isInteger(config.sshPort) || config.sshPort < 1 || config.sshPort > 65535) fail('SSH 端口非法')
  if (!/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(config.expectedIpv4)
    || config.expectedIpv4.split('.').some((part) => Number(part) > 255)) {
    fail('SITE_EXPECTED_IPV4 格式非法')
  }
  if (config.wwwDomain && !/^[A-Za-z0-9.-]+$/.test(config.wwwDomain)) fail('SITE_WWW_DOMAIN 格式非法')
  if (config.wwwDomain && config.wwwDomain !== `www.${config.primaryDomain}`) {
    fail('SITE_WWW_DOMAIN 必须是主域名对应的 www 域名')
  }
  if (!/^\/[A-Za-z0-9._/-]+$/.test(config.remoteHelper) || config.remoteHelper.includes('..')) {
    fail('SITE_REMOTE_HELPER 不是安全绝对路径')
  }
  if (config.certbotEmail && !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(config.certbotEmail)) {
    fail('SITE_CERTBOT_EMAIL 格式非法')
  }
  if (config.leadEndpoint && !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(config.leadEndpoint)) {
    fail('SITE_LEAD_ENDPOINT 必须是完整 HTTPS 接口地址')
  }
  if (config.leadEndpoint && /(?:test\.|localhost|127\.0\.0\.1|192\.168\.)/i.test(config.leadEndpoint)) {
    fail('正式官网禁止使用测试或本地线索接口')
  }
  if (config.identityFile && (!existsSync(config.identityFile) || !lstatSync(config.identityFile).isFile())) {
    fail(`SSH 私钥文件不存在：${config.identityFile}`)
  }
  if (config.primaryDomain === 'test.yinlizhangyu.com' || config.wwwDomain === 'test.yinlizhangyu.com') {
    fail('官网配置禁止使用测试域名')
  }
  return config
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env || process.env,
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout || ''}${result.stderr || ''}`.trim() : ''
    fail(`${command} 执行失败${detail ? `：\n${detail}` : ''}`)
  }
  return options.capture ? result.stdout.trim() : ''
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function capture(command, args, cwd) {
  return run(command, args, { capture: true, cwd })
}

function git(config, ...args) {
  return capture('git', args, config.siteRepo)
}

function assertRepo(config) {
  if (!existsSync(join(config.siteRepo, '.git'))) fail(`官网仓库不存在：${config.siteRepo}`)
  for (const requiredPath of ['loumai-landlord/package-lock.json', 'loumai-landlord/vite.config.ts', 'loumai-ui']) {
    if (!existsSync(join(config.siteRepo, requiredPath))) fail(`官网仓库缺少：${requiredPath}`)
  }
  const branch = git(config, 'branch', '--show-current')
  if (branch !== config.expectedBranch) fail(`官网必须位于 ${config.expectedBranch}，当前是 ${branch}`)
  const dirty = git(config, 'status', '--porcelain')
  if (dirty) fail(`官网工作区不干净，正式发布前请提交：\n${dirty}`)
  const commit = git(config, 'rev-parse', 'HEAD')
  if (!/^[0-9a-f]{40}$/.test(commit)) fail('无法取得确定 Git commit')
  if (config.requireUpstreamMatch) {
    const upstream = git(config, 'rev-parse', '@{upstream}')
    if (upstream !== commit) fail('官网 HEAD 尚未与 upstream 同步，请先 push/pull')
  }
  return { branch, commit }
}

export function createReleaseId(commit, date = new Date()) {
  return `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${commit.slice(0, 10)}`
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function walkFiles(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const info = lstatSync(absolute)
      if (info.isSymbolicLink()) fail(`产物包含软链接：${relative(root, absolute)}`)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) files.push(absolute)
      else fail(`产物包含特殊文件：${relative(root, absolute)}`)
    }
  }
  visit(root)
  return files.sort()
}

function ensureLocalReleaseRoot() {
  const distRoot = join(TOOL_ROOT, 'dist')
  for (const directory of [distRoot, RELEASE_ROOT]) {
    if (existsSync(directory)) {
      const info = lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) fail(`本地构建目录不安全：${directory}`)
    } else {
      mkdirSync(directory, { mode: 0o755 })
    }
  }
  if (realpathSync(RELEASE_ROOT) !== RELEASE_ROOT) fail('本地构建目录包含软链接')
}

function extension(path) {
  const match = path.match(/(\.[A-Za-z0-9]+)$/)
  return match ? match[1].toLowerCase() : ''
}

function normalizeArtifact(root, config) {
  rmSync(join(root, 'mobile-site-preview.html'), { force: true })
  rmSync(join(root, 'site-embed'), { force: true, recursive: true })
  for (const file of walkFiles(root)) {
    if (!TEXT_EXTENSIONS.has(extension(file))) continue
    const source = readFileSync(file, 'utf8')
    const normalized = source
      .split(OLD_PUBLIC_URL).join(config.publicUrl)
      .split(DEFAULT_ICP_PLACEHOLDER).join(config.icpNumber)
    if (normalized !== source) writeFileSync(file, normalized, 'utf8')
  }
}

function validateLocalReferences(root) {
  const missing = []
  for (const file of walkFiles(root).filter((item) => extension(item) === '.html')) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(?:src|href)=["'](\/[^"'#?]+)(?:[?#][^"']*)?["']/g)) {
      const ref = match[1]
      if (!ref.includes('.') && !ref.startsWith('/assets/') && !ref.startsWith('/loumai-ui/')) continue
      const target = join(root, ref.replace(/^\/+/, ''))
      if (!existsSync(target)) missing.push(`${relative(root, file)} -> ${ref}`)
    }
  }
  for (const file of walkFiles(root).filter((item) => extension(item) === '.css')) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/url\(["']?(\/[^)'"?#]+)(?:[?#][^)'" ]*)?["']?\)/g)) {
      const ref = match[1]
      if (!existsSync(join(root, ref.replace(/^\/+/, '')))) {
        missing.push(`${relative(root, file)} -> ${ref}`)
      }
    }
  }
  if (missing.length) fail(`官网产物存在缺失资源：\n${missing.slice(0, 20).join('\n')}`)
}

export function validateArtifact(root, config) {
  const requiredPaths = [
    'index.html',
    'assets',
    'loumai-ui/landlord/channels.html',
    'loumai-ui/landlord/listings.html',
    'loumai-ui/agent/explore.html',
    'loumai-ui/booking.html',
    'robots.txt',
    'sitemap.xml',
  ]
  for (const item of requiredPaths) {
    if (!existsSync(join(root, item))) fail(`官网产物缺少：${item}`)
  }
  for (const forbidden of ['mobile-site-preview.html', 'site-embed', 'loumai-ui/docs', 'loumai-ui/scripts', 'loumai-ui/exports', 'loumai-ui/.cursor']) {
    if (existsSync(join(root, forbidden))) fail(`官网产物包含禁止内容：${forbidden}`)
  }
  const files = walkFiles(root)
  for (const file of files) {
    const artifactPath = relative(root, file).split(sep).join('/')
    if (!/^[A-Za-z0-9._/-]+$/.test(artifactPath) || artifactPath.includes('..')) {
      fail(`官网产物文件路径非法：${artifactPath}`)
    }
    const segments = artifactPath.split('/')
    if (segments.some((segment) => segment.startsWith('.'))) {
      fail(`官网产物包含隐藏文件：${artifactPath}`)
    }
    if (/\.(?:bak|db|env|key|p12|pem|pfx|sql|sqlite)$/i.test(artifactPath)) {
      fail(`官网产物包含敏感文件：${artifactPath}`)
    }
  }
  if (files.length < 50) fail(`官网产物文件数量异常：${files.length}`)
  const scan = files.filter((file) => TEXT_EXTENSIONS.has(extension(file)))
    .map((file) => readFileSync(file, 'utf8')).join('\n')
  if (scan.includes(OLD_PUBLIC_URL)) fail('官网产物仍包含旧域名 f.loumai.ai')
  if (scan.includes(DEFAULT_ICP_PLACEHOLDER)) fail('官网产物仍包含备案号占位符')
  if (!scan.includes(config.publicUrl)) fail('官网产物缺少目标正式域名')
  if (!scan.includes(config.icpNumber)) fail('官网产物缺少真实备案号')
  // React Router 自身包含精确的 `http://localhost` URL 解析回退；它不会发起请求。
  // 只允许这个精确常量，localhost 的端口/路径/参数和所有 RFC1918 地址都拒绝发布。
  const forbiddenNetworkAddress = new RegExp(
    String.raw`(?:https|wss?):\/\/localhost\b|http:\/\/localhost(?=[:/?#])|` +
      String.raw`(?:https?|wss?):\/\/(?:127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?`,
    'i',
  )
  if (forbiddenNetworkAddress.test(scan)) {
    fail('官网产物包含本地或局域网地址')
  }
  const bundleText = files.filter((file) => file.includes(`${sep}assets${sep}`) && extension(file) === '.js')
    .map((file) => readFileSync(file, 'utf8')).join('\n')
  if (!bundleText.includes('/loumai-ui/landlord/channels.html')) fail('官网 JS 未引用真实 loumai-ui')
  if (bundleText.includes('/site-embed/')) fail('官网 JS 仍引用旧 site-embed')
  if (config.leadEndpoint) {
    if (!bundleText.includes(config.leadEndpoint)) fail('官网 JS 未包含已配置的线索接收接口')
  } else if (!bundleText.includes('lead endpoint not configured')) {
    fail('官网缺少“未配置线索接口时明确失败”的保护')
  }
  validateLocalReferences(root)
  return { fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + statSync(file).size, 0) }
}

function writeReleaseFiles(siteRoot, metadata) {
  const indexSha = sha256File(join(siteRoot, 'index.html'))
  const releaseJson = {
    release_id: metadata.releaseId,
    commit: metadata.commit,
    branch: metadata.branch,
    built_at: new Date().toISOString(),
    public_url: metadata.publicUrl,
    index_sha256: indexSha,
  }
  writeFileSync(join(siteRoot, 'release.json'), `${JSON.stringify(releaseJson, null, 2)}\n`, 'utf8')
  const lines = walkFiles(siteRoot)
    .filter((file) => file !== join(siteRoot, 'SHA256SUMS'))
    .map((file) => `${sha256File(file)}  ${relative(siteRoot, file).split(sep).join('/')}`)
  writeFileSync(join(siteRoot, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8')
  return {
    indexSha,
    checksumsSha: sha256File(join(siteRoot, 'SHA256SUMS')),
  }
}

export function buildRelease(config, { skipTests = false } = {}) {
  const repo = assertRepo(config)
  ensureLocalReleaseRoot()
  const releaseId = createReleaseId(repo.commit)
  const releaseDir = join(RELEASE_ROOT, releaseId)
  const siteRoot = join(releaseDir, 'site')
  const archive = join(releaseDir, 'site.tar')
  if (dirname(releaseDir) !== RELEASE_ROOT || !/^\d{8}T\d{6}Z-[0-9a-f]{10}$/.test(releaseId)) {
    fail('拒绝清理非官网构建目录')
  }
  if (existsSync(releaseDir) && lstatSync(releaseDir).isSymbolicLink()) fail('官网构建版本目录不能是软链接')
  rmSync(releaseDir, { force: true, recursive: true })
  mkdirSync(siteRoot, { recursive: true })
  const appRoot = join(config.siteRepo, 'loumai-landlord')
  if (!skipTests) run('npm', ['ci'], { cwd: appRoot })
  const buildEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_')),
  )
  run('npm', ['run', 'build'], {
    cwd: appRoot,
    env: { ...buildEnv, COPYFILE_DISABLE: '1', VITE_LEAD_ENDPOINT: config.leadEndpoint },
  })
  cpSync(join(appRoot, 'dist'), siteRoot, { recursive: true, force: true })
  normalizeArtifact(siteRoot, config)
  const artifact = validateArtifact(siteRoot, config)
  const hashes = writeReleaseFiles(siteRoot, {
    ...repo,
    publicUrl: config.publicUrl,
    releaseId,
  })
  validateArtifact(siteRoot, config)
  run('tar', ['-cf', archive, '-C', siteRoot, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1', TAR_OPTIONS: '' },
  })
  return {
    ...repo,
    ...hashes,
    ...artifact,
    archive,
    archiveSha: sha256File(archive),
    releaseDir,
    releaseId,
    siteRoot,
  }
}

function sshBaseArgs(config) {
	const args = [
		'-p', String(config.sshPort),
		'-o', 'BatchMode=yes',
		'-o', 'StrictHostKeyChecking=yes',
		'-o', 'ConnectTimeout=10',
		'-o', 'ServerAliveInterval=15',
		'-o', 'ServerAliveCountMax=12',
		'-o', 'TCPKeepAlive=yes',
	]
	if (config.identityFile) args.push('-i', config.identityFile)
	return args
}

function scpBaseArgs(config) {
	const args = [
		'-P', String(config.sshPort),
		'-o', 'BatchMode=yes',
		'-o', 'StrictHostKeyChecking=yes',
		'-o', 'ConnectTimeout=10',
		'-o', 'ServerAliveInterval=15',
		'-o', 'ServerAliveCountMax=12',
		'-o', 'TCPKeepAlive=yes',
	]
	if (config.identityFile) args.push('-i', config.identityFile)
	return args
}

function remote(config, args, { captureOutput = true } = {}) {
  return run('ssh', [...sshBaseArgs(config), config.deployTarget, 'sudo', '-n', config.remoteHelper, ...args], {
    capture: captureOutput,
  })
}

function remoteHelperInstalled(config) {
  const result = spawnSync('ssh', [
    ...sshBaseArgs(config),
    config.deployTarget,
    'test',
    '-x',
    config.remoteHelper,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status === 0) return true
  if (result.status === 1) return false
  fail(`无法检查服务器官网 helper：${`${result.stdout || ''}${result.stderr || ''}`.trim()}`)
}

function configShellValue(value) {
  if (!/^[A-Za-z0-9@._:/-]*$/.test(value)) fail(`服务器配置值包含不安全字符：${value}`)
  return value
}

function installRemoteHelper(config) {
  if (!existsSync(REMOTE_HELPER_SOURCE)) fail(`缺少远端 helper：${REMOTE_HELPER_SOURCE}`)
  const nonce = `${process.pid}-${Date.now()}`
  const remoteHelperTmp = `/tmp/workway-site-release.${nonce}`
  const remoteConfigTmp = `/tmp/workway-site-release.env.${nonce}`
  const localConfigTmp = join(RELEASE_ROOT, `.remote-config.${nonce}`)
  mkdirSync(RELEASE_ROOT, { recursive: true })
  const lines = [
    `WORKWAY_SITE_REMOTE_ROOT=${configShellValue(config.remoteRoot)}`,
    `WORKWAY_SITE_PRIMARY_DOMAIN=${configShellValue(config.primaryDomain)}`,
    `WORKWAY_SITE_WWW_DOMAIN=${configShellValue(config.wwwDomain)}`,
    `WORKWAY_SITE_EXPECTED_IPV4=${configShellValue(config.expectedIpv4)}`,
    `WORKWAY_SITE_DEPLOY_USER=${configShellValue(config.deployTarget.split('@')[0])}`,
    `WORKWAY_SITE_CERTBOT_EMAIL=${configShellValue(config.certbotEmail)}`,
  ]
  writeFileSync(localConfigTmp, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    run('scp', [...scpBaseArgs(config), REMOTE_HELPER_SOURCE, `${config.deployTarget}:${remoteHelperTmp}`])
    run('scp', [...scpBaseArgs(config), localConfigTmp, `${config.deployTarget}:${remoteConfigTmp}`])
    const installCommand = [
      `install -o root -g root -m 0755 ${remoteHelperTmp} ${config.remoteHelper}`,
      `install -o root -g root -m 0600 ${remoteConfigTmp} /etc/workway-site-release.env`,
      `rm -f ${remoteHelperTmp} ${remoteConfigTmp}`,
    ].join(' && ')
    run('ssh', [
      ...sshBaseArgs(config),
      config.deployTarget,
      `sudo -n /bin/bash -c ${shellQuote(installCommand)}`,
    ])
  } finally {
    rmSync(localConfigTmp, { force: true })
  }
}

function currentFromStatus(status) {
	const line = status.split(/\r?\n/).find((item) => item.startsWith('CURRENT='))
	return line ? line.slice('CURRENT='.length) : 'NONE'
}

function assertWebsiteReadyForDeploy(config) {
	if (!remoteHelperInstalled(config)) {
		fail('官网尚未初始化，请先执行 website prepare --yes')
	}
	const status = remote(config, ['status'])
	if (currentFromStatus(status) === 'NONE') {
		fail('官网还没有受控版本，请先执行 website prepare --yes')
	}
	if (!status.split(/\r?\n/).includes('HTTPS=enabled')) {
		fail('官网 HTTPS 尚未就绪，请先执行 website enable-https --yes')
	}
	return status
}

async function dnsAnswers(domain, family) {
  try {
    return family === 4 ? await resolve4(domain) : await resolve6(domain)
  } catch (error) {
    if (error?.code === 'ENODATA' || error?.code === 'ENOTFOUND') return []
    fail(`DNS 查询失败：${domain}（IPv${family}）`)
  }
}

export async function assertDnsReady(config) {
  for (const domain of [config.primaryDomain, config.wwwDomain].filter(Boolean)) {
    const ipv4 = [...new Set(await dnsAnswers(domain, 4))].sort()
    const ipv6 = [...new Set(await dnsAnswers(domain, 6))].sort()
    if (ipv4.length !== 1 || ipv4[0] !== config.expectedIpv4) {
      fail(`${domain} 当前解析为 ${ipv4.join(', ') || '无 A 记录'}，必须只保留 ${config.expectedIpv4}`)
    }
    if (ipv6.length) fail(`${domain} 仍有 AAAA 记录 ${ipv6.join(', ')}，当前服务器未配置 IPv6`)
  }
}

function uploadAndActivate(config, release) {
  const status = remote(config, ['status'])
  const expectedCurrent = currentFromStatus(status)
  const prepare = remote(config, ['prepare', release.releaseId])
  const stageLine = prepare.split(/\r?\n/).find((item) => item.startsWith('STAGE_DIR='))
  if (!stageLine) fail('服务器没有返回暂存目录')
  const stageDir = stageLine.slice('STAGE_DIR='.length)
  try {
    run('scp', [...scpBaseArgs(config), release.archive, `${config.deployTarget}:${stageDir}/site.tar`])
    remote(config, [
      'activate',
      release.releaseId,
      release.commit,
      release.indexSha,
      release.checksumsSha,
      release.archiveSha,
      expectedCurrent,
    ], { captureOutput: false })
  } catch (error) {
    try { remote(config, ['abort', release.releaseId]) } catch {}
    throw error
  }
}

function ensureYes(args, action) {
  if (!args.yes) fail(`${action} 会修改服务器，请加 --yes 明确确认`)
}

function printHelp() {
  process.stdout.write(`官网一键部署工具\n\n`)
  process.stdout.write(`  ./loumai-deploy website build\n`)
  process.stdout.write(`  ./loumai-deploy website prepare --yes\n`)
  process.stdout.write(`  ./loumai-deploy website enable-https --yes\n`)
  process.stdout.write(`  ./loumai-deploy website deploy --yes\n`)
  process.stdout.write(`  ./loumai-deploy website status\n`)
  process.stdout.write(`  ./loumai-deploy website rollback --release RELEASE_ID --yes\n`)
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help || args.command === 'help') {
    printHelp()
    return
  }
  const config = loadConfig(args.configPath)
  if (args.command === 'status') {
    if (!remoteHelperInstalled(config)) {
      process.stdout.write('INITIALIZED=false\nCURRENT=NONE\n请先执行 website prepare --yes 初始化官网发布器。\n')
      return
    }
    const output = remote(config, ['status'])
    process.stdout.write(`${output}\n`)
    return
  }
	if (args.command === 'enable-https') {
		if (args.dryRun) {
			if (!remoteHelperInstalled(config)) fail('服务器官网发布器尚未初始化，请先执行 prepare --yes')
			await assertDnsReady(config)
			process.stdout.write(`${remote(config, ['status'])}\nDRY RUN：DNS 已就绪，未申请证书。\n`)
      return
    }
    ensureYes(args, '启用 HTTPS')
    await assertDnsReady(config)
    installRemoteHelper(config)
    remote(config, ['enable-https'], { captureOutput: false })
    return
  }
  if (args.command === 'rollback') {
    if (args.dryRun) {
      if (!remoteHelperInstalled(config)) fail('服务器官网发布器尚未初始化，请先执行 prepare --yes')
      const status = remote(config, ['status'])
      const expectedCurrent = currentFromStatus(status)
      const checked = remote(config, ['check-release', args.releaseId, expectedCurrent])
      process.stdout.write(`${status}\n${checked}\nDRY RUN：目标版本与哈希有效，未执行回滚。\n`)
      return
    }
    ensureYes(args, '官网回滚')
    installRemoteHelper(config)
    const status = remote(config, ['status'])
    remote(config, ['rollback', args.releaseId, currentFromStatus(status)], { captureOutput: false })
    return
  }
	if ((args.command === 'prepare' || args.command === 'deploy') && args.skipTests) {
		fail(`${args.command} 禁止 --skip-tests`)
	}
	if (args.command === 'deploy') assertWebsiteReadyForDeploy(config)
	const release = buildRelease(config, { skipTests: args.skipTests })
  process.stdout.write(`构建完成：${release.releaseId}（${release.fileCount} 个文件）\n`)
  if (args.command === 'build' || args.dryRun) {
    if (args.dryRun) process.stdout.write('DRY RUN：未上传、未修改服务器。\n')
    return
  }
	ensureYes(args, args.command === 'deploy' ? '官网发布' : '官网预部署')
	installRemoteHelper(config)
	uploadAndActivate(config, release)
	process.stdout.write(`官网版本已部署：${release.releaseId}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`)
    process.exitCode = 1
  })
}
