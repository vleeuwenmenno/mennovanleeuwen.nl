import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { isShown, setCalendarHidden, setCalendarShown, useAllCalendars, useCalendarChoice, useCalendarList, useHiddenCalendars } from '../data/calendar'
import { useTasks } from '../data/tasks'
import { BIRTHDAY_COLOR, BIRTHDAYS } from './calendar/birthdays'
import { ENGINES, setSearchSettings, useSearchSettings, type EngineId } from '../data/searchEngine'
import { setLinkSettings, useLinkSettings } from '../data/links'
import { FURIGANA_MODES, FURIGANA_SIZES, setFurigana, setFuriganaSize, useFurigana, useFuriganaSize } from '../data/furigana'
import { HOME_CURRENCIES, setHomeCurrency, useHomeCurrency } from '../data/currency'
import { clearVisits, useVisits } from '../data/siteHistory'
import { clearHits, useRecentHits } from '../data/spotlightRecent'
import { favouriteKey, moveFavourite, removeFavourite, useFavourites } from '../data/spotlightFavourites'
import { ANSWERS_KEEP, CATEGORIES, CTRL_SPACE, RECENT_COUNTS, setInclude, setSpotlightPrefs, setStart, START_SECTIONS, useSpotlightPrefs, type Fallback } from '../data/spotlightPrefs'
import { clearQuick } from '../data/agents'
import { addLauncher, cleanUrl, faviconOf, launcherImage, launchersAreFiles, moveLauncher, posixPath, removeLauncher, updateLauncher, useLaunchers, type Launcher } from '../data/launchers'
import { golinksSite, golinksTemplate, maskGolinks, parseGolinks, setGolinks } from '../data/golinks'
import { setSwing, useSwingPrefs } from '../os/swing'
import { ask } from '../os/Dialogs'
import { UsersSettings } from './UsersSettings'
import { openAlert, useAlerts } from '../os/alerts'
import { formatSize, prettyPath } from '../terminal/vfs'
import { browserFilesState, browserTree, useBrowserFiles, wipeBrowserFiles } from '../data/browserfs'
import { wipeVideoThumbs } from '../data/videoThumbs'
import { Select } from '../os/Select'
import { useStatus as usePhotoStatus } from '../data/photos'
import { ImmichLink } from './photos/PhotosSettings'
import { libraryName, loadLibraries, primaryOf, setSeafilePrefs, useLibraries, useSeafilePrefs } from '../data/seafile'
import { fstabEntries, isSeafileType, useMounts } from '../data/mounts'

const libraryNameOf = (prefix: string) => libraryName(prefix.slice('seafile://'.length))
import { addCaldav, connectGoogle, disconnectGoogle, linkSeafile, removeCaldav, removeOffice, removeOllamaKey, removeUpdownKey, setOffice, setOllamaKey, setUpdownKey, deleteAccount, hasOrgScope, hasRepoScope, orgAccess, signIn, signInWithRepos, signOut, unlinkForge, unlinkSeafile, useAccount, useLikelySignedIn } from '../os/account'
import { clearCodeSearch } from '../os/codeSearch'
import type { OrgAccess, OrgsResponse } from '../data/code'
import { APP_META } from '../os/apps'
import { isDefaultDock, isLauncherId, launcherDockId, pinToDock, resetDock, setDockOrder, unpinFromDock, unpinnedApps, useCanCustomizeDock, useDock, type DockId } from '../os/dockItems'
import { DOCK_MODES, getDockMode, setDockMode, type DockMode } from '../os/dockPrefs'
import { DRAG_KEYS, dragKeyPref } from '../os/modDrag'
import { AppIcon } from '../os/icons'
import { setStartupPrefs, START_WINDOWS, useStartupPrefs } from '../os/startup'
import { tabWorkspacePrefs, tabWorkspacesSupported, useTabWorkspaces } from '../os/tabWorkspaces'
import { clearEntries, pruneEntries, useEntries } from '../os/notify'
import { ACTIVITY_WINDOWS, CALENDAR_LEADS, isOff, KEEP, setNotifyPrefs, setOn, useNotifyPrefs, visibleSources, type NotifySource as NotifySourceDef } from '../os/notifyPrefs'
import { disablePush, enablePush, pushState, sendTestPush, type PushState } from '../os/push'
import { THEMES } from '../os/omarchyThemes'
import { pullAll } from '../os/synced'
import { ACCENTS, DARK_THEMES, LIGHT_THEMES, setAccent, setMode, setTheme, themeLabel, useTheme, type Mode } from '../os/theme'
import { ReleaseStatus } from '../os/TopbarWidgets'
import { useWM, type AppId, type WinState } from '../os/wm'
import { AgentsSettings } from './AgentsSettings'
import { ContactsAccounts, ContactsSettings } from './contacts/ContactsSettings'
import { MailPane } from './mail/MailPane'
import { useContacts } from '../data/contacts'
import { IntegrationNotice } from '../os/IntegrationNotice'
import { AmpPane, CalendarAppPrefs, FilesPane, GamesPane, NotebookPane, PdfPane, PreviewPane, TerminalPane } from './AppSettings'
import { WeatherPane } from './Weather'
import { BUILT, COMMIT, REPO, VERSION } from '../version'
import { BranchGlyph } from './LinkForge'
import { SyncLine } from './Notebook'
import { MailSettings } from './mail/MailSettings'
import { useMailAccounts } from '../data/mail'
import { SecretInput } from '../os/SecretInput'
import { performanceOverlayPref } from '../os/PerformanceOverlay'
import { emojiTypingPref } from '../os/emojiTyping'

// System settings, laid out like macOS: the account on top of a sidebar, one pane per topic.
// Opened from the system menu, the desktop's right-click menu, Spotlight, the terminal and apps'
// window menus; props.section picks the pane (account, appearance, dock, launchers, search
// (Spotlight), windows, links, language, notifications, golinks, instances, integrations, then the apps:
// agents, calendar, contacts, files, games, mail, amp, pdf, preview, terminal; then sync, users, about) and
// props.sub a part of it (Integrations: updown, ollama, seafile, onlyoffice, mail, immich, calendars,
// contacts). Every account is linked in Integrations; an app's pane keeps the app's own settings and
// points there (IntegrationNotice). The account and service panes only show for the signed-in user.

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
  const [error, setError] = useState<string | null>(null)
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
        {account.registration && !account.registration.open ? (
          <p className="muted">Sign-up is closed right now. Existing accounts can still sign in.</p>
        ) : account.registration?.full ? (
          <p className="muted">We're full: every account is taken. Existing accounts can still sign in.</p>
        ) : (
          <p className="muted">Sign in with GitHub for your own desktop: notes, layouts and integrations that follow you between devices.</p>
        )}
        <button className="btn btn-primary" onClick={signIn}>
          Sign in with GitHub
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
        <BrowserFilesRow />
        <li className="set-row">
          <span className="set-row-text">
            <strong>Delete account</strong>
            <span className="muted">Removes everything this server keeps for you, and disconnects GitHub, Google and Seafile.</span>
          </span>
          <button className="btn btn-small btn-danger" onClick={() => void removeAccount(setError)}>
            Delete…
          </button>
        </li>
      </ul>
      {error && <p className="t-red copyable">{error}</p>}
      <p className="muted set-help">
        What is stored and who can see it: <a href="/privacy.html" target="_blank" rel="noopener">privacy</a>.
      </p>
    </>
  )
}

/** Settings → Account: what is kept in this browser for you (src/data/browserfs.ts), and deleting it. */
function BrowserFilesRow() {
  useBrowserFiles()
  const { files, bytes } = browserTree()
  if (browserFilesState() !== 'ready') return null
  const remove = async () => {
    const ok = await ask({ title: 'Delete the files in this browser?', body: `${files} ${files === 1 ? 'file' : 'files'} (${formatSize(bytes)}) kept in this browser are deleted for good. Files in Seafile are not touched.`, confirm: 'Delete', danger: true })
    if (ok) await wipeBrowserFiles()
  }
  return (
    <li className="set-row">
      <span className="set-row-text">
        <strong>Files in this browser</strong>
        <span className="muted">{files ? `${files} ${files === 1 ? 'file' : 'files'}, ${formatSize(bytes)}. Only here: clearing the site's data deletes them.` : 'None yet. Without Seafile as home, files you make are kept here.'}</span>
      </span>
      {files > 0 && (
        <button className="btn btn-small" onClick={() => void remove()}>
          Delete…
        </button>
      )}
    </li>
  )
}

