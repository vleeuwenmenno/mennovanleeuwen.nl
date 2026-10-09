import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { isShown, setCalendarShown, useCalendarChoice, useCalendarList } from '../data/calendar'
import { ENGINES, setSearchSettings, useSearchSettings, type EngineId } from '../data/searchEngine'
import { setLinkSettings, useLinkSettings } from '../data/links'
import { clearVisits, useVisits } from '../data/siteHistory'
import { clearHits, useRecentHits } from '../data/spotlightRecent'
import { favouriteKey, moveFavourite, removeFavourite, useFavourites } from '../data/spotlightFavourites'
import { CATEGORIES, RECENT_COUNTS, setInclude, setSpotlightPrefs, setStart, START_SECTIONS, useSpotlightPrefs, type Fallback } from '../data/spotlightPrefs'
import { addLauncher, cleanUrl, faviconOf, moveLauncher, removeLauncher, updateLauncher, useLaunchers, type Launcher } from '../data/launchers'
import { golinksSite, golinksTemplate, maskGolinks, parseGolinks, setGolinks } from '../data/golinks'
import { MC_ADDRESS, mcNotificationsOn, setMcNotifications, useMinecraft } from '../data/minecraft'
import { setSwing, useSwingPrefs } from '../os/swing'
import { ask } from '../os/Dialogs'
import { libraryName, loadLibraries, primaryOf, setSeafilePrefs, useLibraries, useSeafilePrefs } from '../data/seafile'

const libraryNameOf = (prefix: string) => libraryName(prefix.slice('seafile://'.length))
import { addCaldav, connectGoogle, disconnectGoogle, linkSeafile, removeCaldav, removeOffice, removeUpdownKey, setOffice, setUpdownKey, signIn, signOut, unlinkForge, unlinkSeafile, useAccount, useLikelyOwner } from '../os/account'
import { clearCodeSearch } from '../os/codeSearch'
import { APP_META } from '../os/apps'
import { isDefaultDock, isLauncherId, launcherDockId, pinToDock, resetDock, setDockOrder, unpinFromDock, unpinnedApps, useCanCustomizeDock, useDock, type DockId } from '../os/dockItems'
import { DOCK_MODES, getDockMode, setDockMode, type DockMode } from '../os/dockPrefs'
import { AppIcon } from '../os/icons'
import { THEMES } from '../os/omarchyThemes'
import { pullAll } from '../os/synced'
import { ACCENTS, DARK_THEMES, LIGHT_THEMES, setAccent, setMode, setTheme, themeLabel, useTheme, type Mode } from '../os/theme'
import { ReleaseStatus } from '../os/TopbarWidgets'
import { useWM, type WinState } from '../os/wm'
import { BUILT, COMMIT, REPO, VERSION } from '../version'
import { BranchGlyph } from './LinkForge'
import { SyncLine } from './Notebook'

// System settings, laid out like macOS: the account on top of a sidebar, one pane per topic.
// Opened from the system menu, the desktop's right-click menu, Spotlight and the terminal;
// props.section picks the pane (account, appearance, dock, launchers, search (Spotlight), notifications,
// instances, calendar, integrations, golinks, sync, about). The account and service panes only show
// for the signed-in owner.

const SignInFirst = ({ what }: { what: string }) => {
  const account = useAccount()
  return (
    <div className="set-empty">
      <p className="muted">Sign in first to {what}.</p>
      {account.status === 'anon' && (
        <button className="btn btn-primary" onClick={signIn}>
          Sign in with GitHub
        </button>
      )}
    </div>
  )
}

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
      <div className="set-hero">
        <span className="set-hero-avatar is-guest">?</span>
        <strong>Guest</strong>
        <p className="muted">Your notes, launchers and settings are saved in this browser.</p>
        <button className="link-btn" onClick={signIn}>
          Owner sign-in
        </button>
      </div>
    )
  const u = account.user!
  const linked = [`GitHub`, ...account.forges.map((f) => f.label), ...(account.google ? ['Google Calendar'] : [])]
  return (
    <>
      <div className="set-hero">
        {u.avatar ? <img className="set-hero-avatar" src={u.avatar} alt="" /> : <span className="set-hero-avatar is-guest">{u.login[0].toUpperCase()}</span>}
        <strong>{u.name ?? u.login}</strong>
        <a className="muted" href={`https://github.com/${u.login}`} target="_blank" rel="noopener noreferrer">
          @{u.login} on GitHub
        </a>
      </div>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>Connected</strong>
            <span className="muted">{linked.join(', ')}</span>
          </span>
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Sync</strong>
            <SyncLine />
          </span>
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Sign out</strong>
            <span className="muted">This browser keeps nothing of yours afterwards.</span>
          </span>
          <button className="btn btn-small" onClick={signOut}>
            Sign out
          </button>
        </li>
      </ul>
    </>
  )
}

