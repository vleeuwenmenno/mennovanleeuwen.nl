import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { GAMES } from '../apps/games/Games'
import { openSticky } from '../apps/Sticky'
import { MarkdownPreview } from '../apps/Zed'
import { isCodeQuery, type BranchHit, type Hit, type IssueHit, type RepoHit } from '../data/code'
import { forgetHit, hitKey, rememberHit, useRecentHits, weight } from '../data/spotlightRecent'
import { faviconOf, launch, useLaunchers } from '../data/launchers'
import { createNote, noteTitle, NOTE_COLORS, useAllNotes } from '../data/notes'
import { addWidget, widgetDefs } from '../widgets/registry'
import { ENGINES, searchWeb, useSearchSettings, useSuggestions } from '../data/searchEngine'
import { followGoLink, golinksSite, golinksUrl, useGoSuggestions, useGolinksTemplate } from '../data/golinks'
import { forgetVisit, useVisits, type Visit } from '../data/siteHistory'
import { useSpotlightPrefs, type Category } from '../data/spotlightPrefs'
import { countFor, useContributions } from '../data/contributions'
import { fetchMinecraft, MC_ADDRESS, useMinecraft } from '../data/minecraft'
import { contributions, profile, projects } from '../data/profile'
import { timeAgo, useRecents } from '../data/recents'
import { age, HOME, lookup, prettyPath, walk } from '../terminal/vfs'
import { signIn, useAccount } from './account'
import { APP_META } from './apps'
import { useCodeSearch } from './codeSearch'
import { asWebAddress, useLinkPreview, type LinkPreview } from './linkPreview'
import { openContextMenu } from './ContextMenu'
import { openLink } from '../data/links'
import { isDockableApp, linkDockId, pinLink, pinToDock, unpinFromDock, useCanCustomizeDock, useDock, type DockId } from './dockItems'
import { revealEmail } from '../data/email'
import { cachedRates, loadRates, smartCalc, type CalcResult } from './smartcalc'
import { resetLayout } from './desktopStore'
import { AppIcon } from './icons'
import { setOverlay } from './overlays'
import { THEMES } from './omarchyThemes'
import { ACCENTS, setAccent, setMode, setTheme, themeLabel, themeSettings } from './theme'
import { SINGLE_INSTANCE, useWM, type AppId } from './wm'

// Ctrl+K: one search box for apps, files, projects, games, live status, quick actions, maths and
// terminal commands, with a preview of the highlighted result on the right.

type Group = 'Top hit' | 'Go links' | 'Recent' | 'Recently visited' | 'Status' | 'Apps' | 'Repositories' | 'Issues & PRs' | 'Branches' | 'Code' | 'Widgets' | 'Notes' | 'Actions' | 'Projects' | 'Games' | 'Files' | 'Links' | 'Web' | 'Fallback'

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
  /** Tab fills the search box with this, e.g. "owner/repo" so # or @ can follow */
  complete?: string
  /** A web page this result can be pinned to the dock as (repositories) */
  link?: { label: string; url: string }
  /** Remembered results: drops it from what Spotlight remembers (right-click, or Shift+Delete) */
  forget?: () => void
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

/** "Go to example.com": the top hit whenever the query is a web address. */
function goToRow(url: string, page: LinkPreview | null, open: (url: string) => void, copy: (text: string, label: string) => void): Result {
  const shown = url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const icon = page?.icon ?? (() => {
    try {
      return `${new URL(url).origin}/favicon.ico`
    } catch {
      return null
    }
  })()
  return {
    id: 'goto',
    group: 'Top hit',
    title: `Go to ${shown}`,
    subtitle: page?.title ?? page?.description ?? 'Open in a new tab',
    icon: (
      <Glyph>
        {icon ? <img className="sp-fav" src={icon} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : '↗'}
      </Glyph>
    ),
    run: () => open(url),
    enterLabel: 'Go',
    alt: { label: 'Copy link', run: () => copy(url, 'link') },
    link: { label: page?.siteName ?? page?.host ?? shown, url },
    preview: () => (
      <div className="sp-page">
        {page?.image && <img className="sp-page-image" src={page.image} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />}
        <h4>{page?.title ?? shown}</h4>
        {page?.description && <p>{page.description}</p>}
        <p className="muted sp-small">{page?.url ?? url}</p>
      </div>
    ),
  }
}

const ago = (iso?: string | null) => (iso ? timeAgo(iso) : '')

const shortUrl = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

/** A remembered website, with what the page says about itself (signed in, like Go to). */
function SitePreview({ v }: { v: Visit }) {
  const account = useAccount()
  const page = useLinkPreview(v.url, account.status === 'user')
  return (
    <div className="sp-page">
      {page?.image && <img className="sp-page-image" src={page.image} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />}
      <h4>{page?.title ?? v.title ?? shortUrl(v.url)}</h4>
      {page?.description && <p>{page.description}</p>}
      <p className="muted sp-small">{v.url}</p>
      <p className="muted sp-small">
        Last opened {timeAgo(new Date(v.at).toISOString())}
        {v.count > 1 ? ` · ${v.count} times` : ''}
      </p>
    </div>
  )
}

