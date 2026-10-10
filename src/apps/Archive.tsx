import { useEffect, useMemo, useRef, useState } from 'react'
import { besideArchive, cancelExtract, dismissExtract, extract, useExtractJobs, type Clash } from '../data/extract'
import { posixOf } from '../data/mounts'
import { download, isSf, libraryName, parseSf } from '../data/seafile'
import { pickFolder } from '../os/FolderPicker'
import { folderOf, nameOf, useMedia } from '../data/media'
import { listFolder, METHODS, readZip, type ZipEntry, type ZipIndex } from '../data/zip'
import { useWM, type WinState } from '../os/wm'
import { useBackButton } from '../os/backButton'
import { formatSize, kindOfName, prettyPath } from '../terminal/vfs'

// Archive: what is in a ZIP, browsed like a folder, without unpacking it. Only the archive's table
// of contents is read (from Seafile, just the end of the file), so even a big one opens at once.
// Folders open with a double-click or Enter, Backspace goes up, the columns sort, and the search
// looks through the whole archive. Extract unpacks everything, or what is selected (Ctrl/Shift+
// click, Ctrl+A), into a Seafile folder; the server does it (data/extract.ts, server/unzip.ts).

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
  // Rows picked for unpacking (the cursor is `selected`).
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [panel, setPanel] = useState<{ into: string; clash: Clash } | null>(null)
  const jobs = useExtractJobs().filter((j) => j.zip === path)
  const job = jobs[jobs.length - 1]
  const list = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isSf(path)) return
    if (media.size === null) return
    let live = true
    setIndex(null)
    setError(null)
    setFolder('')
    // Ranges go through the site's server: Seafile's file server sends no CORS headers on them.
    const at = parseSf(path)!
    readZip(`/api/seafile/raw?repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}`, media.size ?? undefined)
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
    setPicked(new Set())
  }
  /** Click: just this row; Ctrl: add or take off; Shift: everything from the last click. */
  const pick = (r: Row, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    if (e.shiftKey && selected) {
      const a = rows.findIndex((x) => x.path === selected)
      const b = rows.findIndex((x) => x.path === r.path)
      setPicked(new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path)))
      return
    }
    setSelected(r.path)
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(picked)
      if (next.has(r.path)) next.delete(r.path)
      else next.add(r.path)
      setPicked(next)
    } else setPicked(new Set([r.path]))
  }
  const where = (sf: string) => {
    const px = posixOf(sf)
    if (px) return prettyPath(px)
    const at = parseSf(sf)!
    return `${libraryName(at.repo)}${at.p === '/' ? '' : at.p}`
  }
  const startExtract = () => {
    if (!panel) return
    const entries = picked.size ? [...picked] : undefined
    setPanel(null)
    void extract(path, panel.into, { entries, base: query ? '' : folder, clash: panel.clash }).catch((e: Error) => setError(e.message))
  }
  const up = () => {
    if (!folder) return
    const parent = folder.split('/').slice(0, -1).join('/')
    setSelected(folder)
    setFolder(parent)
  }

  useBackButton(win.pid, { back: up })

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input')) {
      if (e.key === 'Escape') setQuery('')
      return
    }
    const i = rows.findIndex((r) => r.path === selected)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = rows[e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)]
      setSelected(next?.path ?? null)
      setPicked(next ? new Set([next.path]) : new Set())
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') setPicked(new Set(rows.map((r) => r.path)))
    else if (e.key === 'Escape') setPicked(new Set())
    else if (e.key === 'Enter' && i >= 0) enter(rows[i])
    else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) up()
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') root.current?.querySelector<HTMLInputElement>('.ar-search')?.focus()
    else return
    e.preventDefault()
  }
  useEffect(() => {
    list.current?.querySelector('.is-cursor')?.scrollIntoView({ block: 'nearest' })
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
        <button className="btn btn-small" disabled={!index} onClick={() => setPanel(panel ? null : { into: besideArchive(path), clash: 'keep' })}>
          {picked.size ? `Extract ${picked.size}…` : 'Extract all…'}
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
        <div className="pv-loading">Reading {media.name}…</div>
      ) : (
        <>
          {panel && (
            <div className="ar-panel">
              <span>
                Extract {picked.size ? `${picked.size} selected` : 'everything'} into <strong>{where(panel.into)}</strong>
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
          <div className="ar-list" ref={list} tabIndex={0}>
            <div className="ar-row ar-head">
              {head('name', query ? 'Path' : 'Name')}
              {head('size', 'Size')}
              {head('packed', 'Packed')}
              {head('ratio', 'Saved')}
              {head('date', 'Modified')}
            </div>
            {rows.map((r) => (
              <div key={r.path} className={`ar-row ${picked.has(r.path) ? 'is-selected' : ''} ${r.path === selected ? 'is-cursor' : ''}`} onClick={(e) => pick(r, e)} onDoubleClick={() => enter(r)} title={r.path}>
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
            {job ? (
              <span className="ar-job">
                {job.status.state === 'running' ? (
                  <>
                    <span className="ar-bar" aria-hidden>
                      <i style={{ width: `${job.status.totalBytes ? Math.round((job.status.bytes / job.status.totalBytes) * 100) : 0}%` }} />
                    </span>
                    Unpacking {job.status.count} of {job.status.total}
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
            ) : (
              <span className="muted">{picked.size ? `${picked.size} selected` : 'Click, Ctrl+click or Shift+click to pick what to extract'}</span>
            )}
          </footer>
        </>
      )}
    </div>
  )
}
