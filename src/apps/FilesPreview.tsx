import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatSize, KIND_LABEL, type FileKind, type Node } from '../terminal/vfs'
import { parseSf, readBlob } from '../data/seafile'
import { readBrowserBlob } from '../data/browserfs'
import { useMedia } from '../data/media'
import { archiveFormat, FORMAT_LABEL } from '../data/archive'
import { listFolder, readZip, type ZipIndex } from '../data/zip'
import { pdfjs } from '../data/pdfjs'
import { MarkdownPreview } from '../data/markdown/MarkdownPreview'
import { highlight, knownLanguage } from '../data/markdown/highlight'
import { FileIcon, FolderIcon } from './Files'

// Files' preview pane: what the selected file holds, on the right of the list, as in Finder's
// preview column or Nautilus's and Dolphin's information panel. It shows what MvL OS's own apps
// open, with their own code: pictures and video/audio through the same addresses Preview and
// Player use (data/media.ts), Markdown with Zed's preview (data/markdown), code and text with the
// same highlighter, the first page of a PDF with pdf.js (data/pdfjs.ts), and what an archive holds
// with the Archive app's reader (data/zip.ts). Office documents are never opened here (that would
// mean loading OnlyOffice in the pane): they and anything unknown show their icon, details and
// Open. Reads are capped, so a big file costs no more than its first part.

/** What the pane needs of a Files item (Files' own Item has these and more). */
export type PreviewItem = {
  path: string
  name: string
  node: Node | null
  kind: FileKind
  size: number
  mtime: number
  trash?: 'desktop' | 'joke'
  sf?: { repo: string; p: string; library?: { size: number; encrypted?: boolean } }
}

/** Text is read up to this much, and shown up to TEXT_LINES lines. */
export const TEXT_CAP = 200 * 1024
export const TEXT_LINES = 2000
/** A PDF is read whole to draw its first page: only up to this size. */
const PDF_CAP = 40 * 1024 * 1024
/** A ZIP kept in this browser is read whole (from Seafile only its end): only up to this size. */
const ZIP_CAP = 200 * 1024 * 1024
/** Rows of an archive's top level listed. */
const ZIP_ROWS = 200

export const PREVIEW_MIN = 220
export const PREVIEW_MAX = 720
export const PREVIEW_DEFAULT = 320

const when = (ms: number) => (ms ? new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '')

/** The language the highlighter knows a file by: its extension, or its name (Dockerfile). */
function languageOf(name: string): string | null {
  const ext = extOf(name)
  if (ext && knownLanguage(ext)) return ext
  if (/^dockerfile$/i.test(name)) return 'dockerfile'
  if (/^\.?(bashrc|zshrc|profile|bash_profile)$/i.test(name)) return 'sh'
  return null
}

/** The kind of preview a file gets. Office documents and unknown files get none. */
type Mode = 'image' | 'video' | 'audio' | 'markdown' | 'text' | 'pdf' | 'archive' | null
function modeOf(item: PreviewItem): Mode {
  if (item.kind === 'image') return 'image'
  if (item.kind === 'video') return 'video'
  if (item.kind === 'audio') return 'audio'
  if (item.kind === 'markdown') return 'markdown'
  if (item.kind === 'text') return 'text'
  // .url shortcuts are text; .desktop launchers show as themselves in the list and open what they point at.
  if (item.kind === 'link' && extOf(item.name) === 'url') return 'text'
  if (item.kind === 'pdf') return 'pdf'
  if (item.kind === 'archive' && archiveFormat(item.name)) return 'archive'
  return null
}

/** Where the bytes are: Seafile, this browser's store, or the site's own (in memory). */
function sourceOf(item: PreviewItem): { sf: string } | { browser: string } | { site: () => string } | null {
  if (item.sf) return { sf: item.path }
  const node = item.node
  if (node?.type !== 'file') return null
  if (node.browser) return { browser: node.browser }
  if (node.sf) return { sf: node.sf }
  return { site: node.content }
}

/** The first `cap` bytes of a Seafile file, through the site (Seafile's file server sends no CORS on 206). */
async function sfHead(path: string, size: number, cap: number): Promise<Blob> {
  if (size === 0) return new Blob([])
  const at = parseSf(path)!
  const end = Math.min(size || cap, cap) - 1
  const res = await fetch(`/api/seafile/raw?repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}`, { headers: { Range: `bytes=0-${end}` }, credentials: 'same-origin' })
  if (!res.ok) throw new Error(res.status === 423 ? 'The library is locked: unlock it first.' : `Seafile answered ${res.status}`)
  return res.blob()
}

