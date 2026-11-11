#!/usr/bin/env node
/**
 * 生成一份自包含的 HTML 报告：当前 Cookie 占用量 + 清理历史。
 *
 * 没有网络请求、没有外部资源，双击就能在任何浏览器里打开；
 * 也可以交给 `cookie_guard(action:"report")` 生成后自动打开。
 *
 * 用法：
 *   node report.mjs --db <Cookies> --profile <profileDir> [--out <file.html>] [--log <file>]
 */

import { DatabaseSync } from 'node:sqlite'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const opt = { db: '', profile: '', out: '', logs: [] }
for (let i = 0; i < argv.length; i += 1) {
  const key = argv[i]
  const value = argv[i + 1]
  if (key === '--db') {
    opt.db = value ?? ''
    i += 1
  } else if (key === '--profile') {
    opt.profile = value ?? ''
    i += 1
  } else if (key === '--out') {
    opt.out = value ?? ''
    i += 1
  } else if (key === '--log') {
    if (value) opt.logs.push(value)
    i += 1
  }
}

if (!opt.db) {
  console.error('missing --db')
  process.exit(3)
}

const AVG_COOKIE_BYTES = 230
const HEADER_LIMIT_BYTES = 16 * 1024
const LIMIT_COUNT = Math.floor(HEADER_LIMIT_BYTES / AVG_COOKIE_BYTES)
const OUT_FILE = opt.out || join(opt.profile || '.', 'cookie-guard-report.html')

const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

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

async function databases() {
  const list = []
  if (existsSync(opt.db)) list.push(opt.db)
  const parts = opt.profile ? join(opt.profile, 'Partitions') : ''
  if (parts) {
    try {
      for (const name of await readdir(parts)) {
        const p = join(parts, name, 'Cookies')
        if (existsSync(p)) list.push(p)
      }
    } catch {}
  }
  return list
}

function parseLog(text) {
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
    if (done) {
      events.push({ iso, kind: 'done', removed: Number(done[1]), left: Number(done[2]) })
    } else if (failed) {
      events.push({ iso, kind: 'failed', detail: failed[1] })
    } else if (start) {
      events.push({ iso, kind: 'start', pid: start[1] })
    } else if (spawned) {
      events.push({ iso, kind: 'spawn', pid: spawned[1] })
    } else if (/^timeout/.test(message)) {
      events.push({ iso, kind: 'timeout' })
    }
  }
  // 同一次启动，Host 写 "watcher: spawned pid=N"、清理器写 "start pid=N"；
  // 有 start 就够了，spawn 只留作清理器没能启动时的线索。
  const started = new Set(events.filter((e) => e.kind === 'start').map((e) => e.pid))
  return events.filter((e) => e.kind !== 'spawn' || !started.has(e.pid))
}

function fmtTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const EVENT_TEXT = {
  done: (e) => `清理完成：删除 ${e.removed} 条，剩余 ${e.left} 条`,
  failed: (e) => `清理失败：${e.detail}`,
  start: (e) => `清理器启动（pid ${e.pid}），等待 DSH 退出`,
  spawn: (e) => `清理器挂载（pid ${e.pid}）`,
  timeout: () => '等待超时，本轮未清理',
}

