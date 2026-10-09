import { useEffect, useRef, useState, type ReactNode } from 'react'
import { profile } from '../data/profile'
import { timeAgo } from '../data/recents'
import { fetchMinecraft, MC_ADDRESS, MC_PORT, mcNotificationsOn, setMcNotifications, useMinecraft } from '../data/minecraft'
import { BUILT, COMMIT, REPO, VERSION } from '../version'
import { signIn, signOut, useAccount } from './account'
import { openContextMenu, type MenuItem } from './ContextMenu'
import { toggleOverlay } from './overlays'
import { reboot, shutdown } from './powerState'
import { useWM } from './wm'

/** A top-bar button with a dropdown panel that closes on outside click or Escape. */
function TopbarPopover({ label, className = '', title, children, menu }: { label: ReactNode; className?: string; title: string; children: (close: () => void) => ReactNode; /** Right-click */ menu?: () => MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className={`tb-pop ${className}`} ref={ref}>
      <button className={`tb-btn ${open ? 'is-open' : ''}`} onClick={() => setOpen((o) => !o)} title={title} aria-expanded={open} onContextMenu={menu && ((e) => openContextMenu(e, menu()))}>
        {label}
      </button>
      {open && <div className="tb-panel">{children(() => setOpen(false))}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Clock + calendar

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const born = new Date(`${profile.born}T00:00:00`)

function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 864e5 + 1) / 7)
}

