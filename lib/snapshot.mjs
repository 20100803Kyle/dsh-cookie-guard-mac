/**
 * 采集一次快照：Cookie 库条数 + 清理日志时间线。
 *
 * 报告页（report.mjs）和 Web GUI 面板（lib/client.js 经 /api 路由）用的是
 * 同一份数据，避免两边数字对不上。
 */

import { DatabaseSync } from 'node:sqlite'
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const AVG_COOKIE_BYTES = 230
export const HEADER_LIMIT_BYTES = 16 * 1024
export const LIMIT_COUNT = Math.floor(HEADER_LIMIT_BYTES / AVG_COOKIE_BYTES)

function countsOf(path) {
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const auth = Number(db.prepare("select count(*) as n from cookies where name like 'dsh-auth-%'").get().n)
      const total = Number(db.prepare('select count(*) as n from cookies').get().n)
      return { auth, total, busy: false }
    } finally {
      db.close()
    }
  } catch {
    return { auth: 0, total: 0, busy: true }
  }
}

/** 主库 + Partitions/<hash>/Cookies，去重。 */
export async function databasesOf(db, profile) {
  const list = []
  if (db && existsSync(db)) list.push(db)
  if (profile) {
    try {
      for (const name of await readdir(join(profile, 'Partitions'))) {
        const p = join(profile, 'Partitions', name, 'Cookies')
        if (existsSync(p)) list.push(p)
      }
    } catch {}
  }
  return [...new Set(list)]
}

export function parseLog(text) {
  const events = []
  const lines = text
    .split(/\r?\n/)
    .filter((line) => /^\d{4}-\d\d-\d\dT\S+\s/.test(line))
    .sort()
  for (const line of lines) {
    const match = /^(\d{4}-\d\d-\d\dT\S+)\s+(.*)$/.exec(line.trim())
    if (!match) continue
    const [, iso, message] = match
    const start = /^start pid=(\d+).*?wait=([\d,]*)/.exec(message)
    const done = /^done removed=(\d+) left=(\d+)/.exec(message)
    const failed = /^failed: (.*)/.exec(message)
    const spawned = /^watcher: spawned pid=(\d+)/.exec(message)
    if (done) events.push({ iso, kind: 'done', removed: Number(done[1]), left: Number(done[2]) })
    else if (failed) events.push({ iso, kind: 'failed', detail: failed[1].slice(0, 300) })
    else if (start) events.push({ iso, kind: 'start', pid: start[1] })
    else if (spawned) events.push({ iso, kind: 'spawn', pid: spawned[1] })
    else if (/^timeout/.test(message)) events.push({ iso, kind: 'timeout' })
  }
  // 同一次启动，Host 写 spawned、清理器写 start；有 start 就够了。
  const started = new Set(events.filter((e) => e.kind === 'start').map((e) => e.pid))
  // 同时挂了两个清理器时，两个进程会写出同一毫秒的 done 行；按内容去重。
  const seen = new Set()
  return events.filter((e) => {
    if (e.kind === 'spawn' && started.has(e.pid)) return false
    const key = `${e.iso}|${e.kind}|${e.removed ?? ''}|${e.left ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function readSnapshot({ db, profile, logs = [] }) {
  const paths = await databasesOf(db, profile)
  const dbs = paths.map((path) => {
    const counts = countsOf(path)
    return {
      path,
      total: counts.total,
      auth: counts.auth,
      bytes: counts.auth * AVG_COOKIE_BYTES,
      busy: counts.busy,
    }
  })
  const totalAuth = dbs.reduce((sum, row) => sum + row.auth, 0)
  const bytes = totalAuth * AVG_COOKIE_BYTES
  const pct = Math.min(100, Math.round((bytes / HEADER_LIMIT_BYTES) * 100))

  const files = logs.length ? logs : db ? [`${db}.guard.log`] : []
  let text = ''
  for (const file of files) {
    try {
      text += `${await readFile(file, 'utf8')}\n`
    } catch {}
  }
  const events = parseLog(text)
  const cleaned = events.filter((e) => e.kind === 'done').reduce((sum, e) => sum + e.removed, 0)
  const cleanRuns = events.filter((e) => e.kind === 'done').length

  return {
    generatedAt: new Date().toISOString(),
    avgCookieBytes: AVG_COOKIE_BYTES,
    headerLimitBytes: HEADER_LIMIT_BYTES,
    limitCount: LIMIT_COUNT,
    dbs,
    totalAuth,
    totalCookies: dbs.reduce((sum, row) => sum + row.total, 0),
    pct,
    cleaned,
    cleanRuns,
    events: events.slice(-40).reverse(),
  }
}
