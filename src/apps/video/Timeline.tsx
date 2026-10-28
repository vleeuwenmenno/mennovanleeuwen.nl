import { useEffect, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { BADGE_NOTE, CAMERA_PHRASES, LANE_LABEL, laneBadge, tiledShots, type Compiled, type LaneKind, type Lanes, type VideoProject } from '../../data/videoPlan'
import { openMenuAt, type MenuItem } from '../../os/ContextMenu'
import { itemsOf, moveItem, resizeItem, snapTime, timeOf, type Selection } from './lanes'

// The lanes over time: a ruler (with the clip's real length, H3 rounding its frames up), then
// Shots, Action, Camera, Speech, Sound and Text, and the beds. Each item carries its badge (Real,
// Timed, Ordered, Hint). With a mouse, items are dragged to move and their right edge to resize,
// a shot's left edge moves its cut, a double-click adds an item; everything snaps to 0.25 s and to
// the cuts. On a touch screen items are tapped (and long-pressed for their menu) rather than
// dragged, so the lane scrolls; a pinch zooms. The selected item shows a dotted line back to its
// shot's start: inside a shot only its order reaches the model.

const LANE_H = 34
const DEFAULT_LEN = 1

export type TimelineProps = {
  project: VideoProject
  compiled: Compiled
  duration: number
  /** The clip's real length (H3: 10 s plays 10.58 s), drawn as a lighter tick. */
  effective: number
  lanes: Lanes
  shown: readonly LaneKind[]
  showBed: boolean
  pps: number
  setPps: (v: number) => void
  playhead: number
  setPlayhead: (t: number) => void
  selection: Selection
  setSelection: (s: Selection) => void
  onLanes: (lanes: Lanes) => void
  onAdd: (lane: LaneKind, at: number) => void
  menuFor: (lane: LaneKind, id: string) => MenuItem[]
  onKey: (e: KeyboardEvent<HTMLDivElement>) => void
  touch: boolean
}

export function Timeline(p: TimelineProps) {
  const { duration, pps, lanes } = p
  const width = Math.max(1, duration) * pps
  const shots = tiledShots(lanes, duration)
  const edges = shots.map((s) => s.start).concat(duration)
  const scroller = useRef<HTMLDivElement>(null)
  const drag = useRef<{ lane: LaneKind; id: string; mode: 'move' | 'end'; x: number; at: number; moved: boolean } | null>(null)
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pinch = useRef<{ ids: Map<number, number>; d0: number; pps0: number } | null>(null)

  // Keep the playhead in view while it plays or moves.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const x = p.playhead * pps
    if (x < el.scrollLeft + 24 || x > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = Math.max(0, x - el.clientWidth / 3)
  }, [Math.floor(p.playhead), pps])

  const timeAt = (clientX: number) => {
    const el = scroller.current!
    return (clientX - el.getBoundingClientRect().left + el.scrollLeft - 0) / pps
  }
  const startDrag = (e: ReactPointerEvent, lane: LaneKind, id: string, mode: 'move' | 'end') => {
    e.stopPropagation()
    p.setSelection({ lane, id })
    if (p.touch) {
      // Touch: a long press opens the item's menu; a drag scrolls the lane.
      const target = e.currentTarget as Element
      press.current = setTimeout(() => openMenuAt(target, p.menuFor(lane, id)), 500)
      return
    }
    if (e.button !== 0) return
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const item = itemsOf(lanes, lane).find((i) => i.id === id)
    drag.current = { lane, id, mode, x: e.clientX, at: mode === 'end' ? (item?.end ?? timeOf(item ?? { id }) + DEFAULT_LEN) : timeOf(item ?? { id }), moved: false }
  }
  const moveDrag = (e: ReactPointerEvent) => {
    if (press.current) (clearTimeout(press.current), (press.current = null))
    const d = drag.current
    if (!d) return
    const dt = (e.clientX - d.x) / pps
    if (!d.moved && Math.abs(e.clientX - d.x) < 3) return
    d.moved = true
    const t = snapTime(d.at + dt, duration, edges)
    p.onLanes(d.mode === 'end' ? resizeItem(lanes, d.lane, d.id, t, duration) : moveItem(lanes, d.lane, d.id, t, duration))
  }
  const endDrag = () => {
    if (press.current) (clearTimeout(press.current), (press.current = null))
    drag.current = null
  }

  const onPointerDownScroll = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'touch') return
    const ids = pinch.current?.ids ?? new Map<number, number>()
    ids.set(e.pointerId, e.clientX)
    if (ids.size === 2) {
      const [a, b] = [...ids.values()]
      pinch.current = { ids, d0: Math.abs(a - b) || 1, pps0: pps }
    } else pinch.current = { ids, d0: 0, pps0: pps }
  }
  const onPointerMoveScroll = (e: ReactPointerEvent) => {
    const pin = pinch.current
    if (!pin || !pin.ids.has(e.pointerId)) return
    pin.ids.set(e.pointerId, e.clientX)
    if (pin.ids.size === 2 && pin.d0) {
      const [a, b] = [...pin.ids.values()]
      p.setPps(Math.min(400, Math.max(20, (pin.pps0 * Math.abs(a - b)) / pin.d0)))
    }
  }
  const onPointerUpScroll = (e: ReactPointerEvent) => {
    pinch.current?.ids.delete(e.pointerId)
    if (!pinch.current?.ids.size) pinch.current = null
  }

  const ticks: number[] = []
  const every = pps >= 60 ? 1 : pps >= 30 ? 2 : 5
  for (let t = 0; t <= duration + 1e-6; t += every) ticks.push(Math.round(t * 1000) / 1000)
  const badgeOf = (id: string, lane: LaneKind) => p.compiled.items[id]?.badge ?? laneBadge(p.project.family, lane)
  const sel = p.selection
  const selShot = sel && sel.lane !== 'bed' && sel.lane !== 'shots' ? shots[p.compiled.items[sel.id]?.shot ?? 0] : null
  const selItem = sel && sel.lane !== 'bed' && sel.lane !== 'shots' ? itemsOf(lanes, sel.lane).find((i) => i.id === sel.id) : null

  const label = (lane: LaneKind, item: Record<string, unknown>) => {
    if (lane === 'action' || lane === 'sound') return String(item.text || (lane === 'action' ? 'What happens…' : 'A sound…'))
    if (lane === 'camera') return `${CAMERA_PHRASES[item.move as keyof typeof CAMERA_PHRASES]?.label ?? 'Camera'}${item.speed ? ` · ${item.speed}` : ''}${item.amplitude ? ` · ${item.amplitude}` : ''}`
    if (lane === 'speech') return `${item.speaker}${item.voiceover ? ' vo' : ''} “${String(item.line || '…')}”`
    if (lane === 'text') return `“${String(item.content || '…')}”${item.on ? ` on ${item.on}` : ''}`
    return ''
  }

  return (
    <div className="vs-timeline" tabIndex={0} onKeyDown={p.onKey} aria-label="Timeline: arrow keys nudge the selected item, Delete removes it, S cuts a shot at the playhead, Space plays">
      <div className="vs-lane-heads">
        <div className="vs-ruler-head">
          <button type="button" className="btn btn-small" onClick={() => p.setPps(Math.max(20, pps / 1.4))} aria-label="Zoom out" title="Zoom out">−</button>
          <button type="button" className="btn btn-small" onClick={() => p.setPps(Math.min(400, pps * 1.4))} aria-label="Zoom in" title="Zoom in">+</button>
        </div>
        {p.shown.map((lane) => (
          <div key={lane} className="vs-lane-head" style={{ height: LANE_H }}>
            <span>{LANE_LABEL[lane]}</span>
            <button type="button" className="vs-add" onClick={() => p.onAdd(lane, p.playhead)} aria-label={`Add ${lane === 'shots' ? 'a cut' : `${LANE_LABEL[lane].toLowerCase()}`} at the playhead`} title={lane === 'shots' ? 'Cut at the playhead (S)' : 'Add at the playhead'}>
              +
            </button>
          </div>
        ))}
        {p.showBed && <div className="vs-lane-head" style={{ height: LANE_H }}><span>Bed</span></div>}
      </div>
      <div
        ref={scroller}
        className="vs-scroll"
        onWheel={(e) => {
          if (!e.ctrlKey) return
          e.preventDefault()
          p.setPps(Math.min(400, Math.max(20, pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))
        }}
        onPointerDown={onPointerDownScroll}
        onPointerMove={onPointerMoveScroll}
        onPointerUp={onPointerUpScroll}
        onPointerCancel={onPointerUpScroll}
      >
        <div className="vs-track" style={{ width: Math.max(width, p.effective * pps) + 24 }}>
          <div className="vs-ruler" onPointerDown={(e) => !p.touch && p.setPlayhead(Math.min(duration, Math.max(0, timeAt(e.clientX))))} onClick={(e) => p.touch && p.setPlayhead(Math.min(duration, Math.max(0, timeAt(e.clientX))))}>
            {ticks.map((t) => (
              <span key={t} className="vs-tick" style={{ left: t * pps }}>{t}s</span>
            ))}
            {p.effective > duration + 0.01 && <span className="vs-tick is-effective" style={{ left: p.effective * pps }} title={`The clip really plays ${p.effective.toFixed(2)} s: the model rounds its frames up`}>{(p.effective - duration) * pps > 40 ? p.effective.toFixed(2) : ''}</span>}
          </div>
          {p.shown.map((lane) => (
            <div
              key={lane}
              className={`vs-lane is-${lane}`}
              style={{ height: LANE_H }}
              onDoubleClick={(e) => !p.touch && e.target === e.currentTarget && p.onAdd(lane, timeAt(e.clientX))}
              onClick={(e) => e.target === e.currentTarget && p.setSelection(null)}
            >
              {lane === 'shots'
                ? shots.map((s, i) => {
                    const real = lanes.shots.find((x) => x.id === s.id)
                    const on = sel?.lane === 'shots' && sel.id === s.id
                    const b = laneBadge(p.project.family, 'shots')
                    return (
                      <div
                        key={s.id}
                        className={`vs-item is-shot ${on ? 'is-on' : ''}`}
                        style={{ left: s.start * pps, width: Math.max(8, (s.end - s.start) * pps - 2) }}
                        onPointerDown={(e) => real && startDrag(e, 'shots', s.id, 'move')}
                        onPointerMove={moveDrag}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        onClick={() => real ? p.setSelection({ lane: 'shots', id: s.id }) : p.onAdd('shots', 0)}
                        onContextMenu={(e) => real && (e.preventDefault(), openMenuAt(e.currentTarget, p.menuFor('shots', s.id)))}
                        title={real ? `Shot ${i + 1}${i ? `, cut at ${s.start.toFixed(2)} s` : ''}: ${s.framing || 'no framing yet'}` : 'One shot over the whole clip: click to describe it'}
                      >
                        {i > 0 && !p.touch && <span className="vs-cut-handle" aria-hidden />}
                        <span className="vs-item-text">Shot {i + 1}{i ? ` @${s.start.toFixed(1)}` : ''}{s.transition && s.transition !== 'cut' ? ` ${s.transition.replace('_', ' ')}` : ''}: {s.framing || '…'}</span>
                        <span className={`vs-badge is-${b.toLowerCase()}`} title={BADGE_NOTE[b]}>{b}</span>
                      </div>
                    )
                  })
                : itemsOf(lanes, lane).map((item) => {
                    const at = timeOf(item)
                    const end = item.end ?? at + DEFAULT_LEN
                    const on = sel?.lane === lane && sel.id === item.id
                    const b = badgeOf(item.id, lane)
                    const crosses = p.compiled.items[item.id]?.note
                    const px = Math.max(28, (Math.min(end, duration) - at) * pps - 2)
                    return (
                      <div
                        key={item.id}
                        className={`vs-item is-${lane} ${on ? 'is-on' : ''} ${item.end === undefined ? 'is-point' : ''} ${crosses ? 'is-warn' : ''}`}
                        style={{ left: at * pps, width: px }}
                        onPointerDown={(e) => startDrag(e, lane, item.id, 'move')}
                        onPointerMove={moveDrag}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        onContextMenu={(e) => (e.preventDefault(), openMenuAt(e.currentTarget, p.menuFor(lane, item.id)))}
                        title={`${label(lane, item as Record<string, unknown>)} · ${at.toFixed(2)} s${crosses ? ` · ${crosses}` : ''}`}
                      >
                        <span className="vs-item-text">{label(lane, item as Record<string, unknown>)}</span>
                        {/* A narrow item keeps its words: the badge shrinks to its first letter. */}
                        <span className={`vs-badge is-${b.toLowerCase()}`} title={`${b}: ${BADGE_NOTE[b]}`}>{px < 120 ? b[0] : b}</span>
                        {!p.touch && <span className="vs-end-handle" onPointerDown={(e) => startDrag(e, lane, item.id, 'end')} onPointerMove={moveDrag} onPointerUp={endDrag} aria-hidden />}
                      </div>
                    )
                  })}
              {lane !== 'shots' && selShot && selItem && sel?.lane === lane && timeOf(selItem) > selShot.start && (
                <span className="vs-order-line" style={{ left: selShot.start * pps, width: (timeOf(selItem) - selShot.start) * pps }} title="Only its order within the shot reaches the model" aria-hidden />
              )}
            </div>
          ))}
          {p.showBed && (
            <div className="vs-lane is-bed" style={{ height: LANE_H }}>
              <button type="button" className={`vs-item is-bed ${sel?.lane === 'bed' ? 'is-on' : ''}`} style={{ left: 0, width: Math.max(40, width - 2) }} onClick={() => p.setSelection({ lane: 'bed', id: 'bed' })}>
                <span className="vs-item-text">soundscape: {p.project.soundscape || '…'}{p.project.music ? ` │ music: ${p.project.music}` : ''}</span>
                <span className="vs-badge is-hint" title={BADGE_NOTE.Hint}>Hint</span>
              </button>
            </div>
          )}
          {shots.slice(1).map((s) => <span key={s.id} className="vs-cutline" style={{ left: s.start * pps }} aria-hidden />)}
          <span className="vs-playhead" style={{ left: p.playhead * pps }} aria-hidden />
        </div>
      </div>
    </div>
  )
}