function Calendar() {
  const today = new Date()
  const [view, setView] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const first = new Date(view.getFullYear(), view.getMonth(), 1)
  const lead = (first.getDay() + 6) % 7 // Monday-first
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate()
  const cells: (Date | null)[] = [...Array(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => new Date(view.getFullYear(), view.getMonth(), i + 1))]
  while (cells.length % 7) cells.push(null)
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7))
  const move = (n: number) => setView(new Date(view.getFullYear(), view.getMonth() + n, 1))
  const isToday = (d: Date) => d.toDateString() === today.toDateString()
  const isBirthday = (d: Date) => d.getDate() === born.getDate() && d.getMonth() === born.getMonth()
  const showingNow = view.getFullYear() === today.getFullYear() && view.getMonth() === today.getMonth()

  return (
    <div className="cal">
      <div className="cal-today">
        <span className="cal-big">{today.toLocaleDateString('en-GB', { weekday: 'long' })}</span>
        <span className="muted">
          {today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · week {isoWeek(today)}
        </span>
      </div>
      <div className="cal-head">
        <button className="cal-nav" onClick={() => move(-1)} aria-label="Previous month">
          ‹
        </button>
        <button className="cal-title" onClick={() => setView(new Date(today.getFullYear(), today.getMonth(), 1))} title="Back to today">
          {view.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
        </button>
        <button className="cal-nav" onClick={() => move(1)} aria-label="Next month">
          ›
        </button>
      </div>
      <table className="cal-grid">
        <thead>
          <tr>
            <th className="cal-wk">wk</th>
            {WEEKDAYS.map((d) => (
              <th key={d}>{d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((w, i) => (
            <tr key={i}>
              <td className="cal-wk">{isoWeek(w.find(Boolean)!)}</td>
              {w.map((d, j) => (
                <td key={j}>
                  {d && (
                    <span className={`cal-day ${isToday(d) ? 'is-today' : ''} ${j >= 5 ? 'is-weekend' : ''} ${isBirthday(d) ? 'is-bday' : ''}`} title={isBirthday(d) ? "Menno's birthday" : undefined}>
                      {d.getDate()}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!showingNow && (
        <button className="cal-back" onClick={() => setView(new Date(today.getFullYear(), today.getMonth(), 1))}>
          Back to today
        </button>
      )}
    </div>
  )
}

export function ClockWidget() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    // Tick on the minute boundary so the display never lags behind the real clock.
    let t: ReturnType<typeof setTimeout>
    const tick = () => {
      setNow(new Date())
      t = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50)
    }
    t = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50)
    return () => clearTimeout(t)
  }, [])
  return (
    <TopbarPopover
      className="tb-clock"
      title={now.toLocaleDateString('en-GB', { dateStyle: 'full' })}
      menu={() => {
        const at = new Date()
        const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {})
        return [
          { label: 'Copy date', onSelect: () => copy(at.toLocaleDateString('en-GB', { dateStyle: 'long' })) },
          { label: 'Copy time', onSelect: () => copy(at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })) },
          { label: 'Copy ISO timestamp', onSelect: () => copy(at.toISOString()) },
        ]
      }}
      label={
        <span className="clock">
          <span className="clock-date">{now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
          {now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}
        </span>
      }
    >
      {() => <Calendar />}
    </TopbarPopover>
  )
}

// ---------------------------------------------------------------------------------------------
// Minecraft server

function Pickaxe() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden fill="currentColor">
      <path d="M2 3h2v1h1v1h5V4h1V3h2v1h1v2h-1v1h-1V6h-1v1H9v2H8v1H7v1H6v1H5v1H4v1H2v-2h1v-1h1v-1h1V9h1V8h1V6H6v1H5V6H4v1H3V6H2z" />
    </svg>
  )
}

export function MinecraftWidget() {
  const { status, error, loading } = useMinecraft()
  const [copied, setCopied] = useState(false)
  const online = status?.online
  return (
    <TopbarPopover
      className="tb-mc"
      title="Minecraft server status"
      menu={() => [
        { label: `Copy address (${MC_ADDRESS})`, onSelect: () => navigator.clipboard?.writeText(MC_ADDRESS).catch(() => {}) },
        { label: 'Refresh status', onSelect: () => fetchMinecraft(true) },
        { separator: true },
        { label: 'Notify when players join', checked: mcNotificationsOn(), onSelect: () => setMcNotifications(!mcNotificationsOn()) },
      ]}
      label={
        <span className="mc-label">
          <Pickaxe />
          <span className={`live-dot ${online ? 'is-live' : status ? 'is-down' : ''}`} />
          <span className="mc-count">{status ? (online ? `${status.players.online}/${status.players.max}` : 'offline') : '…'}</span>
        </span>
      }
    >
      {() => (
        <div className="mc">
          <div className="mc-head">
            {status?.icon ? <img src={status.icon} alt="" className="mc-icon" /> : <span className="mc-icon mc-icon-blank">⛏</span>}
            <div>
              <strong>{status?.motd || 'Minecraft server'}</strong>
              <p className="muted">
                {status ? (online ? `Online · Java ${status.version ?? ''}` : 'Offline right now') : error ? `Could not check (${error})` : 'Checking…'}
              </p>
            </div>
          </div>
          <div className="mc-addr">
            <code>{MC_ADDRESS}</code>
            <button
              className="btn btn-small"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(MC_ADDRESS)
                  .then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                  .catch(() => {})
              }}
            >
              {copied ? 'Copied ✓' : 'Copy address'}
            </button>
          </div>
          {online && (
            <div className="mc-players">
              <div className="mc-bar">
                <span style={{ width: `${status.players.max ? (status.players.online / status.players.max) * 100 : 0}%` }} />
              </div>
              <p className="muted">
                {status.players.online} of {status.players.max} players
              </p>
              {status.players.list.length > 0 ? (
                <ul>
                  {status.players.list.map((p) => (
                    <li key={p}>
                      <img src={`https://mc-heads.net/avatar/${encodeURIComponent(p)}/16`} alt="" width={16} height={16} />
                      {p}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mc-empty">Nobody's mining right now.</p>
              )}
            </div>
          )}
          <label className="mc-notify">
            <input type="checkbox" checked={mcNotificationsOn()} onChange={(e) => setMcNotifications(e.target.checked)} />
            Notify me when players join or leave
          </label>
          <footer className="mc-foot muted">
            <span>Port {MC_PORT} · {status ? `checked ${timeAgo(new Date(status.checkedAt).toISOString())}` : ''}</span>
            <button className="mc-refresh" onClick={() => fetchMinecraft(true)} disabled={loading}>
              {loading ? 'Checking…' : 'Refresh'}
            </button>
          </footer>
        </div>
      )}
    </TopbarPopover>
  )
}

// ---------------------------------------------------------------------------------------------
// System menu (the MvL OS logo): which build this is, and whether it is the latest release.

let latestRelease: Promise<string | null> | null = null
const fetchLatestRelease = () =>
  (latestRelease ??= fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (typeof j?.tag_name === 'string' ? j.tag_name.replace(/^v/, '') : null))
    .catch(() => null))

/** -1, 0 or 1 for dotted version numbers; anything after a dash is ignored. */
function compareVersions(a: string, b: string) {
  const pa = a.split('-')[0].split('.').map(Number)
  const pb = b.split('-')[0].split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

function ReleaseStatus() {
  const [latest, setLatest] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    fetchLatestRelease().then((v) => live && setLatest(v))
    return () => {
      live = false
    }
  }, [])
  const dev = !/^\d+\.\d+\.\d+$/.test(VERSION)
  if (latest === undefined) return <span className="muted">checking…</span>
  if (latest === null) return <span className="muted">could not check</span>
  if (dev) return <span>development build · latest release {latest}</span>
  const cmp = compareVersions(VERSION, latest)
  if (cmp >= 0) return <span className="t-green">up to date ✓</span>
  return (
    <span>
      <span className="t-yellow">{latest} is out</span>{' '}
      <button className="sys-link" onClick={() => location.reload()}>
        reload
      </button>
    </span>
  )
}

/** Who is signed in, or a way to sign in (only when this server offers it). */
function AccountBlock({ close }: { close: () => void }) {
  const wm = useWM()
  const account = useAccount()
  const settings = () => {
    close()
    wm.open('settings', { t: String(Date.now()) })
  }
  if (account.status === 'user' && account.user)
    return (
      <div className="sys-user">
        {account.user.avatar && <img src={account.user.avatar} alt="" width={24} height={24} />}
        <span>
          Signed in as <strong>{account.user.login}</strong>
        </span>
        <button onClick={settings}>Settings</button>
        <button
          onClick={() => {
            close()
            void signOut()
          }}
        >
          Sign out
        </button>
      </div>
    )
  if (account.status === 'anon')
    return (
      <div className="sys-user">
        <span className="muted">Owner?</span>
        <button onClick={signIn}>Sign in with GitHub</button>
      </div>
    )
  return null
}

export function SystemMenu() {
  const wm = useWM()
  const built = new Date(BUILT)
  return (
    <TopbarPopover
      className="tb-sys"
      title="About MvL OS"
      label={
        <span className="logo">
          <svg viewBox="0 0 64 64" width="14" height="14" aria-hidden>
            <path d="M14 46V18l18 16 18-16v28" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          MvL OS
        </span>
      }
    >
      {(close) => (
        <div className="sys">
          <div className="sys-head">
            <span className="sys-logo" aria-hidden>
              <svg viewBox="0 0 64 64" width="26" height="26">
                <path d="M14 46V18l18 16 18-16v28" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <strong>MvL OS</strong>
              <p className="muted">Version {VERSION}</p>
            </div>
          </div>
          <dl className="sys-facts">
            <dt>Release</dt>
            <dd>
              <ReleaseStatus />
            </dd>
            <dt>Build</dt>
            <dd>
              {COMMIT ? (
                <a href={`https://github.com/${REPO}/commit/${COMMIT}`} target="_blank" rel="noopener noreferrer">
                  {COMMIT.slice(0, 7)}
                </a>
              ) : (
                'local'
              )}{' '}
              · {built.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} {built.toTimeString().slice(0, 5)}
            </dd>
            <dt>Owner</dt>
            <dd>{profile.name}</dd>
          </dl>
          <AccountBlock close={close} />
          <div className="sys-actions">
            <button
              onClick={() => {
                close()
                wm.open('terminal', { run: 'fastfetch', t: String(Date.now()) })
              }}
            >
              About this system
            </button>
            <button
              onClick={() => {
                close()
                wm.open('settings', { t: String(Date.now()) })
              }}
            >
              Settings
            </button>
            <button
              onClick={() => {
                close()
                toggleOverlay('launchpad')
              }}
            >
              All apps
            </button>
            <a href={`https://github.com/${REPO}/releases`} target="_blank" rel="noopener noreferrer" onClick={close}>
              Release notes
            </a>
            <span className="sys-sep" />
            <button
              onClick={() => {
                close()
                reboot()
              }}
            >
              Reboot
            </button>
            <button
              className="is-danger"
              onClick={() => {
                close()
                shutdown()
              }}
            >
              Shut down
            </button>
          </div>
        </div>
      )}
    </TopbarPopover>
  )
}
