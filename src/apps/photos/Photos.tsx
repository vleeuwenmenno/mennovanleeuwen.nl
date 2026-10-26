import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { signIn, useAccount } from '../../os/account'
import { useBackButton } from '../../os/backButton'
import { openContextMenu, openMenuAt } from '../../os/ContextMenu'
import { holdToDrag, startNativeDrag } from '../../os/dnd'
import { useIsMobile } from '../../os/useIsMobile'
import { useWM, type WinState } from '../../os/wm'
import { getAlbums, loadStatus, photosPrefs, thumbUrl, useStatus, type Album, type Item, type SourceId } from '../../data/photos'
import { loadLibraries } from '../../data/seafile'
import { dragOf, download, favourite, gridMenu, photoMenu, trash, type Ctx, type Toast } from './actions'
import { Grid, ZOOMS, type GridSelection, type TileActions } from './Grid'
import { Lightbox } from './Lightbox'
import { JobStatus, PhotosSettings } from './PhotosSettings'
import { useTimeline } from './useTimeline'
import './photos.css'
import { toUi } from '../../os/uiScale'

// Photos: a timeline of the photos and videos in your Seafile folders or your Immich library,
// by the date they were taken, with albums (Seafile: the folders chosen; Immich: its albums),
// favourites and a lightbox. With both set up, the toolbar switches between them (remembered for
// the account); they are not mixed into one timeline.

type View = 'timeline' | 'albums' | 'favourites' | 'settings'
type Selection = { ids: Set<string>; anchor: string | null }
const NONE: Selection = { ids: new Set(), anchor: null }
const LONG_PRESS_MS = 450

