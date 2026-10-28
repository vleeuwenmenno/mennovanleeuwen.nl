import { useEffect, useRef, useState } from 'react'
import { getStudioImages, type StudioImage } from '../../data/agentImages'
import { readBytes } from '../../data/fileOps'
import { BADGE_NOTE, laneBadge, type Keyframe } from '../../data/videoPlan'
import { listThreadPictures, sourceUrl, uploadVideoSource, type ThreadPicture } from '../../data/videoStudio'
import type { VideoFamily } from '../../data/videoModels'
import { useAccount } from '../../os/account'
import { pickFiles } from '../../os/FolderPicker'
import { useIsMobile } from '../../os/useIsMobile'
import { ImageDialog } from '../AgentsModelBrowser'
import { bitmapOf, coverPlacement, cropToPng, fetchBlob, type Focal } from './frames'

// The keyframe slots (first frame, and last frame for H3) and the picker behind them: a picture
// the Image Studio or an agent made, one sent in a thread, a file from Files (Seafile or this
// browser), or one from this device (a file, a drop on the slot, or a paste). Every picture then
// goes through the crop: the clip's shape over the picture, dragged to keep the right part, and
// the result is sent at the clip's exact size.

const ACCEPT = 'image/png,image/jpeg,image/webp,image/heic,.heic,.dng,.nef,.arw,.cr2'

export function KeyframeSlots({ family, first, last, width, height, onChange, disabled }: { family: VideoFamily; first: Keyframe | null; last: Keyframe | null; width: number; height: number; onChange: (slot: 'firstFrame' | 'lastFrame', k: Keyframe | null) => void; disabled?: boolean }) {
  const [picking, setPicking] = useState<'firstFrame' | 'lastFrame' | null>(null)
  const [dropped, setDropped] = useState<{ slot: 'firstFrame' | 'lastFrame'; blob: Blob; name: string } | null>(null)
  const slots: ['firstFrame' | 'lastFrame', string, Keyframe | null][] = [['firstFrame', 'First frame', first], ...(family === 'minimax_h3' ? [['lastFrame', 'Last frame', last] as ['lastFrame', string, Keyframe | null]] : [])]
  // A keyframe made at another size is cropped again by ComfyUI (centred); say so.
  const off = (k: Keyframe | null) => k && (!k.prepared || k.width !== width || k.height !== height)
  return (
    <section className="vs-section" aria-label="Keyframes">
      <h4 className="vs-head">Keyframes</h4>
      <div className="vs-keys">
        {slots.map(([slot, label, k]) => (
          <div
            key={slot}
            className="vs-key"
            onDragOver={(e) => e.dataTransfer.types.includes('Files') && (e.preventDefault(), (e.dataTransfer.dropEffect = 'copy'))}
            onDrop={(e) => {
              const f = [...e.dataTransfer.files].find((f) => /^image\//.test(f.type) || /\.(heic|dng|nef|arw|cr2)$/i.test(f.name))
              if (!f || disabled) return
              e.preventDefault()
              setDropped({ slot, blob: f, name: f.name })
            }}
          >
            <span className="vs-key-label">
              {label} <span className={`vs-badge is-${laneBadge(family, slot === 'firstFrame' ? 'keyframe' : 'lastFrame').toLowerCase()}`} title={BADGE_NOTE[laneBadge(family, slot === 'firstFrame' ? 'keyframe' : 'lastFrame')]}>{laneBadge(family, slot === 'firstFrame' ? 'keyframe' : 'lastFrame')}</span>
            </span>
            <button type="button" className="vs-key-pic" disabled={disabled} onClick={() => setPicking(slot)} aria-label={k ? `Change the ${label.toLowerCase()}` : `Choose a ${label.toLowerCase()}`} title={k ? k.name : 'Choose, drop or paste a picture'}>
              {k ? <img src={sourceUrl(k.sourceId)} alt="" draggable={false} /> : <span className="muted">+ add</span>}
            </button>
            {k && (
              <span className="vs-row">
                <button type="button" className="btn btn-small" disabled={disabled} onClick={() => setPicking(slot)}>Change…</button>
                <button type="button" className="btn btn-small" disabled={disabled} onClick={() => onChange(slot, null)}>Remove</button>
              </span>
            )}
            {off(k) && <span className="vs-note t-yellow">Not cropped for {width} × {height}: ComfyUI centres it. Change… to crop it yourself.</span>}
          </div>
        ))}
      </div>
      {family === 'ltx25' && <p className="vs-note muted">LTX 2.5 starts from a first frame only.</p>}
      {(picking || dropped) && (
        <KeyframePicker
          title={(picking ?? dropped!.slot) === 'firstFrame' ? 'Choose the first frame' : 'Choose the last frame'}
          width={width}
          height={height}
          start={dropped ? { blob: dropped.blob, name: dropped.name } : null}
          onClose={() => (setPicking(null), setDropped(null))}
          onChoose={(k) => {
            onChange(picking ?? dropped!.slot, k)
            setPicking(null)
            setDropped(null)
          }}
        />
      )}
    </section>
  )
}

type Tab = 'made' | 'files' | 'device'

/** Pick a picture, then crop it to the clip's shape. `start`: a picture already chosen (a drop). */
export function KeyframePicker({ title, width, height, start, onClose, onChoose }: { title: string; width: number; height: number; start: { blob: Blob; name: string } | null; onClose: () => void; onChoose: (k: Keyframe) => void }) {
  const account = useAccount()
  const mobile = useIsMobile()
  const [tab, setTab] = useState<Tab>('made')
  const [picked, setPicked] = useState<{ blob: Blob; name: string } | null>(start)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const take = async (load: () => Promise<Blob>, name: string) => {
    setBusy(true)
    setError('')
    try {
      setPicked({ blob: await load(), name })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // Paste a picture anywhere in the dialog.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((f) => /^image\//.test(f.type))
      if (f) (e.preventDefault(), setPicked({ blob: f, name: f.name || 'pasted.png' }))
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])
  if (picked) return <CropDialog title={title} width={width} height={height} picture={picked} onBack={() => setPicked(null)} onClose={onClose} onDone={onChoose} />
  const tabs: [Tab, string][] = [['made', 'Studio & agents'], ['files', 'Files'], ['device', 'This device']]
  return (
    <ImageDialog title={title} onClose={onClose} wide>
      <div className="vs-picker">
        <div className={mobile ? 'seg seg-small vs-picker-tabs' : 'vs-picker-tabs vs-tabs'} role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)} data-image-autofocus={id === 'made' ? '' : undefined}>
              {label}
            </button>
          ))}
        </div>
        {error && <p className="t-red copyable" role="alert">{error}</p>}
        {busy && <p className="muted" role="status">Loading the picture…</p>}
        {tab === 'made' && <MadePictures onPick={(url, name) => void take(() => fetchBlob(url), name)} />}
        {tab === 'files' && (
          <div className="vs-picker-pane">
            <p className="muted">A picture from Files: your Seafile libraries, or the files kept in this browser.</p>
            <button type="button" className="btn btn-small btn-primary" onClick={() => void pickFiles({ title: 'Choose a picture' }).then((p) => { if (p?.[0]) void take(() => readBytes(p[0]), p[0].split('/').pop() || 'picture') })}>
              Choose in Files…
            </button>
            {!account.seafile && <p className="muted vs-note">Seafile is not linked: only this browser's files are there.</p>}
          </div>
        )}
        {tab === 'device' && (
          <div className="vs-picker-pane">
            <p className="muted">A picture from this device. You can also drop one on a keyframe slot, or paste one here.</p>
            <button type="button" className="btn btn-small btn-primary" onClick={() => input.current?.click()}>
              Choose a file…
            </button>
            <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setPicked({ blob: f, name: f.name }) }} />
          </div>
        )}
      </div>
    </ImageDialog>
  )
}

