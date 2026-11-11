/**
 * dsh-cookie-guard-mac — 自动清理 DeepSeek Harness 桌面端堆积的登录 Cookie
 * （macOS 为主，Windows 路径一并支持）
 *
 * 问题：桌面端每次启动都用随机端口换一条登录 Cookie，名字是
 *   dsh-auth- + base64url(sha256("127.0.0.1:<端口>"))
 * 端口变了 Cookie 名就变，`Max-Age` 又是几十天，DSH 里没有任何清理逻辑。
 * 攒到约 70 条后 Cookie 请求头超过 Node 的 16KB 上限，本地 Host 回 431，
 * 桌面端报 "Web authentication failed"，也就是再也打不开。
 *
 * macOS 上的实测：2026-11-11 这台机器的 Cookies 库里正好堆了 71 条
 * dsh-auth-*，和 Windows 的症状完全一致，只是库的位置不同：
 *   macOS  ~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies
 *   Win    %APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies
 *
 * 做法：不碰 app.asar、不加启动器、不改快捷方式。插件在 Host 启动时
 * detach 一个后台清理器（lib/cleaner.mjs），它等到 DSH 退出、Cookie 库解锁，
 * 就删掉 dsh-auth-*（其他 Cookie 不动）并退出。下一次启动就是干净的。
 *
 * 只用 node: 内置模块（Node 22.5+ 的 node:sqlite），无第三方依赖。
 */