/** A website or go link opened before; right-click or Shift+Delete forgets it. */
function visitRow(v: Visit, goTemplate: string | null, copy: (text: string, label: string) => void): Result {
  const when = timeAgo(new Date(v.at).toISOString())
  const forget = () => forgetVisit(v.url)
  if (v.url.startsWith('go:')) {
    const alias = v.url.slice(3)
    return {
      id: `visit-${v.url}`,
      group: 'Recently visited',
      title: `go/${alias}`,
      subtitle: `Go link · ${when}`,
      icon: <Glyph>↪</Glyph>,
      run: () => goTemplate && followGoLink(goTemplate, alias),
      enterLabel: 'Go',
      complete: `go ${alias}`,
      forget,
    }
  }
  return {
    id: `visit-${v.url}`,
    group: 'Recently visited',
    title: v.title ?? shortUrl(v.url),
    subtitle: v.title ? `${shortUrl(v.url)} · ${when}` : when,
    icon: (
      <Glyph>
        <img className="sp-fav" src={faviconOf(v.url)} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
      </Glyph>
    ),
    run: () => openLink(v.url, { title: v.title }),
    enterLabel: 'Go',
    alt: { label: 'Copy link', run: () => copy(v.url, 'link') },
    link: { label: v.title ?? shortUrl(v.url), url: v.url },
    preview: () => <SitePreview v={v} />,
    forget,
  }
}

/** Which setting leaves a group out of what you type. */
const CATEGORY_OF: Partial<Record<Group, Category>> = { 'Recently visited': 'sites', Status: 'status', Projects: 'projects', Games: 'games', Files: 'files' }

function StateBadge({ state, draft }: { state: IssueHit['state']; draft?: boolean }) {
  const label = draft && state === 'open' ? 'draft' : state
  return <span className={`sp-state is-${label}`}>{label}</span>
}

function RepoPreview({ r }: { r: RepoHit }) {
  return (
    <>
      <h4>{r.fullName}</h4>
      {r.description && <p>{r.description}</p>}
      <dl className="sp-dl">
        <dt>Host</dt>
        <dd>{r.sourceLabel}</dd>
        <dt>Visibility</dt>
        <dd>
          {r.private ? 'Private' : 'Public'}
          {r.fork ? ' · fork' : ''}
          {r.archived ? ' · archived' : ''}
        </dd>
        {r.language && (
          <>
            <dt>Language</dt>
            <dd>{r.language}</dd>
          </>
        )}
        <dt>Default</dt>
        <dd>
          <code>{r.defaultBranch}</code>
        </dd>
        <dt>Open</dt>
        <dd>{r.openIssues} issues and PRs</dd>
        <dt>Stars</dt>
        <dd>{r.stars}</dd>
        {r.pushedAt && (
          <>
            <dt>Pushed</dt>
            <dd>{ago(r.pushedAt)}</dd>
          </>
        )}
      </dl>
      <p className="muted sp-small">
        Tab completes <code>{r.fullName}</code>, then type <code>#</code> for issues or <code>@</code> for branches.
      </p>
    </>
  )
}

function IssuePreview({ i }: { i: IssueHit }) {
  return (
    <>
      <h4>
        {i.title} <span className="muted">#{i.number}</span>
      </h4>
      <p className="sp-issue-meta">
        <StateBadge state={i.state} draft={i.draft} /> {i.kind === 'pr' ? 'Pull request' : 'Issue'} in <code>{i.repo}</code>
      </p>
      <dl className="sp-dl">
        {i.author && (
          <>
            <dt>By</dt>
            <dd>@{i.author}</dd>
          </>
        )}
        {i.headRef && (
          <>
            <dt>Branch</dt>
            <dd>
              <code>{i.headRef}</code> → <code>{i.baseRef}</code>
            </dd>
          </>
        )}
        <dt>Updated</dt>
        <dd>
          {ago(i.updatedAt)} · opened {ago(i.createdAt)}
        </dd>
        <dt>Comments</dt>
        <dd>{i.comments}</dd>
      </dl>
      {i.labels.length > 0 && (
        <p className="sp-labels">
          {i.labels.map((l) => (
            <span key={l.name} className="sp-label" style={{ ['--label' as string]: l.color }}>
              {l.name}
            </span>
          ))}
        </p>
      )}
      {i.body && <pre className="sp-file sp-body">{i.body}</pre>}
    </>
  )
}

