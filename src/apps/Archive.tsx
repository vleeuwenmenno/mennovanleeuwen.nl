import { useEffect, useMemo, useRef, useState } from 'react'
import { besideArchive, cancelExtract, dismissExtract, DRAG_ZIP, extract, setZipDrag, useExtractJobs, type Clash } from '../data/extract'
import { posixOf } from '../data/mounts'
import { download, getLibrary, isSf, libraryName, parseSf, useLibraries } from '../data/seafile'
import { pickFolder } from '../os/FolderPicker'
import { openContextMenu, type MenuItem } from '../os/ContextMenu'
import { folderOf, nameOf, useMedia } from '../data/media'
import { archiveFormat, FORMAT_LABEL } from '../data/archive'
import { listFolder, METHODS, readEntry, readZip, type ZipEntry, type ZipIndex } from '../data/zip'
import { useWM, type WinState } from '../os/wm'
import { useBackButton } from '../os/backButton'
import { formatSize, KIND_LABEL, kindOfName, prettyPath } from '../terminal/vfs'
import { FileIcon, FolderIcon } from './Files'

// Archive: what is in a ZIP or a tar (plain or gzipped), browsed like a folder in Files, without
// unpacking it. Of a ZIP only the table of contents is read (from Seafile, just the end of the
// file), so even a big one opens at once; a tar is listed by the server, header to header, and a
// gzipped one read through (data/tar.ts, server/unzip.ts). It works as Files does: click, Ctrl/Shift+click, a rubber band or Ctrl+A select,
// right-click has the menu, folders open with a double-click or Enter, Back/Forward/Up go through
// the folders, the columns sort, and the search looks through the whole archive. Extract unpacks
// everything, or what is selected, into a Seafile folder; the server does it (data/extract.ts,
// server/unzip.ts). Rows dragged by their name onto a folder in Files (or the desktop) unpack
// there. A single file can also be saved straight from the archive (unpacked here).

type Sort = 'name' | 'size' | 'packed' | 'ratio' | 'date'
type Row = { name: string; path: string; dir: boolean; size: number; packed: number; mtime: number; count?: number; entry?: ZipEntry }

const SORTS: [Sort, string][] = [
  ['name', 'Name'],
  ['size', 'Size'],
  ['packed', 'Packed'],
  ['ratio', 'Saved'],
  ['date', 'Modified'],
]
/** Files saved straight from the archive are unpacked in memory first, so only up to this. */
const SAVE_LIMIT = 512 * 1024 * 1024

