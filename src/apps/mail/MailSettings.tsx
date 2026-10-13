import { useState, type FormEvent } from 'react'
import { ask } from '../../os/Dialogs'
import { useWM } from '../../os/wm'
import { linkMailAccount, unlinkMailAccount, useMailAccounts } from '../../data/mail'
import { SecretInput } from '../../os/SecretInput'

// Settings → Integrations → Mail: JMAP accounts for the Mail app. A session URL (Fastmail's when
// left empty; a host is looked up at /.well-known/jmap) and an API token, checked by the server
// and stored there encrypted: the token never comes back to the browser.

const host = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function MailSettings() {
  const { accounts, error: listError } = useMailAccounts()
  const wm = useWM()
  const [form, setForm] = useState({ url: '', token: '', label: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await linkMailAccount({ url: form.url.trim() || undefined, token: form.token.trim(), label: form.label.trim() || undefined })
      setForm({ url: '', token: '', label: '' })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async (id: number, label: string) => {
    if (!(await ask({ title: `Unlink ${label}?`, body: 'Mail stops showing it here. Nothing is deleted on the mail server, and its token is forgotten.', confirm: 'Unlink', danger: true }))) return
    unlinkMailAccount(id).catch((e: Error) => setError(e.message))
  }
  return (
    <>
      {accounts && accounts.length > 0 && (
        <>
          <ul className="set-list">
            {accounts.map((a) => (
              <li key={a.id} className="set-row">
                <span className="set-glyph">✉</span>
                <span className="set-row-text">
                  <strong>{a.label}</strong>
                  <span className="muted">
                    {a.username} · {host(a.url)}
                  </span>
                </span>
                <button className="btn btn-small" onClick={() => void remove(a.id, a.label)}>
                  Unlink
                </button>
              </li>
            ))}
          </ul>
          <div className="set-actions">
            <button className="btn btn-small btn-primary" onClick={() => wm.open('mail')}>
              Open Mail
            </button>
          </div>
          <h4 className="set-subhead">Add another account</h4>
        </>
      )}
      <form className="set-form" onSubmit={save}>
        <label>
          <span>Server</span>
          <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="Fastmail (api.fastmail.com), or your JMAP server" autoComplete="off" spellCheck={false} />
        </label>
        <label>
          <span>API token</span>
          <SecretInput value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder="API token" required />
        </label>
        <label>
          <span>Name</span>
          <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Fastmail" autoComplete="off" />
        </label>
        <p className="muted set-help">
          For Fastmail, leave the server empty and make a token at{' '}
          <a href="https://app.fastmail.com/settings/security/tokens" target="_blank" rel="noopener noreferrer">
            Settings → Privacy &amp; Security → Manage API tokens
          </a>{' '}
          with access to <em>Mail</em> and <em>Submission</em> (sending). Other JMAP servers (Stalwart and the like): their address, which is looked up at
          /.well-known/jmap. The token is checked once, then stored encrypted on this server and only used from here. IMAP and SMTP are not supported.
        </p>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Checking…' : 'Link mail account'}
        </button>
      </form>
      {(error || listError) && <p className="t-red copyable">{error ?? listError}</p>}
    </>
  )
}