export function Photos({ win }: { win: WinState }) {
  const account = useAccount()
  const wm = useWM()
  const phone = useIsMobile()
  const { status, error } = useStatus()
  const prefs = photosPrefs.use()
  const [view, setView] = useState<View>('timeline')
  const [album, setAlbum] = useState<Album | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [openInfo, setOpenInfo] = useState(false)
  const [sel, setSel] = useState<Selection>(NONE)
  const [toast, setToast] = useState<Toast | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => void loadStatus(), [])

  const available = useMemo(() => [status?.seafile ? 'seafile' : null, status?.immich ? 'immich' : null].filter(Boolean) as SourceId[], [status?.seafile, status?.immich])
  const source: SourceId | null = prefs.source && available.includes(prefs.source) ? prefs.source : (available[0] ?? null)
  const setSource = (s: SourceId) => {
    photosPrefs.set((p) => ({ ...p, source: s }))
    setAlbum(null)
    setOpen(null)
  }
  const zoom = Math.max(0, Math.min(ZOOMS.length - 1, prefs.zoom ?? (phone ? 1 : 2)))
  const setZoom = useCallback((z: number) => photosPrefs.set((p) => ({ ...p, zoom: z })), [])

  // The walk of the Seafile folders adds photos as it goes: the timeline follows every few seconds, and once more at the end.
  const job = status?.seafile?.job ?? null
  const [refresh, setRefresh] = useState(0)
  const lastRefresh = useRef(0)
  useEffect(() => {
    if (!job || source !== 'seafile') return
    if (job.finished || Date.now() - lastRefresh.current > 4000) {
      lastRefresh.current = Date.now()
      setRefresh((n) => n + 1)
    }
  }, [job?.read, job?.added, job?.removed, job?.finished, source]) // eslint-disable-line react-hooks/exhaustive-deps

  const filter = useMemo(() => ({ album: view === 'albums' ? (album?.id ?? null) : null, favourites: view === 'favourites' }), [view, album])
  const showGrid = !!source && (view === 'timeline' || view === 'favourites' || (view === 'albums' && !!album))
  const timeline = useTimeline(showGrid ? source : null, filter, refresh)
  const index = open ? timeline.flat.findIndex((i) => i.id === open) : -1

  // The selection is ids, so it outlives the rows that scroll out of the page. Another source,
  // album or view starts without one.
  const gridKey = `${source}|${filter.album}|${filter.favourites}`
  useEffect(() => setSel(NONE), [gridKey])
  const byId = useMemo(() => new Map(timeline.flat.map((i) => [i.id, i])), [timeline.flat])
  const order = useMemo(() => new Map(timeline.flat.map((i, n) => [i.id, n])), [timeline.flat])
  const selecting = sel.ids.size > 0

  // Immich's albums, for "Add to album", asked once per source.
  const [albums, setAlbums] = useState<Album[] | null>(null)
  useEffect(() => {
    setAlbums(null)
    if (source === 'immich') getAlbums('immich').then(setAlbums, () => setAlbums([]))
    // Seafile's libraries: which are read-only, for the menus.
    if (source === 'seafile') void loadLibraries().catch(() => {})
  }, [source])

  // A message at the bottom (with Undo when it can be taken back), for a few seconds.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.undo ? 10_000 : 4000)
    return () => clearTimeout(t)
  }, [toast])

  useBackButton(win.pid, {
    back: () => (open ? setOpen(null) : selecting ? setSel(NONE) : album ? setAlbum(null) : view !== 'timeline' ? setView('timeline') : undefined),
  })
  useEffect(() => {
    if (wm.focusedPid === win.pid && !open && !root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid, open])

  const openPhoto = (id: string, info = false) => {
    setOpenInfo(info)
    setOpen(id)
  }
  const ctx: Ctx = {
    source: source ?? 'seafile',
    timeline,
    byId,
    immichUrl: status?.immich?.url ?? null,
    albums,
    wm,
    zoom,
    setZoom,
    open: openPhoto,
    selectAll: () => setSel({ ids: new Set(timeline.flat.map((i) => i.id)), anchor: sel.anchor }),
    clear: () => setSel(NONE),
    hasSelection: selecting,
    toast: setToast,
    removed: (ids) => {
      const gone = new Set(ids)
      // The lightbox goes on to the next photo (or the one before, at the end).
      if (open && gone.has(open)) {
        const at = timeline.flat.findIndex((i) => i.id === open)
        const next = timeline.flat.slice(at + 1).find((i) => !gone.has(i.id)) ?? timeline.flat.slice(0, Math.max(0, at)).reverse().find((i) => !gone.has(i.id))
        setOpen(next?.id ?? null)
      }
      timeline.remove(gone)
      setSel((s) => (ids.some((id) => s.ids.has(id)) ? { ids: new Set([...s.ids].filter((id) => !gone.has(id))), anchor: s.anchor && gone.has(s.anchor) ? null : s.anchor } : s))
    },
    refresh: () => setRefresh((n) => n + 1),
  }
  /** What a menu or key acts on: the selection when `id` is in it (or no id is given), else just `id`. */
  const targetOf = (id?: string | null) => (id && !sel.ids.has(id) ? [id] : [...sel.ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)))

  // How tiles answer clicks, holds and drags: one object, always the newest (the tiles keep it).
  const lastPointer = useRef<string>('mouse')
  /** A long press selected: the click its lift sends is not also a tap. */
  const suppressClick = useRef(false)
  const range = (from: string | null, to: string): string[] => {
    const a = from !== null ? order.get(from) : undefined
    const b = order.get(to)
    if (a === undefined || b === undefined) return [to]
    return timeline.flat.slice(Math.min(a, b), Math.max(a, b) + 1).map((i) => i.id)
  }
  const toggle = (id: string) =>
    setSel((s) => {
      const ids = new Set(s.ids)
      if (ids.has(id)) ids.delete(id)
      else ids.add(id)
      return { ids, anchor: id }
    })
  const addRange = (id: string) => setSel((s) => ({ ids: new Set([...s.ids, ...range(s.anchor, id)]), anchor: s.anchor ?? id }))
  const tileActs: TileActions = {
    click: (item, e) => {
      if (suppressClick.current) return void (suppressClick.current = false)
      // Shift and Ctrl/Cmd select whatever is selected; a plain click or tap opens, or (once
      // something is selected) takes the photo in or out. The circle is how selecting starts.
      if (e.shiftKey) addRange(item.id)
      else if (e.ctrlKey || e.metaKey || selecting) toggle(item.id)
      else openPhoto(item.id)
    },
    check: (item, e) => (e.shiftKey && sel.anchor ? addRange(item.id) : toggle(item.id)),
    menu: (item, e) => {
      // A finger's long press selects (below); the browser's own menu for it is not wanted.
      if (lastPointer.current === 'touch') return e.preventDefault()
      openContextMenu(e, photoMenu(ctx, targetOf(item.id)))
    },
    drag: (item, e) => {
      const ids = targetOf(item.id)
      const d = dragOf(ctx, ids)
      if (!d.items.length) return e.preventDefault()
      startNativeDrag(e, d.items, 'photos', { files: d.files, text: ids.length === 1 ? (d.items[0].kind === 'file' ? d.items[0].path : '') : undefined })
    },
    press: (item, e) => {
      lastPointer.current = e.pointerType
      suppressClick.current = false
      if (e.pointerType !== 'touch') return
      // Holding a selected photo drags the selection; holding any other starts (or adds to) the selection.
      if (selecting && sel.ids.has(item.id)) return holdToDrag(e, () => dragOf(ctx, targetOf(item.id)).items, 'photos', ctx.source === 'immich' ? dragOf(ctx, targetOf(item.id)).files : undefined)
      if (selecting) return
      const start = { x: toUi(e.clientX), y: toUi(e.clientY) }
      const timer = setTimeout(() => {
        stop()
        suppressClick.current = true
        try {
          navigator.vibrate?.(10)
        } catch {
          /* no vibration */
        }
        setSel({ ids: new Set([item.id]), anchor: item.id })
      }, LONG_PRESS_MS)
      const move = (ev: PointerEvent) => Math.hypot(toUi(ev.clientX) - start.x, toUi(ev.clientY) - start.y) > 10 && stop()
      function stop() {
        clearTimeout(timer)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
        window.removeEventListener('scroll', stop, true)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
      window.addEventListener('scroll', stop, true)
    },
  }
  const act = useRef(tileActs)
  act.current = tileActs
  const gridSel: GridSelection = {
    selected: sel.ids,
    selecting,
    act,
    toggleAll: (ids) => setSel((s) => ({ ids: ids.every((id) => s.ids.has(id)) ? new Set([...s.ids].filter((id) => !ids.includes(id))) : new Set([...s.ids, ...ids]), anchor: s.anchor })),
    box: (ids, base) => setSel((s) => ({ ids: new Set([...base, ...ids]), anchor: s.anchor })),
    emptyClick: (e) => !(e.ctrlKey || e.metaKey || e.shiftKey) && setSel(NONE),
    emptyMenu: (e) => openContextMenu(e, gridMenu(ctx)),
  }

  // Keys on the grid: Ctrl+A, Escape, Delete, Enter, I (with the details), the period, and the menu key (or Shift+F10).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (open || !source || (e.target as HTMLElement).closest('input, textarea, select, .ph-settings')) return
    const ctrl = e.ctrlKey || e.metaKey
    const ids = targetOf()
    if (ctrl && e.key.toLowerCase() === 'a') ctx.selectAll()
    else if (e.key === 'Escape' && selecting) setSel(NONE)
    else if (e.key === 'Delete' && ids.length) void trash(ctx, ids)
    else if (e.key === 'Enter' && ids.length) openPhoto(sel.anchor && sel.ids.has(sel.anchor) ? sel.anchor : ids[0])
    else if (e.key === '.' && ids.length) void favourite(ctx, ids)
    else if ((e.key === 'i' || e.key === 'I') && !ctrl && ids.length) openPhoto(sel.anchor && sel.ids.has(sel.anchor) ? sel.anchor : ids[0], true)
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const tile = sel.anchor ? root.current?.querySelector(`.ph-tile[data-id="${CSS.escape(sel.anchor)}"]`) : null
      const r = (tile ?? root.current?.querySelector('.ph-scroll'))?.getBoundingClientRect()
      if (!r) return
      const at = { clientX: r.left + Math.min(r.width / 2, 40), clientY: r.top + Math.min(r.height / 2, 40), preventDefault() {}, stopPropagation() {} }
      openContextMenu(at, ids.length ? photoMenu(ctx, ids) : gridMenu(ctx))
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  if (account.status === 'loading') return <div className="ph-blank muted">Loading…</div>
  if (account.status !== 'user')
    return (
      <div className="ph-blank">
        <p className="muted">Photos shows the photos in your Seafile or Immich, for signed-in users.</p>
        {account.status === 'anon' && (
          <button className="btn btn-primary" onClick={signIn}>
            Sign in with GitHub
          </button>
        )}
      </div>
    )
  if (!status) return <div className="ph-blank muted copyable">{error ?? 'Loading…'}</div>

  const nothing = !available.length
  const noFolders = source === 'seafile' && !status.seafile?.sources.length && !status.seafile?.unavailable
  const current: View = nothing || noFolders ? 'settings' : view
  const tabs: { id: View; label: string }[] = [
    { id: 'timeline', label: 'Photos' },
    { id: 'albums', label: 'Albums' },
    { id: 'favourites', label: 'Favourites' },
  ]
  const running = job && !job.finished && source === 'seafile'

  const onFavourite = (id: string, on: boolean) => timeline.patch(id, { fav: on })
  const selected: Item[] = selecting ? targetOf().map((id) => byId.get(id)).filter((i): i is Item => !!i) : []
  const allFav = selected.length > 0 && selected.every((i) => i.fav)
  const empty = (
    <div className="ph-blank">
      {view === 'favourites' ? (
        <p className="muted">No favourites yet: open a photo and press ♡ (or the full stop key).</p>
      ) : running ? (
        <>
          <p className="muted">Looking for photos…</p>
          <JobStatus job={job} scannedAt={null} />
        </>
      ) : (
        <p className="muted">No photos here.</p>
      )}
    </div>
  )

  return (
    <div className={`ph ${phone ? 'is-phone' : ''}`} ref={root} tabIndex={-1} onKeyDown={onKeyDown}>
      {selecting && showGrid && current !== 'settings' && (
        <div className="ph-bar ph-selbar" role="toolbar" aria-label="Selection">
          <button className="ph-lb-btn ph-sel-x" onClick={() => setSel(NONE)} aria-label="Clear the selection" title="Clear the selection (Esc)">
            ✕
          </button>
          <strong className="ph-bar-title">{sel.ids.size.toLocaleString()} selected</strong>
          <span className="spacer" />
          <button className="ph-lb-btn" onClick={() => void favourite(ctx, targetOf())} aria-label={allFav ? 'Unfavourite' : 'Favourite'} title={allFav ? 'Unfavourite (.)' : 'Favourite (.)'}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill={allFav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
              <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
            </svg>
          </button>
          <button className="ph-lb-btn" onClick={() => void download(ctx, targetOf())} aria-label="Download" title={sel.ids.size > 1 ? 'Download as a ZIP' : 'Download'}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
            </svg>
          </button>
          <button className="ph-lb-btn" onClick={() => void trash(ctx, targetOf())} aria-label="Move to trash" title="Move to trash (Del)">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
            </svg>
          </button>
          <button className="ph-lb-btn" onClick={(e) => openMenuAt(e.currentTarget, photoMenu(ctx, targetOf()))} aria-label="More" title="More">
            ⋯
          </button>
        </div>
      )}
      <div className="ph-bar" hidden={selecting && showGrid && current !== 'settings'}>
        {album && current === 'albums' ? (
          <>
            <button className="btn btn-small" onClick={() => setAlbum(null)}>
              ‹ Albums
            </button>
            <strong className="ph-bar-title">{album.name}</strong>
          </>
        ) : (
          <div className="ph-tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={current === t.id} className={current === t.id ? 'is-on' : ''} disabled={nothing || noFolders} onClick={() => setView(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        {running && (
          <span className="ph-progress" title={job.state === 'reading' ? `Reading ${job.read} of ${job.toRead}` : 'Looking through folders'}>
            <span className="ph-spinner" aria-hidden />
            {!phone && (job.state === 'reading' ? `${job.read.toLocaleString()} / ${job.toRead.toLocaleString()}` : 'Indexing…')}
          </span>
        )}
        {available.length > 1 && (
          <div className="ph-switch" role="group" aria-label="Source">
            {available.map((s) => (
              <button key={s} className={source === s ? 'is-on' : ''} aria-pressed={source === s} onClick={() => setSource(s)}>
                {s === 'seafile' ? 'Seafile' : 'Immich'}
              </button>
            ))}
          </div>
        )}
        {!phone && showGrid && current !== 'settings' && (
          <div className="ph-zoom" role="group" aria-label="Zoom">
            <button onClick={() => setZoom(zoom - 1)} disabled={zoom === 0} aria-label="Smaller" title="Smaller (Ctrl+wheel)">
              −
            </button>
            <button onClick={() => setZoom(zoom + 1)} disabled={zoom === ZOOMS.length - 1} aria-label="Bigger" title="Bigger (Ctrl+wheel)">
              +
            </button>
          </div>
        )}
        <button className={`ph-gear ${current === 'settings' ? 'is-on' : ''}`} onClick={() => setView(current === 'settings' && !nothing && !noFolders ? 'timeline' : 'settings')} aria-label="Photo sources" title="Photo sources">
          ⚙
        </button>
      </div>
      {current === 'settings' ? (
        <div className="ph-scroll ph-pad">
          {nothing && <p className="ph-intro">Photos shows the photos and videos in your Seafile folders or your Immich library, by the date they were taken. Set up one (or both) to start.</p>}
          {noFolders && !nothing && <p className="ph-intro">Choose the Seafile folders your photos are in.</p>}
          <PhotosSettings />
        </div>
      ) : current === 'albums' && !album ? (
        <Albums source={source!} onOpen={setAlbum} />
      ) : timeline.error ? (
        <div className="ph-blank t-red copyable">{timeline.error}</div>
      ) : !timeline.buckets ? (
        <div className="ph-blank muted">Loading…</div>
      ) : (
        <Grid key={gridKey} source={source!} timeline={timeline} zoom={zoom} onZoom={setZoom} sel={gridSel} empty={empty} />
      )}
      {open && index >= 0 && source && (
        <Lightbox
          source={source}
          items={timeline.flat}
          index={index}
          onIndex={(i) => setOpen(timeline.flat[i].id)}
          onClose={() => (setOpen(null), root.current?.focus({ preventScroll: true }))}
          onFavourite={onFavourite}
          phone={phone}
          info={openInfo}
          menu={(id) => photoMenu(ctx, [id], { lightbox: true })}
          onTrash={(id) => void trash(ctx, [id])}
        />
      )}
      {toast && (
        <div className="ph-toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              className="btn btn-small"
              onClick={() => {
                const undo = toast.undo!
                setToast({ text: 'Putting them back…' })
                void undo()
              }}
            >
              Undo
            </button>
          )}
          <button className="ph-toast-x" onClick={() => setToast(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

/** The albums: Seafile's chosen folders, or Immich's albums, each with its newest photo. */
function Albums({ source, onOpen }: { source: SourceId; onOpen: (a: Album) => void }) {
  const [albums, setAlbums] = useState<Album[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setAlbums(null)
    getAlbums(source).then(setAlbums, (e: Error) => setError(e.message))
  }, [source])
  if (error) return <div className="ph-blank t-red copyable">{error}</div>
  if (!albums) return <div className="ph-blank muted">Loading…</div>
  if (!albums.length) return <div className="ph-blank muted">{source === 'immich' ? 'No albums in Immich yet.' : 'No folders chosen yet.'}</div>
  return (
    <div className="ph-scroll ph-pad">
      <div className="ph-albums">
        {albums.map((a) => (
          <button key={a.id} className="ph-album" onClick={() => onOpen(a)}>
            <span className="ph-album-cover">{a.cover ? <img src={thumbUrl(source, a.cover, 'medium')} alt="" loading="lazy" /> : <span aria-hidden>🖼</span>}</span>
            <strong>{a.name}</strong>
            <span className="muted">
              {a.count.toLocaleString()} {a.count === 1 ? 'item' : 'items'}
              {a.detail ? ` · ${a.detail}` : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
