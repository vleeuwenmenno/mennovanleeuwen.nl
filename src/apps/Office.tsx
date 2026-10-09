import { useEffect, useRef, useState } from 'react'
import { api, useAccount } from '../os/account'
import { createFile, download, isSf, libraryName, parseSf, sfPath, useSeafileHome, useSeafilePrefs } from '../data/seafile'
import { folderOf, nameOf } from '../data/media'
import { THEMES } from '../os/omarchyThemes'
import { resolvedThemeName } from '../os/theme'
import { useWM, type AppId, type WinState } from '../os/wm'

// Office: OnlyOffice's editor (the document server Seafile uses) in a window, for Word, Excel
// and PowerPoint files (and their OpenDocument cousins) in Seafile. The server signs the editor's
// settings and takes the saves (server/office.ts); OnlyOffice saves by itself as you type.
//
// New Document, New Spreadsheet and New Presentation are apps of their own: each opening makes a
// blank file (Seafile's own template) in Documents, then edits it.

export type NewKind = 'docx' | 'xlsx' | 'pptx'
export const NEW_APPS: Record<NewKind, AppId> = { docx: 'newdoc', xlsx: 'newsheet', pptx: 'newslides' }
const UNTITLED: Record<NewKind, string> = { docx: 'Untitled document.docx', xlsx: 'Untitled spreadsheet.xlsx', pptx: 'Untitled presentation.pptx' }

type DocEditor = { destroyEditor: () => void }
declare global {
  interface Window {
    DocsAPI?: { DocEditor: new (id: string, config: Record<string, unknown>) => DocEditor }
  }
}

const scripts = new Map<string, Promise<void>>()
/** The document server's api.js, once per address. */
function loadApi(src: string): Promise<void> {
  let p = scripts.get(src)
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script')
      s.src = src
      s.async = true
      s.onload = () => (window.DocsAPI ? resolve() : reject(new Error('The document server sent no editor')))
      s.onerror = () => reject(new Error('The document server did not answer'))
      document.head.append(s)
    })
    p.catch(() => scripts.delete(src))
    scripts.set(src, p)
  }
  return p
}

export const officeTitle = (w: WinState) => `${w.props.path ? nameOf(w.props.path) : w.app === 'newsheet' ? 'New spreadsheet' : w.app === 'newslides' ? 'New presentation' : 'New document'}${w.props.unsaved ? ' •' : ''}`

export function Office({ win, kind }: { win: WinState; kind?: NewKind }) {
  const wm = useWM()
  const account = useAccount()
  const office = account.seafile?.office
  const { places, library } = useSeafileHome()
  const { officeFolder } = useSeafilePrefs()
  const path = win.props.path ?? ''
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const holder = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)

  // A New … window makes its file first (only when just opened: a restored one does not).
  const making = useRef(false)
  useEffect(() => {
    if (!kind || path || !win.props.create || making.current || !office) return
    const folder = officeFolder ?? places?.documents ?? (library ? sfPath(library.id) : null)
    if (!folder) return setError('Link Seafile first: new documents are made there.')
    making.current = true
    createFile(`${folder}/${UNTITLED[kind]}`)
      // No Documents folder: the top of the library then.
      .catch(() => (library ? createFile(`${sfPath(library.id)}/${UNTITLED[kind]}`) : Promise.reject(new Error('No folder to make it in'))))
      .then((made) => wm.setProps(win.pid, { path: made, create: undefined }))
      .catch((e: Error) => setError(`Could not make the file: ${e.message}`))
  }, [kind, path, win.props.create, office, officeFolder, places, library])

  // The editor, for this file.
  useEffect(() => {
    if (!path || !office) return
    const at = parseSf(path)
    if (!at) return setError('Only files in Seafile open here.')
    let editor: DocEditor | null = null
    let live = true
    setError(null)
    setReady(false)
    const dark = THEMES[resolvedThemeName()]?.mode !== 'light'
    const mobile = (root.current?.clientWidth ?? 800) < 560
    api<{ api: string; config: Record<string, unknown> }>(`/api/office/config?repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}&theme=${dark ? 'dark' : 'light'}${mobile ? '&mobile' : ''}`)
      .then(async ({ api: src, config }) => {
        await loadApi(src)
        if (!live || !holder.current || !window.DocsAPI) return
        // OnlyOffice swaps this element for its frame: one React does not look after.
        const mount = document.createElement('div')
        mount.id = `office-${win.pid}-${Date.now()}`
        holder.current.replaceChildren(mount)
        editor = new window.DocsAPI.DocEditor(mount.id, {
          ...config,
          width: '100%',
          height: '100%',
          events: {
            onAppReady: () => live && setReady(true),
            onDocumentStateChange: (e: { data: boolean }) => live && setDirty(e.data),
            onError: (e: { data?: { errorDescription?: string } }) => live && setError(e.data?.errorDescription ?? 'The editor ran into a problem'),
            onRequestClose: () => wm.close(win.pid),
          },
        })
      })
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
      try {
        editor?.destroyEditor()
      } catch {
        /* already gone */
      }
    }
  }, [path, office?.url, win.pid])

  // Clicks inside the editor's frame never reach this page: focusing the frame raises the window.
  useEffect(() => {
    const onBlur = () =>
      setTimeout(() => {
        const active = document.activeElement
        if (active?.tagName === 'IFRAME' && root.current?.contains(active) && wm.focusedPid !== win.pid) wm.focus(win.pid)
      })
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [wm, win.pid])

  // An unsaved mark in the title while OnlyOffice has changes it has not stored yet.
  useEffect(() => {
    if (path) wm.setProps(win.pid, { unsaved: dirty ? '1' : undefined })
  }, [dirty])

  const at = parseSf(path)
  if (!office)
    return (
      <div className="office-empty">
        <p className="pv-big">OnlyOffice is not set up</p>
        <p className="muted">Add the document server Seafile uses in Settings → Integrations → OnlyOffice.</p>
        <button className="btn btn-small" onClick={() => wm.open('settings', { section: 'integrations', t: String(Date.now()) })}>
          Open Settings
        </button>
      </div>
    )
  return (
    <div ref={root} className="office">
      <div ref={holder} className="office-frame" />
      {(!ready || error) && (
        <div className="office-empty">
          {error ? (
            <>
              <p className="pv-big">{path ? nameOf(path) : 'New document'}</p>
              <p className="muted">{error}</p>
              {path && isSf(path) && (
                <span className="office-actions">
                  <button className="btn btn-small" onClick={() => void download(path).catch(() => {})}>
                    Download
                  </button>
                  <button className="btn btn-small" onClick={() => wm.openNew('files', { path: folderOf(path), select: path })}>
                    Show in Files
                  </button>
                </span>
              )}
            </>
          ) : (
            <p className="muted">{path ? `Opening ${nameOf(path)}${at ? ` from ${libraryName(at.repo)}` : ''}…` : 'Making a new file…'}</p>
          )}
        </div>
      )}
    </div>
  )
}
