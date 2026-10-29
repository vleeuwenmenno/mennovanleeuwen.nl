import { itemId, tiledShots, VIDEO_PLAN_LIMITS, type LaneKind, type Lanes, type VideoSpeaker } from '../../data/videoPlan'

// Edits to a segment's lanes, as pure functions: the timeline, the list view and the keyboard all
// go through these, so the rules (times inside the clip, on a 0.25 s grid, shots at least a second
// apart) are the same whichever way the person edits.

export type Selection = { lane: LaneKind; id: string } | { lane: 'bed'; id: 'bed' } | null

export const SNAP = 0.25
export const snapTime = (t: number, duration: number, edges: number[] = []) => {
  const near = edges.find((e) => Math.abs(e - t) < 0.15)
  const v = near ?? Math.round(t / SNAP) * SNAP
  return Math.min(duration, Math.max(0, Math.round(v * 1000) / 1000))
}

type AnyItem = { id: string; at?: number; start?: number; end?: number }
export const itemsOf = (lanes: Lanes, lane: LaneKind) => lanes[lane] as AnyItem[]
export const timeOf = (item: AnyItem) => item.at ?? item.start ?? 0

/** A new item at `at`, with sensible words to start from. Null when the lane is full. */
export function addItem(lanes: Lanes, lane: LaneKind, at: number, duration: number, speakers: VideoSpeaker[]): { lanes: Lanes; id: string } | null {
  const id = itemId()
  const t = snapTime(at, duration)
  if (lane === 'shots') {
    const shots = tiledShots(lanes, duration)
    if (shots.length >= VIDEO_PLAN_LIMITS.maxShots) return null
    // An empty lane is one shot over the whole clip: make it real first, then cut at `t`.
    const base = lanes.shots.length ? lanes.shots : [{ id: itemId(), start: 0, framing: '' }]
    if (t <= 0 || base.some((s) => Math.abs(s.start - t) < VIDEO_PLAN_LIMITS.minShotSeconds)) return null
    return { lanes: { ...lanes, shots: [...base, { id, start: t, framing: '', transition: 'cut' as const }].sort((a, b) => a.start - b.start) }, id }
  }
  const made = {
    action: { id, at: t, text: '' },
    camera: { id, at: t, move: 'push_in' },
    speech: { id, at: t, speaker: speakers[0]?.id ?? 'S1', language: 'English', line: '' },
    sound: { id, at: t, text: '' },
    text: { id, at: t, content: '', on: '' },
  }[lane]
  return { lanes: { ...lanes, [lane]: [...lanes[lane], made] }, id }
}

export function updateItem(lanes: Lanes, lane: LaneKind, id: string, patch: Record<string, unknown>): Lanes {
  return { ...lanes, [lane]: (lanes[lane] as AnyItem[]).map((i) => (i.id === id ? { ...i, ...patch } : i)) }
}

export function removeItem(lanes: Lanes, lane: LaneKind, id: string): Lanes {
  return { ...lanes, [lane]: (lanes[lane] as AnyItem[]).filter((i) => i.id !== id) }
}

export function duplicateItem(lanes: Lanes, lane: LaneKind, id: string, duration: number): { lanes: Lanes; id: string } | null {
  if (lane === 'shots') return null
  const item = (lanes[lane] as AnyItem[]).find((i) => i.id === id)
  if (!item) return null
  const copy = { ...item, id: itemId(), at: Math.min(duration, (item.at ?? 0) + 1) }
  if (copy.end !== undefined) copy.end = Math.min(duration, copy.end + 1)
  return { lanes: { ...lanes, [lane]: [...lanes[lane], copy] }, id: copy.id }
}

/** Moves an item (a shot: its cut) to `at`, keeping its length; a shot's cut stays between its neighbours, a second from each. */
export function moveItem(lanes: Lanes, lane: LaneKind, id: string, at: number, duration: number): Lanes {
  if (lane === 'shots') {
    const sorted = [...lanes.shots].sort((a, b) => a.start - b.start)
    const i = sorted.findIndex((s) => s.id === id)
    if (i <= 0) return lanes
    const lo = sorted[i - 1].start + VIDEO_PLAN_LIMITS.minShotSeconds
    const hi = (sorted[i + 1]?.start ?? duration) - VIDEO_PLAN_LIMITS.minShotSeconds
    if (lo > hi) return lanes
    return updateItem(lanes, 'shots', id, { start: Math.min(hi, Math.max(lo, at)) })
  }
  const item = (lanes[lane] as AnyItem[]).find((i) => i.id === id)
  if (!item) return lanes
  const length = item.end !== undefined ? item.end - (item.at ?? 0) : 0
  const start = Math.min(duration - length, Math.max(0, at))
  return updateItem(lanes, lane, id, { at: start, ...(item.end !== undefined ? { end: start + length } : {}) })
}

/** Sets where an item ends (or that it has no end of its own, at or before its start). */
export function resizeItem(lanes: Lanes, lane: LaneKind, id: string, end: number, duration: number): Lanes {
  if (lane === 'shots') return lanes
  const item = (lanes[lane] as AnyItem[]).find((i) => i.id === id)
  if (!item) return lanes
  const at = item.at ?? 0
  return updateItem(lanes, lane, id, { end: end <= at + 0.1 ? undefined : Math.min(duration, end) })
}

/** S: a cut at the playhead (in the shot under it). */
export const splitShot = (lanes: Lanes, at: number, duration: number) => addItem(lanes, 'shots', at, duration, [])

/** Times outside a new duration come inside; shots past the end go. */
export function fitLanes(lanes: Lanes, duration: number): Lanes {
  const clip = <T extends AnyItem>(items: T[]) => items.map((i) => ({ ...i, at: Math.min(i.at ?? 0, duration), ...(i.end !== undefined ? { end: Math.min(i.end, duration) } : {}) }))
  return {
    shots: lanes.shots.filter((s) => s.start === 0 || s.start <= duration - VIDEO_PLAN_LIMITS.minShotSeconds),
    action: clip(lanes.action),
    camera: clip(lanes.camera),
    speech: clip(lanes.speech),
    sound: clip(lanes.sound),
    text: clip(lanes.text),
  }
}
