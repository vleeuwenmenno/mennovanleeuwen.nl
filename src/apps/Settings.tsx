import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ENGINES, setSearchSettings, useSearchSettings, type EngineId } from '../data/searchEngine'
import { addLauncher, cleanUrl, faviconOf, moveLauncher, removeLauncher, updateLauncher, useLaunchers, type Launcher } from '../data/launchers'
import { api, connectGoogle, disconnectGoogle, linkForge, signIn, signOut, unlinkForge, useAccount } from '../os/account'
import { clearCodeSearch } from '../os/codeSearch'
import { APP_META } from '../os/apps'
import { isDefaultDock, isLauncherId, launcherDockId, pinToDock, resetDock, setDockOrder, unpinFromDock, unpinnedApps, useCanCustomizeDock, useDock, type DockId } from '../os/dockItems'
import { AppIcon } from '../os/icons'
import { pullAll } from '../os/synced'
import type { WinState } from '../os/wm'
import { SyncLine } from './Notebook'

// Account, linked Gitea/Forgejo instances, desktop launchers and sync, on one page. Opened from
// the system menu, the desktop's right-click menu (props.section scrolls to a section) or Spotlight.

function Account() {
  const account = useAccount()
  if (account.status === 'loading') return <p className="muted">Checking…</p>
  if (account.status === 'off')
    return (
      <p className="muted">
        Sign-in isn't set up on this server. It needs <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> (see the README). Notes and launchers still work, saved in this browser.
      </p>
    )
  if (account.status === 'anon')
    return (
      <>
        <p className="muted">Signing in syncs notes, window layouts and launchers between devices, and lets Spotlight search your repositories, issues, pull requests and branches.</p>
        <button className="btn btn-primary" onClick={signIn}>
          Sign in with GitHub
        </button>
      </>
    )
  const u = account.user!
  return (
    <div className="set-account">
      {u.avatar && <img className="set-avatar" src={u.avatar} alt="" />}
      <div>
        <strong>{u.name ?? u.login}</strong>
        <p className="muted">
          <a href={`https://github.com/${u.login}`} target="_blank" rel="noopener noreferrer">
            @{u.login}
          </a>{' '}
          on GitHub
        </p>
      </div>
      <span className="nb-spacer" />
      <button className="btn btn-small" onClick={signOut}>
        Sign out
      </button>
    </div>
  )
}

