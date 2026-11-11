#!/usr/bin/env node
/**
 * dsh-cookie-guard-mac 的清理器：等 DSH 退出、Cookie 库解锁，删掉 dsh-auth-*。
 *
 * 独立进程跑（Host 用 detached 方式拉起），所以 DSH 自己正常退出、崩溃退出、
 * 或者被 kill 掉之后都还能工作。
 *
 * 为什么不用 SQLite 的锁判断：Chromium 的 Cookie 库在 macOS 上是通过 POSIX
 * 建议锁打开的，进程只要还开着库就能被别的进程 open('r+') 成功，锁判断
 * 不可靠（Windows 上是强制锁，参考实现那套在 macOS 会误判）。这里改成：
 *   1. Host 的 pid / ppid 还活着吗；
 *   2. `pgrep -f --user-data-dir=<profile>` 还有进程吗（覆盖 Host 重启、pid 变化）；
 *   3. 库文件的 mtime 是否已经稳定一段时间（没人在写）。
 * 三条同时满足才动手。
 *
 * 用法：
 *   node cleaner.mjs --db <Cookies> --profile <profileDir> [--wait-pids 1,2]
 *                    [--max-hours 0] [--interval 2000] [--stability 6000]
 *                    [--now] [--quiet]
 * `--now` 跳过等待直接清（DSH 已经退出的场景）。
 */

import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { appendFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const opt = {
  db: '',
  profile: '',
  waitPids: [],
  maxHours: 0,
  interval: 2000,
  stability: 6000,
  now: false,
  quiet: false,
}

for (let i = 0; i < argv.length; i += 1) {
  const key = argv[i]
  const value = argv[i + 1]
  switch (key) {
    case '--db':
      opt.db = value ?? ''
      i += 1
      break
    case '--profile':
      opt.profile = value ?? ''
      i += 1
      break
    case '--wait-pids':
      opt.waitPids = String(value ?? '')
        .split(',')
        .map((n) => Number(n.trim()))
        .filter((n) => Number.isInteger(n) && n > 1)
      i += 1
      break
    case '--max-hours':
      opt.maxHours = Number(value ?? 0) || 0
      i += 1
      break
    case '--interval':
      opt.interval = Math.max(500, Number(value ?? 2000) || 2000)
      i += 1
      break
    case '--stability':
      opt.stability = Math.max(1000, Number(value ?? 6000) || 6000)
      i += 1
      break
    case '--now':
      opt.now = true
      break
    case '--quiet':
      opt.quiet = true
      break
    default:
      break
  }
}

const PID_FILE = `${opt.db}.guard.pid`
const LOG_FILE = `${opt.db}.guard.log`
const MAX_RETRIES = 6

function say(text) {
  if (!opt.quiet) console.log(text)
}

async function log(text) {
  try {
    await appendFile(LOG_FILE, `${new Date().toISOString()} ${text}\n`)
  } catch {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 用 --user-data-dir 找 DSH 的进程：Host 重启过、pid 变了也能认出来。 */
function appRunning() {
  if (!opt.profile) return false
  const result = spawnSync('pgrep', ['-f', `--user-data-dir=${opt.profile}`], { encoding: 'utf8' })
  if (result.error) return false
  if (result.status === 0) return result.stdout.trim().length > 0
  return false
}

async function mtimeMs(path) {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

async function touchPid() {
  try {
    await writeFile(PID_FILE, `${process.pid}\n`)
  } catch {}
}

async function clearPid() {
  try {
    await rm(PID_FILE, { force: true })
  } catch {}
}

/** 删 dsh-auth-* 并 VACUUM，返回删除前的条数。 */
function prune(db) {
  const database = new DatabaseSync(db)
  try {
    const row = database.prepare("select count(*) as n from cookies where name like 'dsh-auth-%'").get()
    const removed = Number(row.n)
    if (removed > 0) {
      database.exec("delete from cookies where name like 'dsh-auth-%'")
      database.exec('vacuum')
    }
    const left = database.prepare("select count(*) as n from cookies where name like 'dsh-auth-%'").get()
    return { removed, left: Number(left.n) }
  } finally {
    database.close()
  }
}

async function pruneWithRetry(db) {
  let lastError
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return prune(db)
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (!/locked|busy/i.test(message)) break
      await log(`prune attempt ${attempt} busy: ${message}`)
      await sleep(1000)
    }
  }
  throw lastError
}

async function main() {
  if (!opt.db) {
    console.error('missing --db')
    process.exit(3)
  }
  if (!existsSync(opt.db)) {
    say('cookie database not found')
    process.exit(3)
  }

  await touchPid()
  const cleanup = () => {
    void clearPid()
  }
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
  process.on('SIGINT', () => {
    cleanup()
    process.exit(0)
  })

  await log(`start pid=${process.pid} db=${opt.db} wait=${opt.waitPids.join(',')} maxHours=${opt.maxHours}`)

  if (!opt.now) {
    const deadline = opt.maxHours > 0 ? Date.now() + opt.maxHours * 3600_000 : Number.POSITIVE_INFINITY
    let lastMtime = await mtimeMs(opt.db)
    let stableSince = Date.now()

    while (Date.now() < deadline) {
      await touchPid()
      if (!existsSync(opt.db)) {
        await log('database disappeared, exit')
        await clearPid()
        process.exit(0)
      }
      const current = await mtimeMs(opt.db)
      if (current !== lastMtime) {
        lastMtime = current
        stableSince = Date.now()
      }
      const pidsGone = opt.waitPids.every((pid) => !alive(pid))
      const gone = pidsGone && !appRunning()
      if (gone) {
        if (Date.now() - stableSince >= opt.stability) break
      } else {
        stableSince = Date.now()
      }
      await sleep(opt.interval)
    }

    if (Date.now() >= deadline) {
      say(`timeout after ${opt.maxHours}h`)
      await log('timeout, exit without cleaning')
      await clearPid()
      process.exit(2)
    }
  }

  try {
    const { removed, left } = await pruneWithRetry(opt.db)
    say(`removed ${removed}`)
    await log(`done removed=${removed} left=${left}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    say(`failed: ${message}`)
    await log(`failed: ${message}`)
    await clearPid()
    process.exit(4)
  }
  await clearPid()
  process.exit(0)
}

await main()
