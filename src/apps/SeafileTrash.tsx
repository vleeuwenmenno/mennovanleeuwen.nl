import { useCallback, useEffect, useMemo, useState } from 'react'
import { cleanTrash, listTrash, listTrashDir, restoreTrash, sfPath, useLibraries, useSeafileHome, type Entry, type TrashItem } from '../data/seafile'
import { openContextMenu } from '../os/ContextMenu'
import { DESKTOP_ICONS } from '../os/Desktop'
import { restoreIcons, useDesktop } from '../os/desktopStore'
import { formatSize, kindOfName } from '../terminal/vfs'

// Files' Trash with Seafile: each library's own trash, as Seafile keeps it (from the library's
// history). Pick the library, restore what was deleted (one by one or several at once), look
// inside a deleted folder and restore from it, and empty the trash of what is older than a few
// days, or all of it. Desktop icons of the site that were put in the trash are listed too.

type Open = { item: TrashItem; path: string } | null

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.round(s / 86400)} days ago`
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

const CLEAN: [number, string][] = [
  [30, 'Older than 30 days'],
  [7, 'Older than 7 days'],
  [3, 'Older than 3 days'],
  [0, 'Everything'],
]

export function SeafileTrash({ onOpenFolder, toast }: { onOpenFolder: (path: string) => void; toast: (text: string) => void }) {
  const { libraries } = useLibraries()
  const { library: primary } = useSeafileHome()
  const writable = useMemo(() => (libraries ?? []).filter((l) => l.permission === 'rw'), [libraries])
  const [repo, setRepo] = useState<string | null>(null)
  const current = repo ?? primary?.id ?? writable[0]?.id ?? null
  const [items, setItems] = useState<TrashItem[] | null>(null)
  const [more, setMore] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Open>(null)
  const [inside, setInside] = useState<Entry[] | null>(null)
  const desk = useDesktop()
  const trashedIcons = DESKTOP_ICONS.filter((i) => desk.trashed.includes(i.id))

  const key = (t: TrashItem) => `${t.commit}:${t.parent}${t.name}`
  const pathOf = (t: TrashItem) => `${t.parent.replace(/\/$/, '')}/${t.name}`

  const load = useCallback(
    (scan: string | null = null) => {
      if (!current) return
      setLoading(true)
      setError(null)
      listTrash(current, scan)
        .then((page) => {
          setItems((old) => (scan && old ? [...old, ...page.items] : page.items))
          setMore(page.more ? page.scan : null)
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false))
    },
    [current],
  )
  useEffect(() => {
    setItems(null)
    setSelected(new Set())
    setOpen(null)
    load()
  }, [load])

  useEffect(() => {
    if (!open || !current) return setInside(null)
    setInside(null)
    listTrashDir(current, open.item.commit, open.path)
      .then(setInside)
      .catch((e: Error) => setError(e.message))
  }, [open, current])

  /** Restores, grouped by the deletion they came from (Seafile restores per deletion). */
  const restore = async (list: { commit: string; path: string }[]) => {
    if (!current || !list.length) return
    const groups = new Map<string, string[]>()
    for (const r of list) groups.set(r.commit, [...(groups.get(r.commit) ?? []), r.path])
    let restored = 0
    const failed: string[] = []
    for (const [commit, paths] of groups) {
      try {
        const res = await restoreTrash(current, commit, paths)
        restored += res.restored.length
        failed.push(...res.failed.map((f) => f.error))
      } catch (e) {
        failed.push((e as Error).message)
      }
    }
    toast(failed.length ? `Restored ${restored}; ${failed.length} could not: ${failed[0]}` : `Restored ${restored === 1 ? list[0].path.split('/').pop() : `${restored} items`}`)
    setSelected(new Set())
    if (!open) load()
  }

  const clean = (days: number) => {
    if (!current) return
    const name = writable.find((l) => l.id === current)?.name ?? 'this library'
    const what = days ? `everything in ${name}'s trash deleted more than ${days} days ago` : `everything in ${name}'s trash`
    if (!confirm(`Delete ${what} for good? This cannot be undone.`)) return
    cleanTrash(current, days)
      .then(() => {
        toast(days ? `Emptied what is older than ${days} days` : 'Emptied the trash')
        load()
      })
      .catch((e: Error) => toast(e.message))
  }

  const chosen = (items ?? []).filter((t) => selected.has(key(t)))
  const toggle = (t: TrashItem, on: boolean) => {
    const next = new Set(selected)
    if (on) next.add(key(t))
    else next.delete(key(t))
    setSelected(next)
  }

  return (
    <div className="st">
      <div className="st-bar">
        <select className="set-select" value={current ?? ''} onChange={(e) => setRepo(e.target.value)} aria-label="Library">
          {writable.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
              {l.encrypted ? ' 🔒' : ''}
            </option>
          ))}
        </select>
        {open && (
          <span className="st-crumb">
            <button onClick={() => setOpen(null)}>Trash</button> › {open.path}
          </span>
        )}
        <span className="spacer" />
        {!open && chosen.length > 0 && (
          <button className="btn btn-small btn-primary" onClick={() => restore(chosen.map((t) => ({ commit: t.commit, path: pathOf(t) })))}>
            Restore {chosen.length}
          </button>
        )}
        {!open && (
          <button className="btn btn-small" onClick={(e) => openContextMenu({ clientX: e.currentTarget.getBoundingClientRect().left, clientY: e.currentTarget.getBoundingClientRect().bottom + 4, preventDefault() {}, stopPropagation() {} }, CLEAN.map(([days, label]) => ({ label, danger: days === 0, onSelect: () => clean(days) })))} disabled={!items?.length}>
            Empty trash ▾
          </button>
        )}
        <button className="btn btn-small" onClick={() => (open ? setOpen({ ...open }) : load())} title="Refresh">
          ↻
        </button>
      </div>

      {error && <p className="t-red st-note">{error === 'That library is locked: open it in Files and give its password first' ? `${error}.` : error}</p>}

      {open ? (
        <ul className="st-list">
          {inside === null && <li className="st-note muted">Loading…</li>}
          {inside?.map((e) => (
            <li key={e.name} className="st-row">
              <span className="st-icon">{e.dir ? '📁' : '📄'}</span>
              <span className="st-name">{e.name}</span>
              <span className="st-meta muted">{e.dir ? 'Folder' : formatSize(e.size)}</span>
              <span className="st-actions">
                {e.dir && (
                  <button className="btn btn-small" onClick={() => setOpen({ item: open.item, path: `${open.path}/${e.name}` })}>
                    Open
                  </button>
                )}
                <button className="btn btn-small" onClick={() => restore([{ commit: open.item.commit, path: `${open.path}/${e.name}` }])}>
                  Restore
                </button>
              </span>
            </li>
          ))}
          {inside?.length === 0 && <li className="st-note muted">It was empty.</li>}
        </ul>
      ) : (
        <ul className="st-list">
          {items === null && !error && <li className="st-note muted">Loading the trash…</li>}
          {items?.map((t) => (
            <li key={key(t)} className={`st-row ${selected.has(key(t)) ? 'is-selected' : ''}`} onDoubleClick={() => t.dir && setOpen({ item: t, path: pathOf(t) })}>
              <input type="checkbox" checked={selected.has(key(t))} onChange={(e) => toggle(t, e.target.checked)} aria-label={`Select ${t.name}`} />
              <span className="st-icon">{t.dir ? '📁' : kindOfName(t.name) === 'image' ? '🖼️' : '📄'}</span>
              <span className="st-name" title={pathOf(t)}>
                {t.name}
                <span className="muted st-from">
                  {' '}
                  in{' '}
                  <button className="st-link" onClick={() => current && onOpenFolder(sfPath(current, t.parent.replace(/\/$/, '') || '/'))}>
                    {t.parent === '/' ? 'the library' : t.parent.replace(/\/$/, '')}
                  </button>
                </span>
              </span>
              <span className="st-meta muted">
                {t.dir ? 'Folder' : formatSize(t.size)} · {ago(t.deleted)}
              </span>
              <span className="st-actions">
                {t.dir && (
                  <button className="btn btn-small" onClick={() => setOpen({ item: t, path: pathOf(t) })}>
                    Open
                  </button>
                )}
                <button className="btn btn-small" onClick={() => restore([{ commit: t.commit, path: pathOf(t) }])}>
                  Restore
                </button>
              </span>
            </li>
          ))}
          {items?.length === 0 && <li className="st-note muted">The trash of this library is empty.</li>}
          {more && (
            <li className="st-note">
              <button className="btn btn-small" disabled={loading} onClick={() => load(more)}>
                {loading ? 'Loading…' : 'Show older'}
              </button>
            </li>
          )}
        </ul>
      )}

      {!open && trashedIcons.length > 0 && (
        <>
          <p className="st-head">Desktop icons</p>
          <ul className="st-list">
            {trashedIcons.map((i) => (
              <li key={i.id} className="st-row">
                <span className="st-icon">{i.glyph}</span>
                <span className="st-name">{desk.names[i.id] ?? i.label}</span>
                <span className="st-meta muted">The site's own</span>
                <span className="st-actions">
                  <button className="btn btn-small" onClick={() => restoreIcons([i.id])}>
                    Put back
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="st-note muted">Seafile keeps deleted things in each library's history; emptying the trash removes them for good. A restored item goes back where it was.</p>
    </div>
  )
}
