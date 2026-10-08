import { useEffect, useRef, useState, type FormEvent } from 'react'
import { addLauncher, cleanUrl, faviconOf, moveLauncher, removeLauncher, updateLauncher, useLaunchers, type Launcher } from '../data/launchers'
import { linkForge, signIn, signOut, unlinkForge, useAccount } from '../os/account'
import { clearCodeSearch } from '../os/codeSearch'
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
      <button className="btn btn-small" onClick={() => removeLauncher(l.id)}>
        Remove
      </button>
    </li>
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
