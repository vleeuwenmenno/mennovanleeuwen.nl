import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { adminStats, adminUsers, banUser, deleteUser, setAdminSettings, signOutUser, unbanUser, type AdminStats, type AdminUser } from '../data/admin'
import { fileSize } from '../data/agents'
import { timeAgo } from '../data/recents'
import { useAccount } from '../os/account'
import { ask } from '../os/Dialogs'

// Settings → Users, only for admins (ADMIN_USERS on the server, which checks every request
// itself): sign-up open or closed and the cap, then every account, searchable, with what it
// links and how much it stores. Never what it stores.

const ago = (t: number | null) => (t ? timeAgo(new Date(t).toISOString()) : 'never')

function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`set-toggle ${on ? 'is-on' : ''}`} onClick={() => onChange(!on)} />
}

function Avatar({ u }: { u: AdminUser }) {
  return u.avatar ? <img className="usr-avatar" src={u.avatar} alt="" /> : <span className="usr-avatar is-blank">{u.login[0].toUpperCase()}</span>
}

export function UsersSettings() {
  const account = useAccount()
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [cap, setCap] = useState('')
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [open, setOpen] = useState<AdminUser | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (q: string, cursor: string | null = null) => {
    try {
      const page = await adminUsers(q, cursor)
      setUsers((u) => (cursor ? [...(u ?? []), ...page.users] : page.users))
      setNext(page.next)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const refreshStats = useCallback(() => {
    adminStats().then((s) => {
      setStats(s)
      setCap(String(s.max))
    }, (e: Error) => setError(e.message))
  }, [])

  useEffect(refreshStats, [refreshStats])
  // Searching as you type, a moment after the last key.
  useEffect(() => {
    const t = setTimeout(() => void load(query), query ? 250 : 0)
    return () => clearTimeout(t)
  }, [query, load])

  if (!account.user?.admin) return <p className="muted">Only admins see the accounts.</p>

  const save = (body: Parameters<typeof setAdminSettings>[0]) =>
    setAdminSettings(body).then((s) => {
      setStats(s)
      setCap(String(s.max))
    }, (e: Error) => setError(e.message))

  const changed = (u: AdminUser | null, id: number) => {
    setUsers((list) => (u ? list?.map((x) => (x.id === id ? u : x)) : list?.filter((x) => x.id !== id)) ?? null)
    setOpen(u)
    refreshStats()
  }

  if (open) return <UserDetail u={open} onBack={() => setOpen(null)} onChange={(u) => changed(u, open.id)} />

  const submitCap = (e: FormEvent) => {
    e.preventDefault()
    void save({ maxUsers: Number(cap) })
  }

  return (
    <>
      <section className="set-section">
        <h4>Sign-up</h4>
        <ul className="set-list">
          <li className="set-row">
            <span className="set-row-text">
              <strong>Open for new accounts</strong>
              <span className="muted">{stats ? (stats.open ? (stats.count >= stats.max ? "Open, but full: newcomers see \"We're full\"" : 'Any GitHub account can sign up') : 'Closed: only existing accounts sign in') : '…'}</span>
            </span>
            {stats && <Toggle on={stats.open} onChange={(on) => void save({ registration: on ? 'open' : 'closed' })} label="Open for new accounts" />}
          </li>
          <li className="set-row">
            <span className="set-row-text">
              <strong>Accounts</strong>
              <span className="muted">{stats ? `${stats.count} of ${stats.max} used${stats.banned ? ` · ${stats.banned} banned (they keep their spot)` : ''}` : '…'}</span>
            </span>
            <form className="set-form set-form-row usr-cap" onSubmit={submitCap}>
              <input type="number" min={0} value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Most accounts" />
              <button className="btn btn-small" disabled={!stats || cap === String(stats.max)}>
                Set
              </button>
            </form>
          </li>
        </ul>
      </section>

      <section className="set-section">
        <h4>Accounts</h4>
        <input className="set-search usr-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by login or name" aria-label="Search accounts" />
        {error && <p className="t-red copyable">{error}</p>}
        {users === null ? (
          <p className="muted">Loading…</p>
        ) : users.length === 0 ? (
          <p className="muted">{query ? 'Nobody matches.' : 'No accounts yet.'}</p>
        ) : (
          <ul className="set-list">
            {users.map((u) => (
              <li key={u.id} className="set-row set-row-link">
                <button onClick={() => setOpen(u)} aria-label={`${u.login}: details`}>
                  <Avatar u={u} />
                  <span className="set-row-text">
                    <strong>
                      {u.name ?? u.login}
                      {u.admin && <span className="set-badge">Admin</span>}
                      {u.banned && <span className="set-badge usr-banned">Banned</span>}
                    </strong>
                    <span className="muted">
                      @{u.login} · seen {ago(u.lastSeenAt)} · {fileSize(u.storageBytes)}
                      {u.services.length ? ` · ${[...new Set(u.services)].join(', ')}` : ''}
                    </span>
                  </span>
                  <span className="set-chevron" aria-hidden>
                    ›
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {next && (
          <button className="btn btn-small" onClick={() => void load(query, next)}>
            Show more
          </button>
        )}
      </section>
      <p className="muted set-help">Admins see who has an account and how much it stores, never the notes, threads, memories or files in it. Admins themselves are set with ADMIN_USERS on the server.</p>
    </>
  )
}

function UserDetail({ u, onBack, onChange }: { u: AdminUser; onBack: () => void; onChange: (u: AdminUser | null) => void }) {
  const [reason, setReason] = useState('')
  const [banning, setBanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (job: () => Promise<AdminUser | null>) => {
    setBusy(true)
    setError(null)
    try {
      onChange(await job())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const counts = u.services.reduce<Record<string, number>>((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {})
  const linked = Object.entries(counts).map(([s, n]) => (n > 1 ? `${s} ×${n}` : s))

  const ban = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const ok = await ask({ title: `Ban @${u.login}?`, body: 'They are signed out everywhere and can no longer sign in. Their data stays, and so does their spot under the cap, until you delete the account.', confirm: 'Ban', danger: true })
      return ok ? banUser(u.id, reason) : u
    })
  }
  const remove = () =>
    void run(async () => {
      const ok = await ask({ title: `Delete @${u.login}?`, body: 'Their notes, layouts, Agents threads, memories and linked services are deleted for good, and their tokens revoked. They could sign up again later while there is room.', confirm: 'Delete account', danger: true })
      if (!ok) return u
      await deleteUser(u.id)
      return null
    })

  return (
    <>
      <button className="set-up" onClick={onBack}>
        ‹ Users
      </button>
      <div className="set-detail-head">
        <Avatar u={u} />
        <strong>{u.name ?? u.login}</strong>
        {u.admin && <span className="set-badge">Admin</span>}
        {u.banned && <span className="set-badge usr-banned">Banned</span>}
      </div>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>GitHub</strong>
            <a className="muted" href={`https://github.com/${u.login}`} target="_blank" rel="noopener noreferrer">
              @{u.login}
            </a>
          </span>
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Joined</strong>
            <span className="muted">
              {new Date(u.joinedAt).toLocaleDateString()} · last seen {ago(u.lastSeenAt)}
            </span>
          </span>
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Stores</strong>
            <span className="muted">
              {fileSize(u.storageBytes)} · {u.threads} Agents {u.threads === 1 ? 'thread' : 'threads'}
            </span>
          </span>
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Linked</strong>
            <span className="muted">{linked.length ? linked.join(', ') : 'Nothing besides GitHub'}</span>
          </span>
        </li>
        {u.banned && (
          <li className="set-row">
            <span className="set-row-text">
              <strong>Banned</strong>
              <span className="muted">
                {ago(u.banned.at)}
                {u.banned.reason ? ` · ${u.banned.reason}` : ''}
              </span>
            </span>
          </li>
        )}
      </ul>

      {u.admin ? (
        <p className="muted set-help">Admins are managed with ADMIN_USERS on the server, not here.</p>
      ) : (
        <ul className="set-list">
          <li className="set-row">
            <span className="set-row-text">
              <strong>Sign out everywhere</strong>
              <span className="muted">Ends their sessions on every device; they can sign in again.</span>
            </span>
            <button className="btn btn-small" disabled={busy} onClick={() => void run(() => signOutUser(u.id))}>
              Sign out
            </button>
          </li>
          {u.banned ? (
            <li className="set-row">
              <span className="set-row-text">
                <strong>Unban</strong>
                <span className="muted">Lets them sign in again.</span>
              </span>
              <button className="btn btn-small" disabled={busy} onClick={() => void run(() => unbanUser(u.id))}>
                Unban
              </button>
            </li>
          ) : banning ? (
            <li className="set-row">
              <form className="set-form set-form-row usr-ban" onSubmit={ban}>
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Reason (they see it when signing in)" aria-label="Reason" autoFocus />
                <button className="btn btn-small btn-danger" disabled={busy}>
                  Ban
                </button>
                <button type="button" className="btn btn-small" onClick={() => setBanning(false)}>
                  Cancel
                </button>
              </form>
            </li>
          ) : (
            <li className="set-row">
              <span className="set-row-text">
                <strong>Ban</strong>
                <span className="muted">Signs them out and keeps them out. Their data stays.</span>
              </span>
              <button className="btn btn-small" disabled={busy} onClick={() => setBanning(true)}>
                Ban…
              </button>
            </li>
          )}
          <li className="set-row">
            <span className="set-row-text">
              <strong>Delete account</strong>
              <span className="muted">Everything they stored goes, for good.</span>
            </span>
            <button className="btn btn-small btn-danger" disabled={busy} onClick={remove}>
              Delete…
            </button>
          </li>
        </ul>
      )}
      {error && <p className="t-red copyable">{error}</p>}
    </>
  )
}
