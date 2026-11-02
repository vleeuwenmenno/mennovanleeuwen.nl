import { useCallback, useEffect, useRef, useState } from 'react'
import { getAccount, subscribeAccount, useAccount } from '../os/account'
import { getStorage, storageSize, type StorageReport } from '../data/accountStorage'
import './StorageUsage.css'

type State = { report: StorageReport | null; loading: boolean; error: string }

/**
 * Settings → Sync: how much of the account's storage is used, as the quota counts it, and by what.
 * Read only: deleting is done where the things are (Agents threads, Image Studio, Video Studio).
 * A request belongs to the account that made it: a sign-out, account switch or newer refresh
 * cancels it, and its answer is dropped if it arrives anyway.
 */
export function StorageUsage() {
  const account = useAccount()
  const uid = account.status === 'user' ? account.user!.id : null
  const [state, setState] = useState<State>({ report: null, loading: false, error: '' })
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const cancel = () => { controller.current?.abort(); controller.current = null; generation.current++ }
  const load = useCallback(() => {
    cancel()
    if (uid === null) return
    const c = new AbortController(), mine = generation.current
    controller.current = c
    setState((s) => ({ ...s, loading: true, error: '' }))
    const current = () => generation.current === mine && !c.signal.aborted && getAccount().user?.id === uid
    getStorage(c.signal).then(
      (report) => { if (current()) setState({ report, loading: false, error: '' }) },
      (e) => { if (current()) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : 'Could not read your storage' })) },
    )
  }, [uid])
  useEffect(() => {
    setState({ report: null, loading: false, error: '' })
    load()
    const forget = () => { cancel(); setState({ report: null, loading: false, error: '' }) }
    const unsubscribe = subscribeAccount(() => { if (getAccount().user?.id !== uid) forget() })
    for (const event of ['mvlos:forget', 'mvlos:account-changed']) window.addEventListener(event, forget)
    return () => { cancel(); unsubscribe(); for (const event of ['mvlos:forget', 'mvlos:account-changed']) window.removeEventListener(event, forget) }
  }, [uid, load])
  if (uid === null) return null
  const { report, loading, error } = state
  const fraction = report?.used != null && report.limit > 0 ? Math.min(1, report.used / report.limit) : null
  const parts = report?.parts.filter((p) => p.bytes === null || p.bytes > 0) ?? []
  return (
    <section className="storage" aria-labelledby="storage-title" aria-busy={loading}>
      <div className="storage-head">
        <h3 id="storage-title" className="storage-title">Storage</h3>
        <button type="button" className="btn btn-small" onClick={load} disabled={loading}>{loading && report ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {!report && loading && <p className="muted" role="status">Checking your storage…</p>}
      {error && (
        <p className="storage-error" role="alert">
          {report ? 'Could not refresh: ' : 'Could not read your storage: '}{error}{' '}
          <button type="button" className="btn btn-small" onClick={load}>Retry</button>
        </p>
      )}
      {report && (
        <>
          <p className="storage-total">
            {report.used === null ? <>Used: <strong>unknown</strong> of {storageSize(report.limit)}</> : <><strong>{storageSize(report.used)}</strong> of {storageSize(report.limit)} used{report.remaining !== null && !report.over ? ` · ${storageSize(report.remaining)} left` : ''}</>}
          </p>
          {fraction !== null && (
            <div className={`storage-bar ${report.over ? 'is-over' : fraction > 0.9 ? 'is-high' : ''}`} role="progressbar" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} aria-valuetext={`${storageSize(report.used!)} of ${storageSize(report.limit)}`}>
              <span style={{ width: `${Math.max(fraction * 100, report.used! > 0 ? 1 : 0)}%` }} />
            </div>
          )}
          {report.over && <p className="storage-error">Your storage is full: new things can't be saved until you delete some, such as old Agents threads or generated pictures. Everything you have stays readable.</p>}
          {!report.complete && <p className="muted set-help">Some parts couldn't be measured just now, so the total is unknown. Try Refresh.</p>}
          {report.used === 0 ? (
            <p className="muted">Nothing counted toward your storage limit yet. The server may still keep records the limit leaves out (below).</p>
          ) : (
            <ul className="set-list storage-parts" aria-label="What uses your storage">
              {parts.map((p) => (
                <li key={p.id} className="set-row storage-part">
                  <span className="set-row-text">
                    <strong>{p.label}</strong>
                    <span className="muted storage-purpose">{p.purpose}</span>
                  </span>
                  <span className="storage-size">
                    {p.bytes === null ? 'Unknown' : storageSize(p.bytes)}
                    {p.count !== null && <small className="muted">{p.count.toLocaleString()} {p.unit}</small>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="muted set-help">
        Counted here is what your account keeps in this site's database and its video files, the same way the storage limit counts it (pictures kept as text count at that size). Not counted: files and settings kept only in this browser, your Seafile library (it is on your Seafile server), and server records the limit leaves out, such as sign-ins, linked accounts and the list of your threads.
      </p>
    </section>
  )
}