function BranchPreview({ b }: { b: BranchHit }) {
  return (
    <>
      <h4>
        <code>{b.name}</code>
      </h4>
      <p className="muted">
        {b.repo} · {b.sourceLabel}
        {b.isDefault ? ' · default branch' : ''}
        {b.protected ? ' · protected' : ''}
      </p>
      <dl className="sp-dl">
        <dt>Head</dt>
        <dd>
          <code>{b.sha.slice(0, 7)}</code>
          {b.commitDate ? ` · ${ago(b.commitDate)}` : ''}
        </dd>
        {b.commitMessage && (
          <>
            <dt>Commit</dt>
            <dd>{b.commitMessage}</dd>
          </>
        )}
        {b.pr && (
          <>
            <dt>PR</dt>
            <dd>
              <StateBadge state={b.pr.state} /> #{b.pr.number} {b.pr.title}
            </dd>
          </>
        )}
      </dl>
    </>
  )
}

function codeRow(h: Hit, copy: (text: string, label: string) => void): Result {
  // Opening something remembers it, so it comes back first next time (here, not in the
  // websites history: the Recent group already has it).
  const open = (url: string) => {
    rememberHit(h)
    openLink(url, { remember: false })
  }
  if (h.kind === 'repo')
    return {
      id: `repo-${h.source}-${h.fullName}`,
      group: 'Repositories',
      title: h.fullName,
      subtitle: [h.description, h.private ? 'private' : null, h.pushedAt ? `pushed ${ago(h.pushedAt)}` : null, h.sourceLabel].filter(Boolean).join(' · '),
      icon: <Glyph color="color-mix(in srgb, var(--accent) 25%, transparent)">{h.private ? '◆' : '◇'}</Glyph>,
      run: () => open(h.url),
      enterLabel: 'Open',
      alt: { label: 'Copy clone command', run: () => copy(`git clone ${h.cloneUrl}`, 'clone command') },
      complete: h.fullName,
      link: { label: h.fullName.split('/').pop()!, url: h.url },
      preview: () => <RepoPreview r={h} />,
    }
  if (h.kind === 'branch')
    return {
      id: `branch-${h.source}-${h.repo}-${h.name}`,
      group: 'Branches',
      title: h.name,
      subtitle: [h.repo, h.pr ? `PR #${h.pr.number} ${h.pr.state}` : null, h.commitDate ? ago(h.commitDate) : null, h.sourceLabel].filter(Boolean).join(' · '),
      icon: <Glyph color="color-mix(in srgb, var(--magenta) 25%, transparent)">⑂</Glyph>,
      run: () => open(h.url),
      alt: h.pr ? { label: `Open PR #${h.pr.number}`, run: () => open(h.pr!.url) } : { label: 'Copy branch name', run: () => copy(h.name, h.name) },
      complete: `${h.repo}@${h.name}`,
      preview: () => <BranchPreview b={h} />,
    }
  return {
    id: `issue-${h.source}-${h.repo}-${h.number}`,
    group: 'Issues & PRs',
    title: h.title,
    subtitle: `${h.repo}#${h.number} · ${h.draft && h.state === 'open' ? 'draft' : h.state}${h.author ? ` · @${h.author}` : ''} · ${ago(h.updatedAt)} · ${h.sourceLabel}`,
    icon: <Glyph color={`color-mix(in srgb, var(--${h.state === 'open' ? 'green' : h.state === 'merged' ? 'magenta' : 'red'}) 28%, transparent)`}>{h.kind === 'pr' ? '⇄' : '●'}</Glyph>,
    run: () => open(h.url),
    alt: { label: 'Copy link', run: () => copy(h.url, 'link') },
    complete: `${h.repo}#${h.number}`,
    preview: () => <IssuePreview i={h} />,
  }
}

// ---------------------------------------------------------------------------------------------

