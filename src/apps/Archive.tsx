import { useEffect, useMemo, useRef, useState } from 'react'
import { download, fileLink, isSf } from '../data/seafile'
import { folderOf, nameOf, useMedia } from '../data/media'
import { listFolder, METHODS, readZip, type ZipEntry, type ZipIndex } from '../data/zip'
import { useWM, type WinState } from '../os/wm'
import { formatSize, kindOfName } from '../terminal/vfs'

// Archive: what is in a ZIP, browsed like a folder, without unpacking it. Only the archive's table
// of contents is read (from Seafile, just the end of the file), so even a big one opens at once.
// Folders open with a double-click or Enter, Backspace goes up, the columns sort, and the search
// looks through the whole archive. Unpacking comes later.

type Sort = 'name' | 'size' | 'packed' | 'ratio' | 'date'
type Row = { name: string; path: string; dir: boolean; size: number; packed: number; mtime: number; count?: number; entry?: ZipEntry }

const GLYPH: Record<string, string> = { folder: '📁', image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', document: '📃', archive: '🗜️', markdown: '📝', text: '📄' }

export const archiveTitle = (w: WinState) => (w.props.path ? nameOf(w.props.path) : 'Archive')

export function Archive({ win }: { win: WinState }) {
  const wm = useWM()
  const path = win.props.path ?? ''
  const media = useMedia(path)
  const [index, setIndex] = useState<ZipIndex | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [folder, setFolder] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ by: Sort; desc: boolean }>({ by: 'name', desc: false })
  const [selected, setSelected] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isSf(path)) return
    if (media.size === null) return
    let live = true
    setIndex(null)
    setError(null)
    setFolder('')
    fileLink(path, 'download')
      .then((url) => readZip(url, media.size ?? undefined))
      .then((i) => live && setIndex(i))
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [path, media.size === null])

  useEffect(() => {
    if (wm.focusedPid === win.pid && !root.current?.contains(document.activeElement)) list.current?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid])

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

  const enter = (r: Row) => {
    if (!r.dir) return
    setFolder(r.path)
    setQuery('')
    setSelected(null)
  }
  const up = () => {
    if (!folder) return
    const parent = folder.split('/').slice(0, -1).join('/')
    setSelected(folder)
    setFolder(parent)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input')) {
      if (e.key === 'Escape') setQuery('')
      return
    }
    const i = rows.findIndex((r) => r.path === selected)
    if (e.key === 'ArrowDown') setSelected(rows[Math.min(rows.length - 1, i + 1)]?.path ?? null)
    else if (e.key === 'ArrowUp') setSelected(rows[Math.max(0, i - 1)]?.path ?? null)
    else if (e.key === 'Enter' && i >= 0) enter(rows[i])
    else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) up()
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') root.current?.querySelector<HTMLInputElement>('.ar-search')?.focus()
    else return
    e.preventDefault()
  }
  useEffect(() => {
    list.current?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const files = index?.entries.filter((e) => !e.dir) ?? []
  const unpacked = files.reduce((a, e) => a + e.size, 0)
  const packed = files.reduce((a, e) => a + e.compressed, 0)
  const folders = index ? new Set(index.entries.flatMap((e) => e.path.split('/').slice(0, e.dir ? undefined : -1).map((_, i, all) => all.slice(0, i + 1).join('/')))).size : 0
  const chosen = rows.find((r) => r.path === selected)
  const crumbs = folder ? folder.split('/') : []
  const head = (by: Sort, label: string) => (
    <button className={sort.by === by ? 'is-sorted' : ''} onClick={() => setSort((s) => ({ by, desc: s.by === by ? !s.desc : by !== 'name' }))}>
      {label}
      {sort.by === by ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </button>
  )

  return (
    <div ref={root} className="ar" onKeyDown={onKeyDown}>
      <div className="pv-bar">
        <button className="fm-tool" onClick={up} disabled={!folder} title="Up (Backspace)" aria-label="Up">
          ↑
        </button>
        <span className="ar-crumbs">
          <button onClick={() => (setFolder(''), setQuery(''))}>🗜️ {media.name}</button>
          {crumbs.map((c, i) => (
            <span key={i}>
              <span className="muted"> › </span>
              <button onClick={() => (setFolder(crumbs.slice(0, i + 1).join('/')), setQuery(''))}>{c}</button>
            </span>
          ))}
        </span>
        <span className="spacer" />
        <input className="ar-search" placeholder="Search the archive" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the archive" />
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
        <div className="pv-loading">Reading {media.name}…</div>
      ) : (
        <>
          <div className="ar-list" ref={list} tabIndex={0}>
            <div className="ar-row ar-head">
              {head('name', query ? 'Path' : 'Name')}
              {head('size', 'Size')}
              {head('packed', 'Packed')}
              {head('ratio', 'Saved')}
              {head('date', 'Modified')}
            </div>
            {rows.map((r) => (
              <div key={r.path} className={`ar-row ${r.path === selected ? 'is-selected' : ''}`} onClick={() => setSelected(r.path)} onDoubleClick={() => enter(r)} title={r.path}>
                <span className="ar-name">
                  <span className="ar-glyph">{r.dir ? GLYPH.folder : (GLYPH[kindOfName(r.name)] ?? '📄')}</span>
                  {r.name}
                  {r.entry?.encrypted && <span title="Encrypted">🔒</span>}
                </span>
                <span>{r.dir ? `${r.count} ${r.count === 1 ? 'file' : 'files'}` : formatSize(r.size)}</span>
                <span>{r.dir ? formatSize(r.size) : formatSize(r.packed)}</span>
                <span>{r.dir || !r.size ? '' : `${Math.max(0, Math.round((1 - r.packed / r.size) * 100))}%`}</span>
                <span>{r.mtime ? new Date(r.mtime).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span>
              </div>
            ))}
            {!rows.length && <p className="fm-empty">{query ? `Nothing called “${query}” in here.` : 'This folder is empty.'}</p>}
          </div>
          <footer className="fm-status">
            <span>
              {chosen?.entry
                ? `${chosen.entry.path} · ${formatSize(chosen.entry.size)} · ${METHODS[chosen.entry.method] ?? `method ${chosen.entry.method}`}${chosen.entry.encrypted ? ' · encrypted' : ''}${chosen.entry.comment ? ` · ${chosen.entry.comment}` : ''}`
                : `${files.length} files in ${folders} folders · ${formatSize(unpacked)} unpacked · ${formatSize(index.size)} on disk${unpacked ? ` (${Math.max(0, Math.round((1 - packed / unpacked) * 100))}% smaller)` : ''}${index.zip64 ? ' · ZIP64' : ''}`}
            </span>
            <span className="muted">Viewing only</span>
          </footer>
        </>
      )}
    </div>
  )
}
