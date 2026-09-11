import { readFileSync } from 'node:fs'

export function readExpiryPlan(path, environment) {
  if (!path) return 'NONE'
  const value = JSON.parse(readFileSync(path, 'utf8'))
  const keys = ['cutoff', 'environment', 'max_records', 'policy_version', 'target']
  if (!value || typeof value !== 'object' || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
      || value.environment !== environment || !/^[a-f0-9]{64}$/.test(value.target)
      || value.policy_version !== 'P1-NOTIF-07-R2-v1'
      || typeof value.cutoff !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value.cutoff)
      || !Number.isFinite(Date.parse(value.cutoff)) || Date.parse(value.cutoff) > Date.now()
      || !Number.isInteger(value.max_records) || value.max_records < 1 || value.max_records > 10000) {
    throw new Error('通知清理计划格式或环境不正确；请使用已核对并批准的预览结果')
  }
  return Buffer.from(JSON.stringify(value)).toString('base64')
}

// Observe only: never invoke the dispatcher, restart, roll back or mutate data.
export function observeNotificationAcceptance({ sample, sleep, maxSamples = 19 }) {
  let last = { NOTIFICATION_HEALTH: 'UNKNOWN', RELEASE_ACCEPTANCE: 'PENDING' }
  for (let i = 0; i < maxSamples; i += 1) {
    try { last = sample() } catch { return { ...last, RELEASE_ACCEPTANCE: 'PENDING', NOTIFICATION_HEALTH: 'UNKNOWN' } }
    if (last.RELEASE_ACCEPTANCE === 'PASSED' || last.NOTIFICATION_HEALTH === 'DEGRADED'
        || last.NOTIFICATION_GUARD === 'UNSUPPORTED') return last
    if (i + 1 < maxSamples) sleep(10000)
  }
  return last
}
