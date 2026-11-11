/**
 * dsh-cookie-guard-mac 的浏览器侧：左侧栏入口 + 主区看板。
 *
 * 数据来自 Host 注册的 `GET /api/cookie-guard/snapshot`（owner-only，
 * 同源 fetch 会自动带上认证 Cookie），前端不直接读文件。
 *
 * 这个文件不打包、没有 JSX：浏览器端由 __ModuleLoader__ 直接执行，
 * React 从模块表 require 进来。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cookie-guard-mac',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'cookie-guard'
    const PANEL_ID = 'cookie-guard'
    const AUTO_KEY = 'dsh-cookie-guard:auto-open'
    const SEEN_KEY = 'dsh-cookie-guard:auto-opened'
    const SNAPSHOT_URL = '/api/cookie-guard/snapshot'

    const zh = {
      panel: 'Cookie 清理',
      title: 'Cookie 清理看板',
      subtitle: 'DSH 桌面端每次启动都会新增一条 dsh-auth-* 登录 Cookie，退出时由后台清理器删掉。',
      back: '返回对话',
      refresh: '刷新',
      loading: '读取中…',
      error: '读取失败',
      stateClean: '干净',
      stateNormal: '正常',
      stateHigh: '偏高',
      stateCritical: '临界',
      noteClean: '库里没有 dsh-auth-*，下次启动也不会累积到出问题。',
      noteNormal: '远低于 16 KB 上限，退出 DSH 时会自动清零。',
      noteHigh: '已经用掉大半请求头预算，留意别再叠加启动次数。',
      noteCritical: '接近 16 KB 请求头上限，可能随时出现 431 / Web authentication failed。',
      kpiAuth: '当前 dsh-auth-* 条数',
      kpiUsed: '16 KB 请求头已用',
      kpiLeft: '距 431 阈值还剩',
      kpiCleaned: '累计已清理',
      budget: '请求头预算',
      budgetHint: '约 {n} 条 · {bytes} B（Node 默认上限）',
      dbs: 'Cookie 库',
      colPath: '路径',
      colAll: '全部',
      colAuth: 'dsh-auth-*',
      colBytes: '约 (B)',
      colPct: '占比',
      none: '无',
      busy: '占用中',
      history: '清理历史',
      noHistory: '还没有清理记录。清理由后台清理器在 DSH 退出后执行。',
      autoOpen: '每次启动自动打开此面板',
      footer: '清理在 DSH 退出后执行：删掉 name like \'dsh-auth-%\' 的行并 VACUUM，其他 Cookie 不动。',
      times: '{n} 次',
    }
    const en = {
      panel: 'Cookie cleanup',
      title: 'Cookie cleanup',
      subtitle: 'Every DSH Desktop launch appends one dsh-auth-* login cookie; a background cleaner removes them on exit.',
      back: 'Back to chat',
      refresh: 'Refresh',
      loading: 'Loading…',
      error: 'Failed to load',
      stateClean: 'Clean',
      stateNormal: 'Normal',
      stateHigh: 'High',
      stateCritical: 'Critical',
      noteClean: 'No dsh-auth-* cookies in the store.',
      noteNormal: 'Well below the 16 KB limit; cleared when DSH exits.',
      noteHigh: 'Most of the header budget is used up.',
      noteCritical: 'Close to the 16 KB request-header limit: 431 errors are likely.',
      kpiAuth: 'dsh-auth-* cookies',
      kpiUsed: 'of 16 KB header used',
      kpiLeft: 'left before 431',
      kpiCleaned: 'cookies cleaned',
      budget: 'Request-header budget',
      budgetHint: '~{n} cookies · {bytes} B (Node default limit)',
      dbs: 'Cookie stores',
      colPath: 'Path',
      colAll: 'Total',
      colAuth: 'dsh-auth-*',
      colBytes: '~ (B)',
      colPct: 'Share',
      none: 'none',
      busy: 'busy',
      history: 'Cleanup history',
      noHistory: 'No cleanups yet. The cleaner runs after DSH exits.',
      autoOpen: 'Open this panel on every launch',
      footer: 'Cleanup runs after DSH exits: deletes rows matching \'dsh-auth-%\' and VACUUMs; other cookies stay.',
      times: '{n}',
    }

    const mix = (percent) => `color-mix(in oklab, currentColor ${percent}%, transparent)`

    const C = {
      page: {
        height: '100%',
        overflowY: 'auto',
        padding: '26px 34px 40px',
        fontSize: 14,
        lineHeight: 1.5,
        color: 'inherit',
        boxSizing: 'border-box',
      },
      head: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
      h1: { margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: '-0.01em' },
      sub: { margin: '6px 0 0', fontSize: 12.5, opacity: 0.6, maxWidth: 720 },
      grow: { flex: 1 },
      button: {
        font: 'inherit',
        fontSize: 12.5,
        color: 'inherit',
        background: 'transparent',
        border: `1px solid ${mix(18)}`,
        borderRadius: 8,
        padding: '5px 11px',
        cursor: 'pointer',
      },
      pill: (color) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        fontSize: 13,
        fontWeight: 600,
        color,
      }),
      dot: (color) => ({ width: 8, height: 8, borderRadius: 999, background: color }),
      kpis: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 12,
        margin: '22px 0 0',
      },
      card: {
        border: `1px solid ${mix(12)}`,
        borderRadius: 12,
        padding: '13px 15px 12px',
      },
      kpiValue: { fontSize: 26, fontWeight: 650, letterSpacing: '-0.02em', lineHeight: 1.15 },
      kpiLabel: { marginTop: 5, fontSize: 12.5, opacity: 0.6 },
      section: { marginTop: 30 },
      sectionTitle: {
        margin: '0 0 10px',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.09em',
        textTransform: 'uppercase',
        opacity: 0.55,
      },
      track: { height: 8, borderRadius: 999, background: mix(10), overflow: 'hidden', margin: '14px 0 8px' },
      fill: (pct, color) => ({ height: '100%', width: `${Math.max(pct, pct > 0 ? 1.5 : 0)}%`, background: color }),
      hint: { display: 'flex', justifyContent: 'space-between', fontSize: 12, opacity: 0.55 },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5, tableLayout: 'fixed' },
      th: {
        textAlign: 'left',
        padding: '0 10px 8px',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
        opacity: 0.5,
        whiteSpace: 'nowrap',
      },
      td: { padding: '11px 10px', borderTop: `1px solid ${mix(10)}`, verticalAlign: 'top' },
      path: { wordBreak: 'break-all', opacity: 0.85 },
      events: { display: 'flex', flexDirection: 'column' },
      event: {
        display: 'grid',
        gridTemplateColumns: '104px 1fr',
        gap: 14,
        alignItems: 'baseline',
        padding: '10px 0',
        borderTop: `1px solid ${mix(10)}`,
        fontSize: 13,
      },
      eventTime: { fontSize: 12, opacity: 0.55, fontVariantNumeric: 'tabular-nums' },
      empty: { fontSize: 13, opacity: 0.55, padding: '12px 0' },
      footer: { marginTop: 30, fontSize: 12, opacity: 0.55, maxWidth: 720 },
      switchRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, opacity: 0.75 },
      level: (pct, auth, limit) => {
        if (pct >= 100 || auth >= limit) return 'critical'
        if (pct >= 70) return 'high'
        if (auth > 0) return 'normal'
        return 'clean'
      },
      tone: { clean: '#2fbf8f', normal: '#2fbf8f', high: '#d99424', critical: '#e5484d' },
    }

    function GuardIcon({ size = 18 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M12 3.2 19 6v5.6c0 4.3-2.9 7.4-7 9.2-4.1-1.8-7-4.9-7-9.2V6l7-2.8Z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M9.2 12.1l2 2 3.6-3.9',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function timeOf(iso) {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return iso
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    function eventText(event, t) {
      if (event.kind === 'done') return `清理完成：删除 ${event.removed} 条，剩余 ${event.left} 条`
      if (event.kind === 'failed') return `清理失败：${event.detail ?? ''}`
      if (event.kind === 'start') return `清理器启动（pid ${event.pid}），等待 DSH 退出`
      if (event.kind === 'timeout') return '清理器等待超时，已退出'
      return event.kind
    }

    function GuardPage(props) {
      const { t, back } = props
      const [snap, setSnap] = React.useState(null)
      const [error, setError] = React.useState('')
      const [auto, setAuto] = React.useState(localStorage.getItem(AUTO_KEY) !== '0')
      const [stamp, setStamp] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(SNAPSHOT_URL, { cache: 'no-store', headers: { accept: 'application/json' } })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          setSnap(await res.json())
          setError('')
          setStamp(new Date().toLocaleTimeString())
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      React.useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), 15_000)
        return () => clearInterval(timer)
      }, [load])

      const toggleAuto = (next) => {
        setAuto(next)
        localStorage.setItem(AUTO_KEY, next ? '1' : '0')
      }

      const head = h(
        'div',
        { style: C.head },
        h('h1', { style: C.h1 }, t('title')),
        h('div', { style: C.grow }),
        h('button', { style: C.button, type: 'button', onClick: () => void load(), title: t('refresh') }, t('refresh')),
        h('button', { style: C.button, type: 'button', onClick: back }, t('back')),
      )

      const subtitle = h('p', { style: C.sub }, t('subtitle'))

      if (!snap) {
        return h(
          'div',
          { style: C.page },
          head,
          subtitle,
          h('div', { style: { ...C.empty, marginTop: 26 } }, error ? `${t('error')}: ${error}` : t('loading')),
        )
      }

      const level = C.level(snap.pct, snap.totalAuth, snap.limitCount)
      const tone = C.tone[level]
      const note = {
        clean: t('noteClean'),
        normal: t('noteNormal'),
        high: t('noteHigh'),
        critical: t('noteCritical'),
      }[level]
      const stateLabel = {
        clean: t('stateClean'),
        normal: t('stateNormal'),
        high: t('stateHigh'),
        critical: t('stateCritical'),
      }[level]

      const kpis = [
        [String(snap.totalAuth), t('kpiAuth')],
        [`${snap.pct}%`, t('kpiUsed')],
        [String(Math.max(0, snap.limitCount - snap.totalAuth)), t('kpiLeft')],
        [
          String(snap.cleaned),
          snap.cleanRuns > 0 ? `${t('kpiCleaned')} · ${t('times', { n: snap.cleanRuns })}` : t('kpiCleaned'),
        ],
      ]

      const budget = h(
        'section',
        { style: C.section },
        h('h2', { style: C.sectionTitle }, t('budget')),
        h('div', { style: C.track }, h('div', { style: C.fill(snap.pct, tone) })),
        h(
          'div',
          { style: C.hint },
          h('span', null, '0'),
          h('span', null, t('budgetHint', { n: snap.limitCount, bytes: snap.headerLimitBytes })),
        ),
      )

      const colgroup = h(
        'colgroup',
        null,
        h('col', { style: { width: '58%' } }),
        h('col', { style: { width: '10%' } }),
        h('col', { style: { width: '12%' } }),
        h('col', { style: { width: '10%' } }),
        h('col', { style: { width: '10%' } }),
      )

      const table = h(
        'section',
        { style: C.section },
        h('h2', { style: C.sectionTitle }, t('dbs')),
        h(
          'table',
          { style: C.table },
          colgroup,
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { style: C.th }, t('colPath')),
              h('th', { style: { ...C.th, textAlign: 'right' } }, t('colAll')),
              h('th', { style: { ...C.th, textAlign: 'right' } }, t('colAuth')),
              h('th', { style: { ...C.th, textAlign: 'right' } }, t('colBytes')),
              h('th', { style: { ...C.th, textAlign: 'right' } }, t('colPct')),
            ),
          ),
          h(
            'tbody',
            null,
            ...snap.dbs.map((row, index) =>
              h(
                'tr',
                { key: index },
                h('td', { style: C.td }, h('div', { style: C.path }, row.path)),
                h('td', { style: { ...C.td, textAlign: 'right' } }, row.busy ? t('busy') : String(row.total)),
                h('td', { style: { ...C.td, textAlign: 'right' } }, row.busy ? '—' : String(row.auth)),
                h('td', { style: { ...C.td, textAlign: 'right' } }, row.busy ? '—' : String(row.bytes)),
                h(
                  'td',
                  { style: { ...C.td, textAlign: 'right' } },
                  row.busy
                    ? '—'
                    : row.auth === 0
                      ? t('none')
                      : `${Math.min(100, Math.round((row.bytes / snap.headerLimitBytes) * 100))}%`,
                ),
              ),
            ),
          ),
        ),
      )

      const history = h(
        'section',
        { style: C.section },
        h('h2', { style: C.sectionTitle }, t('history')),
        snap.events.length === 0
          ? h('div', { style: C.empty }, t('noHistory'))
          : h(
              'div',
              { style: C.events },
              ...snap.events.map((event, index) =>
                h(
                  'div',
                  { key: index, style: C.event },
                  h('span', { style: C.eventTime }, timeOf(event.iso)),
                  h(
                    'span',
                    { style: event.kind === 'done' ? { color: C.tone.clean } : event.kind === 'failed' ? { color: C.tone.critical } : null },
                    eventText(event, t),
                  ),
                ),
              ),
            ),
      )

      return h(
        'div',
        { style: C.page },
        head,
        subtitle,
        h(
          'div',
          { style: { marginTop: 20, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          h('span', { style: C.pill(tone) }, h('span', { style: C.dot(tone) }), stateLabel),
          h('span', { style: { fontSize: 13, opacity: 0.7 } }, note),
        ),
        h(
          'div',
          { style: C.kpis },
          ...kpis.map(([value, label], index) =>
            h('div', { key: index, style: C.card }, h('div', { style: C.kpiValue }, value), h('div', { style: C.kpiLabel }, label)),
          ),
        ),
        budget,
        table,
        history,
        h(
          'div',
          { style: { marginTop: 26, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' } },
          h(
            'label',
            { style: C.switchRow },
            h('input', {
              type: 'checkbox',
              checked: auto,
              onChange: (event) => toggleAuto(event.target.checked),
            }),
            t('autoOpen'),
          ),
          h('span', { style: { fontSize: 11.5, opacity: 0.45 } }, stamp ? `· ${t('refresh')} ${stamp}` : ''),
        ),
        h('div', { style: C.footer }, t('footer')),
      )
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh,
              en,
            }),
          'dsh-cookie-guard-mac: dictionaries',
        )
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: () => t('panel'),
              locale: NS,
            },
            GuardIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              inject: () => ({
                back: () => {
                  try {
                    ctx.layout.selectPanel(null)
                  } catch {}
                },
              }),
            },
            GuardPage,
          ),
        )

        // 本次窗口第一次打开时自动切到看板；面板里的开关记在 localStorage 里。
        ctx.effect(() => {
          try {
            if (localStorage.getItem(AUTO_KEY) === '0') return
            if (sessionStorage.getItem(SEEN_KEY) === '1') return
            sessionStorage.setItem(SEEN_KEY, '1')
            const timer = setTimeout(() => {
              try {
                ctx.layout.selectPanel(PANEL_ID)
              } catch {}
            }, 600)
            return () => clearTimeout(timer)
          } catch {
            return
          }
        }, 'dsh-cookie-guard-mac: open on start')
      },
    }
  },
})
