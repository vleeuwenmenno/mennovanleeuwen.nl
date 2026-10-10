import { useEffect, useState, useSyncExternalStore } from 'react'
import { libraryName, mkdir, parseSf, sfPath, useDir, useLibraries } from '../data/seafile'
import { Select } from './Select'

// Choosing a Seafile folder, in the desktop's own dialog: a library, then into its folders,
// then "Use this folder". For the places in Files (where Desktop or Documents really is) and
// anything else that needs a folder.
//
//   const path = await pickFolder({ title: 'Folder for Documents', start: current })
//   const paths = await pickFiles({ title: 'Attach files' })     // files instead, several at once

type Request = { title: string; start?: string | null; files?: boolean; resolve: (paths: string[] | null) => void }

let current: Request | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function pickFolder(r: { title: string; start?: string | null }): Promise<string | null> {
  return new Promise((resolve) => {
    current?.resolve(null)
    current = { ...r, resolve: (paths) => resolve(paths?.[0] ?? null) }
    emit()
  })
}

/** Files from any library (read-only ones too), several at once: their Seafile paths. */
export function pickFiles(r: { title: string; start?: string | null }): Promise<string[] | null> {
  return new Promise((resolve) => {
    current?.resolve(null)
    current = { ...r, files: true, resolve }
    emit()
  })
}

function close(paths: string[] | null) {
  const r = current
  current = null
  emit()
  r?.resolve(paths)
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
  // Folders to save into need a library that can be written; files to read can come from any.
  const writable = (libraries ?? []).filter((l) => request.files || l.permission === 'rw')
  const [chosen, setChosen] = useState<string[]>([])
  const start = request.start ? parseSf(request.start) : null
  const [repo, setRepo] = useState<string | null>(start?.repo ?? null)
  const [dir, setDir] = useState(start?.p ?? '/')
  const lib = repo ?? writable[0]?.id ?? null
  const here = lib ? sfPath(lib, dir) : null
  const listing = useDir(here)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // With the library menu open, Escape only closes that menu (the menu host handles it).
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.ctx-menu') && (e.preventDefault(), close(null))
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const folders = (listing.listing?.entries ?? []).filter((e) => e.dir && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const parts = dir.split('/').filter(Boolean)
  const into = (name: string) => setDir(`${dir === '/' ? '' : dir}/${name}`)
  const files = request.files ? (listing.listing?.entries ?? []).filter((e) => !e.dir && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) : []
  const toggle = (path: string) => setChosen((c) => (c.includes(path) ? c.filter((p) => p !== path) : [...c, path]))
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
          <Select
            className="set-select"
            value={lib ?? ''}
            onChange={(id) => {
              setRepo(id)
              setDir('/')
            }}
            aria-label="Library"
            options={writable.map((l) => ({ value: l.id, label: `${l.name}${l.encrypted ? ' 🔒' : ''}` }))}
          />
          {!request.files && (
            <button className="btn btn-small" onClick={newFolder} disabled={!here}>
              New folder
            </button>
          )}
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
          {files.map((f) => {
            const path = `${here}/${f.name}`
            return (
              <li key={f.name}>
                <button className={chosen.includes(path) ? 'is-chosen' : ''} onClick={() => toggle(path)} onDoubleClick={() => close([path])} aria-pressed={chosen.includes(path)}>
                  {chosen.includes(path) ? '☑' : '☐'} {f.name}
                </button>
              </li>
            )
          })}
          {listing.listing && !folders.length && !files.length && <li className="muted fp-note">{request.files ? 'Nothing in here.' : 'No folders in here.'}</li>}
        </ul>
        {error && <p className="t-red">{error}</p>}
        <div className="dlg-actions">
          <button className="btn btn-small" onClick={() => close(null)}>
            Cancel
          </button>
          {request.files ? (
            <button className="btn btn-small btn-primary" disabled={!chosen.length} onClick={() => close(chosen)}>
              {chosen.length > 1 ? `Attach ${chosen.length} files` : 'Attach'}
            </button>
          ) : (
            <button className="btn btn-small btn-primary" disabled={!here || listing.status === 423} onClick={() => here && close([here])}>
              Use {parts.length ? `“${parts[parts.length - 1]}”` : 'the library'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
