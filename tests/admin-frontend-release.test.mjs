import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  API_BASE, LEGACY_API, PRODUCTION_API, PUBLIC_URL, REMOTE_ROOT, TOOL_ROOT,
  adminHelperSource, commandFailureMessage, importPackage, loadConfig, normalizeAdminArtifact, parseArgs,
} from '../admin-frontend/admin-frontend-release.mjs'

const hash = (data) => createHash('sha256').update(data).digest('hex')
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'loumai-admin-test-'))
  try { fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}
function artifact(root, api = LEGACY_API) {
  const output = join(root, 'web')
  mkdirSync(join(output, 'assets'), { recursive: true })
  writeFileSync(join(output, 'index.html'), '<title>工位有方管理后台</title><script type="module" src="/assets/index-Hash123.js"></script>')
  writeFileSync(join(output, 'assets/index-Hash123.js'), `const api=${JSON.stringify(api)};`)
  for (let i = 0; i < 8; i += 1) writeFileSync(join(output, `assets/chunk-${i}.js`), `export default ${i}`)
  writeFileSync(join(output, 'assets/_...all_-Hash123.js'), 'export default 0')
  return output
}
function python(code, args) {
  const result = spawnSync('python3', ['-c', code, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}
function makeZip(output, zip) {
  python('import pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w") as z:\n for f in sorted(p.rglob("*")):\n  if f.is_file(): z.write(f,"dist/"+f.relative_to(p).as_posix())\n z.writestr("__MACOSX/._ignored","metadata")', [output, zip])
}

test('SSH 失败同时保留安装备份位置、Certbot 验证原因和错误摘要', () => {
  const message = commandFailureMessage('ssh', {
    status: 1,
    stdout: 'CONFIG_BACKUP=/var/backups/loumai-admin-frontend/prepare-test\n',
    stderr: 'DNS problem: SERVFAIL looking up CAA for admin-test.yinlizhangyu.com\nSome challenges have failed.\n',
  })
  assert.match(message, /CONFIG_BACKUP=/)
  assert.match(message, /SERVFAIL looking up CAA/)
  assert.match(message, /Some challenges have failed/)
  assert.match(commandFailureMessage('ssh', { status: null, error: new Error('ETIMEDOUT') }), /ETIMEDOUT/)
  assert.match(commandFailureMessage('ssh', { status: 2 }), /exit=2/)
})

test('后台前端默认 test，正式服须显式选择，真实操作必须明确确认', () => {
  assert.equal(parseArgs(['--help']).command, 'help')
  assert.equal(parseArgs(['deploy-package', '--file', '/tmp/admin.zip', '--dry-run']).dryRun, true)
  for (const command of ['prepare', 'deploy-package']) {
    const args = command === 'prepare' ? [command] : [command, '--file', '/tmp/admin.zip']
    assert.throws(() => parseArgs(args), /--yes/)
    assert.equal(parseArgs([...args, '--yes']).yes, true)
  }
  assert.equal(parseArgs(['prepare', '--env', 'production', '--yes']).environment, 'production')
  assert.throws(() => parseArgs(['prepare', '--env', 'staging', '--yes']), /只能为/)
  assert.throws(() => parseArgs(['rollback', '--release', '../bad', '--yes']), /合法/)
  assert.throws(() => parseArgs(['deploy-package', '--file', '--yes']), /缺少参数/)
  assert.throws(() => parseArgs(['prepare', '--skip-tests', '--yes']), /未知参数/)
})

test('SSH 配置锁定测试 IP，禁止配置覆盖域名和发布目录', () => fixture((root) => {
  const key = join(root, 'test-key')
  const config = join(root, 'test.env')
  writeFileSync(key, 'not-a-real-key')
  writeFileSync(config, `ADMIN_FRONTEND_SSH_IDENTITY_FILE=${key}\n`)
  const result = loadConfig(config)
  assert.equal(result.target, 'ubuntu@132.232.220.115')
  assert.equal(result.publicUrl, PUBLIC_URL)
  assert.equal(result.remoteStagingRoot, `${REMOTE_ROOT}/incoming`)
  assert.equal(result.remoteHelperFingerprint, hash(adminHelperSource()))
  writeFileSync(config, `ADMIN_FRONTEND_DEPLOY_TARGET=ubuntu@139.155.246.46\n`)
  assert.throws(() => loadConfig(config), /已确认的测试服务器/)
  writeFileSync(config, 'H5_REMOTE_ROOT=/srv/loumai-h5\n')
  assert.throws(() => loadConfig(config), /不支持/)
}))

test('旧测试 API 在派生副本中改为同源，并删除失效的 gzip/brotli 兄弟文件', () => fixture((root) => {
  const output = artifact(root)
  writeFileSync(join(output, 'assets/index-Hash123.js.gz'), 'old-gzip')
  writeFileSync(join(output, 'assets/index-Hash123.js.br'), 'old-brotli')
  const result = normalizeAdminArtifact(output)
  assert.equal(result.rewrites, 1)
  assert.equal(result.removedCompressed, 2)
  assert.equal(result.artifact.fileCount, 11)
  assert.match(readFileSync(join(output, 'assets/index-Hash123.js'), 'utf8'), /"\/admin-api\/api\/v1"/)
  assert.ok(!existsSync(join(output, 'assets/index-Hash123.js.gz')))
  assert.ok(!existsSync(join(output, 'assets/index-Hash123.js.br')))
}))

test('已使用同源 API 的新包可直接导入，无需再次改前端', () => fixture((root) => {
  assert.equal(normalizeAdminArtifact(artifact(root, API_BASE)).rewrites, 0)
}))

test('正式构建包发布到测试服时只把已确认的正式后台 API 改为测试同源', () => fixture((root) => {
  const output = artifact(root, PRODUCTION_API)
  const result = normalizeAdminArtifact(output)
  assert.equal(result.rewrites, 1)
  assert.match(readFileSync(join(output, 'assets/index-Hash123.js'), 'utf8'), /"\/admin-api\/api\/v1"/)
  assert.doesNotMatch(readFileSync(join(output, 'assets/index-Hash123.js'), 'utf8'), /admin\.yinlizhangyu\.com/)
}))

test('业务 H5、其他 API、SourceMap 和隐藏密钥均被后台产物门禁拒绝', () => {
  for (const invalid of ['title', 'api', 'map', 'env', 'lan', 'missing']) fixture((root) => {
    const output = artifact(root, invalid === 'api' ? 'https://unknown.example/admin-api/api/v1' : LEGACY_API)
    if (invalid === 'title') writeFileSync(join(output, 'index.html'), '<title>工位有方</title>')
    if (invalid === 'map') writeFileSync(join(output, 'assets/code.js.map'), '{}')
    if (invalid === 'env') writeFileSync(join(output, '.env'), 'SECRET=not-real')
    if (invalid === 'lan') writeFileSync(join(output, 'assets/lan.js'), 'const api="http://192.168.1.15:8100/api/v1";')
    if (invalid === 'missing') rmSync(join(output, 'assets/index-Hash123.js'))
    assert.throws(() => normalizeAdminArtifact(output))
  })
})

test('ZIP 导入保留原文件，生成独立后台清单与逐文件哈希，允许 Vue 合法三点文件名', () => fixture((root) => {
  const output = artifact(root)
  const zip = join(root, 'admin.zip')
  makeZip(output, zip)
  const original = hash(readFileSync(zip))
  const release = importPackage(zip)
  try {
    assert.equal(hash(readFileSync(zip)), original)
    assert.equal(release.metadata.source.package_sha256, original)
    assert.equal(release.metadata.target, 'admin-frontend')
    assert.equal(release.metadata.public_url, PUBLIC_URL)
    assert.equal(release.metadata.environment, 'test')
    assert.equal(release.checksumsSha256, hash(readFileSync(join(release.outputDir, 'SHA256SUMS'))))
    for (const line of readFileSync(join(release.outputDir, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
      const [expected, path] = line.split('  ')
      assert.equal(hash(readFileSync(join(release.outputDir, path))), expected)
    }
    assert.match(readFileSync(join(output, 'assets/index-Hash123.js'), 'utf8'), /https:\/\/test/)
    assert.ok(existsSync(join(release.outputDir, 'assets/_...all_-Hash123.js')))
  } finally { rmSync(release.temporaryRoot, { recursive: true, force: true }) }
}))

test('ZIP 路径穿越及软链接在解压前被拒绝', () => fixture((root) => {
  for (const kind of ['traversal', 'symlink']) {
    const zip = join(root, `${kind}.zip`)
    python('import sys,stat,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n if sys.argv[2]=="traversal": z.writestr("../outside","bad")\n else:\n  i=zipfile.ZipInfo("dist/link");i.create_system=3;i.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(i,"../../outside")', [zip, kind])
    assert.throws(() => importPackage(zip), /路径穿越|软链接或特殊文件/)
  }
  assert.equal(existsSync(join(root, 'outside')), false)
}))

test('独立 helper 通过 Bash 语法检查，保留 CAS、哈希和失败自动回滚', () => {
  const helper = adminHelperSource()
  const syntax = spawnSync('bash', ['-n'], { input: helper, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
  assert.match(helper, /CONFIG_FILE="\/etc\/loumai\/admin-frontend-release.env"/)
  assert.match(helper, /禁止接管业务 H5 或正式服/)
  assert.match(helper, /sha256sum -c/)
  assert.match(helper, /frontend-current 已被其他发布修改/)
  assert.match(helper, /arm_current_rollback/)
  assert.match(helper, /public_verify/)
  assert.doesNotMatch(helper, /readonly CONFIG_FILE="\/etc\/loumai\/h5-release.env"/)
  assert.ok(helper.includes('[[ "/$relative/" != *"/../"* && "/$relative/" != *"/./"* ]]'))
  const traversal = spawnSync('bash', ['-c', 'for relative in assets/../bad ./bad ../bad; do [[ "/$relative/" != *"/../"* && "/$relative/" != *"/./"* ]] && exit 1; done; relative=assets/_...all_-hash.js; [[ "/$relative/" != *"/../"* && "/$relative/" != *"/./"* ]]'])
  assert.equal(traversal.status, 0)
})

test('服务器初始化、DNS、认证边界及失败恢复通过隔离 Python 测试', () => {
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_admin_frontend_setup.py', '-v'], {
    cwd: TOOL_ROOT, encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('CLI 缺少确认时在连接服务器前失败', () => {
  const result = spawnSync('bash', ['loumai-deploy', 'admin-frontend', 'prepare'], { cwd: TOOL_ROOT, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--yes/)
  assert.doesNotMatch(result.stdout, /DNS_READY|INITIALIZED/)
})