function Instances() {
  const account = useAccount()
  const [form, setForm] = useState({ baseUrl: '', label: '', token: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (account.status !== 'user') return <p className="muted">Sign in first to link Gitea or Forgejo instances.</p>

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await linkForge(form)
      clearCodeSearch()
      setForm({ baseUrl: '', label: '', token: '' })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const tokenPage = cleanUrl(form.baseUrl)?.replace(/\/+$/, '')

  return (
    <>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-glyph">⌥</span>
          <span className="set-row-text">
            <strong>GitHub</strong>
            <span className="muted">@{account.user!.login} · from your sign-in</span>
          </span>
        </li>
        {account.forges.map((f) => (
          <li key={f.id} className="set-row">
            <img className="set-fav" src={faviconOf(f.baseUrl)} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
            <span className="set-row-text">
              <strong>{f.label}</strong>
              <span className="muted">
                {f.baseUrl.replace(/^https?:\/\//, '')} · @{f.username}
              </span>
            </span>
            <button className="btn btn-small" onClick={() => unlinkForge(f.id).then(clearCodeSearch, (e: Error) => setError(e.message))}>
              Unlink
            </button>
          </li>
        ))}
      </ul>
      <form className="set-form" onSubmit={submit}>
        <label>
          <span>Instance URL</span>
          <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="git.example.com" required spellCheck={false} autoComplete="off" />
        </label>
        <label>
          <span>Name</span>
          <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="optional, e.g. Work" spellCheck={false} autoComplete="off" />
        </label>
        <label>
          <span>Access token</span>
          <input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder="personal access token" required autoComplete="off" />
        </label>
        <p className="muted set-help">
          Create one under{' '}
          {tokenPage ? (
            <a href={`${tokenPage}/user/settings/applications`} target="_blank" rel="noopener noreferrer">
              Settings → Applications
            </a>
          ) : (
            'Settings → Applications'
          )}{' '}
          on the instance, with <em>read</em> access to repository, issue, user and organization. It is checked once, then stored encrypted on this server.
        </p>
        {error && <p className="t-red">{error}</p>}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Checking…' : 'Link instance'}
        </button>
      </form>
    </>
  )
}

function LauncherRow({ l, first, last }: { l: Launcher; first: boolean; last: boolean }) {
  const canDock = useCanCustomizeDock()
  const docked = useDock().includes(launcherDockId(l.id))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(l)
  const [error, setError] = useState(false)
  if (editing)
    return (
      <li className="set-row is-editing">
        <input className="set-emoji" value={draft.glyph ?? ''} onChange={(e) => setDraft({ ...draft, glyph: e.target.value.slice(0, 4) })} placeholder="🔗" aria-label="Emoji" />
        <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} aria-label="Label" />
        <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} aria-label="URL" className={error ? 'is-bad' : ''} spellCheck={false} />
        <button
          className="btn btn-small btn-primary"
          onClick={() => {
            const url = cleanUrl(draft.url)
            if (!url || !draft.label.trim()) return setError(true)
            updateLauncher(l.id, { label: draft.label.trim().slice(0, 40), url, glyph: draft.glyph?.trim() || undefined })
            setEditing(false)
          }}
        >
          Save
        </button>
        <button className="btn btn-small" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </li>
    )
  return (
    <li className="set-row">
      {l.glyph ? <span className="set-glyph">{l.glyph}</span> : <img className="set-fav" src={faviconOf(l.url)} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />}
      <span className="set-row-text">
        <strong>{l.label}</strong>
        <a className="muted" href={l.url} target="_blank" rel="noopener noreferrer">
          {l.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
        </a>
      </span>
      <button className="btn btn-small btn-ghost" disabled={first} onClick={() => moveLauncher(l.id, -1)} aria-label="Move up">
        ↑
      </button>
      <button className="btn btn-small btn-ghost" disabled={last} onClick={() => moveLauncher(l.id, 1)} aria-label="Move down">
        ↓
      </button>
      <button
        className="btn btn-small"
        onClick={() => {
          setDraft(l)
          setEditing(true)
        }}
      >
        Edit
      </button>
      <button className={`btn btn-small ${l.desktop !== false ? 'is-on' : ''}`} onClick={() => updateLauncher(l.id, { desktop: l.desktop === false })} title="Show on the desktop">
        Desktop
      </button>
      {canDock && (
        <button className={`btn btn-small ${docked ? 'is-on' : ''}`} onClick={() => (docked ? unpinFromDock : pinToDock)(launcherDockId(l.id))} title="Pin to the dock">
          Dock
        </button>
      )}
      <button className="btn btn-small" onClick={() => removeLauncher(l.id)}>
        Remove
      </button>
    </li>
  )
}

/** Dock contents: reorder, take off, add back, restore the default. Signed in only. */
function DockSettings() {
  const dock = useDock()
  const can = useCanCustomizeDock()
  const launchers = useLaunchers()
  if (!can) return <p className="muted">Drag dock icons to reorder them. Sign in to add apps and launchers to the dock or take them off.</p>
  const launcherOf = (id: DockId) => launchers.find((l) => launcherDockId(l.id) === id)
  const label = (id: DockId) => (isLauncherId(id) ? (launcherOf(id)?.label ?? 'Link') : APP_META[id].dock)
  const icon = (id: DockId) => {
    if (!isLauncherId(id)) return <AppIcon app={id} size={22} tone />
    const l = launcherOf(id)
    return l?.glyph ? <span className="set-glyph">{l.glyph}</span> : <img className="set-fav" src={l ? faviconOf(l.url) : undefined} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
  }
  const move = (i: number, by: number) => {
    const next = dock.slice()
    next.splice(i + by, 0, next.splice(i, 1)[0])
    setDockOrder(next)
  }
  const available: DockId[] = [...unpinnedApps(dock), ...launchers.map((l) => launcherDockId(l.id)).filter((id) => !dock.includes(id))]
  return (
    <>
      <ul className="set-list">
        {dock.map((id, i) => (
          <li key={id} className="set-row">
            {icon(id)}
            <span className="set-row-text">
              <strong>{label(id)}</strong>
            </span>
            <button className="btn btn-small btn-ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move left">
              ↑
            </button>
            <button className="btn btn-small btn-ghost" disabled={i === dock.length - 1} onClick={() => move(i, 1)} aria-label="Move right">
              ↓
            </button>
            <button className="btn btn-small" onClick={() => unpinFromDock(id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {available.length > 0 && (
        <div className="set-chips">
          <span className="muted">Add:</span>
          {available.map((id) => (
            <button key={id} className="btn btn-small" onClick={() => pinToDock(id)}>
              + {label(id)}
            </button>
          ))}
        </div>
      )}
      <p className="muted set-help">Right-click anything in Spotlight or All apps to pin it, including repositories.</p>
      <button className="btn btn-small" disabled={isDefaultDock()} onClick={resetDock}>
        Restore default dock
      </button>
    </>
  )
}

function Launchers() {
  const launchers = useLaunchers()
  const [form, setForm] = useState({ label: '', url: '', glyph: '' })
  const [error, setError] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const url = cleanUrl(form.url)
    if (!url) return setError('That is not a web address.')
    let label = form.label.trim()
    if (!label) label = new URL(url).hostname.replace(/^www\./, '')
    addLauncher({ label: label.slice(0, 40), url, glyph: form.glyph.trim() || undefined })
    setForm({ label: '', url: '', glyph: '' })
    setError(null)
  }
  return (
    <>
      {launchers.length > 0 && (
        <ul className="set-list">
          {launchers.map((l, i) => (
            <LauncherRow key={l.id} l={l} first={i === 0} last={i === launchers.length - 1} />
          ))}
        </ul>
      )}
      <form className="set-form set-form-row" onSubmit={submit}>
        <input className="set-emoji" value={form.glyph} onChange={(e) => setForm({ ...form, glyph: e.target.value.slice(0, 4) })} placeholder="🔗" aria-label="Emoji (optional)" />
        <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" aria-label="URL" required spellCheck={false} />
        <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Name (optional)" aria-label="Name" />
        <button className="btn btn-primary">Add</button>
      </form>
      {error && <p className="t-red">{error}</p>}
      <p className="muted set-help">Launchers sit on the desktop and show up in All apps and Spotlight. Without an emoji they use the site's own icon.</p>
    </>
  )
}

type CalendarInfo = { id: string; name: string; color: string; primary: boolean; selected: boolean }

/** Google Calendar, read-only, for the Agenda widget. */
function CalendarSettings() {
  const account = useAccount()
  const [calendars, setCalendars] = useState<CalendarInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const connected = account.status === 'user' && !!account.google
  useEffect(() => {
    if (!connected) return setCalendars(null)
    api<CalendarInfo[]>('/api/calendar/calendars').then(setCalendars, (e: Error) => setError(e.message))
  }, [connected])
  if (account.status !== 'user') return <p className="muted">Sign in first to connect Google Calendar.</p>
  if (!account.googleEnabled) return <p className="muted">Google Calendar isn't set up on this server (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, see the README).</p>
  if (!account.google)
    return (
      <>
        <p className="muted">Read-only access to your calendars, shared ones included, for the Agenda widget. It attaches to your GitHub sign-in; it is not a way to sign in.</p>
        <button className="btn btn-primary" onClick={connectGoogle}>
          Connect Google Calendar
        </button>
      </>
    )
  return (
    <>
      <div className="set-account">
        <span className="set-glyph">📅</span>
        <div>
          <strong>{account.google.email}</strong>
          <p className="muted">Read-only, stored encrypted on this server</p>
        </div>
        <span className="nb-spacer" />
        <button className="btn btn-small" onClick={() => disconnectGoogle().catch((e: Error) => setError(e.message))}>
          Disconnect
        </button>
      </div>
      {error && <p className="t-red">{error}</p>}
      {calendars && (
        <ul className="set-list set-calendars">
          {calendars.map((c) => (
            <li key={c.id} className="set-row">
              <span className="set-swatch" style={{ background: c.color }} />
              <span className="set-row-text">
                <strong>{c.name}</strong>
                <span className="muted">{c.primary ? 'Your calendar' : c.selected ? 'Shown in Google Calendar' : 'Hidden in Google Calendar'}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted set-help">Each Agenda widget picks which of these it shows (right-click it). By default: the ones shown in Google Calendar.</p>
    </>
  )
}

/** Spotlight's web search: which engine, and whether to show its suggestions while typing. */
function SearchSettings() {
  const { engine, suggestions } = useSearchSettings()
  const account = useAccount()
  return (
    <>
      <div className="set-choices" role="radiogroup" aria-label="Search engine">
        {(Object.keys(ENGINES) as EngineId[]).map((id) => (
          <label key={id} className={`set-choice ${engine === id ? 'is-on' : ''}`}>
            <input type="radio" name="search-engine" checked={engine === id} onChange={() => setSearchSettings({ engine: id })} />
            {ENGINES[id].label}
          </label>
        ))}
      </div>
      <label className="set-check">
        <input type="checkbox" checked={suggestions} onChange={(e) => setSearchSettings({ suggestions: e.target.checked })} />
        Show {ENGINES[engine].label}'s suggestions in Spotlight
      </label>
      <p className="muted set-help">
        Suggestions send what you type to {ENGINES[engine].label} through this site's server.{' '}
        {account.status === 'user' ? 'Your choice syncs to your other devices.' : 'Saved in this browser.'}
      </p>
    </>
  )
}

export function Settings({ win }: { win: WinState }) {
  const account = useAccount()
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (win.props.section) root.current?.querySelector(`#set-${win.props.section}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [win.props.section, win.props.t])
  return (
    <div className="settings" ref={root}>
      <section id="set-account">
        <h3>Account</h3>
        <Account />
      </section>
      <section id="set-instances">
        <h3>Code hosts</h3>
        <Instances />
      </section>
      <section id="set-launchers">
        <h3>Launchers</h3>
        <Launchers />
      </section>
      <section id="set-calendar">
        <h3>Calendar</h3>
        <CalendarSettings />
      </section>
      <section id="set-search">
        <h3>Search</h3>
        <SearchSettings />
      </section>
      <section id="set-dock">
        <h3>Dock</h3>
        <DockSettings />
      </section>
      <section id="set-sync">
        <h3>Sync</h3>
        <div className="set-account">
          <SyncLine />
          <span className="nb-spacer" />
          {account.status === 'user' && (
            <button className="btn btn-small" onClick={() => void pullAll()}>
              Sync now
            </button>
          )}
        </div>
        <p className="muted set-help">Notes, launchers, desktop icons, the dock and window layouts (one for phones, one for bigger screens) follow you between devices.</p>
      </section>
    </div>
  )
}
