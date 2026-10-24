import { useEffect, useState, useSyncExternalStore } from 'react'
import { libraryName, mkdir, parseSf, sfPath, useDir, useLibraries } from '../data/seafile'
import { browserFilesState, listBrowser, mkdirBrowser, useBrowserFiles } from '../data/browserfs'
import { browserMountPoint } from '../data/mounts'
import { Select } from './Select'

// Choosing a Seafile folder, in the desktop's own dialog: a library, then into its folders,
// then "Use this folder". For the places in Files (where Desktop or Documents really is) and
// anything else that needs a folder.
//
//   const path = await pickFolder({ title: 'Folder for Documents', start: current })
//   const paths = await pickFiles({ title: 'Attach files' })     // files instead, several at once
//   const path = await pickFolder({ title: 'Folder with photos', any: true })  // read-only libraries too
//   const path = await pickFolder({ title: 'Save to', local: true })  // "This browser" as a choice too
//
// With `local`, the files kept in this browser (data/browserfs.ts) are one more choice next to the
// libraries, when that store is open; the path that comes back is then the folder's place in the
// filesystem (~/Pictures, or /mnt/browser/… when Seafile is home), which uploadFiles takes as is.

type Request = { title: string; start?: string | null; files?: boolean; any?: boolean; local?: boolean; resolve: (paths: string[] | null) => void }

let current: Request | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function pickFolder(r: { title: string; start?: string | null; any?: boolean; local?: boolean }): Promise<string | null> {
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

/** The library menu's value for the files kept in this browser. */
const BROWSER = 'browser:'
/** Where this browser's files can be written now, or null (signed out, storage blocked or still loading). */
export const writableBrowserFolder = () => (browserFilesState() === 'ready' ? browserMountPoint() : null)

function Picker({ request }: { request: Request }) {
  const { libraries } = useLibraries()
  useBrowserFiles()
  // Folders to save into need a library that can be written; files (and folders) to read can come from any.
  const writable = (libraries ?? []).filter((l) => request.files || request.any || l.permission === 'rw')
  const local = request.local && !request.files ? writableBrowserFolder() : null
  const [chosen, setChosen] = useState<string[]>([])
  const start = request.start ? parseSf(request.start) : null
  const [repo, setRepo] = useState<string | null>(start?.repo ?? null)
  const [dir, setDir] = useState(start?.p ?? '/')
  const lib = repo ?? writable[0]?.id ?? (local ? BROWSER : null)
  const inBrowser = lib === BROWSER && !!local
  const here = inBrowser ? (dir === '/' ? local : `${local === '/' ? '' : local}${dir}`) : lib && lib !== BROWSER ? sfPath(lib, dir) : null
  const listing = useDir(inBrowser ? null : here)
  const [error, setError] = useState<string | null>(null)
  const sources = [...writable.map((l) => ({ value: l.id, label: `${l.name}${l.encrypted ? ' 🔒' : ''}` })), ...(local ? [{ value: BROWSER, label: 'This browser' }] : [])]

  useEffect(() => {
    // With the library menu open, Escape only closes that menu (the menu host handles it).
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.ctx-menu') && (e.preventDefault(), close(null))
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const entries = inBrowser ? listBrowser(dir).map((e) => ({ name: e.path.split('/').pop()!, dir: e.dir })) : (listing.listing?.entries ?? [])
  const folders = entries.filter((e) => e.dir && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const parts = dir.split('/').filter(Boolean)
  const into = (name: string) => setDir(`${dir === '/' ? '' : dir}/${name}`)
  const files = request.files ? (listing.listing?.entries ?? []).filter((e) => !e.dir && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) : []
  const toggle = (path: string) => setChosen((c) => (c.includes(path) ? c.filter((p) => p !== path) : [...c, path]))
  const newFolder = () => {
    if (!here) return
    const taken = new Set(folders.map((f) => f.name))
    let name = 'New folder'
    for (let n = 2; taken.has(name); n++) name = `New folder ${n}`
    if (inBrowser) {
      const made = `${dir === '/' ? '' : dir}/${name}`
      mkdirBrowser(made).then(() => setDir(made), (e: Error) => setError(e.message))
      return
    }
    mkdir(`${here}/${name}`)
      .then((made) => setDir(parseSf(made)!.p))
      .catch((e: Error) => setError(e.message))
  }

  return (
    <div className="dlg-modal" onPointerDown={(e) => e.target === e.currentTarget && close(null)}>
      <div className="dlg fp" role="dialog" aria-modal="true" aria-label={request.title}>
        <strong className="dlg-title">{request.title}</strong>
        <div className="fp-bar">
          {sources.length > 1 || !request.local ? <Select
            className="set-select"
            value={lib ?? ''}
            onChange={(id) => {
              setRepo(id)
              setDir('/')
            }}
            aria-label="Library"
            options={sources}
          /> : <span className="fp-source">{sources[0]?.label ?? 'Nowhere to save'}</span>}
          {!request.files && !request.any && (
            <button className="btn btn-small" onClick={newFolder} disabled={!here}>
              New folder
            </button>
          )}
        </div>
        <div className="fp-crumbs">
          <button onClick={() => setDir('/')}>{inBrowser ? 'This browser' : lib ? libraryName(lib) : '…'}</button>
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
          {!inBrowser && listing.status === 423 && <li className="muted fp-note">This library is locked: unlock it in Files first.</li>}
          {!inBrowser && listing.loading && !listing.listing && <li className="muted fp-note">Loading…</li>}
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
          {(inBrowser || listing.listing) && !folders.length && !files.length && <li className="muted fp-note">{request.files ? 'Nothing in here.' : 'No folders in here.'}</li>}
        </ul>
        {error && <p className="t-red copyable">{error}</p>}
        <div className="dlg-actions">
          <button className="btn btn-small" onClick={() => close(null)}>
            Cancel
          </button>
          {request.files ? (
            <button className="btn btn-small btn-primary" disabled={!chosen.length} onClick={() => close(chosen)}>
              {chosen.length > 1 ? `Attach ${chosen.length} files` : 'Attach'}
            </button>
          ) : (
            <button className="btn btn-small btn-primary" disabled={!here || (!inBrowser && listing.status === 423)} onClick={() => here && close([here])}>
              Use {parts.length ? `“${parts[parts.length - 1]}”` : inBrowser ? 'this browser' : 'the library'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