/** Settings → Account → Delete: asks first, since nothing comes back. */
async function removeAccount(setError: (e: string | null) => void) {
  const ok = await ask({
    title: 'Delete your account?',
    body: 'Your notes, layouts, Agents threads and memories, linked services and calendars are deleted from this server for good, and this app is removed from your GitHub account. Files in your own Seafile stay where they are.',
    confirm: 'Delete my account',
    danger: true,
  })
  if (!ok) return
  setError(null)
  // This browser's copy of its files goes too (the server never had them).
  await wipeBrowserFiles().catch(() => {})
  await wipeVideoThumbs().catch(() => {})
  await deleteAccount().catch((e: Error) => setError(e.message))
}

/** Light/dark mode, the Omarchy theme for each, and the accent. Kept in this browser. */
function Appearance() {
  const t = useTheme()
  const swing = useSwingPrefs()
  const performanceOverlay = performanceOverlayPref.use()
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
      <SetGroup title="Performance">
        <label className="set-check">
          <input type="checkbox" checked={performanceOverlay} onChange={(e) => performanceOverlayPref.set(e.target.checked)} />
          Show FPS and frame time
        </label>
        <p className="muted set-help">Shows page animation timing across the desktop, apps and games, including fullscreen. Follows the browser's refresh rate; game simulation and content updates may run at a different rate. Saved in this browser.</p>
      </SetGroup>
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

/**
 * Push on this device (src/os/push.ts): Agents answers and questions as system notifications, also
 * with MvL OS closed. iPhone and iPad only have it in the app added to the Home Screen.
 */
function PushRow() {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => void pushState().then(setState), [])
  const run = (job: () => Promise<PushState>) => {
    setBusy(true)
    setNote(null)
    job()
      .then(setState, (e: Error) => setNote(e.message))
      .finally(() => setBusy(false))
  }
  const test = () => {
    setBusy(true)
    sendTestPush()
      .then((r) => setNote(r.sent ? `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'}: it should show in a moment.` : 'No device took it: turn push off and on again here.'), (e: Error) => setNote(e.message))
      .finally(() => setBusy(false))
  }
  const text: Record<PushState, string> = {
    on: 'On: Agents answers and questions reach this device, also with MvL OS closed',
    off: 'Agents answers and questions as notifications on this device, also with MvL OS closed',
    denied: "Blocked: allow notifications for this site in the browser's (or the phone's) settings",
    install: 'On iPhone and iPad: Share → Add to Home Screen, open MvL OS from there, and turn this on in it',
    unsupported: 'Not in this browser',
  }
  return (
    <li className="set-row">
      <span className="set-row-text">
        <strong>Push notifications on this device</strong>
        {/* Wraps: the iPhone steps, or what to do about a browser without push, take a sentence or two. */}
        <span className="muted set-row-wrap">{note ?? (state ? text[state] : 'Checking…')}</span>
      </span>
      {state === 'on' && (
        <>
          <button className="btn btn-small" disabled={busy} onClick={test}>
            Send a test
          </button>
          <button className="btn btn-small" disabled={busy} onClick={() => run(disablePush)}>
            Turn off
          </button>
        </>
      )}
      {state === 'off' && (
        <button className="btn btn-small" disabled={busy} onClick={() => run(enablePush)}>
          Turn on
        </button>
      )}
    </li>
  )
}

function Notifications() {
  const prefs = useNotifyPrefs()
  const account = useAccount()
  const entries = useEntries()
  const signedIn = account.status === 'user'
  return (
    <>
      <SetGroup title="Pop-ups">
        <ul className="set-list">
          <li className="set-row">
            <span className="set-row-text">
              <strong>Show pop-ups</strong>
              <span className="muted">Off is do not disturb: they still collect behind the bell</span>
            </span>
            <Toggle on={prefs.popups} onChange={(on) => setNotifyPrefs({ popups: on })} label="Show pop-ups" />
          </li>
          {signedIn && <PushRow />}
        </ul>
      </SetGroup>

      <SetGroup title="Notification center">
        <div className="seg set-seg" role="radiogroup" aria-label="Keep notifications for">
          {KEEP.map(([id, label]) => (
            <button key={id} role="radio" aria-checked={prefs.keep === id} className={prefs.keep === id ? 'is-active' : ''} onClick={() => (setNotifyPrefs({ keep: id }), pruneEntries())}>
              {label}
            </button>
          ))}
        </div>
        <p className="muted set-help">{signedIn ? 'How long the bell in the top bar keeps a notification. Signed in, the list is the same on every device. ' : 'How long the bell in the top bar keeps a notification, on this device. '}Pop-ups that are only feedback (a failed paste, an update to restart into) are never kept.</p>
        <ul className="set-list">
          <li className="set-row">
            <span className="set-row-text">
              <strong>Remove once opened</strong>
              <span className="muted">Opening one also takes it off the list</span>
            </span>
            <Toggle on={prefs.removeOnOpen} onChange={(on) => setNotifyPrefs({ removeOnOpen: on })} label="Remove notifications once opened" />
          </li>
          <li className="set-row">
            <span className="set-row-text">
              <strong>{entries.length ? `${entries.length} kept now` : 'Nothing kept now'}</strong>
              <span className="muted">{entries.filter((e) => !e.read).length} not read yet</span>
            </span>
            <button className="btn btn-small" disabled={!entries.length} onClick={clearEntries}>
              Clear all
            </button>
          </li>
        </ul>
      </SetGroup>

      <SetGroup title="Apps">
        <ul className="set-list">
          {visibleSources(signedIn).map((src) => (
            <NotifySourceRows key={src.app} src={src} />
          ))}
        </ul>
        <p className="muted set-help">{signedIn ? 'Signed in, the server watches all of these for you and keeps the list the same on every device: with push on, they reach this device even when MvL OS is closed. Do not disturb holds back pop-ups and push alike.' : 'These arrive while this page is open. Sign in to have the server watch for you, with push to your devices.'} Right-click one in the list to turn its kind off.</p>
      </SetGroup>
    </>
  )
}

/**
 * One app in Settings → Notifications: a switch for all of it, and for an app with several kinds
 * of notification, a fold-out list to pick single kinds (and, for Activity, how recent).
 */
function NotifySourceRows({ src }: { src: NotifySourceDef }) {
  const prefs = useNotifyPrefs()
  const [open, setOpenRows] = useState(false)
  const appOn = !isOff(prefs, src.app)
  const kindOn = (id: string) => appOn && !isOff(prefs, `${src.app}.${id}`)
  const single = src.kinds.length === 1
  // Activity and Calendar have a setting of their own under Choose…, besides their kinds.
  const extra = src.app === 'activity' || src.app === 'calendar'
  const on = src.kinds.filter((k) => kindOn(k.id)).length
  const summary = single ? src.kinds[0].hint : !appOn ? 'Off' : on === src.kinds.length ? `All ${src.kinds.length} kinds` : on ? `${on} of ${src.kinds.length} kinds: ${src.kinds.filter((k) => kindOn(k.id)).map((k) => k.label.toLowerCase()).join(', ')}` : 'No kinds chosen'
  return (
    <>
      <li className="set-row">
        {src.icon ? <AppIcon app={src.icon as AppId} size={22} tone /> : <span className="set-glyph">M</span>}
        <span className="set-row-text">
          <strong>{src.label}</strong>
          <span className="muted">{summary}</span>
        </span>
        {(!single || extra) && (
          <button className="btn btn-small set-fold" onClick={() => setOpenRows((o) => !o)} aria-expanded={open} disabled={!appOn}>
            {open && appOn ? 'Done' : 'Choose…'}
          </button>
        )}
        <Toggle on={appOn} onChange={(v) => setOn(src.app, v)} label={`${src.label} notifications`} />
      </li>
      {open && appOn && (
        <>
          {!single && src.kinds.map((k) => (
            <li key={k.id} className="set-row set-row-sub">
              <span className="set-row-text">
                <strong>{k.label}</strong>
                <span className="muted">{k.hint}</span>
              </span>
              <Toggle on={kindOn(k.id)} onChange={(v) => setOn(`${src.app}.${k.id}`, v)} label={`${src.label}: ${k.label}`} />
            </li>
          ))}
          {src.app === 'calendar' && (
            <li className="set-row set-row-sub set-row-stack">
              <span className="set-row-text">
                <strong>Remind me</strong>
                <span className="muted">Events with a start time; the server reminds you, also with MvL OS closed</span>
              </span>
              <div className="seg set-seg" role="radiogroup" aria-label="Remind me">
                {CALENDAR_LEADS.map((m) => (
                  <button key={m} role="radio" aria-checked={prefs.calendarLead === m} className={prefs.calendarLead === m ? 'is-active' : ''} onClick={() => setNotifyPrefs({ calendarLead: m })}>
                    {m ? `${m} min before` : 'When it starts'}
                  </button>
                ))}
              </div>
            </li>
          )}
          {src.app === 'activity' && (
            <li className="set-row set-row-sub set-row-stack">
              <span className="set-row-text">
                <strong>How recent</strong>
                <span className="muted">Older activity stays quiet when MvL OS opens</span>
              </span>
              <div className="seg set-seg" role="radiogroup" aria-label="Notify about activity from the last">
                {ACTIVITY_WINDOWS.map(([id, label]) => (
                  <button key={id} role="radio" aria-checked={prefs.activityWindow === id} className={prefs.activityWindow === id ? 'is-active' : ''} onClick={() => setNotifyPrefs({ activityWindow: id })}>
                    {label}
                  </button>
                ))}
              </div>
            </li>
          )}
        </>
      )}
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
      {error && <p className="t-red copyable">That is not a golinks search URL (…/r/%s?token=…), or a token.</p>}
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
            <span className="muted">
              @{account.user!.login} · {hasRepoScope(account.user) ? 'public and private repositories' : 'public repositories only'}
            </span>
          </span>
          {/* Sign-in only asks GitHub for the profile; private repositories take the broad `repo` scope. */}
          <button className="btn btn-small" onClick={() => signInWithRepos(!hasRepoScope(account.user))}>
            {hasRepoScope(account.user) ? 'Public only' : 'Allow private'}
          </button>
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
      {error && <p className="t-red copyable">{error}</p>}
      <button className="btn btn-primary" onClick={() => wm.open('linkforge', { t: String(Date.now()) })}>
        Link an instance…
      </button>
      <p className="muted set-help">Gitea and Forgejo instances are linked with a personal access token. Spotlight then searches their repositories, issues, pull requests and branches too.</p>
      <p className="muted set-help">Private GitHub repositories need GitHub's <code>repo</code> scope, which also allows writing to them (GitHub has no read-only version). Turning it off again may need the app removed under GitHub → Settings → Applications.</p>
      <GithubOrgs />
    </>
  )
}