const when = (ms: number) => (ms ? new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
const saved = (r: { size: number; packed: number }) => `${Math.max(0, Math.round((1 - r.packed / r.size) * 100))}%`
/** rwxr-xr-x */
const perms = (mode: number) => [6, 3, 0].map((s) => ['r', 'w', 'x'].map((ch, i) => ((mode >> s) & (4 >> i) ? ch : '-')).join('')).join('')

export const archiveTitle = (w: WinState) => (w.props.path ? nameOf(w.props.path) : 'Archive')

export function Archive({ win }: { win: WinState }) {
  const wm = useWM()
  const path = win.props.path ?? ''
  const media = useMedia(path)
  // Loaded for the permissions: Extract here needs write access next to the archive.
  useLibraries()
  const [index, setIndex] = useState<ZipIndex | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [folder, setFolder] = useState('')
  const [back, setBack] = useState<string[]>([])
  const [fwd, setFwd] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ by: Sort; desc: boolean }>({ by: 'name', desc: false })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** Where Shift+click and the arrow keys start from (the row last clicked) */
  const [anchor, setAnchor] = useState<string | null>(null)
  /** The row the keyboard is on: the anchor, or the far end of a Shift+arrow or Shift+click range */
  const [cursor, setCursor] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [panel, setPanel] = useState<{ into: string; clash: Clash } | null>(null)
  /** Properties of a row, or of the archive itself */
  const [props, setProps] = useState<Row | 'archive' | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const jobs = useExtractJobs().filter((j) => j.zip === path)
  const job = jobs[jobs.length - 1]
  const list = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const tiles = useRef(new Map<string, HTMLElement>())
  /** Set while a rubber band that began on a row is drawn, so letting go is not also a click. */
  const banding = useRef(false)
  const format = archiveFormat(media.name) ?? 'zip'
  const zip = format === 'zip'
  const archiveQuery = useMemo(() => {
    const at = parseSf(path)
    return at ? `repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}` : ''
  }, [path])
  const rawUrl = `/api/seafile/raw?${archiveQuery}`

  useEffect(() => {
    if (!isSf(path)) return
    if (media.size === null) return
    let live = true
    setIndex(null)
    setError(null)
    setFolder('')
    setBack([])
    setFwd([])
    // A ZIP is read here, with ranges through the site's server (Seafile's file server sends no
    // CORS headers on them); a tar by the server, which can read a gzipped one through.
    const read = zip
      ? readZip(rawUrl, media.size ?? undefined)
      : fetch(`/api/seafile/archive?${archiveQuery}`, { credentials: 'same-origin' }).then(async (res) => {
          const body = await res.json().catch(() => null)
          if (!res.ok) throw new Error(body?.error ?? `The server answered ${res.status}`)
          return body as ZipIndex
        })
    read
      .then((i) => live && setIndex(i))
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [path, media.size === null])

  useEffect(() => {
    if (wm.focusedPid === win.pid && !root.current?.contains(document.activeElement)) list.current?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [toast])

  const rows = useMemo<Row[]>(() => {
    if (!index) return []
    let out: Row[]
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      out = index.entries
        .filter((e) => !e.dir && e.path.toLowerCase().includes(q))
        .slice(0, 2000)
        .map((e) => ({ name: e.path, path: e.path, dir: false, size: e.size, packed: e.compressed, mtime: e.mtime, entry: e }))
    } else {
      const here = listFolder(index, folder)
      const prefix = folder ? `${folder}/` : ''
      out = [
        ...here.folders.map((f) => {
          const own = index.entries.find((e) => e.dir && e.path === `${prefix}${f.name}`)
          return { name: f.name, path: `${prefix}${f.name}`, dir: true, size: f.size, packed: 0, mtime: own?.mtime ?? 0, count: f.count }
        }),
        ...here.files.map((e) => ({ name: e.path.slice(prefix.length), path: e.path, dir: false, size: e.size, packed: e.compressed, mtime: e.mtime, entry: e })),
      ]
    }
    const ratio = (r: Row) => (r.size ? r.packed / r.size : 1)
    const cmp: Record<Sort, (a: Row, b: Row) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      size: (a, b) => a.size - b.size,
      packed: (a, b) => a.packed - b.packed,
      ratio: (a, b) => ratio(a) - ratio(b),
      date: (a, b) => a.mtime - b.mtime,
    }
    return out.sort((a, b) => (a.dir === b.dir ? 0 : a.dir ? -1 : 1) || cmp[sort.by](a, b) * (sort.desc ? -1 : 1))
  }, [index, folder, query, sort])

  // --- moving around ----------------------------------------------------------------------------

  /** Shows `to`, with `select` picked (the folder you came up from, say). */
  const go = (to: string, record = true, select?: string) => {
    if (to === folder && !query) return
    if (record) {
      setBack((b) => [...b, folder])
      setFwd([])
    }
    setFolder(to)
    setQuery('')
    setSelected(new Set(select ? [select] : []))
    setAnchor(select ?? null)
    setCursor(select ?? null)
  }
  const goUp = () => folder && go(folder.split('/').slice(0, -1).join('/'), true, folder)
  const goBack = () => {
    const prev = back[back.length - 1]
    if (prev === undefined) return
    setBack(back.slice(0, -1))
    setFwd([folder, ...fwd])
    go(prev, false, prev.length < folder.length && folder.startsWith(prev) ? folder : undefined)
  }
  const goForward = () => {
    const next = fwd[0]
    if (next === undefined) return
    setFwd(fwd.slice(1))
    setBack([...back, folder])
    go(next, false)
  }
  useBackButton(win.pid, { back: goBack, forward: goForward })

  // --- doing things -----------------------------------------------------------------------------

  const selectedRows = () => rows.filter((r) => selected.has(r.path))
  const where = (sf: string) => {
    const px = posixOf(sf)
    if (px) return prettyPath(px)
    const at = parseSf(sf)!
    return `${libraryName(at.repo)}${at.p === '/' ? '' : at.p}`
  }
  const canWrite = (sf: string) => getLibrary(parseSf(sf)!.repo)?.permission === 'rw'
  const base = () => (query ? '' : folder)

  /** Unpacks these rows (none: everything) into `into` straight away. */
  const unpack = (paths: string[] | undefined, into: string, clash: Clash = 'keep') =>
    void extract(path, into, { entries: paths?.length ? paths : undefined, base: base(), clash }).catch((e: Error) => setToast(e.message))
  /** The Extract panel: where to and what to do with names already there, for what is selected. */
  const openPanel = (into = besideArchive(path)) => setPanel({ into, clash: 'keep' })
  const startExtract = () => {
    if (!panel) return
    setPanel(null)
    unpack([...selected], panel.into, panel.clash)
  }

  /** Saves one file from the archive, unpacked here (no Seafile folder in between). */
  const save = async (r: Row) => {
    const e = r.entry
    if (!e) return
    if (e.link !== undefined) return setToast(`${r.name.split('/').pop()} is a link (to ${e.link}), not a file`)
    // A tar's file comes from the server, as a download (a gzipped one read through up to it).
    if (!zip) {
      const a = document.createElement('a')
      a.href = `/api/seafile/archive/file?${archiveQuery}&entry=${encodeURIComponent(e.path)}`
      a.download = e.path.split('/').pop() ?? 'file'
      a.click()
      if (format === 'tgz') setToast(`Reading ${media.name} through to ${a.download}…`)
      return
    }
    if (e.size > SAVE_LIMIT) return setToast(`${r.name.split('/').pop()} is too big to save on its own (${formatSize(e.size)}); extract it instead`)
    setToast(`Unpacking ${r.name.split('/').pop()}…`)
    try {
      const data = await readEntry(e, async (from, to) => {
        const res = await fetch(rawUrl, { headers: { Range: `bytes=${from}-${to}` }, credentials: 'same-origin' })
        if (res.status !== 206) throw new Error((await res.json().catch(() => null))?.error ?? `The server answered ${res.status}`)
        return new Uint8Array(await res.arrayBuffer())
      })
      const url = URL.createObjectURL(new Blob([data as BlobPart]))
      const a = document.createElement('a')
      a.href = url
      a.download = e.path.split('/').pop() ?? 'file'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setToast(null)
    } catch (err) {
      setToast(`Could not unpack ${r.name.split('/').pop()}: ${(err as Error).message}`)
    }
  }

  /** Double-click or Enter: folders open, files are saved. */
  const open = (r: Row) => (r.dir ? go(r.path) : void save(r))

  const copyPaths = (paths: string[]) =>
    navigator.clipboard
      ?.writeText(paths.join('\n'))
      .then(() => setToast(paths.length === 1 ? `Copied ${paths[0]}` : `Copied ${paths.length} paths`))
      .catch(() => {})

  const selectAll = () => setSelected(new Set(rows.map((r) => r.path)))

  const extractItems = (paths: string[], count: string): MenuItem[] => [
    { label: `Extract ${count}here`, disabled: !canWrite(folderOf(path)), onSelect: () => unpack(paths, besideArchive(path)) },
    { label: `Extract ${count}to…`, onSelect: () => openPanel() },
  ]

  function rowMenu(r: Row): MenuItem[] {
    const many = selected.has(r.path) && selected.size > 1
    if (many) {
      const sel = selectedRows()
      return [
        ...extractItems(
          sel.map((s) => s.path),
          `${sel.length} items `,
        ),
        { separator: true },
        { label: 'Copy paths', onSelect: () => copyPaths(sel.map((s) => s.path)) },
      ]
    }
    return [
      r.dir ? { label: 'Open', shortcut: '↵', onSelect: () => go(r.path) } : { label: 'Save to computer', shortcut: '↵', disabled: r.entry?.encrypted || r.entry?.link !== undefined, onSelect: () => void save(r) },
      { separator: true },
      ...extractItems([r.path], ''),
      { separator: true },
      { label: 'Copy path', onSelect: () => copyPaths([r.path]) },
      { label: 'Properties', shortcut: 'Alt ↵', onSelect: () => setProps(r) },
    ]
  }

  function backgroundMenu(): MenuItem[] {
    return [
      { label: 'Select all', shortcut: 'Ctrl A', disabled: !rows.length, onSelect: selectAll },
      { label: 'Sort by', submenu: SORTS.filter(([by]) => zip || (by !== 'packed' && by !== 'ratio')).map(([by, label]) => ({ label, checked: sort.by === by, onSelect: () => setSort({ by, desc: by !== 'name' }) })) },
      ...(folder ? [{ label: 'Up', shortcut: 'Backspace', onSelect: goUp }] : []),
      { separator: true },
      { label: 'Extract all here', disabled: !index || !canWrite(folderOf(path)), onSelect: () => unpack(undefined, besideArchive(path)) },
      { label: 'Extract all to…', disabled: !index, onSelect: () => openPanel() },
      { separator: true },
      { label: 'Show in Files', onSelect: () => wm.openNew('files', { path: folderOf(path), select: path }) },
      { label: 'Download archive', onSelect: () => void download(path).catch(() => {}) },
      { label: 'Properties', shortcut: 'Alt ↵', disabled: !index, onSelect: () => setProps('archive') },
    ]
  }

  // --- selection & keyboard ---------------------------------------------------------------------

  /** Click: just this row; Ctrl: add or take off; Shift: everything from the last click. */
  const clickRow = (e: React.MouseEvent, r: Row) => {
    e.stopPropagation()
    if (banding.current) return
    list.current?.focus({ preventScroll: true })
    if (e.shiftKey && anchor) {
      const a = rows.findIndex((x) => x.path === anchor)
      const b = rows.findIndex((x) => x.path === r.path)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      const range = rows.slice(lo, hi + 1).map((x) => x.path)
      setSelected(e.ctrlKey || e.metaKey ? new Set([...selected, ...range]) : new Set(range))
      setCursor(r.path)
      return
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected)
      if (next.has(r.path)) next.delete(r.path)
      else next.add(r.path)
      setSelected(next)
    } else setSelected(new Set([r.path]))
    setAnchor(r.path)
    setCursor(r.path)
  }

  /** The cursor to row `to`; with Shift, everything from the anchor to there is selected. */
  const moveCursor = (to: number, extend: boolean) => {
    if (!rows.length) return
    const i = Math.max(0, Math.min(rows.length - 1, to))
    const next = rows[i].path
    if (extend && anchor) {
      const a = rows.findIndex((x) => x.path === anchor)
      const [lo, hi] = a < i ? [a, i] : [i, a]
      setSelected(new Set(rows.slice(lo, hi + 1).map((x) => x.path)))
      // The anchor stays put; the row that moves is the cursor.
      setCursor(next)
      return
    }
    setSelected(new Set([next]))
    setAnchor(next)
    setCursor(next)
  }
  const at = rows.findIndex((r) => r.path === (cursor && selected.has(cursor) ? cursor : anchor))

  const menuForCursor = () => {
    const r = rows[at]
    const el = r ? tiles.current.get(r.path) : list.current
    const box = el?.getBoundingClientRect()
    if (!box) return
    const e = { clientX: box.left + 24, clientY: box.top + Math.min(box.height, 24), preventDefault() {}, stopPropagation() {} }
    if (r) {
      if (!selected.has(r.path)) setSelected(new Set([r.path]))
      openContextMenu(e, rowMenu(r))
    } else openContextMenu(e, backgroundMenu())
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input')) {
      if (e.key === 'Escape') setQuery('')
      else if (e.key === 'ArrowDown') list.current?.focus()
      return
    }
    const ctrl = e.ctrlKey || e.metaKey
    const page = Math.max(1, Math.floor((list.current?.clientHeight ?? 300) / 24) - 1)
    const sel = selectedRows()
    if (e.key === 'ArrowDown' && !e.altKey) moveCursor(at < 0 ? 0 : at + 1, e.shiftKey)
    else if (e.key === 'ArrowUp' && !e.altKey) moveCursor(at < 0 ? 0 : at - 1, e.shiftKey)
    else if (e.key === 'PageDown') moveCursor(at + page, e.shiftKey)
    else if (e.key === 'PageUp') moveCursor(at - page, e.shiftKey)
    else if (e.key === 'Home') moveCursor(0, e.shiftKey)
    else if (e.key === 'End') moveCursor(rows.length - 1, e.shiftKey)
    else if (ctrl && e.key.toLowerCase() === 'a') selectAll()
    else if (ctrl && e.key.toLowerCase() === 'c' && sel.length) copyPaths(sel.map((r) => r.path))
    else if (ctrl && e.key.toLowerCase() === 'f') root.current?.querySelector<HTMLInputElement>('.ar-search')?.focus()
    else if (e.key === 'Escape') panel ? setPanel(null) : setSelected(new Set())
    else if (e.altKey && e.key === 'Enter') setProps(sel.length === 1 ? sel[0] : 'archive')
    else if (e.key === 'Enter' && sel.length === 1) open(sel[0])
    else if (e.key === 'Enter' && sel.length > 1) openPanel()
    else if (e.altKey && e.key === 'ArrowLeft') goBack()
    else if (e.altKey && e.key === 'ArrowRight') goForward()
    else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) goUp()
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) menuForCursor()
    else return
    e.preventDefault()
  }
  useEffect(() => {
    const r = rows[at]
    if (r) tiles.current.get(r.path)?.scrollIntoView({ block: 'nearest' })
  }, [at])

  /** Dragging rows by their name out to a folder in Files or on the desktop, which unpacks them there. */
  const dragStart = (e: React.DragEvent, r: Row) => {
    const paths = selected.has(r.path) ? selectedRows().map((x) => x.path) : [r.path]
    if (!selected.has(r.path)) {
      setSelected(new Set([r.path]))
      setAnchor(r.path)
      setCursor(r.path)
    }
    e.dataTransfer.setData(DRAG_ZIP, JSON.stringify(paths))
    e.dataTransfer.setData('text/plain', paths.join('\n'))
    e.dataTransfer.effectAllowed = 'copy'
    if (paths.length > 1) {
      // One label for many rows, rather than the one row under the pointer.
      const ghost = document.createElement('div')
      ghost.className = 'ar-ghost'
      ghost.textContent = `${paths.length} items`
      document.body.append(ghost)
      e.dataTransfer.setDragImage(ghost, -10, -10)
      setTimeout(() => ghost.remove())
    }
    setZipDrag({ zip: path, entries: paths, base: base() })
  }

  // Rubber-band selection (Ctrl adds to what is selected). It starts on a row as well as on empty
  // space, as in a details view, except on a row's name, which drags; a click without moving is a click.
  const onListPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.ar-head, .ar-label')) return
    const el = list.current!
    const box = el.getBoundingClientRect()
    // Not on the scrollbar.
    if (e.clientX > box.left + el.clientWidth || e.clientY > box.top + el.clientHeight) return
    const onRow = !!(e.target as HTMLElement).closest('.ar-row')
    const start = { x: e.clientX - box.left + el.scrollLeft, y: e.clientY - box.top + el.scrollTop }
    const kept = e.ctrlKey || e.metaKey ? new Set(selected) : new Set<string>()
    if (!onRow) setSelected(kept)
    banding.current = false
    el.focus({ preventScroll: true })
    const move = (ev: PointerEvent) => {
      const x = ev.clientX - box.left + el.scrollLeft
      const y = ev.clientY - box.top + el.scrollTop
      const rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) }
      if (!banding.current && rect.w < 4 && rect.h < 4) return
      banding.current = true
      setMarquee(rect)
      const hit = new Set(kept)
      for (const [p, row] of tiles.current) {
        const r = row.getBoundingClientRect()
        const top = r.top - box.top + el.scrollTop
        if (top < rect.y + rect.h && top + r.height > rect.y) hit.add(p)
      }
      setSelected(hit)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setMarquee(null)
      // The click that may follow this pointerup comes first; then it is over.
      setTimeout(() => (banding.current = false))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // --- rendering --------------------------------------------------------------------------------

  const files = index?.entries.filter((e) => !e.dir) ?? []
  const unpacked = files.reduce((a, e) => a + e.size, 0)
  const packed = files.reduce((a, e) => a + e.compressed, 0)
  const folders = index ? new Set(index.entries.flatMap((e) => e.path.split('/').slice(0, e.dir ? undefined : -1).map((_, i, all) => all.slice(0, i + 1).join('/')))).size : 0
  const sel = selectedRows()
  const one = sel.length === 1 ? sel[0] : null
  const selSize = sel.reduce((a, r) => a + r.size, 0)
  const crumbs = folder ? folder.split('/') : []
  const head = (by: Sort, label: string) => (
    <button className={sort.by === by ? 'is-sorted' : ''} onClick={() => setSort((s) => ({ by, desc: s.by === by ? !s.desc : by !== 'name' }))}>
      {label}
      {sort.by === by ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </button>
  )

  return (
    <div ref={root} className={`ar ${zip ? '' : 'is-tar'}`} onKeyDown={onKeyDown}>
      <div className="pv-bar">
        <button className="fm-tool" onClick={goBack} disabled={!back.length} title="Back (Alt+←)" aria-label="Back">
          ←
        </button>
        <button className="fm-tool" onClick={goForward} disabled={!fwd.length} title="Forward (Alt+→)" aria-label="Forward">
          →
        </button>
        <button className="fm-tool" onClick={goUp} disabled={!folder} title="Up (Backspace)" aria-label="Up">
          ↑
        </button>
        <span className="ar-crumbs">
          <button onClick={() => go('')}>🗜️ {media.name}</button>
          {crumbs.map((c, i) => (
            <span key={i}>
              <span className="muted"> › </span>
              <button onClick={() => go(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
            </span>
          ))}
        </span>
        <span className="spacer" />
        <input className="ar-search" placeholder="Search the archive" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the archive" />
        <button className="btn btn-small" disabled={!index} onClick={() => (panel ? setPanel(null) : openPanel())}>
          {selected.size ? `Extract ${selected.size}…` : 'Extract all…'}
        </button>
        <button className="btn btn-small" onClick={() => wm.openNew('files', { path: folderOf(path), select: path })}>
          Show in Files
        </button>
        <button className="btn btn-small" onClick={() => void download(path).catch(() => {})}>
          Download
        </button>
      </div>

      {media.unplayable || (!isSf(path) && path) ? (
        <div className="pv-empty">
          <p className="pv-big">{media.name}</p>
          <p className="muted">{media.unplayable ?? 'Only archives in Seafile open here.'}</p>
        </div>
      ) : error ? (
        <div className="pv-empty">
          <p className="pv-big">{media.name}</p>
          <p className="muted">{error}</p>
        </div>
      ) : !index ? (
        <div className="pv-loading">{format === 'tgz' ? `Reading ${media.name} through (a gzipped tar has no table of contents)…` : `Reading ${media.name}…`}</div>
      ) : (
        <>
          {panel && (
            <div className="ar-panel">
              <span>
                Extract {selected.size ? `${selected.size} selected` : 'everything'} into <strong>{where(panel.into)}</strong>
              </span>
              <button className="btn btn-small" onClick={() => void pickFolder({ title: 'Extract into', start: panel.into }).then((p) => p && setPanel({ ...panel, into: p }))}>
                Change…
              </button>
              <span className="ar-clash" role="radiogroup" aria-label="When a file is already there">
                <span className="muted">Already there:</span>
                {(
                  [
                    ['keep', 'Keep both'],
                    ['replace', 'Replace'],
                    ['skip', 'Skip'],
                  ] as const
                ).map(([id, label]) => (
                  <label key={id} className={`set-choice ${panel.clash === id ? 'is-on' : ''}`}>
                    <input type="radio" name={`clash-${win.pid}`} checked={panel.clash === id} onChange={() => setPanel({ ...panel, clash: id })} />
                    {label}
                  </label>
                ))}
              </span>
              <span className="spacer" />
              <button className="btn btn-small" onClick={() => setPanel(null)}>
                Cancel
              </button>
              <button className="btn btn-small btn-primary" onClick={startExtract}>
                Extract
              </button>
            </div>
          )}
          <div
            className="ar-list"
            ref={list}
            tabIndex={0}
            onPointerDown={onListPointerDown}
            onContextMenu={(e) => {
              if ((e.target as HTMLElement).closest('.ar-row')) return
              setSelected(new Set())
              openContextMenu(e, backgroundMenu())
            }}
          >
            <div className="ar-row ar-head">
              {head('name', query ? 'Path' : 'Name')}
              {head('size', 'Size')}
              {zip && head('packed', 'Packed')}
              {zip && head('ratio', 'Saved')}
              {head('date', 'Modified')}
            </div>
            {rows.map((r) => (
              <div
                key={r.path}
                ref={(el) => {
                  if (el) tiles.current.set(r.path, el)
                  else tiles.current.delete(r.path)
                }}
                className={`ar-row ${selected.has(r.path) ? 'is-selected' : ''} ${rows[at]?.path === r.path ? 'is-cursor' : ''}`}
                onClick={(e) => clickRow(e, r)}
                onDoubleClick={() => open(r)}
                onContextMenu={(e) => {
                  if (!selected.has(r.path)) {
                    setSelected(new Set([r.path]))
                    setAnchor(r.path)
                    setCursor(r.path)
                  }
                  openContextMenu(e, rowMenu(r))
                }}
                title={r.path}
              >
                <span className="ar-name">
                  <span className="ar-label" draggable onDragStart={(e) => dragStart(e, r)} onDragEnd={() => setZipDrag(null)}>
                    <span className="ar-glyph">{r.dir ? <FolderIcon size={16} /> : <FileIcon size={16} kind={kindOfName(r.name)} name={r.name} />}</span>
                    {r.name}
                    {r.entry?.encrypted && <span title="Encrypted">🔒</span>}
                    {r.entry?.link !== undefined && <span className="muted"> → {r.entry.link}</span>}
                  </span>
                </span>
                <span>{r.dir ? `${r.count} ${r.count === 1 ? 'file' : 'files'}` : formatSize(r.size)}</span>
                {zip && <span>{r.dir ? formatSize(r.size) : formatSize(r.packed)}</span>}
                {zip && <span>{r.dir || !r.size ? '' : saved(r)}</span>}
                <span>{when(r.mtime)}</span>
              </div>
            ))}
            {!rows.length && <p className="fm-empty">{query ? `Nothing called “${query}” in here.` : 'This folder is empty.'}</p>}
            {marquee && <div className="fm-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
          </div>
          <footer className="fm-status">
            <span>
              {one?.entry
                ? zip
                  ? `${one.entry.path} · ${formatSize(one.entry.size)} · ${METHODS[one.entry.method] ?? `method ${one.entry.method}`}${one.entry.encrypted ? ' · encrypted' : ''}${one.entry.comment ? ` · ${one.entry.comment}` : ''}`
                  : `${one.entry.path} · ${one.entry.link !== undefined ? `link to ${one.entry.link}` : formatSize(one.entry.size)}${one.entry.mode !== undefined ? ` · ${perms(one.entry.mode)} ${one.entry.owner ?? ''}` : ''}`
                : sel.length
                  ? `${sel.length} selected · ${formatSize(selSize)}`
                  : `${files.length} files in ${folders} folders · ${formatSize(unpacked)} unpacked · ${formatSize(index.size)} on disk${unpacked && format !== 'tar' ? ` (${Math.max(0, Math.round((1 - (zip ? packed : index.size) / unpacked) * 100))}% smaller)` : ''}${index.zip64 ? ' · ZIP64' : ''}`}
            </span>
            {job && (
              <span className="ar-job">
                {job.status.state === 'running' ? (
                  <>
                    <span className="ar-bar" aria-hidden>
                      <i style={{ width: `${job.status.totalBytes ? Math.round((job.status.bytes / job.status.totalBytes) * 100) : 0}%` }} />
                    </span>
                    Unpacking {Math.min(job.status.files ?? job.status.count, job.status.total)} of {job.status.total}
                    {job.status.current ? ` · ${job.status.current.split('/').pop()}` : ''}
                    <button className="link-btn" onClick={() => void cancelExtract(job.id)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    {job.status.state === 'done' ? `Unpacked into ${where(job.into)}` : job.status.state === 'cancelled' ? 'Stopped' : `Failed: ${job.status.error}`}
                    {job.status.errors.length > 0 && <span title={job.status.errors.map((e) => `${e.path}: ${e.error}`).join('\n')}> · {job.status.errors.length} left out</span>}
                    <button className="link-btn" onClick={() => wm.openNew('files', { path: job.into })}>
                      Show
                    </button>
                    <button className="link-btn" onClick={() => dismissExtract(job.id)} aria-label="Dismiss">
                      ✕
                    </button>
                  </>
                )}
              </span>
            )}
          </footer>
        </>
      )}
      {toast && <div className="fm-toast">{toast}</div>}
      {props && index && <Properties row={props} index={index} name={media.name} location={where(folderOf(path))} close={() => setProps(null)} />}
    </div>
  )
}

/** A row's details (or the archive's), as Files shows a file's. */
function Properties({ row, index, name, location, close }: { row: Row | 'archive'; index: ZipIndex; name: string; location: string; close: () => void }) {
  const files = index.entries.filter((e) => !e.dir)
  const unpacked = files.reduce((a, e) => a + e.size, 0)
  const packed = files.reduce((a, e) => a + e.compressed, 0)
  const title = row === 'archive' ? name : row.path.split('/').pop()!
  const rows: [string, string][] =
    row === 'archive'
      ? [
          ['Name', name],
          ['Location', location],
          ['Type', `${FORMAT_LABEL[index.format ?? 'zip']}${index.zip64 ? ' (ZIP64)' : ''}`],
          ['Size', `${formatSize(index.size)} (${index.size.toLocaleString('en-GB')} bytes)`],
          ['Contents', `${files.length.toLocaleString('en-GB')} files, ${formatSize(unpacked)} unpacked`],
          ...(index.format !== 'tar' ? [['Saved', unpacked ? saved({ size: unpacked, packed: index.format === 'tgz' ? index.size : packed }) : '—'] as [string, string]] : []),
          ...(index.comment ? [['Comment', index.comment] as [string, string]] : []),
        ]
      : [
          ['Name', title],
          ['Folder', row.path.split('/').slice(0, -1).join('/') || '/'],
          ['Type', row.dir ? 'Folder' : KIND_LABEL[kindOfName(title)]],
          ...(row.dir
            ? [
                ['Contents', `${row.count} ${row.count === 1 ? 'file' : 'files'}`] as [string, string],
                ['Size', `${formatSize(row.size)} unpacked`] as [string, string],
              ]
            : row.entry?.link !== undefined
              ? [['Link to', row.entry.link] as [string, string]]
              : index.format === 'tar' || index.format === 'tgz'
                ? [
                    ['Size', `${formatSize(row.size)} (${row.size.toLocaleString('en-GB')} bytes)`] as [string, string],
                    ...(row.entry?.mode !== undefined ? [['Permissions', `${perms(row.entry.mode)} (${row.entry.mode.toString(8).padStart(4, '0')})`] as [string, string]] : []),
                    ...(row.entry?.owner ? [['Owner', row.entry.owner] as [string, string]] : []),
                  ]
                : [
                    ['Size', `${formatSize(row.size)} (${row.size.toLocaleString('en-GB')} bytes)`] as [string, string],
                    ['Packed', `${formatSize(row.packed)}${row.size ? `, ${saved(row)} smaller` : ''}`] as [string, string],
                    ['Method', `${METHODS[row.entry!.method] ?? `method ${row.entry!.method}`}${row.entry!.encrypted ? ', encrypted' : ''}`] as [string, string],
                    ['CRC-32', row.entry!.crc.toString(16).padStart(8, '0')] as [string, string],
                  ]),
          ['Modified', row.mtime ? new Date(row.mtime).toLocaleString('en-GB') : '—'],
          ...(row.entry?.comment ? [['Comment', row.entry.comment] as [string, string]] : []),
        ]
  return (
    <div className="fm-modal" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="fm-dialog" role="dialog" aria-label={`${title} properties`} onKeyDown={(e) => (e.stopPropagation(), e.key === 'Escape' && close())}>
        <header>
          <span className="fm-dialog-icon">{row !== 'archive' && row.dir ? <FolderIcon size={40} /> : <FileIcon size={40} kind={row === 'archive' ? 'archive' : kindOfName(title)} name={title} />}</span>
          <strong>{title}</strong>
        </header>
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="fm-dialog-actions">
          <button className="btn btn-primary" autoFocus onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
