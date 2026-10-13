import { useEffect, useState, type FormEvent } from 'react'
import { addAccount, defaultBook, listAccounts, removeAccount, useContacts, type CarddavInfo, type ReusableLogin } from '../../data/contacts'
import { signIn, useAccount } from '../../os/account'
import { ask } from '../../os/Dialogs'
import { Select } from '../../os/Select'
import { IntegrationNotice } from '../../os/IntegrationNotice'
import { useWM } from '../../os/wm'
import { SecretInput } from '../../os/SecretInput'

// Settings for Contacts. The accounts are linked in Settings → Integrations → Contacts
// (ContactsAccounts): CardDAV (Fastmail, iCloud, Nextcloud, Radicale or any other), and a CalDAV
// login to use for contacts too. The app's own setting, the address book new contacts go in, is in
// Settings → Apps → Contacts (ContactsSettings), under a pointer to the accounts. The address book
// on this site is always there, for whoever has no CardDAV server.

type Provider = 'fastmail' | 'icloud' | 'nextcloud' | 'other'
const PROVIDERS: { id: Provider; label: string; url?: string; placeholder?: string }[] = [
  { id: 'fastmail', label: 'Fastmail', url: 'https://carddav.fastmail.com/dav/' },
  { id: 'icloud', label: 'iCloud', url: 'https://contacts.icloud.com/' },
  { id: 'nextcloud', label: 'Nextcloud', placeholder: 'https://cloud.example.com/remote.php/dav/' },
  { id: 'other', label: 'Other', placeholder: 'https://dav.example.com/' },
]

/** Settings → Apps → Contacts: where new contacts go; the accounts are in Integrations. */
export function ContactsSettings() {
  const account = useAccount()
  const { books } = useContacts()
  const choice = defaultBook.use()
  if (account.status !== 'user') return <SignInFirst />
  const writable = books.filter((b) => b.writable)
  return (
    <>
      <IntegrationNotice sub="contacts" linked={books.some((b) => b.account !== undefined)} app="Contacts" invite="Link a CardDAV account (Fastmail, iCloud, Nextcloud…) to bring its address books here." />
      {writable.length > 1 ? (
        <>
          <h4 className="set-subhead">New contacts</h4>
          <div className="set-row">
            <span className="set-row-text">
              <strong>Add new contacts to</strong>
              <span className="muted">From the Contacts app's + New, and "Add to contacts" in other apps</span>
            </span>
            <Select value={writable.some((b) => b.id === choice) ? choice : 'local'} options={writable.map((b) => ({ value: b.id, label: b.name, note: b.id === 'local' ? undefined : b.source }))} onChange={(v) => defaultBook.set(v)} aria-label="Address book for new contacts" />
          </div>
        </>
      ) : (
        <p className="muted set-help">New contacts are kept on this site. With a second address book that can be changed, you pick here which one they go in.</p>
      )}
    </>
  )
}

const SignInFirst = () => {
  const account = useAccount()
  return (
    <div className="set-empty">
      <p className="muted">Sign in first to keep contacts.</p>
      {account.status === 'anon' && (
        <button className="btn btn-primary" onClick={signIn}>
          Sign in with GitHub
        </button>
      )}
    </div>
  )
}