const ORG_STATUS: Record<Exclude<OrgAccess['access'], 'ok'>, { short: string; long: string }> = {
  restricted: { short: 'Blocked by its OAuth app policy', long: "The organisation restricts OAuth apps and hasn't approved this site, so only its public repositories show." },
  sso: { short: 'Needs single sign-on', long: 'The organisation uses SAML single sign-on: sign in again and authorise it for this site.' },
  unknown: { short: 'Public membership, access unknown', long: 'Without the read:org scope this site only sees public memberships and cannot tell whether it may read the private repositories.' },
}

function orgLine(o: OrgAccess) {
  if (o.access !== 'ok') return ORG_STATUS[o.access].short
  if (!o.repos) return 'No repositories you can see'
  return `${o.repos} ${o.repos === 1 ? 'repository' : 'repositories'}${o.privateRepos ? `, ${o.privateRepos} private` : ''}`
}

/**
 * The GitHub organisations the account is in and whether this site's OAuth app may read their
 * repositories (server/search.ts). Organisations can keep OAuth apps out (GitHub's default for new
 * ones) until an owner approves the app, which no code here can get around: this says so and links
 * GitHub's page for granting or requesting access, and checks again on coming back from it.
 */
function GithubOrgs() {
  const account = useAccount()
  const user = account.user
  const [data, setData] = useState<OrgsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Sent to GitHub: check again when this tab is back in front. */
  const away = useRef(false)
  const load = useRef((fresh: boolean) => {
    setBusy(true)
    orgAccess(fresh)
      .then(
        (d) => {
          setData(d)
          setError(d.error)
          // Spotlight's remembered results may predate an organisation letting the site in.
          if (fresh) clearCodeSearch()
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setBusy(false))
  }).current
  useEffect(() => {
    load(true)
    const back = () => {
      if (document.visibilityState !== 'visible' || !away.current) return
      away.current = false
      load(true)
    }
    document.addEventListener('visibilitychange', back)
    window.addEventListener('focus', back)
    return () => {
      document.removeEventListener('visibilitychange', back)
      window.removeEventListener('focus', back)
    }
  }, [load])
  if (!user) return null
  const repo = hasRepoScope(user)
  const grant = data?.clientId ? `https://github.com/settings/connections/applications/${encodeURIComponent(data.clientId)}` : null
  const toGitHub = () => (away.current = true)
  const blocked = (data?.orgs ?? []).filter((o) => o.access !== 'ok')
  return (
    <>
      <h4 className="set-subhead">GitHub organisations</h4>
      {!repo ? (
        <p className="muted set-help">Spotlight searches the public repositories of your organisations. Their private ones need “Allow private” above.</p>
      ) : (
        !hasOrgScope(user) && (
          <ul className="set-list">
            <li className="set-row">
              <span className="set-glyph">!</span>
              <span className="set-row-text">
                <strong>New sign-in needed</strong>
                <span className="muted" title="Your GitHub sign-in is from before this site asked for read:org">Your sign-in predates the read:org scope, so only public memberships show.</span>
              </span>
              <button className="btn btn-small" onClick={() => signInWithRepos(true)}>
                Sign in again
              </button>
            </li>
          </ul>
        )
      )}
      {data && data.orgs.length > 0 && (
        <ul className="set-list">
          {data.orgs.map((o) => (
            <li key={o.login} className="set-row">
              {o.avatar ? <img className="set-fav" src={o.avatar} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <span className="set-glyph">◫</span>}
              <span className="set-row-text">
                <a href={o.url} target="_blank" rel="noopener noreferrer">
                  <strong>{o.login}</strong>
                </a>
                <span className={o.access === 'ok' ? 'muted' : 't-yellow'} title={o.access === 'ok' ? undefined : ORG_STATUS[o.access].long}>
                  {orgLine(o)}
                </span>
              </span>
              {o.access === 'restricted' && grant && (
                <a className="btn btn-small" href={grant} target="_blank" rel="noopener noreferrer" onClick={toGitHub}>
                  Grant access
                </a>
              )}
              {o.access === 'sso' && (
                <button className="btn btn-small" onClick={() => signInWithRepos(repo)}>
                  Sign in again
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {data && !data.orgs.length && !error && <p className="muted set-help">No organisations found for @{user.login}.</p>}
      {!data && !error && <p className="muted set-help">Checking your organisations…</p>}
      {error && <p className="t-red copyable">{error}</p>}
      {blocked.length > 0 && <p className="muted set-help">{blocked.map((o) => `${o.login}: ${ORG_STATUS[o.access as Exclude<OrgAccess['access'], 'ok'>].long}`).join(' ')}</p>}
      <div className="set-actions">
        <button className="btn btn-small" disabled={busy} onClick={() => load(true)}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
        {grant && (
          <a className="btn btn-small" href={grant} target="_blank" rel="noopener noreferrer" onClick={toGitHub}>
            Organisation access on GitHub
          </a>
        )}
      </div>
      <p className="muted set-help">
        Spotlight lists the repositories of every organisation you are in; typing an organisation's name finds its repositories. Organisations can restrict OAuth apps (GitHub's default for new ones): until an owner approves this site, their private repositories stay out. On GitHub's page for this site, owners click <em>Grant</em> and members <em>Request</em> next to the organisation. If your membership is private and the organisation keeps the site out, GitHub hides the organisation from this list too, but that page still shows it. Coming back to this tab checks again.
      </p>
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
        {!l.app && <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} aria-label="URL" className={error ? 'is-bad' : ''} spellCheck={false} />}
        <button
          className="btn btn-small btn-primary"
          onClick={() => {
            // A launcher that opens an app has no address to change.
            const url = l.app ? '' : cleanUrl(draft.url)
            if ((!url && !l.app) || !draft.label.trim()) return setError(true)
            updateLauncher(l.id, { label: draft.label.trim().slice(0, 40), url: url ?? '', glyph: draft.glyph?.trim() || undefined })
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
      {l.glyph || !launcherImage(l) ? <span className="set-glyph">{l.glyph ?? '▦'}</span> : <img className="set-fav" src={launcherImage(l)} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />}
      <span className="set-row-text">
        <strong>{l.label}</strong>
        {l.app ? (
          <span className="muted">Opens {l.app}</span>
        ) : (
          <a className="muted" href={l.url} target="_blank" rel="noopener noreferrer">
            {l.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
          </a>
        )}
        {l.file && <span className="muted set-file">{prettyPath(posixPath(l.file) ?? l.file)}</span>}
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
        <p className="muted set-help">Drag dock icons to reorder them. Open apps also show in the dock until they are closed. Sign in to add apps and launchers to the dock or take them off.</p>
      </>
    )
  const launcherOf = (id: DockId) => launchers.find((l) => launcherDockId(l.id) === id)
  const label = (id: DockId) => (isLauncherId(id) ? (launcherOf(id)?.label ?? 'Link') : APP_META[id].dock)
  const icon = (id: DockId) => {
    if (!isLauncherId(id)) return <AppIcon app={id} size={22} tone />
    const l = launcherOf(id)
    return l?.glyph ? <span className="set-glyph">{l.glyph}</span> : <img className="set-fav" src={l ? launcherImage(l) : undefined} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
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
      <p className="muted set-help">Right-click anything in Spotlight or All apps to pin it, including repositories. Open apps also show in the dock until they are closed; right-click one and choose Keep in dock, or drag it in among the pinned ones.</p>
      <button className="btn btn-small" disabled={isDefaultDock()} onClick={resetDock}>
        Restore default dock
      </button>
    </>
  )
}

function Launchers() {
  const launchers = useLaunchers()
  const files = launchersAreFiles()
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
      {error && <p className="t-red copyable">{error}</p>}
      <p className="muted set-help">Launchers sit on the desktop and show up in All apps and Spotlight. Without an emoji they use the site's own icon.</p>
      {files ? (
        <p className="muted set-help">
          Each one is a <code>.desktop</code> file in your home: those on the desktop in <code>~/Desktop</code>, the others in <code>~/.local/share/applications</code>. Drag them into folders like any file; the terminal shows the files themselves (<code>ls ~/Desktop</code>, <code>cat</code>, <code>open</code>).
        </p>
      ) : (
        <p className="muted set-help">They are kept in this browser. Signed in, they become <code>.desktop</code> files in your home.</p>
      )}
    </>
  )
}

/** Every account the desktop links to, and the keys it keeps for services: updown.io for Status, Ollama, Seafile, OnlyOffice, mail, Immich, calendars and address books. */
type IntegrationId = 'updown' | 'ollama' | 'seafile' | 'onlyoffice' | 'mail' | 'immich' | 'calendars' | 'contacts'

/** Third-party services, one row each; a row opens that service's own settings. */
/** `sub` opens one service's settings straight away (Settings → Integrations → Seafile, from an alert). */
function Integrations({ sub, t }: { sub?: string; t?: string }) {
  const account = useAccount()
  const [open, setOpen] = useState<IntegrationId | null>(null)
  useEffect(() => {
    if (sub === 'updown' || sub === 'ollama' || sub === 'seafile' || sub === 'onlyoffice' || sub === 'contacts' || sub === 'mail' || sub === 'immich' || sub === 'calendars') setOpen(sub)
  }, [sub, t])
  const { libraries } = useLibraries()
  const { accounts: mailAccounts } = useMailAccounts()
  const photos = usePhotoStatus().status
  const { books } = useContacts()
  if (account.status !== 'user') return <p className="muted">Sign in first to connect services for widgets and Files.</p>
  const seafile = account.seafile
  const host = (url: string) => url.replace(/^https?:\/\//, '')
  const calendarLinks = [account.google?.email, ...account.caldav.map((c) => c.label)].filter((v): v is string => !!v)
  // The address books of linked CardDAV accounts, by where they live (the one on this site is always there).
  const carddav = [...new Set(books.filter((b) => b.account !== undefined).map((b) => b.source))]

  const rows: { id: IntegrationId; name: string; icon: ReactNode; status: string; on: boolean; disabled?: boolean }[] = [
    {
      id: 'updown',
      name: 'updown.io',
      icon: <img className="set-fav" src="https://updown.io/favicon.ico" alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />,
      status: account.integrations.updown === 'server' ? 'Connected with the key set on the server' : account.integrations.updown ? 'Connected · for the Status widget' : 'Uptime checks, for the Status widget',
      on: !!account.integrations.updown,
    },
    {
      id: 'ollama',
      name: 'Ollama Cloud',
      icon: <Fav src="https://ollama.com/public/icon-64x64.png" glyph="🦙" />,
      status: account.integrations.ollama === 'server' ? 'Connected with the key set on the server' : account.integrations.ollama ? 'Connected · for Agents' : 'Models and web search, for the Agents app',
      on: !!account.integrations.ollama,
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
    {
      id: 'mail',
      name: 'Mail',
      icon: <span className="set-glyph">✉</span>,
      status: mailAccounts?.length ? `${mailAccounts.map((a) => a.username).join(', ')} · for the Mail app` : 'Fastmail or another JMAP server, for the Mail app',
      on: !!mailAccounts?.length,
    },
    {
      id: 'immich',
      name: 'Immich',
      icon: <span className="set-glyph">🖼</span>,
      status: photos?.immich ? `${host(photos.immich.url)} · Immich ${photos.immich.version} · for Photos` : 'Your photo library, in the Photos app',
      on: !!photos?.immich,
    },
    {
      id: 'calendars',
      name: 'Calendars (Google, CalDAV)',
      icon: <span className="set-glyph">📅</span>,
      status: calendarLinks.length ? `${calendarLinks.join(', ')} · for Calendar and Tasks` : 'Google Calendar, Fastmail, Nextcloud and iCloud, for Calendar and Tasks',
      on: calendarLinks.length > 0,
    },
    {
      id: 'contacts',
      name: 'Contacts (CardDAV)',
      icon: <span className="set-glyph">📇</span>,
      status: carddav.length ? `${carddav.join(', ')} · for Contacts` : 'Fastmail, iCloud, Nextcloud and other address books, for Contacts',
      on: carddav.length > 0,
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
        {current.id === 'mail' ? <MailSettings /> : current.id === 'updown' ? <UpdownSettings /> : current.id === 'ollama' ? <OllamaSettings /> : current.id === 'seafile' ? <SeafileSettings /> : current.id === 'immich' ? <ImmichLink /> : current.id === 'contacts' ? <ContactsAccounts /> : current.id === 'calendars' ? <CalendarAccounts /> : <OfficeSettings />}
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
            <SecretInput value={key} onChange={(e) => setKey(e.target.value)} placeholder="read-only API key" required />
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
      {error && <p className="t-red copyable">{error}</p>}
    </>
  )
}

/** Ollama Cloud's API key, for the Agents app: its models, web search and web fetch. */
function OllamaSettings() {
  const account = useAccount()
  const wm = useWM()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await setOllamaKey(key)
      setKey('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {account.integrations.ollama === 'server' && <p className="muted">Connected with OLLAMA_API_KEY from the server's environment. A key saved here would be used instead.</p>}
      {account.integrations.ollama === 'settings' ? (
        <>
          <p className="muted">Connected with a key saved here, stored encrypted on this server. Agents uses it for the models, web search and reading pages; usage counts against your Ollama plan.</p>
          <div className="set-actions">
            <button className="btn btn-small btn-primary" onClick={() => wm.open('agents')}>
              Open Agents
            </button>
            <button className="btn btn-small" onClick={() => removeOllamaKey().catch((e: Error) => setError(e.message))}>
              Remove key
            </button>
          </div>
        </>
      ) : (
        <form className="set-form" onSubmit={save}>
          <label>
            <span>API key</span>
            <SecretInput value={key} onChange={(e) => setKey(e.target.value)} placeholder="Ollama API key" required />
          </label>
          <p className="muted set-help">
            Make one at{' '}
            <a href="https://ollama.com/settings/keys" target="_blank" rel="noopener noreferrer">
              ollama.com → Settings → Keys
            </a>
            . It is checked once, then stored encrypted on this server and only used from here.
          </p>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Checking…' : 'Connect Ollama Cloud'}
          </button>
        </form>
      )}
      {error && <p className="t-red copyable">{error}</p>}
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
  const wm = useWM()
  useMounts()
  const sfLines = fstabEntries().filter((e) => isSeafileType(e) || e.options.includes('bind'))

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
          <SecretInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="password" required />
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
        {error && <p className="t-red copyable">{error}</p>}
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
          <Select
            className="set-select"
            value={primary?.id ?? ''}
            disabled={!libs?.length}
            onChange={(primary) => setSeafilePrefs({ primary })}
            aria-label="Primary library"
            placeholder={libs ? undefined : 'Loading…'}
            options={(libs ?? []).map((l) => ({ value: l.id, label: `${l.name}${l.encrypted ? ' 🔒' : ''}${l.type !== 'mine' && l.owner ? ` (${l.owner})` : ''}` }))}
          />
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Use as home</strong>
            <span className="muted">{sfPrefs.home ? `Files and the desktop use ${primary?.name ?? 'the primary library'}` : 'Off: home is the built-in one, Seafile is still in Files’ sidebar'}</span>
          </span>
          <Toggle on={sfPrefs.home} onChange={(home) => setSeafilePrefs({ home })} label="Use the primary library as home" />
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Mounts</strong>
            <span className="muted">
              {sfLines.length ? `${sfLines.length} Seafile line${sfLines.length === 1 ? '' : 's'} in /etc/fstab: ${sfLines.map((e) => e.target).join(', ')}` : 'No Seafile lines in /etc/fstab'}. Files and the terminal both follow it.
            </span>
          </span>
          <button className="btn btn-small" onClick={() => wm.openNew('terminal', { run: 'findmnt', t: String(Date.now()) })}>
            Show
          </button>
          <button className="btn btn-small" onClick={() => wm.openNew('terminal', { run: 'sudo nano /etc/fstab', t: String(Date.now()) })}>
            Edit fstab
          </button>
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
          <Select
            className="set-select"
            value={sfPrefs.lockMinutes}
            onChange={(lockMinutes) => setSeafilePrefs({ lockMinutes })}
            aria-label="Lock encrypted libraries after"
            options={[5, 15, 30, 55].map((m) => ({ value: m, label: `${m} minutes` }))}
          />
        </li>
      </ul>
      {libsError && (
        <p className="t-red copyable">
          {libsError}{' '}
          <button className="btn btn-small" onClick={() => loadLibraries(true)}>
            Try again
          </button>
        </p>
      )}
      {error && <p className="t-red copyable">{error}</p>}
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
        {error && <p className="t-red copyable">{error}</p>}
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
        <SecretInput value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder="ONLYOFFICE_JWT_SECRET" required />
      </label>
      <p className="muted set-help">
        The document server Seafile opens Office files with, to edit them in a window here. The secret is <em>ONLYOFFICE_JWT_SECRET</em> from Seafile's <em>.env</em> (or <em>seahub_settings.py</em>). The URL is checked by loading its editor, then both are stored encrypted on this server.
      </p>
      {error && <p className="t-red copyable">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? 'Checking…' : 'Add OnlyOffice'}
      </button>
    </form>
  )
}

/** Settings → Integrations → Calendars: Google Calendar and CalDAV accounts, for the Calendar app, Tasks, the Agenda widget and the clock. */
function CalendarAccounts() {
  const account = useAccount()
  const wm = useWM()
  const { errors } = useCalendarList()
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

      {(error || errors.length > 0) && <p className="t-red copyable">{[error, ...errors].filter(Boolean).join(' · ')}</p>}
      <div className="set-actions">
        <button className="btn btn-small" onClick={() => wm.open('calendar', { t: String(Date.now()) })}>
          Open Calendar
        </button>
        <button className="btn btn-small" onClick={() => wm.open('tasks', { t: String(Date.now()) })}>
          Open Tasks
        </button>
      </div>
    </>
  )
}

/** Settings → Apps → Calendar: which calendars show, and how the Calendar app opens. The accounts are in Integrations. */
function CalendarSettings() {
  const account = useAccount()
  const { calendars } = useCalendarList()
  const picks = useCalendarChoice()
  if (account.status !== 'user') return <SignInFirst what="connect a calendar" />
  const linked = !!account.google || account.caldav.length > 0
  return (
    <>
      <IntegrationNotice sub="calendars" linked={linked} app="Calendar" invite="Link a calendar account to get started." />
      {linked && <HiddenCalendars />}
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
      <CalendarAppPrefs />
    </>
  )
}

/** Settings → Apps → Calendar: every calendar by account, with a switch to leave it out of MvL OS altogether (the same calendar twice, say, through Google and Fastmail). */
function HiddenCalendars() {
  const { calendars } = useAllCalendars()
  const { lists } = useTasks()
  const hidden = useHiddenCalendars()
  const groups: { title: string; items: { id: string; name: string; sub?: string; color: string }[] }[] = []
  const add = (title: string, item: { id: string; name: string; sub?: string; color: string }) => {
    const group = groups.find((g) => g.title === title)
    if (group) group.items.push(item)
    else groups.push({ title, items: [item] })
  }
  for (const c of calendars ?? []) add(c.source ?? 'Google', { id: c.id, name: c.name, sub: [c.primary ? 'your calendar' : '', c.writable === false ? 'read-only' : ''].filter(Boolean).join(' · ') || undefined, color: c.color })
  add('Contacts', { id: BIRTHDAYS, name: 'Birthdays', sub: 'read-only', color: BIRTHDAY_COLOR })
  for (const l of lists ?? []) if (!(calendars ?? []).some((c) => c.id === l.id)) add('Tasks', { id: l.id, name: l.name, sub: l.source, color: l.color })
  return (
    <>
      <h4 className="set-subhead">Show in MvL OS</h4>
      <p className="muted set-help">Hidden calendars are left out everywhere: the Calendar, pickers, widgets and Spotlight. Untick one in the Calendar's sidebar to just filter it from view.</p>
      {groups.map((g) => (
        <SetGroup key={g.title} title={g.title}>
          <ul className="set-list set-calendars">
            {g.items.map((c) => (
              <li key={c.id} className={`set-row ${hidden.includes(c.id) ? 'is-hidden' : ''}`}>
                <span className="set-swatch" style={{ background: c.color }} />
                <span className="set-row-text">
                  <strong>{c.name}</strong>
                  {c.sub && <span className="muted">{c.sub}</span>}
                </span>
                <Toggle on={!hidden.includes(c.id)} onChange={(on) => setCalendarHidden(c.id, !on)} label={`Show ${c.name} in MvL OS`} />
              </li>
            ))}
          </ul>
        </SetGroup>
      ))}
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
        <SecretInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="app password" required />
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
      {error && <p className="t-red copyable">{error}</p>}
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
  // Quick answers come from the Agents app: only when signed in, with an Ollama key.
  const agents = account.status === 'user' && !!account.integrations.ollama
  const [cleared, setCleared] = useState(false)
  const clearAnswers = async () => {
    if (!(await ask({ title: 'Forget every quick answer?', body: 'Answers you continued in Agents stay there.', confirm: 'Forget all', danger: true }))) return
    await clearQuick().catch(() => {})
    setCleared(true)
  }
  const fallbacks: [Fallback, string][] = [
    ['web', `Searches ${ENGINES[engine].label}`],
    ['terminal', 'Runs it in a terminal'],
  ]
  return (
    <>
      <SetGroup title="Ctrl+Space opens">
        <div className="seg set-seg" role="radiogroup" aria-label="Ctrl+Space opens">
          {CTRL_SPACE.map(([id, label]) => (
            <button key={id} role="radio" aria-checked={prefs.ctrlSpace === id} className={prefs.ctrlSpace === id ? 'is-active' : ''} onClick={() => setSpotlightPrefs({ ctrlSpace: id })}>
              {label}
            </button>
          ))}
        </div>
        <p className="muted set-help">
          {prefs.ctrlSpace === 'spotlight'
            ? 'Ctrl+Space opens Spotlight. Ctrl+K and Cmd+K open All apps.'
            : 'Ctrl+Space opens All apps. Ctrl+K and Cmd+K open Spotlight.'}
        </p>
      </SetGroup>
      <SetGroup title="When Spotlight opens, show">
        {START_SECTIONS.filter(([id]) => agents || id !== 'answers').map(([id, label, hint]) => (
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
        <p className="muted set-help">How many recent answers, recently visited websites, and repositories and issues an empty Spotlight lists.</p>
      </SetGroup>
      {agents && (
        <SetGroup title="Keep quick answers for">
          <div className="seg set-seg" role="radiogroup" aria-label="Keep quick answers for">
            {ANSWERS_KEEP.map(([id, label]) => (
              <button key={id} role="radio" aria-checked={prefs.answersKeep === id} className={prefs.answersKeep === id ? 'is-active' : ''} onClick={() => setSpotlightPrefs({ answersKeep: id })}>
                {label}
              </button>
            ))}
          </div>
          <p className="muted set-help">
            Questions you ask Agents from Spotlight (start with <code>?</code>) are answered there and listed under Recent answers, until this long after their last reply. Continue one in Agents (Ctrl+K) to keep it; forget one by hand with right-click or Shift+Delete.
          </p>
          <button className="btn btn-small" disabled={cleared} onClick={() => void clearAnswers()}>
            {cleared ? 'Forgotten' : 'Forget all quick answers'}
          </button>
        </SetGroup>
      )}
      <SpotlightFavourites />
      <SetGroup title="While you type, include">
        {CATEGORIES.filter(([id]) => (agents || id !== 'answers') && (account.status === 'user' || (id !== 'contacts' && id !== 'mail'))).map(([id, label]) => (
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

/**
 * Where web links open, and whether the browser's new tab page (/?newtab) always uses this tab
 * and starts in Spotlight.
 */
/** Settings → Windows: which key, held while dragging, moves and resizes a window from anywhere on it. */
function DragKeySettings() {
  const key = dragKeyPref.use()
  return (
    <SetGroup title="Drag windows with a key">
      <div className="seg set-seg" role="radiogroup" aria-label="Drag windows with a key">
        {DRAG_KEYS.map(([id, label]) => (
          <button key={id} role="radio" aria-checked={key === id} className={key === id ? 'is-active' : ''} onClick={() => dragKeyPref.set(id)}>
            {label}
          </button>
        ))}
      </div>
      <p className="muted set-help">
        {key === 'off'
          ? 'Windows move and resize by their title bar and edges only.'
          : `Hold ${key === 'alt' ? 'Alt' : 'Ctrl'} and drag anywhere on a window with the left button to move it, or with the right button to resize it from the nearest corner, as in Hyprland. A plain ${key === 'alt' ? 'Alt' : 'Ctrl'}-click still goes to the app. Games and programs in the terminal that read the mouse keep the key for themselves. Alt is the key this site already uses for workspaces. In Files and Photos, Shift-drag adds to the selection with a box. Not on phones. Saved in this browser.`}
      </p>
    </SetGroup>
  )
}

/** Settings → Windows: what the desktop shows when MvL OS opens again. */
function WindowsSettings() {
  const { windows } = useStartupPrefs()
  const wm = useWM()
  return (
    <>
      <SetGroup title="When MvL OS opens">
        <div className="seg set-seg" role="radiogroup" aria-label="When MvL OS opens">
          {START_WINDOWS.map(([id, label]) => (
            <button key={id} role="radio" aria-checked={windows === id} className={windows === id ? 'is-active' : ''} onClick={() => setStartupPrefs({ windows: id })}>
              {label}
            </button>
          ))}
        </div>
        <p className="muted set-help">
          {START_WINDOWS.find(([id]) => id === windows)?.[2]}. This counts for a new tab, a reload and the installed app starting again.
          {windows !== 'last' && " While this is chosen, MvL OS doesn't save which windows are open."}
        </p>
      </SetGroup>
      <TabWorkspacesGroup lastWindows={windows === 'last'} />
      <DragKeySettings />
      <SetGroup title="Right now">
        <ul className="set-list">
          <li className="set-row">
            <span className="set-row-text">
              <strong>Start over</strong>
              <span className="muted">Close every window and open the welcome windows</span>
            </span>
            <button className="btn btn-small" onClick={() => wm.reset()}>
              Start over
            </button>
          </li>
        </ul>
      </SetGroup>
    </>
  )
}

/** Settings → Windows → Workspaces: one workspace per tab of this browser (src/os/tabWorkspaces.ts). */
function TabWorkspacesGroup({ lastWindows }: { lastWindows: boolean }) {
  const prefs = tabWorkspacePrefs.use()
  const tabs = useTabWorkspaces()
  const wm = useWM()
  const now = !tabWorkspacesSupported
    ? "This browser can't tell which of its tabs are open (no Web Locks), so every tab shows the same workspace."
    : !prefs.perTab
      ? 'Every tab shows the same workspace.'
      : !lastWindows
        ? 'This needs Last windows above: with the other choices every tab has windows of its own.'
        : !wm.workspaces
          ? 'A phone has the one workspace.'
          : tabs.status === 'own'
            ? `This tab has workspace ${tabs.mine}.`
            : tabs.status === 'shared'
              ? 'Every workspace was open in another tab when this one opened, so this tab shares them.'
              : ''
  return (
    <SetGroup title="Workspaces">
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>One workspace per tab</strong>
            <span className="muted">Every open tab of MvL OS gets a workspace of its own</span>
          </span>
          <Toggle on={prefs.perTab} onChange={(on) => tabWorkspacePrefs.patch({ perTab: on })} label="One workspace per tab" />
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Adopt left-behind workspaces</strong>
            <span className="muted">A new tab takes over the windows a closed tab left</span>
          </span>
          <Toggle on={prefs.adopt} onChange={(on) => tabWorkspacePrefs.patch({ adopt: on })} label="Adopt left-behind workspaces" />
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>…also as the new tab page</strong>
            <span className="muted">
              Off: <code>/?newtab</code> starts on an empty workspace
            </span>
          </span>
          <Toggle on={prefs.adoptNewTab} onChange={(on) => tabWorkspacePrefs.patch({ adoptNewTab: on })} label="Adopt left-behind workspaces on the new tab page" />
        </li>
      </ul>
      <p className="muted set-help">
        {now && `${now} `}The bar marks the workspaces open in other tabs with a dot. Going to one is refused, since a page can't bring another tab forward; a window sent there moves to that tab. The new tab page leaves old workspaces alone unless the last switch is on, or every Ctrl+T would take one over. Saved in this browser.
      </p>
    </SetGroup>
  )
}

function LanguagePane() {
  return (
    <>
      <FuriganaGroup />
      <EmojiGroup />
      <RegionGroup />
    </>
  )
}

function EmojiGroup() {
  const on = emojiTypingPref.use()
  return (
    <SetGroup title="Emoji shortcodes">
      <label className="set-check">
        <input type="checkbox" checked={on} onChange={(e) => emojiTypingPref.set(e.target.checked)} />
        Turn :name: into an emoji while typing
      </label>
      <p className="muted set-help">
        In the Agents message box and the Notebook, <code>:fi</code> offers matching names, and a finished <code>:fire:</code> followed by a space becomes 🔥. Code and links are left alone. Replies and notes always show <code>:name:</code> as the emoji, whatever this says. Saved in this browser.
      </p>
    </SetGroup>
  )
}

function RegionGroup() {
  const home = useHomeCurrency()
  const account = useAccount()
  // A code synced from elsewhere that isn't in the list still shows.
  const options = HOME_CURRENCIES.some(([c]) => c === home) ? HOME_CURRENCIES : [...HOME_CURRENCIES, [home, home] as [string, string]]
  return (
    <SetGroup title="Region">
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>Home currency</strong>
            <span className="muted">What amounts in Agents and Spotlight convert to</span>
          </span>
          <Select className="set-select" value={home} onChange={setHomeCurrency} aria-label="Home currency" options={options.map(([value, name]) => ({ value, label: value === name ? value : `${value} · ${name}` }))} />
        </li>
      </ul>
      <p className="muted set-help">
        Click an amount like €180 or ¥60,000 in an Agents reply to see it in this currency and a few others. Rates are the European Central Bank's, topped up from exchangerate-api.com for other currencies, and refreshed every six hours.{' '}
        {account.status === 'user' ? 'Your choice syncs to your other devices.' : 'Saved in this browser.'}
      </p>
    </SetGroup>
  )
}

function FuriganaGroup() {
  const mode = useFurigana()
  const size = useFuriganaSize()
  const account = useAccount()
  const shown = FURIGANA_MODES.find(([id]) => id === mode)!
  return (
    <SetGroup title="Furigana">
      <div className="set-choices" role="radiogroup" aria-label="Furigana">
        {FURIGANA_MODES.map(([id, label]) => (
          <label key={id} className={`set-choice ${mode === id ? 'is-on' : ''}`}>
            <input type="radio" name="furigana" checked={mode === id} onChange={() => setFurigana(id)} />
            {label}
          </label>
        ))}
      </div>
      {mode !== 'off' && (
        <>
          <h4 className="set-subhead">Reading size</h4>
          <div className="set-choices" role="radiogroup" aria-label="Furigana reading size">
            {FURIGANA_SIZES.map(([id, label]) => (
              <label key={id} className={`set-choice ${size === id ? 'is-on' : ''}`}>
                <input type="radio" name="furigana-size" checked={size === id} onChange={() => setFuriganaSize(id)} />
                {label}
              </label>
            ))}
          </div>
        </>
      )}
      <p className="set-furigana-sample" lang="ja">
        <ruby>
          日本語<rp>(</rp>
          <rt>にほんご</rt>
          <rp>)</rp>
        </ruby>
        を
        <ruby>
          勉強<rp>(</rp>
          <rt>べんきょう</rt>
          <rp>)</rp>
        </ruby>
        する
      </p>
      <p className="muted set-help">
        {shown[2]} Applies to all Markdown text: Agents replies, the previews in Zed and Files, Notebook, Spotlight answers and the terminal's <code>agents</code> view. It is written <code>{'{漢字|かんじ}'}</code>, and an agent can write it too.{' '}
        {account.status === 'user' ? 'Your choice syncs to your other devices.' : 'Saved in this browser.'}
      </p>
    </SetGroup>
  )
}

function LinkSettingsPane() {
  const { target, newTabPageSameTab, newTabPageSpotlight } = useLinkSettings()
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
      <label className="set-check">
        <input type="checkbox" checked={newTabPageSpotlight} onChange={(e) => setLinkSettings({ newTabPageSpotlight: e.target.checked })} />
        As the browser's new tab page, start with Spotlight open
      </label>
      <p className="muted set-help">
        Covers Spotlight, the terminal's <code>open</code> and <code>go</code>, launchers and links in apps. Ctrl-click still opens a new tab. The new tab page is this site loaded as <code>/?newtab</code>.{' '}
        {account.status === 'user' ? 'Your choice syncs to your other devices.' : 'Saved in this browser.'}
      </p>
    </>
  )
}

type PaneId = 'account' | 'appearance' | 'dock' | 'launchers' | 'search' | 'windows' | 'links' | 'language' | 'notifications' | 'instances' | 'calendar' | 'contacts' | 'integrations' | 'agents' | 'golinks' | 'terminal' | 'files' | 'games' | 'mail' | 'amp' | 'notebook' | 'pdf' | 'preview' | 'weather' | 'sync' | 'users' | 'about'
/** `account`: only when signed in (accounts and services); visitors don't see it at all.
 * `admin`: only for admins (the server checks that on every request too). */
type Pane = { id: PaneId; label: string; hue: string; icon: ReactNode; /** An app's pane (Settings → Apps) shows the app's own dock icon instead */ app?: AppId; keywords: string; blurb: string; account?: true; admin?: true; render: (opened: { sub?: string; t?: string }) => ReactNode }
/** A group of panes in the sidebar, under a small heading when it has a title (Apps). */
type Group = { title?: string; panes: Pane[] }

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
      <p className="muted set-help">Notes, launchers, desktop icons, the dock, the top bar, the search engine, where links open, the go links account, Spotlight's settings, favourites and history, notification settings, what opens at the start, /etc/fstab, and window layouts (one for phones, one for bigger screens) follow you between devices once signed in. So do some apps' settings: the Terminal's text size and extra keys, Agents, the Calendar app's view and calendars, Files' bookmarks, and Weather's units and saved cities; and game high scores, Gladiator's saves and your Empires At War multiplayer name. Without an account they stay in this browser, as do the other apps' settings in Settings → Apps.</p>
    </>
  )
}

// Grouped like macOS System Settings: the look of the desktop, then how things are found and
// announced, then the outside services, then each app's own settings (under a heading, since
// their names alone don't say they are apps), then housekeeping.
const GROUPS: Group[] = [
  {
    panes: [
      { id: 'appearance', label: 'Appearance', hue: 'var(--blue)', icon: svg(<><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></>), keywords: 'theme dark light mode accent color omarchy motion wiggle swing animation performance fps frame time counter', blurb: 'Light and dark mode, themes, the accent color, motion and frame timing.', render: () => <Appearance /> },
      { id: 'dock', label: 'Dock', hue: 'var(--cyan)', icon: svg(<><rect x="3" y="4" width="18" height="16" /><path d="M7 16h10" /></>), keywords: 'dock hide pin apps order', blurb: 'When the dock shows, and what is in it.', render: () => <DockSettings /> },
      { id: 'launchers', label: 'Launchers', hue: 'var(--magenta)', icon: svg(<><rect x="4" y="4" width="6" height="6" /><rect x="14" y="4" width="6" height="6" /><rect x="4" y="14" width="6" height="6" /><rect x="14" y="14" width="6" height="6" /></>), keywords: 'launchers links bookmarks desktop shortcuts', blurb: 'Links on the desktop, in All apps and in Spotlight.', render: () => <Launchers /> },
    ],
  },
  {
    panes: [
      { id: 'search', label: 'Spotlight', hue: 'var(--green)', icon: svg(<><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>), keywords: 'spotlight search engine suggestions duckduckgo kagi google history recent visited websites preview start empty fallback terminal favourites favorites starred ctrl space shortcut keyboard all apps launchpad', blurb: 'What Spotlight shows when it opens, what it searches, what it remembers, and what Ctrl+Space opens.', render: () => <SpotlightSettings /> },
      { id: 'windows', label: 'Windows', hue: 'var(--yellow)', icon: svg(<><rect x="3" y="5" width="12" height="10" /><rect x="9" y="9" width="12" height="10" /></>), keywords: 'windows restore reopen startup start open last session layout tabs welcome empty desktop reset start over workspaces workspace per tab browser tabs adopt left behind closed tab newtab new tab page drag move resize modifier key ctrl alt hyprland corner mouse', blurb: 'What the desktop shows when MvL OS opens again, one workspace per browser tab, and dragging windows with a key.', render: () => <WindowsSettings /> },
      { id: 'links', label: 'Links', hue: 'var(--blue)', icon: svg(<><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v6H4V6h6" /></>), keywords: 'links open new tab same tab browser newtab home page spotlight', blurb: 'Whether links open in a new tab or this one.', render: () => <LinkSettingsPane /> },
      { id: 'language', label: 'Language & region', hue: 'var(--magenta)', icon: svg(<><path d="M4 6h9M8.5 3v3M6 6c.5 3 3 5.5 6 6.5M12 6c-.5 3-3 5.5-6 6.5" /><path d="M13 20l3.5-8 3.5 8M14.3 17h4.4" /></>), keywords: 'language region emoji emojis shortcode shortcodes smiley discord slack autocomplete replace typing furigana ruby reading readings kanji japanese hiragana hover show hide size small medium large bigger currency home money exchange rate euro dollar yen', blurb: 'Furigana, the readings above Japanese characters, and your home currency.', render: () => <LanguagePane /> },
      { id: 'notifications', label: 'Notifications', hue: 'var(--red)', icon: svg(<><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 21h4" /></>), keywords: 'notifications alerts notification center bell pop-ups do not disturb dnd keep history clear minecraft activity agents uploads unpacking updates system browser', blurb: 'Pop-ups, the notification center, and which apps may notify.', render: () => <Notifications /> },
      { id: 'golinks', label: 'Go links', hue: 'var(--yellow)', icon: svg(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>), keywords: 'go links golinks terminal spotlight suggestions mvl.sh token', blurb: "The golinks account that go <alias> follows, in Spotlight and the terminal.", render: () => <GoLinks /> },
    ],
  },
  {
    panes: [
      { id: 'instances', label: 'Code hosts', hue: 'var(--orange)', account: true, icon: <BranchGlyph />, keywords: 'code hosts gitea forgejo github token instances repositories repos org orgs organisation organisations organization organizations team company private access grant oauth sso saml read:org', blurb: 'GitHub and its organisations, and the Gitea or Forgejo instances you linked.', render: () => <Instances /> },
      { id: 'integrations', label: 'Integrations', hue: 'var(--green)', account: true, icon: svg(<><circle cx="7" cy="12" r="3" /><circle cx="17" cy="12" r="3" /><path d="M10 12h4" /></>), keywords: 'integrations accounts link connect updown uptime status monitoring api key widgets seafile files cloud onlyoffice office documents ollama agents ai models storage mail email jmap fastmail immich photos calendar calendars google caldav tasks contacts carddav address book icloud nextcloud', blurb: 'Every account and key: calendars (Google, CalDAV), contacts (CardDAV), Mail, Immich, Seafile, OnlyOffice, Ollama Cloud and updown.io.', render: ({ sub, t }) => <Integrations sub={sub} t={t} /> },
    ],
  },
  {
    title: 'Apps',
    panes: [
      { id: 'agents', label: 'Agents', hue: 'var(--magenta)', account: true, icon: null, app: 'agents', keywords: 'past threads history search agents overview status ai assistant ollama images image generation openai gpt-image chatgpt codex sign in api key icons icon library image studio comfyui diffusion models quick deep research thinking effort reasoning favourites favorite gpt-5 chatgpt models deepseek glm kimi mistral title thread system prompt agents.md tools memory skills always on always-on skills caveman adhd personalize hooks rules per project instructions', blurb: 'The Agents app: its models, what a new thread starts with, and its system prompt.', render: () => <AgentsSettings /> },
      { id: 'calendar', label: 'Calendar', hue: 'var(--red)', account: true, icon: null, app: 'calendar', keywords: 'calendar agenda events view week month day year default new events which calendars show google caldav accounts hide hidden calendar duplicate duplicates fastmail show in mvl os', blurb: 'Which calendars show, how the Calendar app opens, and where new events go. The accounts are in Integrations.', render: () => <CalendarSettings /> },
      { id: 'contacts', label: 'Contacts', hue: 'var(--orange)', account: true, icon: null, app: 'contacts', keywords: 'contacts people address book default new contacts carddav accounts vcard vcf birthdays groups', blurb: 'Where new contacts go. The address book accounts (Fastmail, iCloud…) are in Integrations.', render: () => <ContactsSettings /> },
      { id: 'files', label: 'Files', hue: 'var(--blue)', icon: null, app: 'files', keywords: 'files file manager view list grid compact gallery icon size zoom sort order hidden dotfiles sidebar preview pane quick look new windows remember', blurb: 'How Files shows a folder: the view, icon size, sort order, hidden files, the sidebar and the preview pane.', render: () => <FilesPane /> },
      { id: 'games', label: 'Games', hue: 'var(--cyan)', icon: null, app: 'games', keywords: 'games arcade pool gladiator empires at war rts sound music volume mute helpers aim sensitivity difficulty computer health bars rings fog camera edge scrolling key bindings keybinds keys multiplayer name online', blurb: 'Pool, Gladiator and Empires At War: how they play and sound.', render: ({ sub, t }) => <GamesPane sub={sub} t={t} /> },
      { id: 'mail', label: 'Mail', hue: 'var(--blue)', account: true, icon: null, app: 'mail', keywords: 'mail email jmap fastmail read mark as read remote content images allow list allowed senders domain tracking pixels quoted text signature reply all default account identity from ctrl enter send notifications', blurb: 'How Mail reads and writes: when mail counts as read, remote content and the senders you allowed, signatures and replies. The accounts are in Integrations.', render: () => <MailPane /> },
      { id: 'notebook', label: 'Notebook', hue: 'var(--yellow)', icon: null, app: 'notebook', keywords: 'notebook notes preview edit markdown open notes in last used default view', blurb: 'Whether a note opens in Preview or Edit.', render: () => <NotebookPane /> },
      { id: 'amp', label: 'Omamp', hue: 'var(--green)', icon: null, app: 'amp', keywords: 'omamp music player audio winamp shuffle repeat equalizer eq preset visualizer spectrum oscilloscope time remaining playlist', blurb: 'The music player: shuffle and repeat, the equalizer, and what it shows.', render: () => <AmpPane /> },
      { id: 'pdf', label: 'PDF', hue: 'var(--red)', icon: null, app: 'pdf', keywords: 'pdf viewer documents night mode dark sidebar thumbnails outline', blurb: 'The PDF viewer: its sidebar and night mode.', render: () => <PdfPane /> },
      { id: 'preview', label: 'Preview', hue: 'var(--blue)', icon: null, app: 'preview', keywords: 'preview pictures images photos viewer sidebar', blurb: 'The picture viewer: its sidebar.', render: () => <PreviewPane /> },
      { id: 'terminal', label: 'Terminal', hue: 'var(--green)', icon: null, app: 'terminal', keywords: 'terminal shell console text size font size zoom phone desktop extra keys touch keyboard esc tab ctrl colours colors theme mvshrc rc startup file alias aliases msh bashrc profile', blurb: 'Text size on desktops and phones, the extra keys on touch screens, and the ~/.mvshrc startup file.', render: () => <TerminalPane /> },
      { id: 'weather', label: 'Weather', hue: 'var(--cyan)', icon: null, app: 'weather', keywords: 'weather forecast temperature celsius fahrenheit units cities location rain wind', blurb: 'Units for the Weather app and widget-linked cities.', render: () => <WeatherPane /> },
    ],
  },
  {
    panes: [
      { id: 'sync', label: 'Sync', hue: 'var(--green)', account: true, icon: svg(<><path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></>), keywords: 'sync devices cloud', blurb: 'What follows you between devices.', render: () => <SyncPane /> },
      { id: 'users', label: 'Users', hue: 'var(--accent)', account: true, admin: true, icon: svg(<><circle cx="9" cy="8" r="3.5" /><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6" /><circle cx="17" cy="9" r="2.5" /><path d="M16 14.2c2.9.1 5 2.4 5 5.8" /></>), keywords: 'users accounts admin sign-up registration ban delete cap full', blurb: 'Every account, sign-up and the cap. Only for admins.', render: () => <UsersSettings /> },
      { id: 'about', label: 'About', hue: 'var(--text)', icon: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>), keywords: 'about version update release build', blurb: 'Which version this is, and whether a newer one is out.', render: () => <About /> },
    ],
  },
]
const ACCOUNT_PANE: Pane = { id: 'account', label: 'Account', hue: 'var(--accent)', icon: null, keywords: 'account github sign in sign out profile', blurb: '', render: () => <Account /> }
const PANES: Pane[] = [ACCOUNT_PANE, ...GROUPS.flatMap((g) => g.panes)]
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
  // Visitors only see what works without an account; the user's panes would just say "sign in".
  const signedIn = useLikelySignedIn()
  const admin = !!account.user?.admin
  const alerts = useAlerts()
  const badges = alerts.reduce<Partial<Record<string, number>>>((m, a) => (a.pane ? { ...m, [a.pane]: (m[a.pane] ?? 0) + 1 } : m), {})
  const groups = useMemo((): Group[] => {
    const mine = GROUPS.map((g) => ({ ...g, panes: g.panes.filter((p) => (signedIn || !p.account) && (admin || !p.admin)) })).filter((g) => g.panes.length)
    // Searching lists what matches in one plain list, without the groups' headings.
    return q ? [{ panes: mine.flatMap((g) => g.panes).filter((p) => `${p.label} ${p.keywords}`.toLowerCase().includes(q)) }] : mine
  }, [q, signedIn, admin])
  const asked = PANES.find((p) => p.id === pane)!
  const current = (asked.account && !signedIn) || (asked.admin && !admin) ? ACCOUNT_PANE : asked
  const u = account.user

  return (
    <div className={`settings ${showPane ? 'is-pane' : ''}`}>
      <nav className="set-side" aria-label="Settings">
        <input
          className="set-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && groups[0]?.panes[0] && go(groups[0].panes[0].id)}
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
        {/* What needs you, as macOS lists "Finish setting up" under your name (src/os/alerts.ts). */}
        {!q && alerts.length > 0 && (
          <ul className="set-alerts">
            {alerts.map((a) => (
              <li key={a.id}>
                <button onClick={() => (a.run ? a.run() : a.pane ? go(a.pane as PaneId) : openAlert(a))} title={a.body}>
                  <span className="set-alert-dot" aria-hidden>
                    !
                  </span>
                  <span className="set-alert-text">{a.title}</span>
                  <span className="set-chevron" aria-hidden>
                    ›
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {groups.map((g, i) => (
          <ul key={i} className="set-nav" aria-label={g.title}>
            {g.title && (
              <li className="set-nav-head" aria-hidden>
                {g.title}
              </li>
            )}
            {g.panes.map((p) => (
              <li key={p.id}>
                <button className={current.id === p.id ? 'is-on' : ''} onClick={() => go(p.id)} aria-current={current.id === p.id ? 'page' : undefined}>
                  {p.app ? (
                    <AppIcon app={p.app} size={22} tone />
                  ) : (
                    <span className="set-tile" style={{ ['--hue' as string]: p.hue }}>
                      {p.icon}
                    </span>
                  )}
                  {p.label}
                  {badges[p.id] ? (
                    <span className="set-nav-badge" aria-label={`${badges[p.id]} needs attention`}>
                      {badges[p.id]}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ))}
        {q && !groups[0].panes.length && <p className="muted set-noresult">Nothing matches “{query.trim()}”.</p>}
      </nav>
      <div className="set-main" ref={content}>
        <header className="set-head">
          <button className="set-back" onClick={() => setShowPane(false)} aria-label="All settings">
            ‹ Settings
          </button>
          <h2>{current.label}</h2>
          {current.blurb && <p className="muted">{current.blurb}</p>}
        </header>
        <div className="set-body">{current.render({ sub: win.props.section === current.id ? win.props.sub : undefined, t: win.props.t })}</div>
      </div>
    </div>
  )
}