/** Light/dark mode, the Omarchy theme for each, and the accent. Kept in this browser. */
function Appearance() {
  const t = useTheme()
  const swing = useSwingPrefs()
  const modes: [Mode, string][] = [
    ['auto', 'Auto'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ]
  const grid = (ids: string[], current: string) => (
    <div className="set-themes">
      {ids.map((id) => {
        const p = THEMES[id]
        return (
          <button key={id} className={`set-theme ${current === id ? 'is-on' : ''}`} onClick={() => setTheme(id)} aria-pressed={current === id}>
            <span className="set-theme-preview" style={{ background: p.background, color: p.foreground }} aria-hidden>
              <span style={{ background: p.darkBackground }} />
              <i style={{ background: p.accent }} />
              <i style={{ background: p.foreground, width: '55%' }} />
              <i style={{ background: p.muted, width: '35%' }} />
            </span>
            <span>{themeLabel(id)}</span>
          </button>
        )
      })}
    </div>
  )
  return (
    <>
      <SetGroup title="Mode">
        <div className="seg set-seg" role="radiogroup" aria-label="Mode">
          {modes.map(([m, label]) => (
            <button key={m} role="radio" aria-checked={t.mode === m} className={t.mode === m ? 'is-active' : ''} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
        <p className="muted set-help">Auto follows your device's light or dark setting. Showing {t.label} now.</p>
      </SetGroup>
      <SetGroup title="Accent color">
        <div className="set-swatches">
          <button className={`set-swatch-btn set-swatch-theme ${!t.accent ? 'is-on' : ''}`} style={{ ['--sw' as string]: t.palette.accent }} onClick={() => setAccent(null)} title="The theme's own accent">
            Theme
          </button>
          {Object.entries(ACCENTS).map(([name, color]) => (
            <button key={name} className={`set-swatch-btn ${t.accent === name ? 'is-on' : ''}`} style={{ ['--sw' as string]: color }} onClick={() => setAccent(name)} title={name} aria-label={name} />
          ))}
        </div>
      </SetGroup>
      <SetGroup title="Light theme">{grid(LIGHT_THEMES, t.light)}</SetGroup>
      <SetGroup title="Dark theme">{grid(DARK_THEMES, t.dark)}</SetGroup>
      <SetGroup title="Motion">
        <label className="set-check">
          <input type="checkbox" checked={swing.icons} onChange={(e) => setSwing({ icons: e.target.checked })} />
          Desktop icons wiggle while you drag them
        </label>
        <label className="set-check">
          <input type="checkbox" checked={swing.notes} onChange={(e) => setSwing({ notes: e.target.checked })} />
          Notes and widgets wiggle while you drag them
        </label>
      </SetGroup>
      <p className="muted set-help">The themes are Omarchy's own palettes. Saved in this browser.</p>
    </>
  )
}

function useDockMode(): DockMode {
  const [mode, set] = useState(getDockMode)
  useEffect(() => {
    const sync = () => set(getDockMode())
    window.addEventListener('mvlos:dock', sync)
    return () => window.removeEventListener('mvlos:dock', sync)
  }, [])
  return mode
}

function Notifications() {
  useMinecraft() // re-renders when the toggle changes
  return (
    <>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>Minecraft server</strong>
            <span className="muted">When players join or leave {MC_ADDRESS}, or it goes down or comes back</span>
          </span>
          <Toggle on={mcNotificationsOn()} onChange={setMcNotifications} label="Minecraft notifications" />
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Activity</strong>
            <span className="muted">New pushes, releases and pull requests from the last 15 minutes, once per visit</span>
          </span>
          <span className="muted">Always on</span>
        </li>
      </ul>
      <p className="muted set-help">Notifications show in the top right corner of the desktop and only while this page is open.</p>
    </>
  )
}

/** The terminal's `go` command: which golinks account it follows. */
function GoLinks() {
  const account = useAccount()
  const [template, setTemplate] = useState(golinksTemplate)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(false)
  const save = (e: FormEvent) => {
    e.preventDefault()
    const next = parseGolinks(draft.trim().split(/\s+/))
    if (!next) return setError(true)
    setGolinks(next)
    setTemplate(next)
    setDraft('')
    setError(false)
  }
  return (
    <>
      {template ? (
        <ul className="set-list">
          <li className="set-row">
            <span className="set-glyph">↪</span>
            <span className="set-row-text">
              <strong>{golinksSite(template).replace(/^https?:\/\//, '')}</strong>
              <span className="muted">{maskGolinks(template)}</span>
            </span>
            <a className="btn btn-small" href={`${golinksSite(template)}/aliases`} target="_blank" rel="noopener noreferrer">
              Aliases
            </a>
            <button
              className="btn btn-small"
              onClick={() => {
                setGolinks(null)
                setTemplate(null)
              }}
            >
              Remove
            </button>
          </li>
        </ul>
      ) : (
        <p className="muted">
          No account yet. Make a token on{' '}
          <a href="https://mvl.sh/tokens" target="_blank" rel="noopener noreferrer">
            mvl.sh
          </a>{' '}
          (or your own golinks) and paste its search URL here.
        </p>
      )}
      <form className="set-form set-form-row" onSubmit={save}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="https://mvl.sh/r/%s?token=…" aria-label="Search URL" className={error ? 'is-bad' : ''} spellCheck={false} autoComplete="off" />
        <button className="btn btn-primary">{template ? 'Replace' : 'Save'}</button>
      </form>
      {error && <p className="t-red">That is not a golinks search URL (…/r/%s?token=…), or a token.</p>}
      <p className="muted set-help">
        Then <code>go &lt;alias&gt;</code> in Spotlight or the terminal opens that link; Spotlight suggests your aliases as you type. {account.status === 'user' ? 'Synced to your account.' : 'Saved in this browser.'}
      </p>
    </>
  )
}

function About() {
  return (
    <>
      <div className="set-hero">
        <span className="set-hero-avatar set-hero-logo">M</span>
        <strong>MvL OS</strong>
        <span className="muted">Version {VERSION}</span>
      </div>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>Updates</strong>
            <ReleaseStatus />
          </span>
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Build</strong>
            <span className="muted">
              {COMMIT ? (
                <a href={`https://github.com/${REPO}/commit/${COMMIT}`} target="_blank" rel="noopener noreferrer">
                  {COMMIT.slice(0, 7)}
                </a>
              ) : (
                'local'
              )}{' '}
              · {new Date(BUILT).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
          </span>
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Source</strong>
            <a className="muted" href={`https://github.com/${REPO}`} target="_blank" rel="noopener noreferrer">
              github.com/{REPO}
            </a>
          </span>
        </li>
      </ul>
      <p className="muted set-help">Menno's CV as a tiny operating system. Built with Vite, React and TypeScript; themes from Omarchy.</p>
    </>
  )
}

const SetGroup = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="set-section">
    <h4>{title}</h4>
    {children}
  </section>
)

function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`set-toggle ${on ? 'is-on' : ''}`} onClick={() => onChange(!on)} />
}

function Instances() {
  const wm = useWM()
  const account = useAccount()
  const [error, setError] = useState<string | null>(null)
  if (account.status !== 'user') return <SignInFirst what="link Gitea or Forgejo instances" />
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
      {error && <p className="t-red">{error}</p>}
      <button className="btn btn-primary" onClick={() => wm.open('linkforge', { t: String(Date.now()) })}>
        Link an instance…
      </button>
      <p className="muted set-help">Gitea and Forgejo instances are linked with a personal access token. Spotlight then searches their repositories, issues, pull requests and branches too.</p>
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
  const mode = useDockMode()
  const behaviour = (
    <SetGroup title="Show the dock">
      <div className="set-radios" role="radiogroup" aria-label="Show the dock">
        {DOCK_MODES.map(([m, label]) => (
          <label key={m} className={`set-choice ${mode === m ? 'is-on' : ''}`}>
            <input type="radio" name="dock-mode" checked={mode === m} onChange={() => setDockMode(m)} />
            {label}
          </label>
        ))}
      </div>
    </SetGroup>
  )
  if (!can)
    return (
      <>
        {behaviour}
        <p className="muted set-help">Drag dock icons to reorder them. Sign in to add apps and launchers to the dock or take them off.</p>
      </>
    )
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
      {behaviour}
      <h4 className="set-subhead">In the dock</h4>
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

/** Third-party services the widgets read from, with keys on the server: updown.io for Status. */
type IntegrationId = 'updown' | 'seafile' | 'onlyoffice'

/** Third-party services, one row each; a row opens that service's own settings. */
function Integrations() {
  const account = useAccount()
  const [open, setOpen] = useState<IntegrationId | null>(null)
  const { libraries } = useLibraries()
  if (account.status !== 'user') return <p className="muted">Sign in first to connect services for widgets and Files.</p>
  const seafile = account.seafile
  const host = (url: string) => url.replace(/^https?:\/\//, '')

  const rows: { id: IntegrationId; name: string; icon: ReactNode; status: string; on: boolean; disabled?: boolean }[] = [
    {
      id: 'updown',
      name: 'updown.io',
      icon: <img className="set-fav" src="https://updown.io/favicon.ico" alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />,
      status: account.integrations.updown === 'server' ? 'Connected with the key set on the server' : account.integrations.updown ? 'Connected · for the Status widget' : 'Uptime checks, for the Status widget',
      on: !!account.integrations.updown,
    },
    {
      id: 'seafile',
      name: 'Seafile',
      icon: seafile ? <Fav src={`${seafile.url}/media/favicons/favicon.png`} glyph="☁" /> : <span className="set-glyph">☁</span>,
      status: seafile ? `${seafile.username} · ${host(seafile.url)}${libraries ? ` · ${libraries.length} ${libraries.length === 1 ? 'library' : 'libraries'}` : ''}` : 'Your libraries in Files and on the desktop',
      on: !!seafile,
    },
    {
      id: 'onlyoffice',
      name: 'OnlyOffice',
      icon: <span className="set-glyph">📝</span>,
      status: seafile?.office ? `${host(seafile.office.url)} · for Word, Excel and PowerPoint files` : seafile ? 'Edit Office files in a window, with the server Seafile uses' : 'Link Seafile first',
      on: !!seafile?.office,
      disabled: !seafile,
    },
  ]

  const current = rows.find((r) => r.id === open && !r.disabled)
  if (current)
    return (
      <>
        <button className="set-up" onClick={() => setOpen(null)}>
          ‹ Integrations
        </button>
        <div className="set-detail-head">
          {current.icon}
          <strong>{current.name}</strong>
          {current.on && <span className="set-badge">Connected</span>}
        </div>
        {current.id === 'updown' ? <UpdownSettings /> : current.id === 'seafile' ? <SeafileSettings /> : <OfficeSettings />}
      </>
    )

  return (
    <ul className="set-list">
      {rows.map((r) => (
        <li key={r.id} className="set-row set-row-link">
          <button disabled={r.disabled} onClick={() => setOpen(r.id)} aria-label={`${r.name} settings`}>
            {r.icon}
            <span className="set-row-text">
              <strong>{r.name}</strong>
              <span className="muted">{r.status}</span>
            </span>
            {r.on && <span className="set-dot" title="Connected" />}
            <span className="set-chevron" aria-hidden>
              ›
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** A service's own icon, or a glyph when it does not load. */
function Fav({ src, glyph }: { src: string; glyph: string }) {
  const [broken, setBroken] = useState(false)
  return broken ? <span className="set-glyph">{glyph}</span> : <img className="set-fav" src={src} alt="" onError={() => setBroken(true)} />
}

/** updown.io's read-only API key, for the Status widget. */
function UpdownSettings() {
  const account = useAccount()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await setUpdownKey(key)
      setKey('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {account.integrations.updown === 'server' && <p className="muted">Connected with UPDOWN_API_KEY from the server's environment. A key saved here would be used instead.</p>}
      {account.integrations.updown === 'settings' ? (
        <>
          <p className="muted">Connected with a read-only key saved here, stored encrypted on this server. The Status widget shows your checks.</p>
          <button className="btn btn-small" onClick={() => removeUpdownKey().catch((e: Error) => setError(e.message))}>
            Remove key
          </button>
        </>
      ) : (
        <form className="set-form" onSubmit={save}>
          <label>
            <span>Read-only API key</span>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="read-only API key" autoComplete="off" required />
          </label>
          <p className="muted set-help">
            Use the <em>read-only</em> key from{' '}
            <a href="https://updown.io/settings/edit" target="_blank" rel="noopener noreferrer">
              updown.io → Settings → API
            </a>
            , not the super-powered one. It is checked once, then stored encrypted on this server.
          </p>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Checking…' : 'Connect updown.io'}
          </button>
        </form>
      )}
      {error && <p className="t-red">{error}</p>}
    </>
  )
}

/** Seafile for Files and the desktop: linking, the primary library and home, encrypted libraries. */
function SeafileSettings() {
  const account = useAccount()
  const seafile = account.seafile
  const [form, setForm] = useState({ url: '', username: '', password: '', otp: '' })
  const [askOtp, setAskOtp] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { libraries: libs, error: libsError } = useLibraries()
  const sfPrefs = useSeafilePrefs()
  const primary = primaryOf(libs, sfPrefs.primary)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const link = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      if ((await linkSeafile(form)) === 'otp') return setAskOtp(true)
      setForm({ url: '', username: '', password: '', otp: '' })
      setAskOtp(false)
    })
  }

  if (!seafile)
    return (
      <form className="set-form" onSubmit={link}>
        <label>
          <span>Server URL</span>
          <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://seafile.example.com" required spellCheck={false} autoComplete="off" />
        </label>
        <label>
          <span>Email or username</span>
          <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="you@example.com" required spellCheck={false} autoComplete="off" />
        </label>
        <label>
          <span>Password</span>
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="password" required autoComplete="off" />
        </label>
        {askOtp && (
          <label>
            <span>2FA code</span>
            <input value={form.otp} onChange={(e) => setForm({ ...form, otp: e.target.value })} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" required autoFocus />
          </label>
        )}
        <p className="muted set-help">
          Your libraries in Files. The password is used once to sign in and is not kept: this server stores only the token Seafile hands out, encrypted. It shows in Seafile under <em>Settings → Devices</em> as {`"mennovanleeuwen.nl"`}, where you can revoke it.
        </p>
        {error && <p className="t-red">{error}</p>}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : askOtp ? 'Verify and link' : 'Link Seafile'}
        </button>
      </form>
    )

  return (
    <>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>{seafile.name || seafile.username}</strong>
            <span className="muted">
              {seafile.username} · {seafile.url.replace(/^https?:\/\//, '')}
              {seafile.version && ` · Seafile ${seafile.version}`}
            </span>
          </span>
          <button className="btn btn-small" disabled={busy} onClick={async () => (await ask({ title: 'Unlink Seafile?', body: 'Files and the desktop stop showing it, and this device is signed out on Seafile. Nothing in Seafile is deleted.', confirm: 'Unlink', danger: true })) && run(unlinkSeafile)}>
            Unlink
          </button>
        </li>
      </ul>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>Primary library</strong>
            <span className="muted">Home in Files: its Desktop, Documents, Downloads, Music, Pictures and Videos folders</span>
          </span>
          <select className="set-select" value={primary?.id ?? ''} disabled={!libs?.length} onChange={(e) => setSeafilePrefs({ primary: e.target.value })} aria-label="Primary library">
            {!libs && <option value="">Loading…</option>}
            {libs?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.encrypted ? ' 🔒' : ''}
                {l.type !== 'mine' && l.owner ? ` (${l.owner})` : ''}
              </option>
            ))}
          </select>
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Use as home</strong>
            <span className="muted">{sfPrefs.home ? `Files and the desktop use ${primary?.name ?? 'the primary library'}` : 'Off: home is the built-in one, Seafile is still in Files’ sidebar'}</span>
          </span>
          <Toggle on={sfPrefs.home} onChange={(home) => setSeafilePrefs({ home })} label="Use the primary library as home" />
        </li>
        <li className={`set-row ${sfPrefs.home ? '' : 'is-off'}`}>
          <span className="set-row-text">
            <strong>Site icons on the desktop</strong>
            <span className="muted">{sfPrefs.siteIcons ? 'Next to the Desktop folder’s files and folders' : 'Off: the desktop is the Desktop folder (and your launchers)'}</span>
          </span>
          <Toggle on={sfPrefs.siteIcons} onChange={(siteIcons) => sfPrefs.home && setSeafilePrefs({ siteIcons })} label="Show the site's icons on the desktop" />
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Seafile's trash in Files</strong>
            <span className="muted">{sfPrefs.trash ? 'Trash shows what was deleted in your libraries, to restore or empty' : 'Off: Trash is the site’s own'}</span>
          </span>
          <Toggle on={sfPrefs.trash} onChange={(trash) => setSeafilePrefs({ trash })} label="Show Seafile's trash in Files" />
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Encrypted libraries</strong>
            <span className="muted">Ask for the password again after</span>
          </span>
          <select className="set-select" value={sfPrefs.lockMinutes} onChange={(e) => setSeafilePrefs({ lockMinutes: Number(e.target.value) })} aria-label="Lock encrypted libraries after">
            {[5, 15, 30, 55].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </li>
      </ul>
      {libsError && (
        <p className="t-red">
          {libsError}{' '}
          <button className="btn btn-small" onClick={() => loadLibraries(true)}>
            Try again
          </button>
        </p>
      )}
      {error && <p className="t-red">{error}</p>}
    </>
  )
}

/** The OnlyOffice document server Seafile uses, for editing Office files in a window. */
function OfficeSettings() {
  const account = useAccount()
  const office = account.seafile?.office
  const dock = useDock()
  const sfPrefs = useSeafilePrefs()
  const [form, setForm] = useState({ url: '', secret: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (office)
    return (
      <>
        <ul className="set-list">
          <li className="set-row">
            <span className="set-row-text">
              <strong>{office.url.replace(/^https?:\/\//, '')}</strong>
              <span className="muted">Word, Excel and PowerPoint files open in it; the JWT secret is stored encrypted here</span>
            </span>
            <button className="btn btn-small" disabled={busy} onClick={async () => (await ask({ title: 'Remove OnlyOffice?', body: 'Office files download again instead of opening here. Nothing in Seafile changes.', confirm: 'Remove', danger: true })) && run(removeOffice)}>
              Remove
            </button>
          </li>
        </ul>
        <ul className="set-list">
          {(['newdoc', 'newsheet', 'newslides'] as const).map((app) => (
            <li key={app} className="set-row">
              <AppIcon app={app} size={22} />
              <span className="set-row-text">
                <strong>{APP_META[app].dock}</strong>
                <span className="muted">In Spotlight and All apps{dock.includes(app) ? ', on the dock' : ''}</span>
              </span>
              <Toggle on={dock.includes(app)} onChange={(on) => (on ? pinToDock(app) : unpinFromDock(app))} label={`${APP_META[app].dock} on the dock`} />
            </li>
          ))}
          <li className="set-row">
            <span className="set-row-text">
              <strong>On the desktop</strong>
              <span className="muted">New Document, New Spreadsheet and New Presentation as desktop icons</span>
            </span>
            <Toggle on={sfPrefs.officeDesktop} onChange={(officeDesktop) => setSeafilePrefs({ officeDesktop })} label="New document icons on the desktop" />
          </li>
          <li className="set-row">
            <span className="set-row-text">
              <strong>New files go to</strong>
              <span className="muted">{sfPrefs.officeFolder ? sfPrefs.officeFolder.replace(/^seafile:\/\/[^/]+/, (m) => libraryNameOf(m)) : 'Documents in your home library'}</span>
            </span>
            {sfPrefs.officeFolder && (
              <button className="btn btn-small" onClick={() => setSeafilePrefs({ officeFolder: null })}>
                Back to Documents
              </button>
            )}
          </li>
        </ul>
        <p className="muted set-help">Pick another folder from Files: right-click it → New documents go here.</p>
        {error && <p className="t-red">{error}</p>}
      </>
    )
  return (
    <form
      className="set-form"
      onSubmit={(e) => {
        e.preventDefault()
        run(async () => {
          await setOffice(form)
          setForm({ url: '', secret: '' })
        })
      }}
    >
      <label>
        <span>OnlyOffice URL</span>
        <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://office.example.com" required spellCheck={false} autoComplete="off" />
      </label>
      <label>
        <span>JWT secret</span>
        <input type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder="ONLYOFFICE_JWT_SECRET" required autoComplete="off" />
      </label>
      <p className="muted set-help">
        The document server Seafile opens Office files with, to edit them in a window here. The secret is <em>ONLYOFFICE_JWT_SECRET</em> from Seafile's <em>.env</em> (or <em>seahub_settings.py</em>). The URL is checked by loading its editor, then both are stored encrypted on this server.
      </p>
      {error && <p className="t-red">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? 'Checking…' : 'Add OnlyOffice'}
      </button>
    </form>
  )
}

/** Google Calendar and CalDAV accounts, for the Calendar app, the Agenda widget and the clock; and which calendars show. */
function CalendarSettings() {
  const account = useAccount()
  const { calendars, errors } = useCalendarList()
  const picks = useCalendarChoice()
  const [error, setError] = useState<string | null>(null)
  if (account.status !== 'user') return <SignInFirst what="connect a calendar" />
  return (
    <>
      <h4 className="set-subhead">Google Calendar</h4>
      {!account.googleEnabled ? (
        <p className="muted">Not set up on this server (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, see the README).</p>
      ) : account.google ? (
        <div className="set-account">
          <span className="set-glyph">📅</span>
          <div>
            <strong>{account.google.email}</strong>
            <p className="muted">{account.google.canWrite ? 'Can add and change events, stored encrypted on this server' : 'Read-only so far, stored encrypted on this server'}</p>
          </div>
          <span className="nb-spacer" />
          {!account.google.canWrite && (
            <button className="btn btn-small btn-primary" onClick={connectGoogle} title="Connect again, allowing the Calendar app to add and change events">
              Allow editing
            </button>
          )}
          <button className="btn btn-small" onClick={() => disconnectGoogle().catch((e: Error) => setError(e.message))}>
            Disconnect
          </button>
        </div>
      ) : (
        <>
          <p className="muted">Your Google calendars, shared ones included, to see and (in the Calendar app) add and change events. It attaches to your GitHub sign-in; it is not a way to sign in.</p>
          <button className="btn btn-small" onClick={connectGoogle}>
            Connect Google Calendar
          </button>
        </>
      )}

      <h4 className="set-subhead">CalDAV (Fastmail, Nextcloud, iCloud…)</h4>
      {account.caldav.length > 0 && (
        <ul className="set-list">
          {account.caldav.map((c) => (
            <li key={c.id} className="set-row">
              <span className="set-glyph">🗓</span>
              <span className="set-row-text">
                <strong>{c.label}</strong>
                <span className="muted">
                  {c.username} · {c.url.replace(/^https?:\/\//, '')}
                </span>
              </span>
              <button className="btn btn-small" onClick={() => removeCaldav(c.id).catch((e: Error) => setError(e.message))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <CaldavForm />

      {(error || errors.length > 0) && <p className="t-red">{[error, ...errors].filter(Boolean).join(' · ')}</p>}
      {calendars && calendars.length > 0 && (
        <>
          <h4 className="set-subhead">Your calendars</h4>
          <ul className="set-list set-calendars">
            {calendars.map((c) => (
              <li key={c.id} className="set-row">
                <span className="set-swatch" style={{ background: c.color }} />
                <span className="set-row-text">
                  <strong>{c.name}</strong>
                  <span className="muted">
                    {c.source && c.source !== 'Google' ? c.source : c.primary ? 'Google · your calendar' : 'Google'}
                    {c.writable === false && ' · read-only'}
                  </span>
                </span>
                <Toggle on={isShown(c, picks)} onChange={(on) => setCalendarShown(c.id, on)} label={`Show ${c.name}`} />
              </li>
            ))}
          </ul>
          <p className="muted set-help">Switched-on calendars show in the Calendar app, the clock and every Agenda widget, unless a widget picks its own (right-click it → Calendars). Until you switch them, Google calendars follow Google Calendar and the others are on.</p>
        </>
      )}
    </>
  )
}

/** Adding a CalDAV account: Fastmail by default, any CalDAV server otherwise. */
function CaldavForm() {
  const [provider, setProvider] = useState<'fastmail' | 'other'>('fastmail')
  const [form, setForm] = useState({ url: '', username: '', password: '', label: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await addCaldav({ ...form, url: provider === 'fastmail' ? 'https://caldav.fastmail.com/dav/' : form.url, label: form.label || (provider === 'fastmail' ? 'Fastmail' : '') })
      setForm({ url: '', username: '', password: '', label: '' })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="set-form" onSubmit={submit}>
      <div className="set-choices" role="radiogroup" aria-label="CalDAV provider">
        {(
          [
            ['fastmail', 'Fastmail'],
            ['other', 'Other CalDAV'],
          ] as const
        ).map(([id, label]) => (
          <label key={id} className={`set-choice ${provider === id ? 'is-on' : ''}`}>
            <input type="radio" name="caldav-provider" checked={provider === id} onChange={() => setProvider(id)} />
            {label}
          </label>
        ))}
      </div>
      {provider === 'other' && (
        <label>
          <span>Server URL</span>
          <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://cloud.example.com/remote.php/dav/" required spellCheck={false} autoComplete="off" />
        </label>
      )}
      <label>
        <span>Username</span>
        <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder={provider === 'fastmail' ? 'you@fastmail.com' : 'username'} required spellCheck={false} autoComplete="off" />
      </label>
      <label>
        <span>App password</span>
        <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="app password" required autoComplete="off" />
      </label>
      <p className="muted set-help">
        {provider === 'fastmail' ? (
          <>
            Make one in{' '}
            <a href="https://app.fastmail.com/settings/security/apps/new" target="_blank" rel="noopener noreferrer">
              Fastmail → Settings → Privacy &amp; Security → Connected apps
            </a>
            : access <em>Calendars (CalDAV)</em>. Leave <em>Read-only</em> unticked to add and change events from the Calendar app; adding the same account again replaces its app password.
          </>
        ) : (
          'Use an app password (a read-only one is enough to look, the Calendar app needs read-write to change things).'
        )}{' '}
        It is checked by finding your calendars, then stored encrypted on this server.
      </p>
      {error && <p className="t-red">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? 'Finding your calendars…' : `Add ${provider === 'fastmail' ? 'Fastmail' : 'CalDAV account'}`}
      </button>
    </form>
  )
}

/** Spotlight's favourites: reorder or remove; they are added from Spotlight's right-click menu. */
function SpotlightFavourites() {
  const favourites = useFavourites()
  return (
    <SetGroup title="Favourites">
      {favourites.length > 0 ? (
        <ul className="set-list">
          {favourites.map((f, i) => {
            const key = favouriteKey(f)
            const go = f.kind === 'site' && f.url.startsWith('go:')
            return (
              <li key={key} className="set-row">
                {f.kind === 'site' && !go ? <img className="set-fav" src={faviconOf(f.url)} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <span className="set-glyph">{go ? '↪' : '★'}</span>}
                <span className="set-row-text">
                  <strong>{f.title}</strong>
                  <span className="muted">{f.kind === 'result' ? 'In MvL OS' : go ? 'Go link' : f.url.replace(/^https?:\/\//, '')}</span>
                </span>
                <button className="btn btn-small btn-ghost" disabled={i === 0} onClick={() => moveFavourite(key, -1)} aria-label="Move up">
                  ↑
                </button>
                <button className="btn btn-small btn-ghost" disabled={i === favourites.length - 1} onClick={() => moveFavourite(key, 1)} aria-label="Move down">
                  ↓
                </button>
                <button className="btn btn-small" onClick={() => removeFavourite(key)}>
                  Remove
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="muted">None yet. Right-click anything in Spotlight (an app, a note, a website you visited) and choose Add to favourites.</p>
      )}
    </SetGroup>
  )
}

/** How Spotlight behaves: the empty box, what it searches, the web search, Enter's fallback, history. */
function SpotlightSettings() {
  const { engine, suggestions } = useSearchSettings()
  const prefs = useSpotlightPrefs()
  const visits = useVisits()
  const hits = useRecentHits()
  const account = useAccount()
  const fallbacks: [Fallback, string][] = [
    ['web', `Searches ${ENGINES[engine].label}`],
    ['terminal', 'Runs it in a terminal'],
  ]
  return (
    <>
      <SetGroup title="When Spotlight opens, show">
        {START_SECTIONS.map(([id, label, hint]) => (
          <label key={id} className="set-check">
            <input type="checkbox" checked={prefs.start[id]} onChange={(e) => setStart(id, e.target.checked)} />
            <span>
              {label} <span className="muted">· {hint}</span>
            </span>
          </label>
        ))}
        <p className="muted set-help">With everything off, Spotlight opens as an empty search box.</p>
      </SetGroup>
      <SetGroup title="Recent items of each kind">
        <div className="seg set-seg" role="radiogroup" aria-label="Recent items of each kind">
          {RECENT_COUNTS.map((n) => (
            <button key={n} role="radio" aria-checked={prefs.recentCount === n} className={prefs.recentCount === n ? 'is-active' : ''} onClick={() => setSpotlightPrefs({ recentCount: n })}>
              {n}
            </button>
          ))}
        </div>
        <p className="muted set-help">How many recently visited websites, and repositories and issues, an empty Spotlight lists.</p>
      </SetGroup>
      <SpotlightFavourites />
      <SetGroup title="While you type, include">
        {CATEGORIES.map(([id, label]) => (
          <label key={id} className="set-check">
            <input type="checkbox" checked={prefs.include[id]} onChange={(e) => setInclude(id, e.target.checked)} />
            {label}
          </label>
        ))}
        <p className="muted set-help">Apps, actions, notes, launchers and your repositories are always searched.</p>
      </SetGroup>
      <SetGroup title="When nothing of yours matches, Enter">
        <div className="set-radios" role="radiogroup" aria-label="When nothing matches">
          {fallbacks.map(([id, label]) => (
            <label key={id} className={`set-choice ${prefs.fallback === id ? 'is-on' : ''}`}>
              <input type="radio" name="spotlight-fallback" checked={prefs.fallback === id} onChange={() => setSpotlightPrefs({ fallback: id })} />
              {label}
            </label>
          ))}
        </div>
      </SetGroup>
      <SetGroup title="Preview">
        <label className="set-check">
          <input type="checkbox" checked={prefs.preview} onChange={(e) => setSpotlightPrefs({ preview: e.target.checked })} />
          Show a preview of the highlighted result
        </label>
      </SetGroup>
      <SetGroup title="History">
        <label className="set-check">
          <input type="checkbox" checked={prefs.history} onChange={(e) => setSpotlightPrefs({ history: e.target.checked })} />
          Remember websites I open from MvL OS
        </label>
        <ul className="set-list">
          <li className="set-row">
            <span className="set-row-text">
              <strong>Websites</strong>
              <span className="muted">{visits.length ? `${visits.length} remembered` : 'None remembered'}</span>
            </span>
            <button className="btn btn-small" disabled={!visits.length} onClick={clearVisits}>
              Clear
            </button>
          </li>
          <li className="set-row">
            <span className="set-row-text">
              <strong>Repositories and issues</strong>
              <span className="muted">{hits.length ? `${hits.length} remembered` : 'None remembered'}</span>
            </span>
            <button className="btn btn-small" disabled={!hits.length} onClick={clearHits}>
              Clear
            </button>
          </li>
        </ul>
        <p className="muted set-help">
          Browsers don't let a web page read their own history, so this only knows what you opened from here: Spotlight, launchers, the terminal and links in apps. Right-click a result in Spotlight (or Shift+Delete) to forget just that one.
        </p>
      </SetGroup>
      <h4 className="set-subhead">Web search</h4>
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
        {account.status === 'user' ? 'These settings and the history sync to your other devices.' : 'Saved in this browser.'}
      </p>
    </>
  )
}

/** Where web links open, and whether the browser's new tab page (/?newtab) always uses this tab. */
function LinkSettingsPane() {
  const { target, newTabPageSameTab } = useLinkSettings()
  const account = useAccount()
  return (
    <>
      <div className="set-choices" role="radiogroup" aria-label="Open links in">
        {(
          [
            ['new', 'A new tab'],
            ['same', 'This tab'],
          ] as const
        ).map(([id, label]) => (
          <label key={id} className={`set-choice ${target === id ? 'is-on' : ''}`}>
            <input type="radio" name="link-target" checked={target === id} onChange={() => setLinkSettings({ target: id })} />
            {label}
          </label>
        ))}
      </div>
      <label className="set-check">
        <input type="checkbox" checked={newTabPageSameTab} onChange={(e) => setLinkSettings({ newTabPageSameTab: e.target.checked })} />
        As the browser's new tab page, always open links in this tab
      </label>
      <p className="muted set-help">
        Covers Spotlight, the terminal's <code>open</code> and <code>go</code>, launchers and links in apps. Ctrl-click still opens a new tab. The new tab page is this site loaded as <code>/?newtab</code>.{' '}
        {account.status === 'user' ? 'Your choice syncs to your other devices.' : 'Saved in this browser.'}
      </p>
    </>
  )
}

type PaneId = 'account' | 'appearance' | 'dock' | 'launchers' | 'search' | 'links' | 'notifications' | 'instances' | 'calendar' | 'integrations' | 'golinks' | 'sync' | 'about'
/** `owner`: only for the signed-in owner (accounts and services); visitors don't see it at all. */
type Pane = { id: PaneId; label: string; hue: string; icon: ReactNode; keywords: string; blurb: string; owner?: true; render: () => ReactNode }

const svg = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
)

function SyncPane() {
  const account = useAccount()
  return (
    <>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>Status</strong>
            <SyncLine />
          </span>
          {account.status === 'user' && (
            <button className="btn btn-small" onClick={() => void pullAll()}>
              Sync now
            </button>
          )}
        </li>
      </ul>
      <p className="muted set-help">Notes, launchers, desktop icons, the dock, the search engine, where links open, game high scores, the go links account, Spotlight's settings, favourites and history, and window layouts (one for phones, one for bigger screens) follow you between devices once signed in. Without an account they stay in this browser.</p>
    </>
  )
}

// Grouped like macOS System Settings: the look of the desktop, then how things are found and
// announced, then the outside services, then housekeeping.
const GROUPS: Pane[][] = [
  [
    { id: 'appearance', label: 'Appearance', hue: 'var(--blue)', icon: svg(<><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></>), keywords: 'theme dark light mode accent color omarchy motion wiggle swing animation', blurb: 'Light and dark mode, themes, the accent color and motion.', render: () => <Appearance /> },
    { id: 'dock', label: 'Dock', hue: 'var(--cyan)', icon: svg(<><rect x="3" y="4" width="18" height="16" /><path d="M7 16h10" /></>), keywords: 'dock hide pin apps order', blurb: 'When the dock shows, and what is in it.', render: () => <DockSettings /> },
    { id: 'launchers', label: 'Launchers', hue: 'var(--magenta)', icon: svg(<><rect x="4" y="4" width="6" height="6" /><rect x="14" y="4" width="6" height="6" /><rect x="4" y="14" width="6" height="6" /><rect x="14" y="14" width="6" height="6" /></>), keywords: 'launchers links bookmarks desktop shortcuts', blurb: 'Links on the desktop, in All apps and in Spotlight.', render: () => <Launchers /> },
  ],
  [
    { id: 'search', label: 'Spotlight', hue: 'var(--green)', icon: svg(<><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>), keywords: 'spotlight search engine suggestions duckduckgo kagi google history recent visited websites preview start empty fallback terminal favourites favorites starred', blurb: 'What Spotlight shows when it opens, what it searches, and what it remembers.', render: () => <SpotlightSettings /> },
    { id: 'links', label: 'Links', hue: 'var(--blue)', icon: svg(<><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v6H4V6h6" /></>), keywords: 'links open new tab same tab browser newtab home page', blurb: 'Whether links open in a new tab or this one.', render: () => <LinkSettingsPane /> },
    { id: 'notifications', label: 'Notifications', hue: 'var(--red)', icon: svg(<><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 21h4" /></>), keywords: 'notifications alerts minecraft activity', blurb: 'What may pop up in the corner of the desktop.', render: () => <Notifications /> },
    { id: 'golinks', label: 'Go links', hue: 'var(--yellow)', icon: svg(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>), keywords: 'go links golinks terminal spotlight suggestions mvl.sh token', blurb: "The golinks account that go <alias> follows, in Spotlight and the terminal.", render: () => <GoLinks /> },
  ],
  [
    { id: 'instances', label: 'Code hosts', hue: 'var(--orange)', owner: true, icon: <BranchGlyph />, keywords: 'code hosts gitea forgejo github token instances repositories', blurb: 'GitHub, and the Gitea or Forgejo instances you linked.', render: () => <Instances /> },
    { id: 'calendar', label: 'Calendar', hue: 'var(--red)', owner: true, icon: svg(<><rect x="4" y="5" width="16" height="15" /><path d="M4 10h16M9 3v4M15 3v4" /></>), keywords: 'calendar google agenda events caldav fastmail nextcloud icloud', blurb: 'Google Calendar and CalDAV (Fastmail…), for the Calendar app, the Agenda widget and the clock.', render: () => <CalendarSettings /> },
    { id: 'integrations', label: 'Integrations', hue: 'var(--green)', owner: true, icon: svg(<><circle cx="7" cy="12" r="3" /><circle cx="17" cy="12" r="3" /><path d="M10 12h4" /></>), keywords: 'integrations updown uptime status monitoring api key widgets seafile files cloud onlyoffice office documents', blurb: 'Services the widgets and Files read from: updown.io for Status, Seafile and OnlyOffice.', render: () => <Integrations /> },
  ],
  [
    { id: 'sync', label: 'Sync', hue: 'var(--green)', owner: true, icon: svg(<><path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></>), keywords: 'sync devices cloud', blurb: 'What follows you between devices.', render: () => <SyncPane /> },
    { id: 'about', label: 'About', hue: 'var(--text)', icon: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>), keywords: 'about version update release build', blurb: 'Which version this is, and whether a newer one is out.', render: () => <About /> },
  ],
]
const ACCOUNT_PANE: Pane = { id: 'account', label: 'Account', hue: 'var(--accent)', icon: null, keywords: 'account github sign in sign out profile', blurb: '', render: () => <Account /> }
const PANES: Pane[] = [ACCOUNT_PANE, ...GROUPS.flat()]
const isPane = (id: string | undefined): id is PaneId => !!id && PANES.some((p) => p.id === id)

// The pane last looked at, for the next time Settings opens without asking for one.
let lastPane: PaneId = 'account'

export function Settings({ win }: { win: WinState }) {
  const account = useAccount()
  const [pane, setPane] = useState<PaneId>(() => (isPane(win.props.section) ? win.props.section : lastPane))
  // Narrow windows show the sidebar or a pane, not both; this says which.
  const [showPane, setShowPane] = useState(isPane(win.props.section))
  const [query, setQuery] = useState('')
  const content = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isPane(win.props.section)) return
    setPane(win.props.section)
    setShowPane(true)
  }, [win.props.section, win.props.t])
  useEffect(() => {
    lastPane = pane
    content.current?.scrollTo({ top: 0 })
  }, [pane])

  const go = (id: PaneId) => {
    setPane(id)
    setShowPane(true)
  }
  const q = query.trim().toLowerCase()
  // Visitors only see what works without an account; the owner's panes would just say "sign in".
  const owner = useLikelyOwner()
  const groups = useMemo(() => {
    const mine = GROUPS.map((g) => g.filter((p) => owner || !p.owner)).filter((g) => g.length)
    return q ? [mine.flat().filter((p) => `${p.label} ${p.keywords}`.toLowerCase().includes(q))] : mine
  }, [q, owner])
  const asked = PANES.find((p) => p.id === pane)!
  const current = asked.owner && !owner ? ACCOUNT_PANE : asked
  const u = account.user

  return (
    <div className={`settings ${showPane ? 'is-pane' : ''}`}>
      <nav className="set-side" aria-label="Settings">
        <input
          className="set-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && groups[0]?.[0] && go(groups[0][0].id)}
          placeholder="Search"
          aria-label="Search settings"
        />
        <button className={`set-profile ${current.id === 'account' ? 'is-on' : ''}`} onClick={() => go('account')}>
          {u?.avatar ? <img src={u.avatar} alt="" /> : <span className="set-profile-blank">{u ? u.login[0].toUpperCase() : '?'}</span>}
          <span className="set-profile-text">
            <strong>{u ? (u.name ?? u.login) : 'Guest'}</strong>
            <span className="muted">{u ? `@${u.login} · GitHub` : 'This browser only'}</span>
          </span>
        </button>
        {groups.map((g, i) => (
          <ul key={i} className="set-nav">
            {g.map((p) => (
              <li key={p.id}>
                <button className={current.id === p.id ? 'is-on' : ''} onClick={() => go(p.id)} aria-current={current.id === p.id ? 'page' : undefined}>
                  <span className="set-tile" style={{ ['--hue' as string]: p.hue }}>
                    {p.icon}
                  </span>
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
        ))}
        {q && !groups[0].length && <p className="muted set-noresult">Nothing matches “{query.trim()}”.</p>}
      </nav>
      <div className="set-main" ref={content}>
        <header className="set-head">
          <button className="set-back" onClick={() => setShowPane(false)} aria-label="All settings">
            ‹ Settings
          </button>
          <h2>{current.label}</h2>
          {current.blurb && <p className="muted">{current.blurb}</p>}
        </header>
        <div className="set-body">{current.render()}</div>
      </div>
    </div>
  )
}
