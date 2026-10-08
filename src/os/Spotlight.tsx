import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { GAMES } from '../apps/games/Games'
import { countFor, useContributions } from '../data/contributions'
import { fetchMinecraft, MC_ADDRESS, useMinecraft } from '../data/minecraft'
import { contributions, profile, projects } from '../data/profile'
import { timeAgo, useRecents } from '../data/recents'
import { age, HOME, lookup, prettyPath, walk } from '../terminal/vfs'
import { APP_META } from './apps'
import { calculate, formatNumber } from './calc'
import { resetLayout } from './desktopStore'
import { AppIcon } from './icons'
import { setOverlay } from './overlays'
import { ACCENTS, setAccent } from './theme'
import { SINGLE_INSTANCE, useWM, type AppId } from './wm'

// Ctrl+K: one search box for apps, files, projects, games, live status, quick actions, maths and
// terminal commands, with a preview of the highlighted result on the right.

type Group = 'Top hit' | 'Status' | 'Apps' | 'Actions' | 'Projects' | 'Games' | 'Files' | 'Links' | 'Fallback'

type Result = {
  id: string
  group: Group
  title: string
  subtitle?: string
  icon: ReactNode
  keywords?: string
  /** Enter */
  run: () => void
  /** Ctrl/Cmd+Enter */
  alt?: { label: string; run: () => void }
  enterLabel?: string
  preview?: () => ReactNode
}

const Glyph = ({ children, color = 'var(--panel-2)' }: { children: ReactNode; color?: string }) => (
  <span className="sp-glyph" style={{ background: color }}>
    {children}
  </span>
)

/** Higher is better; 0 means no match. Prefix > word start > substring > in-order letters
 * (the last only for short titles, where it reads as a typo-tolerant abbreviation). */
function score(text: string, q: string, fuzzy = false): number {
  const t = text.toLowerCase()
  if (!q) return 1
  if (t === q) return 100
  if (t.startsWith(q)) return 80
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) return 60
  if (t.includes(q)) return 40
  if (!fuzzy) return 0
  let i = 0
  for (const ch of t) if (ch === q[i]) i++
  return i === q.length ? 15 : 0
}

// ---------------------------------------------------------------------------------------------
// Previews

function McPreview() {
  const { status, error } = useMinecraft()
  if (!status) return <p className="muted">{error ? `Could not check: ${error}` : 'Checking…'}</p>
  return (
    <>
      <h4>{status.motd || 'Minecraft server'}</h4>
      <dl className="sp-dl">
        <dt>Status</dt>
        <dd className={status.online ? 't-green' : 't-red'}>{status.online ? 'Online' : 'Offline'}</dd>
        <dt>Address</dt>
        <dd>
          <code>{MC_ADDRESS}</code>
        </dd>
        {status.online && (
          <>
            <dt>Version</dt>
            <dd>Java {status.version}</dd>
            <dt>Players</dt>
            <dd>
              {status.players.online}/{status.players.max}
              {status.players.list.length ? `: ${status.players.list.join(', ')}` : ''}
            </dd>
          </>
        )}
      </dl>
    </>
  )
}