/** The Image Studio's and agents' pictures, then the pictures sent in threads. */
function MadePictures({ onPick }: { onPick: (url: string, name: string) => void }) {
  const [made, setMade] = useState<StudioImage[] | null>(null)
  const [madeNext, setMadeNext] = useState<string | null>(null)
  const [sent, setSent] = useState<ThreadPicture[] | null>(null)
  const [sentNext, setSentNext] = useState<number | null>(null)
  const [studioOnly, setStudioOnly] = useState(false)
  const [error, setError] = useState('')
  const loadMade = (before?: string) => getStudioImages('all', before).then((r) => (setMade((l) => [...(before ? l ?? [] : []), ...r.images]), setMadeNext(r.next_before)), (e: Error) => setError(e.message))
  const loadSent = (before?: number) => listThreadPictures(before).then((r) => (setSent((l) => [...(before ? l ?? [] : []), ...r.pictures]), setSentNext(r.next_before)), () => setSent([]))
  useEffect(() => {
    void loadMade()
    void loadSent()
  }, [])
  const shown = (made ?? []).filter((i) => !studioOnly || i.studio)
  return (
    <div className="vs-picker-pane">
      {error && <p className="t-red copyable">{error}</p>}
      <span className="vs-row">
        <strong className="vs-sub">Generated pictures</strong>
        <label className="vs-check"><input type="checkbox" checked={studioOnly} onChange={(e) => setStudioOnly(e.target.checked)} /> Image Studio only</label>
      </span>
      {!made && !error && <p className="muted" role="status">Loading your pictures…</p>}
      {made && !shown.length && <p className="muted">No generated pictures yet.</p>}
      <ul className="vs-thumbs">
        {shown.map((i) => (
          <li key={i.id}>
            <button type="button" className="vs-thumb" onClick={() => onPick(i.url, i.name)} title={`${i.name} · ${i.width} × ${i.height}`} aria-label={`Use ${i.name}`}>
              <img src={i.url} alt="" loading="lazy" draggable={false} />
            </button>
          </li>
        ))}
      </ul>
      {madeNext && <button type="button" className="btn btn-small" onClick={() => void loadMade(madeNext)}>Show older</button>}
      {!!sent?.length && <strong className="vs-sub">Sent in threads</strong>}
      <ul className="vs-thumbs">
        {(sent ?? []).map((p) => (
          <li key={p.id}>
            <button type="button" className="vs-thumb" onClick={() => onPick(p.url, p.name)} title={p.name} aria-label={`Use ${p.name}`}>
              <img src={p.url} alt="" loading="lazy" draggable={false} />
            </button>
          </li>
        ))}
      </ul>
      {sentNext && <button type="button" className="btn btn-small" onClick={() => void loadSent(sentNext)}>Show older</button>}
    </div>
  )
}

