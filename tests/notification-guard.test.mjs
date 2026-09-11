import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { readExpiryPlan, observeNotificationAcceptance } from '../backend/notification-health.mjs'
import { parseArgs } from '../backend/backend-release.mjs'

const helper = readFileSync(new URL('../backend/remote/loumai-backend-release', import.meta.url), 'utf8')
const functions = helper.slice(helper.indexOf('notification_guard_supported()'), helper.indexOf('notification_status_for_release()'))
function shell(body, env = {}) {
  return spawnSync('/bin/bash', ['-c', 'set -eu\nfail() { echo "$*" >&2; exit 1; }\n' + functions + body],
                   { encoding: 'utf8', env: { ...process.env, ...env } })
}
function guarded(root) {
  for (const path of ['app/modules/notifications/delivery_freshness.py',
      'scripts/expire_stale_notification_deliveries.py', 'scripts/check_notification_health.py']) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), '# test')
  }
}

test('plan requires exact environment, cutoff, target, policy and maximum', () => {
  const root = mkdtempSync(join(tmpdir(), 'notification-plan-'))
  try {
    const path = join(root, 'plan.json')
    const plan = { cutoff: '2026-01-01T00:00:00Z', environment: 'test', target: 'a'.repeat(64),
                   policy_version: 'P1-NOTIF-07-R2-v1', max_records: 20 }
    writeFileSync(path, JSON.stringify(plan))
    assert.deepEqual(JSON.parse(Buffer.from(readExpiryPlan(path, 'test'), 'base64')), plan)
    assert.throws(() => readExpiryPlan(path, 'production'))
    for (const change of [{ max_records: -1 }, { cutoff: '2026-01-01' }, { target: 'wrong' },
                          { policy_version: 'old' }, { extra: 'unapproved' }]) {
      writeFileSync(path, JSON.stringify({ ...plan, ...change }))
      assert.throws(() => readExpiryPlan(path, 'test'))
    }
    assert.equal(readExpiryPlan('', 'test'), 'NONE')
    assert.equal(parseArgs(['deploy', '--notification-expiry-plan', path]).notificationExpiryPlan, path)
    assert.throws(() => parseArgs(['deploy', '--notification-expiry-plan']))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('passive acceptance handles two-completion report and bounded pending without side effects', () => {
  let calls = 0
  let sleeps = 0
  const result = observeNotificationAcceptance({ sample: () => (++calls === 3
    ? { RELEASE_ACCEPTANCE: 'PASSED' } : { RELEASE_ACCEPTANCE: 'PENDING', NOTIFICATION_HEALTH: 'RUNNING' }),
    sleep: ms => { assert.equal(ms, 10000); sleeps++ } })
  assert.equal(result.RELEASE_ACCEPTANCE, 'PASSED')
  assert.equal(sleeps, 2)
  calls = 0
  const pending = observeNotificationAcceptance({ maxSamples: 2, sample: () => {
    calls++; return { RELEASE_ACCEPTANCE: 'PENDING' }
  }, sleep: () => {} })
  assert.equal(calls, 2)
  assert.equal(pending.RELEASE_ACCEPTANCE, 'PENDING')
  const failed = observeNotificationAcceptance({ sample: () => { throw new Error('ssh unavailable') },
    sleep: () => assert.fail('no repeat after inaccessible host') })
  assert.equal(failed.NOTIFICATION_HEALTH, 'UNKNOWN')
})

test('unsupported old backend allows helper preflight, guarded downgrade rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'notification-helper-'))
  try {
    guarded(join(root, 'new'))
    assert.equal(shell('notification_release_preflight "$OLD" NONE', { OLD: join(root, 'old') }).status, 0)
    const blocked = shell('assert_notification_guard_retained "$NEW" "$OLD"',
      { NEW: join(root, 'new'), OLD: join(root, 'old') })
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /缺少通知时效保护/)
    assert.equal(shell('assert_notification_guard_retained "$OLD" "$NEW"',
      { NEW: join(root, 'new'), OLD: join(root, 'old') }).status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('preflight refuses unapproved, unknown, invalid and incomplete queues before writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'notification-preview-'))
  try {
    guarded(root)
    const clean = { environment: 'test', complete: true, expired: 0, uncovered_old: 0, invalid: 0 }
    const code = 'run_in_release() { printf "%s\\n" "$REPORT"; }\nnotification_release_preflight "$ROOT" "$PLAN"'
    for (const [report, plan, expected] of [
      [clean, 'NONE', 0], [{ ...clean, expired: 4 }, 'NONE', 1],
      [{ ...clean, expired: 4 }, 'approved-plan', 0],
      [{ ...clean, uncovered_old: 1 }, 'approved-plan', 1],
      [{ ...clean, invalid: 1 }, 'approved-plan', 1],
      [{ ...clean, complete: false }, 'approved-plan', 1],
      [{ ...clean, environment: 'production' }, 'approved-plan', 1]
    ]) {
      const result = shell(code, { ROOT: root, PLAN: plan, REPORT: JSON.stringify(report), ENVIRONMENT: 'test' })
      assert.equal(result.status, expected, result.stderr)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cleanup does not claim completion with locked leftovers', () => {
  const code = 'run_in_release() { printf "%s\\n" "$REPORT"; }\nnotification_release_cleanup /fake approved backup'
  assert.equal(shell(code, { REPORT: JSON.stringify({ remaining_complete: true, remaining_expired: 0 }) }).status, 0)
  assert.equal(shell(code, { REPORT: JSON.stringify({ remaining_complete: true, remaining_expired: 1 }) }).status, 1)
})

test('deployment ordering keeps cleanup backed up and notification health outside recovery trap', () => {
  const activate = helper.slice(helper.indexOf('action_activate()'), helper.indexOf('action_rollback()'))
  const body = activate.slice(activate.indexOf('trap activation_failure'))
  const preview = body.indexOf('notification_release_preflight')
  const stop = body.indexOf('  stop_writers')
  const backup = body.indexOf('    create_database_backup')
  const cleanup = body.indexOf('    notification_release_cleanup')
  const start = body.indexOf('  start_services')
  const clear = body.indexOf('  trap - EXIT INT TERM HUP')
  const health = body.indexOf('  notification_status_for_release')
  assert.ok(preview < stop && stop < backup && backup < cleanup && cleanup < start)
  assert.ok(clear < health && health > start)
  assert.match(body, /migration_required.*notification_plan/)
  assert.match(body, /if notification_guard_supported "\$actual_current"; then\n\s+notification_release_preflight "\$actual_current"/)
  assert.match(activate, /ACTIVATION_NOTIFICATION_CLEANUP_STARTED[\s\S]*notification_guard_supported/)
  const rollback = helper.slice(helper.indexOf('action_rollback()'))
  assert.ok(rollback.indexOf('assert_notification_guard_retained') < rollback.indexOf('  stop_writers'))
  const node = readFileSync(new URL('../backend/backend-release.mjs', import.meta.url), 'utf8')
  assert.match(node, /prepared = false\n\s+info\(`核心版本激活完成[\s\S]*verifyNotificationAcceptance/)
  const verify = node.slice(node.indexOf('function verifyNotificationAcceptance'), node.indexOf('function uploadArchive'))
  assert.doesNotMatch(verify, /remoteHelper|stop_writers|rollback\(/)
})
