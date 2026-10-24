import { useEffect, useRef, useState } from 'react'
import { api } from '../../os/account'
import { accountGuard, TAB_ACCOUNT } from '../../os/accountSpace'
import { Select } from '../../os/Select'
import { getAlbums, getBucket, getBuckets, getInfo, thumbUrl, monthTitle, type Album, type Bucket, type Item, type SourceId, type Status } from '../../data/photos'
import { readPhotoOriginal } from '../../data/photoAttachments'
import { toAttachment, type Attachment } from '../../data/agents'
import { ImageDialog } from '../AgentsModelBrowser'
import './photoPicker.css'

type Selection = { source: SourceId; item: Item }
const sourceName = (source: SourceId) => source === 'immich' ? 'Immich' : 'Seafile'
const dateLabel = (wall: number) => new Date(wall).toLocaleDateString(undefined, { timeZone: 'UTC', dateStyle: 'medium' })
const selectionKey = ({ source, item }: Selection) => `${source}:${item.id}`

/** Read-only library browsing; nothing reaches the composer until all selected originals load. */
export function PhotoPicker({ limit, onAttach, onClose }: { limit: number; onAttach: (files: Attachment[]) => void; onClose: () => void }) {
  const [sources, setSources] = useState<SourceId[]>([])
  const [source, setSource] = useState<SourceId | null>(null)
  const [albums, setAlbums] = useState<Album[]>([])
  const [album, setAlbum] = useState('')
  const [search, setSearch] = useState('')
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [month, setMonth] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [visible, setVisible] = useState(120)
  const [selected, setSelected] = useState<Selection[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingItems, setLoadingItems] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [reading, setReading] = useState(false)
  const alive = useRef(true)
  const download = useRef<AbortController | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false; download.current?.abort() } }, [])
  useEffect(() => {
    let current = true
    setLoading(true); setError('')
    void api<Status>('/api/photos/status').then((status) => {
      if (!current) return
      const available: SourceId[] = [...(status.seafile ? ['seafile' as const] : []), ...(status.immich ? ['immich' as const] : [])]
      setSources(available); setSource((value) => value && available.includes(value) ? value : available[0] ?? null)
    }).catch((e: Error) => { if (current) setError(e.message) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [revision])
  useEffect(() => {
    if (!source) return
    let current = true
    setAlbums([])
    void getAlbums(source).then((value) => { if (current) setAlbums(value) }).catch((e: Error) => { if (current) setError(e.message) })
    return () => { current = false }
  }, [source, revision])
  useEffect(() => {
    if (!source) return
    let current = true
    setLoadingItems(true); setError(''); setBuckets([]); setMonth(''); setItems([])
    void getBuckets(source, { album: album || null }).then((value) => {
      if (current) { setBuckets(value); setMonth(value[0]?.key ?? ''); if (!value.length) setLoadingItems(false) }
    }).catch((e: Error) => { if (current) { setError(e.message); setLoadingItems(false) } })
    return () => { current = false }
  }, [source, album, revision])
  useEffect(() => {
    if (!source || !month) return
    let current = true
    setLoadingItems(true); setItems([]); setVisible(120)
    void getBucket(source, month, { album: album || null }).then((value) => { if (current) setItems(value.filter((item) => !item.video)) })
      .catch((e: Error) => { if (current) setError(e.message) }).finally(() => { if (current) setLoadingItems(false) })
    return () => { current = false }
  }, [source, month, album, revision])
  const close = () => { download.current?.abort(); onClose() }
  const toggle = (value: Selection) => {
    const key = selectionKey(value)
    setError('')
    if (selected.some((item) => selectionKey(item) === key)) setSelected((all) => all.filter((item) => selectionKey(item) !== key))
    else if (selected.length >= limit) setError(`You can attach ${limit} more photo${limit === 1 ? '' : 's'}. Remove an attachment first.`)
    else setSelected((all) => [...all, value])
  }
  const attach = async () => {
    if (reading || !selected.length) return
    const abort = new AbortController(); download.current = abort
    setReading(true); setError('')
    try {
      const attachments: Attachment[] = []
      for (const { source, item } of selected) {
        if (!accountGuard()) throw new Error('Signed in as another account')
        const info = await getInfo(source, item.id)
        abort.signal.throwIfAborted()
        if (info.kind !== 'image') throw new Error('Choose photos, not videos.')
        const blob = await readPhotoOriginal(source, item.id, { signal: abort.signal, headers: { 'X-MvL-Account': TAB_ACCOUNT } })
        attachments.push(await toAttachment(blob, info.name, `Photos: ${sourceName(source)}`))
      }
      if (!alive.current || abort.signal.aborted || !accountGuard()) return
      onAttach(attachments)
      onClose()
    } catch (e) { if (alive.current && !abort.signal.aborted) setError((e as Error).message) }
    finally { if (alive.current) setReading(false) }
  }
  const matchingAlbums = albums.filter((entry) => entry.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  return <ImageDialog title="Attach from Photos" onClose={close} wide>
    <div className="photo-picker-controls">
      <p className="muted">Choose original images from your Photos libraries. PNG, JPEG, WebP or GIF; up to 5 MB each.</p>
      {sources.length > 0 && <>
        <label>Library<Select value={source} options={sources.map((value) => ({ value, label: sourceName(value) }))} disabled={reading} onChange={(value) => { setSource(value); setAlbum(''); setSearch('') }} aria-label="Photo library" /></label>
        <label>Find album<input type="search" value={search} disabled={reading} placeholder="Search album names" onChange={(e) => setSearch(e.target.value)} /></label>
        <label>Album<Select value={album} disabled={reading} aria-label="Photo album" options={[{ value: '', label: 'All photos' }, ...albums.filter((entry) => entry.id === album || matchingAlbums.includes(entry)).map((entry) => ({ value: entry.id, label: entry.name, note: String(entry.count) }))]} onChange={setAlbum} /></label>
        <label>Month<Select value={month} disabled={reading || !buckets.length} aria-label="Photo month" placeholder="No months" options={buckets.map((entry) => ({ value: entry.key, label: monthTitle(entry.month), note: String(entry.count) }))} onChange={setMonth} /></label>
        {search && !matchingAlbums.length && <p className="muted">No albums match “{search}”.</p>}
      </>}
    </div>
    {error && <div className="photo-picker-status" role="alert">{error} <button className="btn btn-small" disabled={reading} onClick={() => setRevision((n) => n + 1)}>Retry</button></div>}
    {(loading || loadingItems) && <p className="photo-picker-status muted" role="status">Loading photos…</p>}
    {!loading && !sources.length && !error && <p className="photo-picker-status muted">No Photos library connected. Connect Immich or choose Seafile folders in Photos settings first.</p>}
    {!loading && !loadingItems && source && !items.length && !error && <p className="photo-picker-status muted">No photos in this album or month. Choose another month or album, or add folders in Photos settings.</p>}
    <div className="photo-picker-grid" aria-label="Photos">{source && items.slice(0, visible).map((item, index) => {
      const value = { source, item }, checked = selected.some((entry) => selectionKey(entry) === selectionKey(value))
      return <button type="button" key={item.id} className={`photo-picker-photo ${checked ? 'is-selected' : ''}`} aria-pressed={checked} aria-label={`Photo ${index + 1}, ${dateLabel(item.wall)}`} disabled={reading} onClick={() => toggle(value)}>
        <img src={thumbUrl(source, item.id, 'small', item.v)} alt="" loading="lazy" />
        <span>{checked ? 'Selected' : dateLabel(item.wall)}</span>
      </button>
    })}</div>
    {items.length > visible && <div className="photo-picker-status"><button className="btn" onClick={() => setVisible((n) => n + 120)}>Show more photos</button></div>}
    {!!selected.length && <div className="photo-picker-selection" aria-label="Selected photos">{selected.map((value) => <button type="button" key={selectionKey(value)} className="btn btn-small" disabled={reading} onClick={() => toggle(value)} aria-label={`Remove selected photo from ${sourceName(value.source)}, ${dateLabel(value.item.wall)}`}><img src={thumbUrl(value.source, value.item.id, 'small', value.item.v)} alt="" />Remove</button>)}</div>}
    <footer className="image-dialog-foot"><span className="muted" role="status">{reading ? 'Reading originals…' : `${selected.length} selected · ${limit} available attachment slots`}</span><span className="nb-spacer" /><button className="btn" onClick={close}>Cancel</button><button className="btn" disabled={reading || !selected.length} onClick={() => void attach()}>Attach{selected.length ? ` (${selected.length})` : ''}</button></footer>
  </ImageDialog>
}
