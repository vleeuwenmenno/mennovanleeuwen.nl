import { useState, type FormEvent } from 'react'
import { cleanUrl } from '../data/launchers'
import { linkForge, useAccount } from '../os/account'
import { clearCodeSearch } from '../os/codeSearch'
import { useWM, type WinState } from '../os/wm'

// Linking a Gitea or Forgejo instance, in a window of its own (opened from Settings → Code hosts).
// It closes itself once the token checks out and brings Settings back to the list.

export function LinkForge({ win }: { win: WinState }) {
  const wm = useWM()
  const account = useAccount()
  const [form, setForm] = useState({ baseUrl: '', label: '', token: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (account.status !== 'user')
    return (
      <div className="lf">
        <p className="muted">Sign in first to link Gitea or Forgejo instances.</p>
      </div>
    )

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await linkForge(form)
      clearCodeSearch()
      wm.close(win.pid)
      wm.open('settings', { section: 'instances', t: String(Date.now()) })
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  const tokenPage = cleanUrl(form.baseUrl)?.replace(/\/+$/, '')

  return (
    <form className="lf" onSubmit={submit}>
      <header className="lf-head">
        <span className="set-tile" style={{ ['--hue' as string]: 'var(--orange)' }}>
          <BranchGlyph />
        </span>
        <div>
          <h2>Link a code host</h2>
          <p className="muted">A Gitea or Forgejo instance, for Spotlight's code search and the Code inbox.</p>
        </div>
      </header>
      <div className="set-group lf-fields">
        <label className="set-field">
          <span>Instance URL</span>
          <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="git.example.com" required spellCheck={false} autoComplete="off" autoFocus />
        </label>
        <label className="set-field">
          <span>Name</span>
          <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="optional, e.g. Work" spellCheck={false} autoComplete="off" />
        </label>
        <label className="set-field">
          <span>Access token</span>
          <input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder="personal access token" required autoComplete="off" />
        </label>
      </div>
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
      <footer className="lf-foot">
        <button type="button" className="btn" onClick={() => wm.close(win.pid)}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Checking…' : 'Link instance'}
        </button>
      </footer>
    </form>
  )
}

export function BranchGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 7v10M18 10c0 4-6 3-12 7" />
    </svg>
  )
}