function main() {
  return (async () => {
    const paths = await databases()
    const rows = paths.map((path) => ({ path, ...countsOf(path) }))
    const totalAuth = rows.reduce((sum, row) => sum + row.auth, 0)
    const bytes = totalAuth * AVG_COOKIE_BYTES
    const pct = Math.min(100, Math.round((bytes / HEADER_LIMIT_BYTES) * 100))

    // 清理器把 done/failed 写进 <Cookies>.guard.log，Host 把 watcher 记录写进
    // cookie-guard.log；两份都要读，否则时间线会缺一半。
    const logFiles = opt.logs.length ? opt.logs : [`${opt.db}.guard.log`]
    let logText = ''
    for (const file of logFiles) {
      try {
        logText += `${await readFile(file, 'utf8')}\n`
      } catch {}
    }
    const events = parseLog(logText)
    const cleaned = events.filter((e) => e.kind === 'done').reduce((sum, e) => sum + e.removed, 0)
    const cleanRuns = events.filter((e) => e.kind === 'done').length

    const state =
      totalAuth === 0
        ? { label: '干净', tone: 'ok', note: '库里没有 dsh-auth-*，下次启动会新增一条。' }
        : totalAuth >= LIMIT_COUNT - 5
          ? { label: '临界', tone: 'bad', note: '再启动几次就会触发 431，建议尽快退出 DSH 让它清理。' }
          : pct >= 50
            ? { label: '偏高', tone: 'warn', note: '已经用掉一半以上请求头预算，退出 DSH 即可清理。' }
            : { label: '正常', tone: 'ok', note: '远低于 16 KB 上限，退出 DSH 时会自动清零。' }

    const timeline = events
      .slice(-14)
      .reverse()
      .map((event) => {
        const text = EVENT_TEXT[event.kind] ? EVENT_TEXT[event.kind](event) : event.kind
        return `<li class="event event--${event.kind}"><time>${esc(fmtTime(event.iso))}</time><span>${esc(text)}</span></li>`
      })
      .join('')

    const table = rows
      .map((row) => {
        const rowBytes = row.auth * AVG_COOKIE_BYTES
        const rowPct = Math.min(100, Math.round((rowBytes / HEADER_LIMIT_BYTES) * 100))
        const status = row.busy ? '被 DSH 占用，未读取' : row.auth > 0 ? `${rowPct}%` : '无'
        return `<tr>
      <td class="path">${esc(row.path)}</td>
      <td class="num">${row.busy ? '—' : row.total}</td>
      <td class="num">${row.busy ? '—' : row.auth}</td>
      <td class="num">${row.busy ? '—' : rowBytes}</td>
      <td class="num">${esc(status)}</td>
    </tr>`
      })
      .join('\n')

    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Cookie 清理报告</title>
<style>
  :root {
    --bg: #fafaf9; --panel: #ffffff; --text: #1c1917; --muted: #78716c; --line: #e7e5e4;
    --ok: #0f766e; --warn: #b45309; --bad: #b91c1c; --track: #f5f5f4;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0c0a09; --panel: #1c1917; --text: #f5f5f4; --muted: #a8a29e; --line: #292524; --track: #292524; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 15px/1.6 -apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 48px 24px 64px; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 20px; margin-bottom: 32px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 6px; letter-spacing: -.01em; }
  .sub { color: var(--muted); font-size: 13px; }
  .state { display: flex; align-items: baseline; gap: 12px; margin: 24px 0 8px; }
  .state strong { font-size: 17px; font-weight: 600; }
  .state--ok strong { color: var(--ok); }
  .state--warn strong { color: var(--warn); }
  .state--bad strong { color: var(--bad); }
  .state span { color: var(--muted); font-size: 13px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--line);
          border: 1px solid var(--line); margin: 24px 0 32px; }
  .kpi { background: var(--panel); padding: 16px 18px; }
  .kpi .v { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .kpi .k { color: var(--muted); font-size: 12px; margin-top: 2px; }
  h2 { font-size: 13px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
       color: var(--muted); margin: 36px 0 14px; }
  .gauge { position: relative; height: 14px; background: var(--track); border-radius: 2px; overflow: hidden; }
  .gauge i { display: block; height: 100%; width: ${pct}%; background: var(--${state.tone}); }
  .gauge-cap { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; white-space: nowrap; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.path { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px; color: var(--muted); word-break: break-all; }
  ul.events { list-style: none; margin: 0; padding: 0; }
  .event { display: flex; gap: 16px; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
  .event time { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .event--done span { color: var(--ok); }
  .event--failed span { color: var(--bad); }
  .event--timeout span { color: var(--warn); }
  footer { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>DSH 桌面端 Cookie 清理报告</h1>
    <div class="sub">生成于 ${esc(new Date().toLocaleString('zh-CN', { hour12: false }))} · 数据来自本机 Cookie 库与清理器日志</div>
  </header>

  <div class="state state--${state.tone}">
    <strong>${esc(state.label)}</strong>
    <span>${esc(state.note)}</span>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="v">${totalAuth}</div><div class="k">当前 dsh-auth-* 条数</div></div>
    <div class="kpi"><div class="v">${pct}%</div><div class="k">16 KB 请求头已用</div></div>
    <div class="kpi"><div class="v">${Math.max(0, LIMIT_COUNT - totalAuth)}</div><div class="k">距 431 阈值还剩</div></div>
    <div class="kpi"><div class="v">${cleaned}</div><div class="k">累计已清理（${cleanRuns} 次）</div></div>
  </div>

  <h2>请求头预算</h2>
  <div class="gauge"><i></i></div>
  <div class="gauge-cap">
    <span>0</span>
    <span>约 ${LIMIT_COUNT} 条 · ${HEADER_LIMIT_BYTES} B（Node 默认上限）</span>
  </div>

  <h2>Cookie 库</h2>
  <table>
    <colgroup><col style="width:56%"><col span="4" style="width:11%"></colgroup>
    <thead><tr><th>路径</th><th class="num">全部</th><th class="num">dsh-auth-*</th><th class="num">约 (B)</th><th class="num">占比</th></tr></thead>
    <tbody>
${table}
    </tbody>
  </table>

  <h2>清理历史</h2>
  ${timeline ? `<ul class="events">${timeline}</ul>` : '<p class="sub">日志里还没有记录。</p>'}

  <footer>
    清理在 DSH 退出后执行：删掉 <code>name like 'dsh-auth-%'</code> 的行并 VACUUM，其他 Cookie 不动。<br>
    单条按 ${AVG_COOKIE_BYTES} B 估算，阈值取 Node 默认 <code>16 * 1024</code> B 请求头上限，所以约 ${LIMIT_COUNT} 条时触发 431。
  </footer>
</main>
</body>
</html>
`

    await writeFile(OUT_FILE, html, 'utf8')
    console.log(OUT_FILE)
    console.log(`auth=${totalAuth} total=${rows.reduce((s, r) => s + r.total, 0)} pct=${pct} cleaned=${cleaned}`)
  })()
}

await main()
