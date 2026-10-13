import { useEffect, useState, type FormEvent } from 'react'
import { useAccount } from '../../os/account'
import { ask } from '../../os/Dialogs'
import { pickFolder } from '../../os/FolderPicker'
import { useWM } from '../../os/wm'
import { libraryName, parseSf } from '../../data/seafile'
import { linkImmich, loadStatus, rescan, setSources, suggestFolders, unlinkImmich, useStatus, type Job } from '../../data/photos'
import { SecretInput } from '../../os/SecretInput'
import { IntegrationNotice } from '../../os/IntegrationNotice'

// Where Photos finds photos: Seafile folders (any library; folders named like photo folders are
// suggested), and whether an Immich server is linked. Shown in the app; the Seafile and Immich
// accounts themselves are linked in Settings → Integrations (ImmichLink is its Immich pane).

export function PhotosSettings() {
  const account = useAccount()
  const wm = useWM()
  const { status } = useStatus()
  const [suggestions, setSuggestions] = useState<{ repo: string; path: string; library: string; name: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sources = status?.seafile?.sources ?? []
  const linked = account.status === 'user' && !!account.seafile
  // Fresh when opened: folders, locks and the last walk may have changed elsewhere.
  useEffect(() => void loadStatus(), [])

  useEffect(() => {
    if (!linked) return
    suggestFolders().then(setSuggestions, () => setSuggestions([]))
  }, [linked, sources.length])

  const save = (next: { repo: string; path: string }[]) => setSources(next).catch((e: Error) => setError(e.message))
  const add = async () => {
    const path = await pickFolder({ title: 'Folder with photos', any: true })
    const at = path ? parseSf(path) : null
    if (at) void save([...sources, { repo: at.repo, path: at.p }])
  }
  const remove = async (repo: string, path: string, name: string) => {
    if (!(await ask({ title: `Stop showing “${name}”?`, body: 'Its photos leave the timeline. Nothing is deleted from Seafile.', confirm: 'Remove' }))) return
    void save(sources.filter((s) => s.repo !== repo || s.path !== path))
  }

  return (
    <div className="ph-settings">
      <section>
        <h2>Seafile</h2>
        {!linked ? (
          <>
            <p className="muted">Link Seafile to show the photos in its folders.</p>
            <button className="btn btn-small btn-primary" onClick={() => wm.open('settings', { section: 'integrations', sub: 'seafile', t: String(Date.now()) })}>
              Link Seafile…
            </button>
          </>
        ) : (
          <>
            <p className="muted">
              The folders to show, with everything in their subfolders. The server reads each photo's EXIF (when it was taken, the camera, the place) once, from the first 128 KB of the file, and again only when the file changes. Encrypted libraries are read only while
              they are unlocked.
            </p>
            {sources.length > 0 && (
              <ul className="set-list">
                {sources.map((s) => (
                  <li key={s.repo + s.path} className="set-row">
                    <span className="set-row-text">
                      <strong>
                        {s.name}
                        {s.encrypted ? ' 🔒' : ''}
                      </strong>
                      <span className="muted">
                        {s.library ?? libraryName(s.repo)}
                        {s.path === '/' ? '' : s.path} · {s.locked ? 'locked: unlock it in Files to see its photos' : `${s.count.toLocaleString()} ${s.count === 1 ? 'photo or video' : 'photos and videos'}`}
                      </span>
                    </span>
                    <button className="btn btn-small" onClick={() => void remove(s.repo, s.path, s.name)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="set-actions">
              <button className="btn btn-small btn-primary" onClick={() => void add()}>
                Add a folder…
              </button>
              {sources.length > 0 && (
                <button className="btn btn-small" onClick={() => rescan().catch((e: Error) => setError(e.message))} disabled={!!status?.seafile?.job && !status.seafile.job.finished}>
                  Look for new photos
                </button>
              )}
            </div>
            <JobStatus job={status?.seafile?.job ?? null} scannedAt={status?.seafile?.scannedAt ?? null} />
            {!!suggestions?.length && (
              <>
                <h3>Suggested</h3>
                <ul className="set-list">
                  {suggestions.map((s) => (
                    <li key={s.repo + s.path} className="set-row">
                      <span className="set-row-text">
                        <strong>{s.name}</strong>
                        <span className="muted">
                          {s.library}
                          {s.path === '/' ? '' : s.path}
                        </span>
                      </span>
                      <button className="btn btn-small" onClick={() => void save([...sources, { repo: s.repo, path: s.path }])}>
                        Add
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {error && <p className="t-red copyable">{error}</p>}
          </>
        )}
      </section>
      <section>
        <h2>Immich</h2>
        <IntegrationNotice sub="immich" linked={!!status?.immich} app="Photos" invite="Link an Immich server to show its photos." />
        {status?.immich && <p className="muted">{`${status.immich.url.replace(/^https?:\/\//, '')} · Immich ${status.immich.version}`}</p>}
      </section>
    </div>
  )
}

/** How the walk of the Seafile folders goes, or when it last went. */
export function JobStatus({ job, scannedAt }: { job: Job | null; scannedAt: number | null }) {
  if (job && !job.finished) {
    const text = job.state === 'waiting' ? 'Waiting for another account’s walk to finish…' : job.state === 'listing' ? `Looking through folders: ${job.folders.toLocaleString()} folders, ${job.files.toLocaleString()} photos and videos so far` : `Reading new photos: ${job.read.toLocaleString()} of ${job.toRead.toLocaleString()}`
    return (
      <div className="ph-job">
        <span>{text}</span>
        {job.state === 'reading' && job.toRead > 0 && <progress max={job.toRead} value={job.read} />}
      </div>
    )
  }
  return (
    <div className="ph-job muted">
      {job && job.state === 'failed' && <p className="t-red copyable">The last look failed: {job.errors[0]}</p>}
      {job && job.capped && <p>Not everything fits: the index stops at 100,000 photos and 20,000 folders.</p>}
      {job?.skipped.map((s) => (
        <p key={s.repo}>
          {s.library}: {s.why}
        </p>
      ))}
      {job && job.state === 'done' && job.errors.length > 0 && <p>Some folders could not be read: {job.errors.slice(0, 3).join('; ')}</p>}
      {scannedAt ? <p>Last looked {new Date(scannedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}{job?.state === 'done' && (job.added || job.removed) ? `: ${job.added.toLocaleString()} new, ${job.removed.toLocaleString()} gone` : ''}.</p> : null}
    </div>
  )
}

/** Links an Immich server with an API key (stored encrypted on the server, never sent back). */
export function ImmichLink() {
  const { status } = useStatus()
  const immich = status?.immich ?? null
  const [form, setForm] = useState({ url: '', key: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await linkImmich(form.url, form.key)
      setForm({ url: '', key: '' })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (immich)
    return (
      <>
        <ul className="set-list">
          <li className="set-row">
            <span className="set-row-text">
              <strong>{immich.name || immich.email || 'Immich'}</strong>
              <span className="muted">
                {immich.email ? `${immich.email} · ` : ''}
                {immich.url.replace(/^https?:\/\//, '')} · Immich {immich.version}
              </span>
            </span>
            <button
              className="btn btn-small"
              onClick={async () => {
                if (await ask({ title: 'Unlink Immich?', body: 'Photos stops showing it, and this server forgets the API key. Delete the key in Immich (Account settings → API keys) to revoke it there too.', confirm: 'Unlink' })) unlinkImmich().catch((e: Error) => setError(e.message))
              }}
            >
              Unlink
            </button>
          </li>
        </ul>
        {error && <p className="t-red copyable">{error}</p>}
      </>
    )
  return (
    <form className="set-form" onSubmit={submit}>
      <label>
        <span>Server URL</span>
        <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://photos.example.com" required spellCheck={false} autoComplete="off" />
      </label>
      <label>
        <span>API key</span>
        <SecretInput value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="API key" required />
      </label>
      <p className="muted set-help">
        Make a key in Immich under <em>Account settings → API keys</em>, with <em>All</em> permissions or at least asset.read, asset.view, asset.download, asset.update, album.read, timeline.read and user.read. It is checked once, then stored encrypted on this server and only used
        from here: thumbnails, photos and videos come through this server. Immich 2 and 3 work.
      </p>
      {error && <p className="t-red copyable">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? 'Checking…' : 'Link Immich'}
      </button>
    </form>
  )
}
