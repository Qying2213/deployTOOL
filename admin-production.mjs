import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TOOL_ROOT = dirname(fileURLToPath(import.meta.url))
export const ADMIN_BACKEND_ROOT = '/srv/loumai-company-management-production'
export const ADMIN_FRONTEND_ROOT = '/srv/loumai-admin-frontend-production'
export const ADMIN_BACKEND_HELPER = '/usr/local/sbin/loumai-company-management-production-release'
export const ADMIN_FRONTEND_HELPER = '/usr/local/sbin/loumai-admin-frontend-production-release'

export function productionOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('必须填写正式管理后台 HTTPS 域名') }
  if (url.protocol !== 'https:' || url.port || url.pathname !== '/' || url.search || url.hash
    || url.username || url.password || isIP(url.hostname) || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(url.hostname)
    || /(^|[.-])(test|localhost|example|invalid)([.-]|$)/i.test(url.hostname)) {
    throw new Error('正式管理后台必须使用真实 HTTPS 根域名，禁止测试域名、IP、占位符和自定义端口')
  }
  return url.origin
}

export function productionSsh(raw, prefix) {
  const target = raw[`${prefix}_DEPLOY_TARGET`] || ''
  if (!/^loumai-deploy@[A-Za-z0-9.-]+$/.test(target)
    || /132\.232\.220\.115|production-server|example|localhost|test/i.test(target)) {
    throw new Error('正式服必须显式配置独立 loumai-deploy@正式服地址，禁止测试服务器和管理员账号')
  }
  const port = Number(raw[`${prefix}_SSH_PORT`] || 22)
  const identity = raw[`${prefix}_SSH_IDENTITY_FILE`] || ''
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口非法')
  if (!identity.startsWith('/') || !existsSync(identity) || !lstatSync(identity).isFile()) {
    throw new Error('必须配置存在的正式服 SSH 私钥绝对路径（不能填写私钥内容）')
  }
  return { target, port, identity }
}

export function assertConfigKeys(raw, allowed) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new Error(`不支持的正式部署配置字段：${key}；禁止存放应用密钥`)
  }
}

// A prepare command only builds a local, reviewable installation bundle. It never
// runs an uploaded script as root, issues certificates, or installs remote helpers.
export function writeSetupBundle(name, mapping, replacements, { dryRun = false } = {}) {
  if (dryRun) {
    process.stdout.write(`将生成本机 ${name} 安装包；不连接或修改服务器\n`)
    return null
  }
  const dist = join(TOOL_ROOT, 'dist')
  if (!existsSync(dist)) mkdirSync(dist, { mode: 0o700 })
  if (realpathSync(dist) !== dist || !lstatSync(dist).isDirectory()) throw new Error('本机 dist 目录不安全')
  const root = mkdtempSync(join(dist, `${name}-`))
  for (const [target, source] of Object.entries(mapping)) {
    let text = typeof source === 'object' ? source.text : readFileSync(resolve(TOOL_ROOT, source), 'utf8')
    for (const [from, to] of Object.entries(replacements)) text = text.replaceAll(from, to)
    writeFileSync(join(root, target), text, { mode: 0o600, flag: 'wx' })
  }
  process.stdout.write(`本机安装包：${root}\n仅生成文件；须由管理员核验后按正式服文档安装。没有连接服务器。\n`)
  return root
}
