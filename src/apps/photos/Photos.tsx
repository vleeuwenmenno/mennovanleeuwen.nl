import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { signIn, useAccount } from '../../os/account'
import { useBackButton } from '../../os/backButton'
import { useIsMobile } from '../../os/useIsMobile'
import { useWM, type WinState } from '../../os/wm'
import { getAlbums, loadStatus, photosPrefs, thumbUrl, useStatus, type Album, type SourceId } from '../../data/photos'
import { Grid, ZOOMS } from './Grid'
import { Lightbox } from './Lightbox'
import { JobStatus, PhotosSettings } from './PhotosSettings'
import { useTimeline } from './useTimeline'
import './photos.css'

// Photos: a timeline of the photos and videos in your Seafile folders or your Immich library,
// by the date they were taken, with albums (Seafile: the folders chosen; Immich: its albums),
// favourites and a lightbox. With both set up, the toolbar switches between them (remembered for
// the account); they are not mixed into one timeline.

type View = 'timeline' | 'albums' | 'favourites' | 'settings'

export function Photos({ win }: { win: WinState }) {
  const account = useAccount()
  const wm = useWM()
  const phone = useIsMobile()
  const { status, error } = useStatus()
  const prefs = photosPrefs.use()
  const [view, setView] = useState<View>('timeline')
  const [album, setAlbum] = useState<Album | null>(null)
  const [open, setOpen] = useState<string | null>(null)
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

  useBackButton(win.pid, {
    back: () => (open ? setOpen(null) : album ? setAlbum(null) : view !== 'timeline' ? setView('timeline') : undefined),
  })
  useEffect(() => {
    if (wm.focusedPid === win.pid && !open && !root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid, open])

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
  if (!status) return <div className="ph-blank muted">{error ?? 'Loading…'}</div>

  const nothing = !available.length
  const noFolders = source === 'seafile' && !status.seafile?.sources.length
  const current: View = nothing || noFolders ? 'settings' : view
  const tabs: { id: View; label: string }[] = [
    { id: 'timeline', label: 'Photos' },
    { id: 'albums', label: 'Albums' },
    { id: 'favourites', label: 'Favourites' },
  ]
  const running = job && !job.finished && source === 'seafile'

  const onFavourite = (id: string, on: boolean) => timeline.patch(id, { fav: on })
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
    <div className={`ph ${phone ? 'is-phone' : ''}`} ref={root} tabIndex={-1}>
      <div className="ph-bar">
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
        <div className="ph-blank t-red">{timeline.error}</div>
      ) : !timeline.buckets ? (
        <div className="ph-blank muted">Loading…</div>
      ) : (
        <Grid key={`${source}|${filter.album}|${filter.favourites}`} source={source!} timeline={timeline} zoom={zoom} onZoom={setZoom} onOpen={(i) => setOpen(timeline.flat[i]?.id ?? null)} empty={empty} />
      )}
      {open && index >= 0 && source && <Lightbox source={source} items={timeline.flat} index={index} onIndex={(i) => setOpen(timeline.flat[i].id)} onClose={() => (setOpen(null), root.current?.focus({ preventScroll: true }))} onFavourite={onFavourite} phone={phone} />}
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
  if (error) return <div className="ph-blank t-red">{error}</div>
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