/** A file's text, at most TEXT_CAP bytes and TEXT_LINES lines; `cut` when there was more. */
async function readHead(item: PreviewItem): Promise<{ text: string; cut: boolean; binary: boolean }> {
  const src = sourceOf(item)
  if (!src) throw new Error('Nothing to read.')
  let text: string
  let cut = item.size > TEXT_CAP
  if ('site' in src) {
    const all = src.site()
    cut = all.length > TEXT_CAP
    text = all.slice(0, TEXT_CAP)
  } else {
    const blob = 'sf' in src ? await sfHead(src.sf, item.size, TEXT_CAP) : (await readBrowserBlob(src.browser)).slice(0, TEXT_CAP)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    // A NUL in the first few KB: not text.
    if (bytes.subarray(0, 8192).includes(0)) return { text: '', cut: false, binary: true }
    text = new TextDecoder().decode(bytes)
  }
  const lines = text.split('\n')
  if (lines.length > TEXT_LINES) {
    text = lines.slice(0, TEXT_LINES).join('\n')
    cut = true
  }
  return { text, cut, binary: false }
}

/** A file's bytes, whole (a PDF, a ZIP kept in this browser), refusing what is over `cap`. */
async function readWhole(item: PreviewItem, cap: number): Promise<Blob> {
  if (item.size > cap) throw new Error(`Too big to preview (${formatSize(item.size)}).`)
  const src = sourceOf(item)
  if (!src) throw new Error('Nothing to read.')
  if ('sf' in src) return readBlob(src.sf)
  if ('browser' in src) return readBrowserBlob(src.browser)
  throw new Error('Only real files, in Seafile or kept in this browser, preview here.')
}