/** Settings → Integrations → Contacts: the CardDAV accounts. */
export function ContactsAccounts() {
  const account = useAccount()
  const wm = useWM()
  const { books, errors } = useContacts()
  const [data, setData] = useState<{ accounts: CarddavInfo[]; reusable: ReusableLogin[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const reload = () => listAccounts().then(setData, (e: Error) => setError(e.message))
  useEffect(() => {
    if (account.status === 'user') void reload()
  }, [account.status])

  if (account.status !== 'user') return <SignInFirst />

  const reuse = async (r: ReusableLogin) => {
    setBusy(r.caldav)
    setError(null)
    try {
      await addAccount({ caldav: r.caldav, label: r.label })
      await reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const remove = async (a: CarddavInfo) => {
    if (!(await ask({ title: `Remove ${a.label}?`, body: 'Its contacts stay on the server; they just no longer show here.', confirm: 'Remove', danger: true }))) return
    await removeAccount(a.id).catch((e: Error) => setError(e.message))
    await reload()
  }

  return (
    <>
      <h4 className="set-subhead">Address books</h4>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-glyph">👥</span>
          <span className="set-row-text">
            <strong>On this site</strong>
            <span className="muted">Kept in this server's database, for your account only</span>
          </span>
        </li>
        {data?.accounts.map((a) => (
          <li key={a.id} className="set-row">
            <span className="set-glyph">📇</span>
            <span className="set-row-text">
              <strong>{a.label}</strong>
              <span className="muted">
                {a.username} · {a.url.replace(/^https?:\/\//, '')}
                {books.some((b) => b.account === a.id) && ` · ${books.filter((b) => b.account === a.id).map((b) => b.name).join(', ')}`}
              </span>
            </span>
            <button className="btn btn-small" onClick={() => void remove(a)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {data && data.reusable.length > 0 && (
        <>
          <p className="muted set-help">Your calendar account can bring its contacts too, with the same login:</p>
          <div className="set-actions">
            {data.reusable.map((r) => (
              <button key={r.caldav} className="btn btn-small" disabled={busy !== null} onClick={() => void reuse(r)} title={`${r.username} · ${r.url}`}>
                {busy === r.caldav ? 'Finding your address books…' : `Use your ${r.label} login (${r.username})`}
              </button>
            ))}
          </div>
        </>
      )}
      <CarddavForm onAdded={() => void reload()} />
      {(error || errors.length > 0) && <p className="t-red copyable">{[error, ...errors].filter(Boolean).join(' · ')}</p>}

      <div className="set-actions">
        <button className="btn btn-small" onClick={() => wm.open('contacts', { t: String(Date.now()) })}>
          Open Contacts
        </button>
      </div>
    </>
  )
}

/** Adding a CardDAV account: Fastmail by default. */
function CarddavForm({ onAdded }: { onAdded: () => void }) {
  const [provider, setProvider] = useState<Provider>('fastmail')
  const [form, setForm] = useState({ url: '', username: '', password: '', label: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const p = PROVIDERS.find((x) => x.id === provider)!
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await addAccount({ ...form, url: p.url ?? form.url, label: form.label || (p.url ? p.label : '') })
      setForm({ url: '', username: '', password: '', label: '' })
      onAdded()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="set-form" onSubmit={submit}>
      {/* Four choices: they wrap in a narrow window. */}
      <div className="set-choices" role="radiogroup" aria-label="CardDAV provider" style={{ flexWrap: 'wrap', maxWidth: '100%' }}>
        {PROVIDERS.map((x) => (
          <label key={x.id} className={`set-choice ${provider === x.id ? 'is-on' : ''}`}>
            <input type="radio" name="carddav-provider" checked={provider === x.id} onChange={() => setProvider(x.id)} />
            {x.label}
          </label>
        ))}
      </div>
      {!p.url && (
        <label>
          <span>Server URL</span>
          <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder={p.placeholder} required spellCheck={false} autoComplete="off" />
        </label>
      )}
      <label>
        <span>Username</span>
        <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder={provider === 'fastmail' ? 'you@fastmail.com' : provider === 'icloud' ? 'Apple ID email' : 'username'} required spellCheck={false} autoComplete="off" />
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
            : access <em>Contacts (CardDAV)</em>, not read-only, to add and change contacts here.
          </>
        ) : provider === 'icloud' ? (
          <>
            Make an app-specific password at{' '}
            <a href="https://account.apple.com/account/manage" target="_blank" rel="noopener noreferrer">
              account.apple.com → Sign-In and Security
            </a>
            .
          </>
        ) : provider === 'nextcloud' ? (
          'Use an app password (Nextcloud → Settings → Security → Devices & sessions). The URL is your Nextcloud address with /remote.php/dav/.'
        ) : (
          'Radicale, Baïkal, SOGo and others: the server URL (or just its address; /.well-known/carddav is tried too) and an app password.'
        )}{' '}
        It is checked by finding your address books, then stored encrypted on this server; adding the same account again replaces its password.
      </p>
      {error && <p className="t-red copyable">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? 'Finding your address books…' : `Add ${p.url ? p.label : 'CardDAV account'}`}
      </button>
    </form>
  )
}