/** The clip's frame over the picture: drag (or use the arrow keys) to choose what stays in view. */
function CropDialog({ title, width, height, picture, onBack, onClose, onDone }: { title: string; width: number; height: number; picture: { blob: Blob; name: string }; onBack: () => void; onClose: () => void; onDone: (k: Keyframe) => void }) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)
  const [url] = useState(() => URL.createObjectURL(picture.blob))
  const [focal, setFocal] = useState<Focal>({ x: 0.5, y: 0.5 })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; focal: Focal } | null>(null)
  useEffect(() => {
    let gone = false
    bitmapOf(picture.blob, picture.name).then((b) => (gone ? b.close() : setBitmap(b)), (e: Error) => setError(e.message))
    return () => {
      gone = true
      URL.revokeObjectURL(url)
    }
  }, [])
  useEffect(() => () => bitmap?.close(), [bitmap])
  // The frame is shown at most 520 × 320 (smaller on a phone), the picture covering it.
  const [frameW, setFrameW] = useState(480)
  useEffect(() => {
    const el = box.current?.parentElement
    if (!el) return
    const ro = new ResizeObserver(([e]) => setFrameW(Math.max(200, Math.min(520, e.contentRect.width - 8))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const fw = Math.min(frameW, (320 * width) / height), fh = (fw * height) / width
  const place = bitmap ? coverPlacement(bitmap.width, bitmap.height, fw, fh, focal) : null
  const nudge = (dx: number, dy: number) => setFocal((f) => ({ x: Math.min(1, Math.max(0, f.x + dx)), y: Math.min(1, Math.max(0, f.y + dy)) }))
  const save = async () => {
    if (!bitmap) return
    setSaving(true)
    setError('')
    try {
      const data = await cropToPng(bitmap, width, height, focal)
      const stem = picture.name.replace(/\.[^.]*$/, '') || 'keyframe'
      const s = await uploadVideoSource(`${stem}.png`, data)
      onDone({ sourceId: s.id, name: s.name, width: s.width, height: s.height, prepared: true })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const ratio = bitmap ? bitmap.width / bitmap.height : width / height
  return (
    <ImageDialog title={title} onClose={onClose} wide>
      <div className="vs-crop">
        <p className="muted">
          Drag the picture to choose what stays in the {width} × {height} frame.
          {bitmap && Math.abs(ratio / (width / height) - 1) > 0.03 ? ' Its shape differs from the clip’s: the edges are cut off.' : ''}
        </p>
        <div
          ref={box}
          className="vs-crop-frame"
          style={{ width: fw, height: fh }}
          tabIndex={0}
          role="slider"
          aria-label="What stays in the frame: arrow keys move it"
          aria-valuetext={`${Math.round(focal.x * 100)}% across, ${Math.round(focal.y * 100)}% down`}
          onKeyDown={(e) => {
            const d = e.shiftKey ? 0.1 : 0.02
            const k: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }
            if (k[e.key]) (e.preventDefault(), nudge(...k[e.key]))
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, y: e.clientY, focal }
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d || !place) return
            setFocal({ x: Math.min(1, Math.max(0, d.focal.x - (e.clientX - d.x) / place.dw)), y: Math.min(1, Math.max(0, d.focal.y - (e.clientY - d.y) / place.dh)) })
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          {place && <img src={url} alt="" draggable={false} style={{ left: place.x, top: place.y, width: place.dw, height: place.dh }} />}
          {!bitmap && !error && <span className="muted">Loading…</span>}
        </div>
        {error && <p className="t-red copyable" role="alert">{error}</p>}
        <span className="vs-row">
          <button type="button" className="btn btn-small" onClick={onBack}>Back</button>
          <button type="button" className="btn btn-small" onClick={() => setFocal({ x: 0.5, y: 0.5 })}>Centre</button>
          <span className="vs-grow" />
          <button type="button" className="btn btn-small btn-primary" disabled={!bitmap || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Use this frame'}</button>
        </span>
      </div>
    </ImageDialog>
  )
}