/** Runs `load` for the item on show, and forgets an answer that came back for an item no longer shown. */
function useLoad<T>(key: string, load: () => Promise<T>): { value: T | null; error: string | null } {
  const [state, setState] = useState<{ key: string; value: T | null; error: string | null }>({ key: '', value: null, error: null })
  useEffect(() => {
    let live = true
    load().then(
      (value) => live && setState({ key, value, error: null }),
      (e: Error) => live && setState({ key, value: null, error: e.message }),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state.key === key ? state : { value: null, error: null }
}

// --- the pane -------------------------------------------------------------------------------------

export function FilesPreview({
  item,
  folder,
  trash,
  onOpen,
  openLabel,
}: {
  item: PreviewItem | null
  /** The folder on show, for when nothing is selected */
  folder: { name: string; count: number }
  /** The trash is on show */
  trash: boolean
  onOpen: (item: PreviewItem) => void
  openLabel?: string
}) {
  const [extra, setExtra] = useState<{ key: string; rows: [string, string][] }>({ key: '', rows: [] })
  const key = item ? `${item.path}@${item.mtime}-${item.size}` : ''
  const report = useMemo(() => (rows: [string, string][]) => setExtra({ key, rows }), [key])

  if (!item)
    return (
      <div className="fm-pv-body">
        <div className="fm-pv-stage is-icon">
          {trash ? <span className="fm-pv-trash">🗑</span> : <FolderIcon size={88} />}
        </div>
        <div className="fm-pv-info">
          <strong className="fm-pv-name">{trash ? 'Trash' : folder.name}</strong>
          <p className="fm-pv-hint">{trash ? 'No preview in Trash.' : `${folder.count} item${folder.count === 1 ? '' : 's'}. Select a file to preview it.`}</p>
        </div>
      </div>
    )

  const mode = item.trash ? null : modeOf(item)
  const rows: [string, string][] = [
    ['Kind', item.sf?.library ? `Library${item.sf.library.encrypted ? ', encrypted' : ''}` : KIND_LABEL[item.kind]],
    ...(item.kind !== 'folder' ? [['Size', formatSize(item.size)] as [string, string]] : item.sf?.library ? [['Size', formatSize(item.sf.library.size)] as [string, string]] : !item.sf && item.node?.type === 'dir' ? [['Contains', `${item.size} item${item.size === 1 ? '' : 's'}`] as [string, string]] : []),
    ['Modified', when(item.mtime)],
    ...(extra.key === key ? extra.rows : []),
  ]
  const big = <span className="fm-pv-icon">{item.kind === 'folder' ? <FolderIcon size={88} /> : <FileIcon size={88} kind={item.kind} name={item.name} />}</span>

  return (
    <div className="fm-pv-body">
      <div className={`fm-pv-stage ${mode === 'markdown' || mode === 'text' || mode === 'archive' ? 'is-doc' : mode ? '' : 'is-icon'}`}>
        {item.trash ? (
          <>
            {big}
            <p className="fm-pv-hint">No preview in Trash.</p>
          </>
        ) : mode === 'image' || mode === 'video' || mode === 'audio' ? (
          <MediaPreview key={key} item={item} mode={mode} fallback={big} report={report} />
        ) : mode === 'markdown' || mode === 'text' ? (
          <TextPreview key={key} item={item} markdown={mode === 'markdown'} fallback={big} />
        ) : mode === 'pdf' ? (
          <PdfPreview key={key} item={item} fallback={big} report={report} />
        ) : mode === 'archive' ? (
          <ArchivePreview key={key} item={item} fallback={big} report={report} />
        ) : (
          big
        )}
      </div>
      <div className="fm-pv-info">
        <strong className="fm-pv-name" title={item.name}>
          {item.name}
        </strong>
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {!item.trash && (
          <div className="fm-pv-actions">
            <button className="btn btn-small" onClick={() => onOpen(item)}>
              {openLabel ?? 'Open'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** The pane's message in place of a preview: the file's icon and why. */
const Fallback = ({ icon, note }: { icon: ReactNode; note?: string | null }) => (
  <>
    {icon}
    {note && <p className="fm-pv-hint">{note}</p>}
  </>
)

// --- pictures, video and audio ----------------------------------------------------------------------

/** Through useMedia, as Preview and Player load them (Seafile video streams through the site). */
function MediaPreview({ item, mode, fallback, report }: { item: PreviewItem; mode: 'image' | 'video' | 'audio'; fallback: ReactNode; report: (rows: [string, string][]) => void }) {
  const media = useMedia(item.path)
  const [broken, setBroken] = useState(false)
  if (media.error || broken) return <Fallback icon={fallback} note={media.error ?? 'This file could not be shown.'} />
  if (media.unplayable) return <Fallback icon={fallback} note={media.unplayable} />
  if (!media.url) return <Fallback icon={fallback} note="Loading…" />
  if (mode === 'image')
    return (
      <img
        className="fm-pv-img"
        src={media.url}
        alt=""
        draggable={false}
        onError={() => setBroken(true)}
        onLoad={(e) => {
          const { naturalWidth: w, naturalHeight: h } = e.currentTarget
          if (w && h) report([['Dimensions', `${w} × ${h}`]])
        }}
      />
    )
  if (mode === 'video')
    return (
      <video
        className="fm-pv-video"
        src={media.url}
        controls
        muted
        playsInline
        preload="metadata"
        onError={() => setBroken(true)}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          const rows: [string, string][] = []
          if (v.videoWidth && v.videoHeight) rows.push(['Dimensions', `${v.videoWidth} × ${v.videoHeight}`])
          if (isFinite(v.duration)) rows.push(['Duration', duration(v.duration)])
          report(rows)
        }}
      />
    )
  return (
    <div className="fm-pv-audio">
      {fallback}
      <audio
        src={media.url}
        controls
        muted
        preload="metadata"
        onError={() => setBroken(true)}
        onLoadedMetadata={(e) => isFinite(e.currentTarget.duration) && report([['Duration', duration(e.currentTarget.duration)]])}
      />
    </div>
  )
}

const duration = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

// --- Markdown, code and text -------------------------------------------------------------------------

/** Markdown as Zed's preview renders it; code coloured by the same highlighter; the rest as plain text. */
function TextPreview({ item, markdown, fallback }: { item: PreviewItem; markdown: boolean; fallback: ReactNode }) {
  const { value, error } = useLoad(item.path, () => readHead(item))
  const lang = markdown ? null : languageOf(item.name)
  const tokens = useMemo(() => (value && lang ? highlight(value.text, lang) : null), [value, lang])
  if (error) return <Fallback icon={fallback} note={error} />
  if (!value) return <p className="fm-pv-hint">Loading…</p>
  if (value.binary) return <Fallback icon={fallback} note="Not text: no preview." />
  const cut = value.cut && <p className="fm-pv-cut">Only the start is shown. Open the file to see all of it.</p>
  if (markdown)
    return (
      <div className="zed-preview fm-pv-md">
        <MarkdownPreview text={value.text} />
        {cut}
      </div>
    )
  return (
    <div className="zed-preview fm-pv-code">
      <pre>{tokens ? tokens.map((t, i) => (t.cls ? <span key={i} className={`hl-${t.cls}`}>{t.text}</span> : t.text)) : value.text}</pre>
      {cut}
    </div>
  )
}

// --- PDF -----------------------------------------------------------------------------------------------

/** The first page, drawn by pdf.js as the PDF viewer draws its pages. */
function PdfPreview({ item, fallback, report }: { item: PreviewItem; fallback: ReactNode; report: (rows: [string, string][]) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'done' | string>('loading')
  useEffect(() => {
    let live = true
    let destroy: (() => void) | null = null
    ;(async () => {
      const data = new Uint8Array(await (await readWhole(item, PDF_CAP)).arrayBuffer())
      if (!live) return
      const m = await pdfjs()
      const task = m.getDocument({ data })
      destroy = () => void task.destroy()
      const doc = await task.promise
      if (!live) return
      report([['Pages', String(doc.numPages)]])
      const page = await doc.getPage(1)
      const c = canvas.current
      if (!live || !c) return
      const base = page.getViewport({ scale: 1 })
      // Sharp at the pane's widest, on a high-density screen too.
      const scale = Math.min(3, (720 / base.width) * Math.min(2, window.devicePixelRatio || 1))
      const viewport = page.getViewport({ scale })
      c.width = Math.floor(viewport.width)
      c.height = Math.floor(viewport.height)
      await page.render({ canvas: c, viewport }).promise
      if (live) setState('done')
    })().catch((e: Error) => live && setState(e.name === 'PasswordException' ? 'This PDF has a password.' : e.message))
    return () => {
      live = false
      destroy?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.path])
  if (state !== 'loading' && state !== 'done') return <Fallback icon={fallback} note={state} />
  return (
    <>
      <canvas ref={canvas} className="fm-pv-pdf" hidden={state !== 'done'} aria-label={`First page of ${item.name}`} />
      {state === 'loading' && <p className="fm-pv-hint">Loading…</p>}
    </>
  )
}

// --- archives ------------------------------------------------------------------------------------------

/** The top level of a ZIP (or of a tar in Seafile), read as the Archive app reads it. */
function ArchivePreview({ item, fallback, report }: { item: PreviewItem; fallback: ReactNode; report: (rows: [string, string][]) => void }) {
  const format = archiveFormat(item.name)!
  const { value, error } = useLoad<ZipIndex>(item.path, async () => {
    const at = parseSf(item.sf ? item.path : '')
    if (at) {
      const q = `repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}`
      // A ZIP's table of contents is at its end, read in ranges; a tar is listed by the server.
      if (format === 'zip') return readZip(`/api/seafile/raw?${q}`, item.size)
      const res = await fetch(`/api/seafile/archive?${q}`, { credentials: 'same-origin' })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error ?? `The server answered ${res.status}`)
      return body as ZipIndex
    }
    if (format !== 'zip') throw new Error('Tar archives preview from Seafile only.')
    return readZip(await readWhole(item, ZIP_CAP))
  })
  useEffect(() => {
    if (value) report([['Contains', `${value.entries.filter((e) => !e.dir).length} files`], ['Format', FORMAT_LABEL[format]]])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  if (error) return <Fallback icon={fallback} note={error} />
  if (!value) return <p className="fm-pv-hint">Loading…</p>
  const top = listFolder(value, '')
  const rows = [...top.folders.map((f) => ({ name: f.name, dir: true, size: f.size })), ...top.files.map((f) => ({ name: f.path.split('/').pop()!, dir: false, size: f.size }))]
  return (
    <ul className="fm-pv-zip">
      {rows.slice(0, ZIP_ROWS).map((r) => (
        <li key={r.name}>
          <span className="fm-pv-zip-icon">{r.dir ? <FolderIcon size={14} /> : <FileIcon size={14} kind="file" name={r.name} />}</span>
          <span className="fm-pv-zip-name">{r.name}</span>
          <span className="fm-pv-zip-size">{r.dir ? '' : formatSize(r.size)}</span>
        </li>
      ))}
      {rows.length > ZIP_ROWS && <li className="fm-pv-cut">and {rows.length - ZIP_ROWS} more</li>}
      {!rows.length && <li className="fm-pv-hint">Empty archive.</li>}
    </ul>
  )
}