import { spawn } from 'node:child_process'
import { access, appendFile, readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { readSnapshot } from './snapshot.mjs'

export const name = 'dsh-cookie-guard-mac'

// cordis 是严格注入：apply 里用到的服务必须在这里声明。
export const inject = ['tools']

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLEANER = join(PKG_ROOT, 'lib', 'cleaner.mjs')
const REPORT = join(PKG_ROOT, 'lib', 'report.mjs')

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'
const supported = isMac || isWin

const PROFILE_DIR = isMac
  ? join(homedir(), 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop')
  : join(process.env.APPDATA ?? '', '@deepseek-ai', 'dsh-desktop')
const PRIMARY_DB = isMac ? join(PROFILE_DIR, 'Cookies') : join(PROFILE_DIR, 'Network', 'Cookies')

/** 16KB 是 Node 默认的请求头上限；DSH 单条 Cookie 约 230 字节。 */
const HEADER_LIMIT_BYTES = 16 * 1024
const AVG_COOKIE_BYTES = 230
const GUARD_LOG = join(PROFILE_DIR, 'cookie-guard.log')
/** 清理器自己是按 <db>.guard.log 写的（每个库一份），和 Host 的日志不是同一个文件。 */
const CLEAN_LOG = `${PRIMARY_DB}.guard.log`
const PID_FILE = `${PRIMARY_DB}.guard.pid`
const REPORT_FILE = join(PROFILE_DIR, 'cookie-guard-report.html')

const textRender = (makeText) => (_args, value) => [{ type: 'text', text: makeText(value) }]

async function guardLog(text) {
  try {
    await appendFile(GUARD_LOG, `${new Date().toISOString()} ${text}\n`)
  } catch {}
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function watcherPid() {
  try {
    const info = await stat(PID_FILE)
    // 清理器每轮都会刷新 pid 文件；超过 90 秒没刷新就是残留文件。
    if (Date.now() - info.mtimeMs > 90_000) return 0
    const value = (await readFile(PID_FILE, 'utf8')).trim()
    const pid = Number(value)
    return alive(pid) ? pid : 0
  } catch {
    return 0
  }
}

/** macOS 的 Cookies 库在 profile 根目录，另外还有 Partitions/<name>/Cookies。 */
async function dbPaths() {
  const list = []
  if (existsSync(PRIMARY_DB)) list.push(PRIMARY_DB)
  if (isMac) {
    const parts = join(PROFILE_DIR, 'Partitions')
    try {
      for (const name of await readdir(parts)) {
        const p = join(parts, name, 'Cookies')
        if (existsSync(p)) list.push(p)
      }
    } catch {}
  }
  return list
}

/** 库被 DSH 占用时可能读不到；读不到就返回 undefined。 */
async function countsOf(path) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const row = db.prepare("select count(*) as n from cookies where name like 'dsh-auth-%'").get()
      const all = db.prepare('select count(*) as n from cookies').get()
      return { auth: Number(row.n), total: Number(all.n) }
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

/** 只挑真正的清理结果行，别把 watcher 启动记录当成"上次清理"。 */
async function lastCleanLine() {
  let latest = ''
  for (const file of [CLEAN_LOG, GUARD_LOG]) {
    try {
      const text = await readFile(file, 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (!/^\d{4}-\d\d-\d\dT\S+\s+(done removed=|failed:)/.test(line)) continue
        // ISO 时间戳可以直接按字符串比大小。
        if (line > latest) latest = line
      }
    } catch {}
  }
  return latest ? latest.replace(/^\S+\s+/, '') : ''
}

async function dbFacts() {
  const paths = await dbPaths()
  const rows = []
  let totalAuth = 0
  let busy = 0
  for (const path of paths) {
    const counts = await countsOf(path)
    if (!counts) {
      busy += 1
      rows.push(`  ${path}\n    正被 DSH 占用，读不到条数`)
      continue
    }
    totalAuth += counts.auth
    const header = counts.auth * AVG_COOKIE_BYTES
    const pct = Math.round((header / HEADER_LIMIT_BYTES) * 100)
    rows.push(
      `  ${path}\n    Cookie ${counts.total} 条，其中 dsh-auth-* ${counts.auth} 条` +
        (counts.auth > 0 ? `（约 ${header} B / ${HEADER_LIMIT_BYTES} B，占 ${pct}%）` : ''),
    )
  }
  return { paths, rows, totalAuth, busy }
}

async function status() {
  if (!supported) return { ok: false, summary: `仅支持 macOS / Windows（当前 ${process.platform}）。` }
  const facts = await dbFacts()
  const pid = await watcherPid()
  const last = await lastCleanLine()
  const lines = [
    `Cookie 库（${facts.paths.length} 个）：`,
    ...(facts.rows.length ? facts.rows : ['  （未找到：桌面端可能还没启动过）']),
    pid ? `后台清理器：运行中（pid ${pid}），等 DSH 退出后清理` : '后台清理器：未运行（下次启动 DSH 会重新挂上）',
    last ? `上次清理：${last}` : '上次清理：还没有执行过',
  ]
  if (facts.totalAuth > 0) {
    lines.push(
      '',
      `提示：当前共 ${facts.totalAuth} 条 dsh-auth-*，约 ${facts.totalAuth * AVG_COOKIE_BYTES} B；` +
        `到 ${Math.floor(HEADER_LIMIT_BYTES / AVG_COOKIE_BYTES)} 条附近就可能触发 431。`,
      '跑 cookie_guard(action:"clean") 可以让清理器在 DSH 退出时立刻处理，或直接等它自动清。',
    )
  }
  return {
    ok: true,
    action: 'status',
    summary: [
      facts.paths.length ? `Cookie 库 ${facts.paths.length} 个` : '未找到 Cookie 库',
      facts.busy ? `${facts.busy} 个库被占用` : '',
      facts.totalAuth ? `dsh-auth-* 共 ${facts.totalAuth} 条` : '没有 dsh-auth-*',
      pid ? '清理器在跑' : '清理器未运行',
    ]
      .filter(Boolean)
      .join('，'),
    details: lines.join('\n'),
  }
}

async function clean() {
  if (!supported) return { ok: false, summary: `仅支持 macOS / Windows（当前 ${process.platform}）。` }
  if (!existsSync(PRIMARY_DB)) return { ok: false, summary: '没找到 Cookie 库。' }

  const facts = await dbFacts()
  const pid = await watcherPid()

  // 库被占用 = DSH 在跑，清理只能排到退出之后。
  if (facts.busy > 0) {
    if (pid) {
      return {
        ok: true,
        action: 'clean',
        summary: `清理器已在运行（pid ${pid}），DSH 退出后立刻清掉 dsh-auth-*。`,
        details: '退出 DSH 后自动删除 dsh-auth-*，其他 Cookie 不动。',
      }
    }
    const started = startWatcher()
    const live = await watcherPid()
    return {
      ok: Boolean(live),
      action: 'clean',
      summary: live
        ? `清理器已就绪（pid ${live}），DSH 退出后立刻清掉 dsh-auth-*。`
        : `没能挂上清理器${started.error ? `：${started.error}` : ''}。`,
      details: live
        ? '退出 DSH 后自动删除 dsh-auth-*，其他 Cookie 不动。'
        : '下次启动 DSH 会再试一次。',
    }
  }

  // 库已经空出来（比如 DSH 刚退出）——直接调用同一套清理逻辑。
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(
    process.execPath,
    [
      CLEANER,
      '--db',
      PRIMARY_DB,
      '--profile',
      PROFILE_DIR,
      '--now',
      '--max-hours',
      '0.02',
    ],
    { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  )
  const out = (result.stdout || '').trim()
  const removed = /removed (\d+)/.exec(out)?.[1] ?? '0'
  return {
    ok: result.status === 0,
    action: 'clean',
    summary:
      result.status === 0
        ? `已清理：删除 ${removed} 条 dsh-auth-*（其余 Cookie 未动）。`
        : `清理失败：${(result.stderr || out || '').slice(0, 300)}`,
    details: out || undefined,
  }
}

/**
 * 生成一份自包含的 HTML 报告（当前占用 + 清理历史）并打开。
 * 报告里没有网络请求和外部资源，关掉 DSH 也还能双击查看。
 */
async function report() {
  if (!supported) return { ok: false, summary: `仅支持 macOS / Windows（当前 ${process.platform}）。` }
  if (!existsSync(REPORT)) return { ok: false, summary: '报告脚本缺失，请重新安装插件。' }
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(
    process.execPath,
    [
      REPORT,
      '--db',
      PRIMARY_DB,
      '--profile',
      PROFILE_DIR,
      '--out',
      REPORT_FILE,
      '--log',
      CLEAN_LOG,
      '--log',
      GUARD_LOG,
    ],
    { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  )
  if (result.status !== 0) {
    return {
      ok: false,
      action: 'report',
      summary: `生成报告失败：${(result.stderr || result.stdout || '').trim().slice(0, 300)}`,
    }
  }
  const line = (result.stdout || '').trim().split('\n').at(-1) ?? ''
  // 打开报告：macOS 用 open，Windows 用 start。失败不影响文件本身。
  try {
    const opener =
      process.platform === 'darwin'
        ? ['open', [REPORT_FILE]]
        : ['cmd', ['/c', 'start', '', REPORT_FILE]]
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref()
  } catch {}
  return {
    ok: true,
    action: 'report',
    summary: `清理报告已生成并打开：${REPORT_FILE}`,
    details: `${line}\n报告可直接用浏览器打开，也能发出去当证据；数据来自本机 Cookie 库和两份清理日志。`,
  }
}

/**
 * 起一个 detach 的清理器。
 *
 * 每次都起：上一个清理器可能正好在这一刻完成清理并退出，此时跳过就会导致
 * 这一轮没有清理器。重复的清理器只会多清一次 0 条，无害。
 */
function startWatcher(maxHours = 0) {
  if (!supported) return { pid: 0, error: 'unsupported platform' }
  if (!existsSync(PRIMARY_DB)) return { pid: 0, error: 'cookie database missing' }
  if (!existsSync(CLEANER)) return { pid: 0, error: 'cleaner script missing' }
  const pids = [process.pid, process.ppid].filter((p) => Number.isInteger(p) && p > 1)
  try {
    const child = spawn(
      process.execPath,
      [
        CLEANER,
        '--db',
        PRIMARY_DB,
        '--profile',
        PROFILE_DIR,
        '--wait-pids',
        pids.join(','),
        '--max-hours',
        String(maxHours),
        '--quiet',
      ],
      {
        detached: true,
        stdio: 'ignore',
        // Host 本身就是以 ELECTRON_RUN_AS_NODE 启动的；显式传下去，确保子进程跑脚本
        // 而不是再起一个桌面端实例。
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    )
    child.on('error', (error) => {
      void guardLog(`watcher: child error: ${error instanceof Error ? error.message : String(error)}`)
    })
    child.unref()
    const pid = child.pid ?? 0
    void guardLog(`watcher: spawned pid=${pid} pids=${pids.join(',')} maxHours=${maxHours}`)
    return { pid, error: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    void guardLog(`watcher: spawn failed: ${message}`)
    return { pid: 0, error: message }
  }
}

export function apply(ctx, config = {}) {
  const cfg = config ?? {}
  // 0 = 不设上限，DSH 开多久就等多久；配置正数则按小时封顶。
  const maxHours = Number(cfg.maxHours) > 0 ? Number(cfg.maxHours) : 0

  // 起不来就隔 8 秒再试一次（覆盖启动瞬间的抖动），失败都写进 guard.log。
  const boot = async () => {
    if (startWatcher(maxHours).pid) return
    await new Promise((resolve) => setTimeout(resolve, 8000))
    if (await watcherPid()) return
    const retry = startWatcher(maxHours)
    await guardLog(`watcher: retry ${retry.pid ? `ok pid=${retry.pid}` : `failed: ${retry.error}`}`)
  }
  try {
    ctx.effect?.(() => {
      void boot()
      return () => {}
    })
  } catch {
    void boot()
  }

  // Web GUI 看板的数据源：owner-only 的 /api 路由，浏览器同源 fetch 自动带认证 Cookie。
  // 没有 webServer / connection（比如纯 CLI 运行时）时静默跳过。
  try {
    ctx.inject?.(['connection'], (scope) => {
      try {
        const route = {
          path: '/api/cookie-guard/snapshot',
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async () =>
            new Response(
              JSON.stringify(
                await readSnapshot({ db: PRIMARY_DB, profile: PROFILE_DIR, logs: [CLEAN_LOG, GUARD_LOG] }),
              ),
              {
                headers: {
                  'content-type': 'application/json; charset=utf-8',
                  'cache-control': 'no-store',
                },
              },
            ),
        }
        const connection = scope.connection
        if (connection?.fetch?.register) connection.fetch.register(route)
        else if (connection?.registerFetchRoute) connection.registerFetchRoute(scope, route)
        else void guardLog('panel: connection 没有可用的 fetch 路由注册接口')
      } catch (error) {
        void guardLog(`panel: 注册 /api/cookie-guard/snapshot 失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    void guardLog(`panel: inject connection 失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  ctx.tools.register({
    name: 'cookie_guard',
    description:
      'DeepSeek Harness 桌面端每次启动都会新增一条 dsh-auth-* 登录 Cookie，从不清理；约 70 次后 Cookie 请求头超过 16KB，' +
      '本地 Host 回 431，DSH 报 Web authentication failed 且打不开。这个插件在 DSH 启动时挂一个后台清理器，等 DSH 退出、Cookie 库解锁后，' +
      '删掉 dsh-auth-*（其他 Cookie 不动），下一次启动就是干净的。macOS 路径为 ~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies，' +
      'Windows 为 %APPDATA%\\@deepseek-ai\\dsh-desktop\\Network\\Cookies。' +
      'action=status 看现状，action=clean 让清理器立刻在退出后处理，action=report 生成可视化报告。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'clean', 'report'],
          description:
            'status=查看 Cookie 库与清理器状态；clean=触发一次清理（DSH 运行中则排到退出后）；report=生成并打开可视化 HTML 报告。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          summary: { type: 'string' },
          details: { type: 'string' },
        },
        required: ['ok', 'summary'],
      },
      render: textRender((value) => {
        const head = `${value.ok ? '✓' : '✗'} ${value.summary ?? ''}`
        return value.details ? `${head}\n\n${value.details}` : head
      }),
    },
    async execute(args) {
      const action = String(args?.action ?? 'status')
      try {
        if (action === 'clean') return await clean()
        if (action === 'status') return await status()
        if (action === 'report') return await report()
        return { ok: false, summary: `未知 action：${action}` }
      } catch (error) {
        return {
          ok: false,
          action,
          summary: `执行失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  })
}

export const __test = { status, clean, report, startWatcher, dbPaths, PRIMARY_DB, PROFILE_DIR, HEADER_LIMIT_BYTES }
