import { useEffect, useState, useSyncExternalStore } from 'react'
import { libraryName, mkdir, parseSf, sfPath, useDir, useLibraries } from '../data/seafile'

// Choosing a Seafile folder, in the desktop's own dialog: a library, then into its folders,
// then "Use this folder". For the places in Files (where Desktop or Documents really is) and
// anything else that needs a folder.
//
//   const path = await pickFolder({ title: 'Folder for Documents', start: current })

type Request = { title: string; start?: string | null; resolve: (path: string | null) => void }

let current: Request | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function pickFolder(r: { title: string; start?: string | null }): Promise<string | null> {
  return new Promise((resolve) => {
    current?.resolve(null)
    current = { ...r, resolve }
    emit()
  })
}

function close(path: string | null) {
  const r = current
  current = null
  emit()
  r?.resolve(path)
}

export function FolderPicker() {
  const request = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
  return request ? <Picker key={request.title + (request.start ?? '')} request={request} /> : null
}

function Picker({ request }: { request: Request }) {
  const { libraries } = useLibraries()
  const writable = (libraries ?? []).filter((l) => l.permission === 'rw')
  const start = request.start ? parseSf(request.start) : null
  const [repo, setRepo] = useState<string | null>(start?.repo ?? null)
  const [dir, setDir] = useState(start?.p ?? '/')
  const lib = repo ?? writable[0]?.id ?? null
  const here = lib ? sfPath(lib, dir) : null
  const listing = useDir(here)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), close(null))
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const folders = (listing.listing?.entries ?? []).filter((e) => e.dir && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const parts = dir.split('/').filter(Boolean)
  const into = (name: string) => setDir(`${dir === '/' ? '' : dir}/${name}`)
  const newFolder = () => {
    if (!here) return
    const taken = new Set(folders.map((f) => f.name))
    let name = 'New folder'
    for (let n = 2; taken.has(name); n++) name = `New folder ${n}`
    mkdir(`${here}/${name}`)
      .then((made) => setDir(parseSf(made)!.p))
      .catch((e: Error) => setError(e.message))
  }

  return (
    <div className="dlg-modal" onPointerDown={(e) => e.target === e.currentTarget && close(null)}>
      <div className="dlg fp" role="dialog" aria-modal="true" aria-label={request.title}>
        <strong className="dlg-title">{request.title}</strong>
        <div className="fp-bar">
          <select
            className="set-select"
            value={lib ?? ''}
            onChange={(e) => {
              setRepo(e.target.value)
              setDir('/')
            }}
            aria-label="Library"
          >
            {writable.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.encrypted ? ' 🔒' : ''}
              </option>
            ))}
          </select>
          <button className="btn btn-small" onClick={newFolder} disabled={!here}>
            New folder
          </button>
        </div>
        <div className="fp-crumbs">
          <button onClick={() => setDir('/')}>{lib ? libraryName(lib) : '…'}</button>
          {parts.map((p, i) => (
            <span key={i}>
              {' › '}
              <button onClick={() => setDir('/' + parts.slice(0, i + 1).join('/'))}>{p}</button>
            </span>
          ))}
        </div>
        <ul className="fp-list">
          {dir !== '/' && (
            <li>
              <button onClick={() => setDir('/' + parts.slice(0, -1).join('/'))}>⤴ Up</button>
            </li>
          )}
          {listing.status === 423 && <li className="muted fp-note">This library is locked: unlock it in Files first.</li>}
          {listing.loading && !listing.listing && <li className="muted fp-note">Loading…</li>}
          {folders.map((f) => (
            <li key={f.name}>
              <button onDoubleClick={() => into(f.name)} onClick={() => into(f.name)}>
                📁 {f.name}
              </button>
            </li>
          ))}
          {listing.listing && !folders.length && <li className="muted fp-note">No folders in here.</li>}
        </ul>
        {error && <p className="t-red">{error}</p>}
        <div className="dlg-actions">
          <button className="btn btn-small" onClick={() => close(null)}>
            Cancel
          </button>
          <button className="btn btn-small btn-primary" disabled={!here || listing.status === 423} onClick={() => close(here)}>
            Use {parts.length ? `“${parts[parts.length - 1]}”` : 'the library'}
          </button>
        </div>
      </div>
    </div>
  )
}