function ActivityPreview() {
  const { items, live } = useRecents()
  return (
    <>
      <h4>Latest activity {live && <span className="sp-live">live</span>}</h4>
      <ul className="sp-feed">
        {items.slice(0, 6).map((a) => (
          <li key={a.id}>
            <span>{a.title}</span>
            <span className="muted">
              {a.repo.split('/')[1]} · {timeAgo(a.date)}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

function ContribPreview() {
  const data = useContributions()
  if (!data) return <p className="muted">Loading…</p>
  const last = data.days.slice(-84)
  const max = Math.max(1, ...last.map((d) => countFor(d, 'all')))
  const total = data.days.reduce((a, d) => a + countFor(d, 'all'), 0)
  const gh = data.days.reduce((a, d) => a + d.github, 0)
  return (
    <>
      <h4>{total.toLocaleString('en-GB')} contributions this year</h4>
      <p className="muted">
        GitHub {gh.toLocaleString('en-GB')} · git.mvl.sh {(total - gh).toLocaleString('en-GB')}
      </p>
      <div className="sp-spark" aria-label="Last 12 weeks">
        {last.map((d) => (
          <span key={d.date} style={{ height: `${Math.max(4, (countFor(d, 'all') / max) * 100)}%` }} title={`${d.date}: ${countFor(d, 'all')}`} />
        ))}
      </div>
      <p className="muted sp-small">Last 12 weeks</p>
    </>
  )
}

function FilePreview({ path }: { path: string }) {
  const node = lookup(path)
  if (!node || node.type !== 'file') return null
  const text = node.content()
  return (
    <>
      <h4 className="sp-path">{prettyPath(path)}</h4>
      <pre className="sp-file">{text.split('\n').slice(0, 24).join('\n')}</pre>
    </>
  )
}

// ---------------------------------------------------------------------------------------------

export function Spotlight() {
  const wm = useWM()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const mc = useMinecraft()
  const recents = useRecents()
  const close = () => setOverlay(null)

  useEffect(() => {
    input.current?.focus()
    fetchMinecraft()
  }, [])

  const term = (cmd: string, fresh = false) => (fresh ? wm.openNew : wm.open)('terminal', { run: cmd, t: String(Date.now()) })
  const copy = (text: string, label: string) =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => setFlash(`Copied ${label}`))
      .catch(() => {})

  const all = useMemo<Result[]>(() => {
    const out: Result[] = []

    // Status
    out.push({
      id: 'status-mc',
      group: 'Status',
      title: 'Minecraft server',
      subtitle: mc.status ? (mc.status.online ? `Online · ${mc.status.players.online}/${mc.status.players.max} players` : 'Offline') : 'Checking…',
      keywords: 'mc minecraft server status players cloud.mvl.sh stardebris game',
      icon: <Glyph color="linear-gradient(160deg,#5d9b3a,#3b6b25)">⛏</Glyph>,
      run: () => copy(MC_ADDRESS, MC_ADDRESS),
      enterLabel: 'Copy address',
      alt: { label: 'Refresh', run: () => fetchMinecraft(true) },
      preview: () => <McPreview />,
    })
    out.push({
      id: 'status-activity',
      group: 'Status',
      title: 'Latest activity',
      subtitle: recents.items[0] ? `${recents.items[0].title} · ${timeAgo(recents.items[0].date)}` : 'GitHub and git.mvl.sh',
      keywords: 'github recent activity commits pushes releases status feed',
      icon: <AppIcon app="recents" size={28} />,
      run: () => wm.open('recents'),
      preview: () => <ActivityPreview />,
    })
    out.push({
      id: 'status-contrib',
      group: 'Status',
      title: 'Contributions this year',
      subtitle: 'GitHub + git.mvl.sh',
      keywords: 'contributions heatmap graph commits github gitea forgejo stats',
      icon: <Glyph color="color-mix(in srgb, var(--green) 30%, transparent)">▦</Glyph>,
      run: () => wm.open('recents'),
      alt: { label: 'Show in terminal', run: () => term('heatmap') },
      preview: () => <ContribPreview />,
    })
    const { years, days } = age()
    out.push({
      id: 'status-uptime',
      group: 'Status',
      title: `Uptime: ${years} years, ${days} days`,
      subtitle: 'Menno has been running since 19 September 1996',
      keywords: 'uptime age birthday born old',
      icon: <Glyph>⏱</Glyph>,
      run: () => term('uptime'),
    })
    out.push({
      id: 'status-time',
      group: 'Status',
      title: new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
      subtitle: 'Date and time',
      keywords: 'time date clock calendar today week',
      icon: <Glyph>🗓</Glyph>,
      run: () => term('cal'),
      enterLabel: 'Show calendar',
    })

    // Apps
    for (const app of Object.keys(APP_META) as AppId[]) {
      const meta = APP_META[app]
      const open = wm.windows.filter((w) => w.app === app).length
      out.push({
        id: `app-${app}`,
        group: 'Apps',
        title: meta.dock,
        subtitle: open ? `${meta.blurb} · ${open} open` : meta.blurb,
        keywords: `${app} app open`,
        icon: <AppIcon app={app} size={28} />,
        run: () => wm.open(app),
        alt: SINGLE_INSTANCE.has(app) ? undefined : { label: 'New window', run: () => wm.openNew(app) },
      })
    }

    // Actions
    const action = (id: string, title: string, keywords: string, run: () => void, glyph: ReactNode, subtitle?: string) =>
      out.push({ id: `act-${id}`, group: 'Actions', title, subtitle, keywords, icon: <Glyph>{glyph}</Glyph>, run })
    action('new-terminal', 'New terminal window', 'terminal shell new window launch console bash', () => wm.openNew('terminal'), '›_')
    action('minimize', 'Minimize all windows', 'minimize hide windows show desktop', () => wm.windows.forEach((w) => wm.minimize(w.pid)), '▁')
    action('close', 'Close all windows', 'close quit all windows', () => wm.windows.forEach((w) => wm.close(w.pid)), '✕')
    action('focus-mode', `Focus follows mouse: turn ${wm.focusMode === 'hover' ? 'off' : 'on'}`, 'focus follows mouse hover click window manager sloppy', () => wm.setFocusMode(wm.focusMode === 'hover' ? 'click' : 'hover'), '◎', wm.focusMode === 'hover' ? 'Currently on: hovering focuses and raises windows' : 'Currently off: click to focus')
    action('cleanup', 'Clean up desktop icons', 'desktop icons tidy arrange reset', resetLayout, '▤')
    action('print', 'Print or save CV as PDF', 'print pdf cv resume download', () => {
      wm.open('cv')
      setTimeout(() => window.print(), 300)
    }, '⎙')
    action('email', `Copy email address`, 'email mail contact copy', () => copy(profile.email, 'email address'), '@', profile.email)
    for (const [name, color] of Object.entries(ACCENTS))
      out.push({ id: `accent-${name}`, group: 'Actions', title: `Accent color: ${name}`, keywords: `theme accent color colour ${name}`, icon: <Glyph color={color}> </Glyph>, run: () => setAccent(name) })

    // Projects & contributions
    for (const p of projects)
      out.push({
        id: `proj-${p.slug}`,
        group: 'Projects',
        title: p.name,
        subtitle: p.tagline,
        keywords: `${p.stack.join(' ')} project ${p.description}`,
        icon: <Glyph color={p.accent}>{p.name[0]}</Glyph>,
        run: () => wm.open('projects', { slug: p.slug }),
        alt: p.url ? { label: 'Visit website', run: () => window.open(p.url, '_blank', 'noopener') } : undefined,
        preview: () => (
          <>
            <h4>{p.name}</h4>
            <p className="muted">{p.tagline}</p>
            <p>{p.description}</p>
            <p className="sp-small muted">
              {p.stack.join(' · ')} · {p.status}
            </p>
          </>
        ),
      })
    for (const c of contributions)
      out.push({
        id: `contrib-${c.slug}`,
        group: 'Projects',
        title: c.name,
        subtitle: `Contributor · ${c.owner}/${c.slug}`,
        keywords: `${c.description} contribution open source omarchy`,
        icon: <Glyph color={c.accent}>{c.name[0]}</Glyph>,
        run: () => wm.open('projects', { slug: c.slug }),
        alt: { label: 'Open repository', run: () => window.open(c.repo, '_blank', 'noopener') },
        preview: () => (
          <>
            <h4>{c.name}</h4>
            <p>{c.description}</p>
            <ul className="sp-list">
              {c.work.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </>
        ),
      })

    // Games
    for (const g of GAMES)
      out.push({
        id: `game-${g.id}`,
        group: 'Games',
        title: g.name,
        subtitle: g.blurb,
        keywords: 'game play arcade fun',
        icon: <Glyph color={`color-mix(in srgb, ${g.color} 30%, transparent)`}>{g.glyph}</Glyph>,
        run: () => wm.openNew('games', { game: g.id }),
      })

    // Files in the home directory
    for (const path of walk(HOME)) {
      const node = lookup(path)
      if (node?.type !== 'file') continue
      const name = path.split('/').pop()!
      out.push({
        id: `file-${path}`,
        group: 'Files',
        title: path.split('/').length > HOME.split('/').length + 1 ? path.split('/').slice(-2).join('/') : name,
        subtitle: prettyPath(path),
        keywords: `file ${prettyPath(path)}`,
        icon: <Glyph>{name.endsWith('.url') ? '🔗' : name.endsWith('.md') ? '📝' : '📄'}</Glyph>,
        run: () => {
          if (node.open?.url) window.open(node.open.url, '_blank', 'noopener')
          else if (node.open?.app) wm.open(node.open.app as AppId, node.open.props)
          else term(`cat ${prettyPath(path)}`)
        },
        alt: { label: 'Open in terminal', run: () => term(`cat ${prettyPath(path)}`, true) },
        preview: () => <FilePreview path={path} />,
      })
    }

    // Links
    for (const l of profile.links)
      out.push({ id: `link-${l.label}`, group: 'Links', title: l.label, subtitle: l.url.replace(/^https:\/\//, ''), keywords: 'link profile social', icon: <Glyph>↗</Glyph>, run: () => window.open(l.url, '_blank', 'noopener') })

    return out
  }, [mc.status, recents.items, wm])

  const results = useMemo(() => {
    const query = q.trim().toLowerCase()
    const out: Result[] = []

    const value = calculate(q)
    if (value !== null)
      out.push({
        id: 'calc',
        group: 'Top hit',
        title: `= ${formatNumber(value)}`,
        subtitle: `${q.trim()}`,
        icon: <Glyph color="color-mix(in srgb, var(--accent) 25%, transparent)">∑</Glyph>,
        run: () => copy(String(value), 'result'),
        enterLabel: 'Copy',
      })

    if (!query) {
      // Empty box: status first, then the common things.
      const pick = new Set(['status-mc', 'status-activity', 'status-contrib', 'act-new-terminal', 'app-projects', 'app-cv', 'app-games', 'app-terminal'])
      return [...out, ...all.filter((r) => pick.has(r.id))]
    }

    const scored = all
      .map((r) => ({ r, s: Math.max(score(r.title, query, true) * 1.2, score(r.keywords ?? '', query) * 0.8, score(r.subtitle ?? '', query) * 0.6) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)

    // The single best match leads, then everything else grouped.
    const order: Group[] = ['Status', 'Apps', 'Actions', 'Projects', 'Games', 'Files', 'Links']
    const [top, ...rest] = scored
    if (top && !out.length) out.push({ ...top.r, group: 'Top hit' })
    else if (top) rest.unshift(top)
    for (const g of order) out.push(...rest.filter((x) => x.r.group === g).slice(0, g === 'Files' ? 6 : 5).map((x) => x.r))

    out.push({
      id: 'run',
      group: 'Fallback',
      title: `Run “${q.trim()}” in a terminal`,
      icon: <Glyph>›_</Glyph>,
      run: () => term(q.trim()),
      alt: { label: 'In a new terminal', run: () => term(q.trim(), true) },
    })
    out.push({
      id: 'web',
      group: 'Fallback',
      title: `Search the web for “${q.trim()}”`,
      icon: <Glyph>🔍</Glyph>,
      run: () => window.open(`https://duckduckgo.com/?q=${encodeURIComponent(q.trim())}`, '_blank', 'noopener'),
    })
    return out
  }, [q, all])

  useEffect(() => setActive(0), [q])
  useEffect(() => {
    list.current?.querySelector('.sp-item.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 1400)
    return () => clearTimeout(t)
  }, [flash])

  const current = results[active]
  const execute = (r: Result | undefined, alt: boolean) => {
    if (!r) return
    const keepOpen = r.id === 'calc' || r.id === 'status-mc' || r.id.startsWith('act-email') || r.id.startsWith('accent-')
    ;(alt && r.alt ? r.alt.run : r.run)()
    if (!keepOpen) close()
  }

  let lastGroup: Group | null = null

  return (
    <div className="spotlight-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="spotlight"
        role="dialog"
        aria-label="Spotlight search"
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
          else if (e.key === 'ArrowDown') setActive((a) => Math.min(results.length - 1, a + 1))
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
          else if (e.key === 'Enter') execute(current, e.ctrlKey || e.metaKey)
          else return
          e.preventDefault()
        }}
      >
        <div className="sp-input">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps, files, projects, status… or type a sum" aria-label="Search" spellCheck={false} autoComplete="off" />
          <kbd>esc</kbd>
        </div>
        <div className="sp-main">
          <div className="sp-results" ref={list} role="listbox">
            {results.map((r, i) => {
              const header = r.group !== lastGroup && r.group !== 'Fallback' ? r.group : r.group === 'Fallback' && lastGroup !== 'Fallback' ? 'More' : null
              lastGroup = r.group
              return (
                <div key={r.id}>
                  {header && <p className="sp-group">{header}</p>}
                  <button className={`sp-item ${i === active ? 'is-active' : ''}`} role="option" aria-selected={i === active} onPointerMove={() => setActive(i)} onClick={(e) => execute(r, e.ctrlKey || e.metaKey)}>
                    {r.icon}
                    <span className="sp-text">
                      <span className="sp-title">{r.title}</span>
                      {r.subtitle && <span className="sp-sub">{r.subtitle}</span>}
                    </span>
                    {i === active && <span className="sp-enter">{r.enterLabel ?? 'Open'} ↵</span>}
                  </button>
                </div>
              )
            })}
          </div>
          <aside className="sp-preview">{current?.preview ? current.preview() : current ? <DefaultPreview r={current} /> : null}</aside>
        </div>
        <footer className="sp-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> {current?.enterLabel ?? 'open'}
          </span>
          {current?.alt && (
            <span>
              <kbd>ctrl</kbd>
              <kbd>↵</kbd> {current.alt.label.toLowerCase()}
            </span>
          )}
          {flash && <span className="sp-flash">{flash}</span>}
        </footer>
      </div>
    </div>
  )
}

function DefaultPreview({ r }: { r: Result }) {
  return (
    <div className="sp-default">
      <span className="sp-default-icon">{r.icon}</span>
      <h4>{r.title}</h4>
      {r.subtitle && <p className="muted">{r.subtitle}</p>}
    </div>
  )
}