export function Spotlight() {
  const wm = useWM()
  const [q, setQ] = useState('')
  // A list opened inside Spotlight (Add widget…); the search box then filters that list.
  const [sub, setSub] = useState<'widgets' | null>(null)
  const openSub = (s: 'widgets' | null) => {
    setSub(s)
    setQ('')
  }
  const [active, setActive] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const mc = useMinecraft()
  const recents = useRecents()
  const account = useAccount()
  const notes = useAllNotes()
  const launchers = useLaunchers()
  // "go <alias>": the go links account, like the terminal's go command, with its suggestions.
  const goAlias = sub || !/^go\s/i.test(q) ? null : q.replace(/^go\s+/i, '').trim()
  const goTemplate = useGolinksTemplate()
  const goSuggestions = useGoSuggestions(goTemplate, goAlias ?? '', goAlias !== null)
  const code = useCodeSearch(sub || goAlias !== null ? '' : q)
  const recentHits = useRecentHits()
  const visits = useVisits()
  const prefs = useSpotlightPrefs()
  const address = sub ? null : asWebAddress(q)
  const page = useLinkPreview(address, account.status === 'user')
  const dock = useDock()
  const canPin = useCanCustomizeDock()
  const searchSettings = useSearchSettings()
  const engine = ENGINES[searchSettings.engine]
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
      run: () => wm.open('mcserver', { t: String(Date.now()) }),
      enterLabel: 'Open overview',
      alt: { label: 'Copy address', run: () => copy(MC_ADDRESS, MC_ADDRESS) },
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
      if (app === 'viewer' || app === 'widget') continue // need a file, or are added as widgets
      if (app === 'linkforge') continue // a dialog of Settings
      if (app === 'mcserver') continue // the Minecraft server's status entry opens it
      if (app === 'calendar' && account.status !== 'user') continue // the owner's own calendars
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
    action('new-note', 'New sticky note', 'note sticky new write memo todo', () => openSticky(wm, createNote().id), '✎')
    // One row that opens the list of widgets inside Spotlight.
    const defs = widgetDefs()
    out.push({
      id: 'sub-widgets',
      group: 'Widgets',
      title: 'Add widget…',
      subtitle: defs.map((d) => d.name).join(', '),
      keywords: `widget widgets add new desktop ${defs.map((d) => `${d.name} ${d.blurb}`).join(' ')}`,
      icon: <Glyph>▦</Glyph>,
      run: () => openSub('widgets'),
      enterLabel: 'Choose',
    })
    if (account.status === 'anon') action('sign-in', 'Sign in with GitHub', 'login sign in account github sync owner', signIn, '⎆', 'Sync notes and search your repositories')
    action('settings', 'Settings', 'settings preferences account launchers gitea forgejo token sync', () => wm.open('settings'), '⚙')
    action('minimize', 'Minimize all windows', 'minimize hide windows show desktop', () => wm.windows.forEach((w) => wm.minimize(w.pid)), '▁')
    action('close', 'Close all windows', 'close quit all windows', () => wm.windows.forEach((w) => wm.close(w.pid)), '✕')
    action('cleanup', 'Clean up desktop icons', 'desktop icons tidy arrange reset', resetLayout, '▤')
    action('print', 'Print or save CV as PDF', 'print pdf cv resume download', () => {
      wm.open('cv')
      setTimeout(() => window.print(), 300)
    }, '⎙')
    action('email', `Copy email address`, 'email mail contact copy', () => copy(revealEmail(), 'email address'), '@', 'Copies it; it is not shown here')
    const ts = themeSettings()
    out.push({ id: 'theme-mode-light', group: 'Actions', title: 'Day mode', subtitle: themeLabel(ts.light), keywords: 'theme light day mode appearance', icon: <Glyph color={THEMES[ts.light].background}>☀</Glyph>, run: () => setMode('light') })
    out.push({ id: 'theme-mode-dark', group: 'Actions', title: 'Night mode', subtitle: themeLabel(ts.dark), keywords: 'theme dark night mode appearance', icon: <Glyph color={THEMES[ts.dark].background}>☾</Glyph>, run: () => setMode('dark') })
    out.push({ id: 'theme-mode-auto', group: 'Actions', title: 'Auto theme (follow system)', keywords: 'theme auto system appearance', icon: <Glyph>◐</Glyph>, run: () => setMode('auto') })
    for (const t of Object.keys(THEMES))
      out.push({ id: `theme-${t}`, group: 'Actions', title: `Theme: ${themeLabel(t)}`, subtitle: `Omarchy ${THEMES[t].mode} theme`, keywords: `theme omarchy appearance ${t} ${THEMES[t].mode}`, icon: <Glyph color={THEMES[t].background}><span style={{ color: THEMES[t].accent }}>●</span></Glyph>, run: () => setTheme(t) })
    for (const [name, color] of Object.entries(ACCENTS))
      out.push({ id: `accent-${name}`, group: 'Actions', title: `Accent color: ${name}`, keywords: `accent color colour ${name}`, icon: <Glyph color={color}> </Glyph>, run: () => setAccent(name) })

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
        alt: p.url ? { label: 'Visit website', run: () => openLink(p.url!) } : undefined,
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
        alt: { label: 'Open repository', run: () => openLink(c.repo) },
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
      if (!node || path.split('/').some((part) => part.startsWith('.'))) continue
      if (node.type === 'dir') {
        if (path === HOME) continue
        out.push({
          id: `dir-${path}`,
          group: 'Files',
          title: path.split('/').slice(-1)[0] + '/',
          subtitle: prettyPath(path),
          keywords: `folder directory ${prettyPath(path)}`,
          icon: <Glyph color="color-mix(in srgb, var(--accent) 30%, transparent)">▰</Glyph>,
          run: () => wm.openNew('files', { path }),
          alt: { label: 'Open in terminal', run: () => term(`cd ${prettyPath(path)} && ls`, true) },
        })
        continue
      }
      const name = path.split('/').pop()!
      out.push({
        id: `file-${path}`,
        group: 'Files',
        title: path.split('/').length > HOME.split('/').length + 1 ? path.split('/').slice(-2).join('/') : name,
        subtitle: prettyPath(path),
        keywords: `file ${prettyPath(path)}`,
        icon: <Glyph>{name.endsWith('.url') ? '🔗' : name.endsWith('.md') ? '📝' : '📄'}</Glyph>,
        run: () => {
          if (node.open?.url) openLink(node.open.url)
          else if (node.open?.app) wm.open(node.open.app as AppId, node.open.props)
          else if (name.endsWith('.md')) wm.open('zed', { path, view: 'preview', t: String(Date.now()) })
          else wm.openNew('viewer', { path })
        },
        alt: { label: 'Open in terminal', run: () => term(`cat ${prettyPath(path)}`, true) },
        preview: () => <FilePreview path={path} />,
      })
    }

    // Your notes
    for (const n of notes) {
      if (n.deleted || n.purged) continue
      out.push({
        id: `note-${n.id}`,
        group: 'Notes',
        title: noteTitle(n),
        subtitle: n.text.split('\n').filter((l) => l.trim()).slice(1).join(' ').slice(0, 80) || 'Note',
        keywords: `note ${n.text.slice(0, 2000)}`,
        icon: <Glyph color={NOTE_COLORS[n.color].bg}>✎</Glyph>,
        run: () => openSticky(wm, n.id),
        enterLabel: 'Show on desktop',
        alt: { label: 'Open in Notebook', run: () => wm.open('notebook', { id: n.id, t: String(Date.now()) }) },
        preview: () => (
          <div className="zed-preview sp-note">
            <MarkdownPreview text={n.text || '_Empty note_'} />
          </div>
        ),
      })
    }

    // Your launchers
    for (const l of launchers)
      out.push({
        id: `launcher-${l.id}`,
        group: 'Links',
        title: l.label,
        subtitle: l.url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        keywords: `launcher link bookmark ${l.url}`,
        icon: l.glyph ? <Glyph>{l.glyph}</Glyph> : <Glyph><img className="sp-fav" src={faviconOf(l.url)} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /></Glyph>,
        run: () => launch(l),
        alt: { label: 'Copy link', run: () => copy(l.url, 'link') },
      })

    // Links
    for (const l of profile.links)
      out.push({ id: `link-${l.label}`, group: 'Links', title: l.label, subtitle: l.url.replace(/^https:\/\//, ''), keywords: 'link profile social', icon: <Glyph>↗</Glyph>, run: () => openLink(l.url) })

    return out
  }, [mc.status, recents.items, wm, account.status, notes, launchers])

  // Calculator, units and currencies. Exchange rates load the first time a currency appears.
  const [rates, setRates] = useState(cachedRates)
  const calc = useMemo(() => (sub ? null : smartCalc(q, rates)), [q, rates, sub])
  // The search engine's suggestions, for plain text (not maths, #123 or repo@branch).
  const suggestions = useSuggestions(q, !sub && !calc && !isCodeQuery(q) && goAlias === null)
  useEffect(() => {
    if (calc?.kind === 'pending') loadRates().then((r) => r && setRates(r))
  }, [calc?.kind])

  const calcRow = (c: CalcResult): Result => {
    const icon = <Glyph color="color-mix(in srgb, var(--accent) 25%, transparent)">{c.kind === 'ok' && c.usesRates ? '¤' : '∑'}</Glyph>
    if (c.kind === 'pending') return { id: 'calc', group: 'Top hit', title: 'Fetching exchange rates…', subtitle: c.expression, icon, run: () => {} }
    if (c.kind === 'error') return { id: 'calc', group: 'Top hit', title: `Can't calculate: ${c.message}`, subtitle: c.expression, icon, run: () => {} }
    return {
      id: 'calc',
      group: 'Top hit',
      title: c.value,
      subtitle: c.note ?? c.expression,
      icon,
      run: () => copy(c.copy, c.copy),
      enterLabel: 'Copy',
      preview: () => (
        <>
          <p className="sp-calc-expr muted">{c.expression}</p>
          <p className="sp-calc-value">{c.value}</p>
          {c.alternatives.length > 0 && (
            <ul className="sp-calc-alts">
              {c.alternatives.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
          {c.note && <p className="muted sp-small">{c.note}</p>}
        </>
      ),
    }
  }

  /** Spotlight's `go` mode: the typed alias first, then the golinks server's suggestions. */
  const goRows = (alias: string): Result[] => {
    if (!goTemplate)
      return [
        {
          id: 'go-setup',
          group: 'Top hit',
          title: 'Set up go links',
          subtitle: 'Paste your golinks search URL, and go <alias> works here and in the terminal',
          icon: <Glyph>↪</Glyph>,
          run: () => wm.open('settings', { section: 'golinks' }),
          enterLabel: 'Open',
        },
      ]
    const site = golinksSite(goTemplate).replace(/^https?:\/\//, '')
    const row = (name: string, target: string | undefined, group: Group): Result => {
      const url = golinksUrl(goTemplate, name)
      return {
        id: `go-${name}`,
        group,
        title: `go/${name}`,
        subtitle: target ? target.replace(/^https?:\/\//, '').replace(/\/$/, '') : `Through ${site}`,
        icon: <Glyph>↪</Glyph>,
        run: () => followGoLink(goTemplate, name),
        enterLabel: 'Go',
        complete: `go ${name}`,
        alt: { label: 'Copy link', run: () => copy(url, 'link') },
      }
    }
    const out: Result[] = []
    if (alias) out.push(row(alias, goSuggestions.find((g) => g.name === alias)?.target, 'Top hit'))
    for (const g of goSuggestions) if (g.name !== alias) out.push(row(g.name, g.target, 'Go links'))
    if (alias)
      out.push({
        id: 'run',
        group: 'Fallback',
        title: `Run “go ${alias}” in a terminal`,
        icon: <Glyph>›_</Glyph>,
        run: () => term(`go ${alias}`),
        alt: { label: 'In a new terminal', run: () => term(`go ${alias}`, true) },
      })
    return out
  }

  const results = useMemo(() => {
    const query = q.trim().toLowerCase()
    const out: Result[] = []

    // Inside "Add widget…": just the widgets, filtered by what is typed.
    if (sub === 'widgets')
      return widgetDefs()
        .filter((d) => !query || `${d.name} ${d.blurb}`.toLowerCase().includes(query))
        .map<Result>((d) => ({ id: `widget-${d.kind}`, group: 'Widgets', title: d.name, subtitle: d.blurb, icon: <Glyph>{d.glyph}</Glyph>, run: () => addWidget(wm, d.kind), enterLabel: 'Add' }))

    if (goAlias !== null) return goRows(goAlias)

    if (calc) out.push(calcRow(calc))

    // A web address always leads: "Go to google.com", with what the page says about itself.
    if (address) out.unshift(goToRow(address, page, (url) => openLink(url, { title: page?.title ?? undefined }), copy))

    // What you opened from Spotlight before, most used and recent first; right-click forgets one.
    const recentRow = (h: Hit): Result => {
      const r = codeRow(h, copy)
      return { ...r, id: `recent-${hitKey(h)}`, group: 'Recent', forget: () => forgetHit(h) }
    }
    const recentRanked = recentHits.slice().sort((a, b) => weight(b) - weight(a))

    if (!query) {
      // Empty box: what Settings → Spotlight asks for, in this order.
      const { start } = prefs
      const status = new Set(['status-mc', 'status-activity', 'status-contrib'])
      const apps = new Set(['act-new-terminal', 'app-projects', 'app-cv', 'app-games', 'app-terminal'])
      return [
        ...out,
        ...(start.sites ? visits.slice(0, 5).map((v) => visitRow(v, goTemplate, copy)) : []),
        ...(start.status ? all.filter((r) => status.has(r.id)) : []),
        ...(start.apps ? all.filter((r) => apps.has(r.id)) : []),
        ...(start.code ? recentRanked.slice(0, 4).map((r) => recentRow(r.hit)) : []),
      ]
    }

    // Remembered things matching the query: instant, no request to GitHub.
    const recentMatches = isCodeQuery(query)
      ? []
      : recentRanked
          .map((r) => {
            const h = r.hit
            const text = h.kind === 'repo' ? h.fullName : h.kind === 'branch' ? `${h.repo}@${h.name}` : `${h.repo}#${h.number} ${h.title}`
            const match = Math.max(score(text.split('/').pop() ?? text, query, true) * 1.3, score(text, query))
            // It has to match first; how often you open it only orders the matches.
            return { r, s: match > 0 ? match + weight(r) * 10 : 0 }
          })
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 4)
    const recentKeys = new Set(recentMatches.map((x) => hitKey(x.r.hit)))

    // Repositories, issues, PRs and branches from the owner's code hosts.
    const codeRows = (code.result?.hits ?? []).filter((h) => !recentKeys.has(hitKey(h))).map((h) => codeRow(h, copy))
    const codeStatus: Result[] = []
    // Searching and trouble only matter when the query is about code (#123, repo@branch).
    if (isCodeQuery(query) && code.loading && !codeRows.length) codeStatus.push({ id: 'code-loading', group: 'Code', title: 'Searching your code hosts…', icon: <Glyph>⌕</Glyph>, run: () => {} })
    if (isCodeQuery(query) && code.error) codeStatus.push({ id: 'code-error', group: 'Code', title: `Code search failed: ${code.error}`, icon: <Glyph>!</Glyph>, run: () => {} })
    for (const e of isCodeQuery(query) ? (code.result?.errors ?? []) : []) codeStatus.push({ id: `code-err-${e}`, group: 'Code', title: e, subtitle: 'Some results may be missing', icon: <Glyph>!</Glyph>, run: () => wm.open('settings', { section: 'instances' }) })
    if (isCodeQuery(query)) {
      // #123, repo#123, repo@branch: only code results make sense.
      if (account.status === 'anon') codeStatus.push({ id: 'code-signin', group: 'Code', title: 'Sign in to search repositories, issues and branches', icon: <Glyph>⎆</Glyph>, run: signIn })
      else if (!code.loading && !code.error && code.result && !codeRows.length) codeStatus.push({ id: 'code-none', group: 'Code', title: 'No matching issues, pull requests or branches', subtitle: 'Try owner/repo#123, repo#text or repo@branch', icon: <Glyph>∅</Glyph>, run: () => {} })
      const [first, ...more] = codeRows
      return [...out, ...(first ? [{ ...first, group: 'Top hit' as Group }] : []), ...more, ...codeStatus]
    }

    // Websites opened before, by title or address; a little ahead when opened lately or often.
    const visited = prefs.include.sites
      ? visits.map((v, i) => {
          const r = visitRow(v, goTemplate, copy)
          return { r, s: Math.max(score(r.title, query, true), score(shortUrl(v.url), query) * 0.9) * (1 + Math.log2(1 + v.count) / 20 - i / 400) }
        })
      : []
    const scored = all
      .filter((r) => !CATEGORY_OF[r.group] || prefs.include[CATEGORY_OF[r.group]!])
      .map((r) => ({ r, s: Math.max(score(r.title, query, true) * 1.2, score(r.keywords ?? '', query) * 0.8, score(r.subtitle ?? '', query) * 0.6) }))
      .concat(visited)
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)

    // The single best match leads, then everything else grouped.
    const order: Group[] = ['Recent', 'Recently visited', 'Status', 'Apps', 'Widgets', 'Repositories', 'Issues & PRs', 'Branches', 'Notes', 'Actions', 'Projects', 'Games', 'Files', 'Links']
    const [top, ...rest] = scored
    const recentRows = recentMatches.map((x) => recentRow(x.r.hit))
    // A remembered thing that matches well beats an app name that matches about as well.
    if (recentMatches[0] && !out.length && (!top || recentMatches[0].s >= top.s)) {
      out.push({ ...recentRows.shift()!, group: 'Top hit' })
      if (top) rest.unshift(top)
    } else if (top && !out.length) out.push({ ...top.r, group: 'Top hit' })
    else if (top) rest.unshift(top)
    rest.unshift(...recentRows.map((r) => ({ r, s: 0 })))
    for (const g of order) {
      out.push(...rest.filter((x) => x.r.group === g).slice(0, g === 'Files' ? 6 : g === 'Recently visited' ? 3 : 5).map((x) => x.r))
      if (g === 'Widgets') out.push(...codeRows.filter((r) => r.id !== out[0]?.id), ...codeStatus)
    }

    for (const sug of suggestions.filter((x) => x.toLowerCase() !== q.trim().toLowerCase()).slice(0, 5))
      out.push({
        id: `web-${sug}`,
        group: 'Web',
        title: sug,
        subtitle: `Search ${engine.label}`,
        icon: <Glyph>⌕</Glyph>,
        run: () => searchWeb(sug),
        enterLabel: 'Search',
        complete: sug,
      })
    const web: Result = {
      id: 'web',
      group: 'Fallback',
      title: `Search ${engine.label} for “${q.trim()}”`,
      icon: <Glyph>🔍</Glyph>,
      run: () => searchWeb(q.trim()),
      enterLabel: 'Search',
    }
    const runIt: Result = {
      id: 'run',
      group: 'Fallback',
      title: `Run “${q.trim()}” in a terminal`,
      icon: <Glyph>›_</Glyph>,
      run: () => term(q.trim()),
      alt: { label: 'In a new terminal', run: () => term(q.trim(), true) },
    }
    // Nothing of your own matched: Enter searches exactly what you typed (or runs it, as
    // Settings → Spotlight says). The engine's suggestions follow it, one arrow down away.
    const [first, second] = prefs.fallback === 'terminal' ? [runIt, web] : [web, runIt]
    if (!out.length || out[0].group === 'Web') out.unshift({ ...first, group: 'Top hit' })
    else out.push(first)
    out.push(second)
    return out
  }, [q, all, calc, code, suggestions, engine, sub, wm, recentHits, visits, prefs, address, page, goAlias, goTemplate, goSuggestions])

  useEffect(() => setActive(0), [q, sub])
  useEffect(() => {
    list.current?.querySelector('.sp-item.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 1400)
    return () => clearTimeout(t)
  }, [flash])

  /** Pin or unpin: apps, your launchers and repositories (as a launcher). Signed in only. */
  const pinFor = (r: Result | undefined): { pinned: boolean; toggle: () => void } | null => {
    if (!r || !canPin) return null
    let id: DockId | null = null
    if (r.id.startsWith('app-') && isDockableApp(r.id.slice(4) as AppId)) id = r.id.slice(4) as AppId
    else if (r.id.startsWith('launcher-')) id = `launcher:${r.id.slice('launcher-'.length)}`
    else if (r.link) {
      const existing = linkDockId(r.link.url)
      const link = r.link
      if (!existing || !dock.includes(existing)) return { pinned: false, toggle: () => pinLink(link.label, link.url) }
      id = existing
    }
    if (!id) return null
    const pinned = dock.includes(id)
    const target = id
    return { pinned, toggle: () => (pinned ? unpinFromDock : pinToDock)(target) }
  }
  const togglePin = (r: Result | undefined) => {
    const pin = pinFor(r)
    if (!pin) return
    pin.toggle()
    setFlash(pin.pinned ? 'Removed from the dock' : 'Pinned to the dock')
  }

  const current = results[active]
  const currentPin = pinFor(current)
  const execute = (r: Result | undefined, alt: boolean) => {
    if (!r) return
    const keepOpen = r.id.startsWith('sub-') || r.id === 'calc' || (r.id.startsWith('code-') && r.id !== 'code-signin' && !r.id.startsWith('code-err-')) || (r.id === 'status-mc' && alt) || r.id.startsWith('act-email') || r.id.startsWith('accent-') || r.id.startsWith('theme-')
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
          // In a sub-list, Esc (or Backspace in an empty box) goes back instead of closing.
          if (e.key === 'Escape' && sub) {
            e.stopPropagation()
            openSub(null)
          } else if (e.key === 'Backspace' && sub && !q) openSub(null)
          else if (e.key === 'Escape') close()
          else if (e.key === 'ArrowDown') setActive((a) => Math.min(results.length - 1, a + 1))
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
          else if (e.key === 'Enter' && e.shiftKey && currentPin) togglePin(current)
          else if (e.key === 'Enter') execute(current, e.ctrlKey || e.metaKey)
          else if (e.key === 'Tab' && current?.complete && !e.shiftKey) setQ(current.complete)
          else if (e.key === 'Delete' && e.shiftKey && current?.forget) current.forget()
          else return
          e.preventDefault()
        }}
      >
        <div className="sp-input">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          {sub && (
            <button className="sp-back" onClick={() => (openSub(null), input.current?.focus())} aria-label="Back">
              ‹ Add widget
            </button>
          )}
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={sub ? 'Which widget?' : account.status === 'user' ? 'Search apps, notes, repos… or #123, repo#text, repo@branch' : 'Search apps, files, status… or try 5 ft in cm, €20 to USD, 1 TB in GiB'}
            aria-label="Search"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd>esc</kbd>
        </div>
        <div className={`sp-main ${prefs.preview ? '' : 'no-preview'}`}>
          <div className="sp-results" ref={list} role="listbox">
            {results.map((r, i) => {
              const header = r.group !== lastGroup && r.group !== 'Fallback' ? r.group : r.group === 'Fallback' && lastGroup !== 'Fallback' ? 'More' : null
              lastGroup = r.group
              return (
                <div key={r.id}>
                  {header && <p className="sp-group">{header}</p>}
                  <button className={`sp-item ${i === active ? 'is-active' : ''}`} role="option" aria-selected={i === active} onPointerMove={() => setActive(i)}
                    onClick={(e) => execute(r, e.ctrlKey || e.metaKey)}
                    onContextMenu={(e) => {
                      const pin = pinFor(r)
                      openContextMenu(e, [
                        { label: r.enterLabel ?? 'Open', onSelect: () => execute(r, false) },
                        ...(r.alt ? [{ label: r.alt.label, onSelect: () => execute(r, true) }] : []),
                        ...(pin ? [{ separator: true as const }, { label: pin.pinned ? 'Remove from dock' : 'Pin to dock', onSelect: () => togglePin(r) }] : []),
                        ...(r.forget ? [{ separator: true as const }, { label: 'Forget', shortcut: 'Shift Del', onSelect: r.forget }] : []),
                      ])
                    }}
                  >
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
          {prefs.preview && <aside className="sp-preview">{current?.preview ? current.preview() : current ? <DefaultPreview r={current} /> : null}</aside>}
        </div>
        <footer className="sp-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> {current?.enterLabel ?? 'open'}
          </span>
          {current?.complete && (
            <span>
              <kbd>tab</kbd> complete
            </span>
          )}
          {current?.alt && (
            <span>
              <kbd>ctrl</kbd>
              <kbd>↵</kbd> {current.alt.label.toLowerCase()}
            </span>
          )}
          {current?.forget && (
            <span>
              <kbd>shift</kbd>
              <kbd>del</kbd> forget
            </span>
          )}
          {currentPin && (
            <span>
              <kbd>shift</kbd>
              <kbd>↵</kbd> {currentPin.pinned ? 'unpin' : 'pin to dock'}
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
