// Which widgets are on the desktop and where (src/widgets). Kept apart from the window layout
// (wm.tsx) so they follow the account as a set merged entry by entry, like notes: two devices
// adding widgets at the same time both keep theirs, and one device moving a widget doesn't put
// back the windows another device closed. Phones and bigger screens share the one set; a phone
// keeps the place a widget was put on a big screen, and only changes its place in the phone's
// column of notes (`stack`).
//
// Each time a widget goes on the desktop it is a new entry, under a key of its own: the widget's
// id the first time, a variant of it if that widget (a sticky's note) is put back after being
// taken off. Entries carry a change counter (`at`): per entry, the higher one wins. A change made
// here counts on from the entry it changes (nextAt), so a device whose clock runs behind still
// wins with a change made after one from a device whose clock runs ahead; equal counters are
// broken the same way everywhere. Taking a widget off removes its entry for good: its key goes
// into `removed`, and no change from anywhere brings that key back, however late it turns up.
// That list is only the keys (9 bytes each for most widgets), so it stays small enough to keep for
// good. Entries moved over from an older window layout get `at: 0`, so anything done to that
// widget since, anywhere, wins over them.

export type WidgetPlace = {
  /** The widget (its window's props.id, its settings' key; a sticky's note id) */
  id: string
  kind: string
  /** Where it was put on a big screen, on a screen `vw` × `vh` px (see wm.tsx widgetGeometry). */
  x: number
  y: number
  w: number
  h: number
  /** Legacy layouts did not record screen dimensions; keep their coordinates without scaling. */
  screenUnknown?: boolean
  /** Screen class is independent of logical dimensions at a high UI scale. Absent in old saves. */
  phone?: boolean
  vw: number
  vh: number
  /** Its place in the phone layout's column, once moved there by hand. */
  stack?: number
  minimized?: boolean
  /** Change counter for merging (see nextAt); 0 for one moved over from a window layout. */
  at: number
}

/** The set: the entries on the desktop by key, and the keys of those taken off, space-separated and sorted. */
export type WidgetSet = { places: Record<string, WidgetPlace>; removed: string }

export const EMPTY: WidgetSet = { places: {}, removed: '' }
export const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
export const KEY = /^[^\s]{1,80}$/

function place(id: string, raw: Partial<WidgetPlace>): WidgetPlace {
  return {
    id,
    kind: raw.kind!,
    x: num(raw.x),
    y: num(raw.y),
    w: num(raw.w, 280),
    h: num(raw.h, 260),
    ...(raw.screenUnknown ? { screenUnknown: true } : {}),
    ...(typeof raw.phone === 'boolean' ? { phone: raw.phone } : {}),
    vw: num(raw.vw),
    vh: num(raw.vh),
    ...(typeof raw.stack === 'number' ? { stack: raw.stack } : {}),
    ...(raw.minimized ? { minimized: true } : {}),
    at: num(raw.at),
  }
}

export const removedKeys = (set: WidgetSet) => new Set(set.removed ? set.removed.split(' ') : [])
const joinKeys = (keys: Iterable<string>) => [...new Set(keys)].filter((k) => KEY.test(k)).sort().join(' ')

/** Reads the set, including the first format (one record per widget id, `removed: true` for one taken off). */
export function normalizeSet(v: unknown): WidgetSet {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return EMPTY
  const o = v as { places?: unknown; removed?: unknown }
  const first = !('places' in o)
  const source = first ? o : o.places
  const entries = Object.entries(source && typeof source === 'object' && !Array.isArray(source) ? source as Record<string, Partial<WidgetPlace> & { removed?: unknown }> : {})
  const removed = new Set(!first && typeof o.removed === 'string' && o.removed ? o.removed.split(' ') : [])
  const places: Record<string, WidgetPlace> = {}
  for (const [key, raw] of entries) {
    if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string' || !KEY.test(key)) continue
    if (raw.removed) removed.add(key)
    else places[key] = place(typeof raw.id === 'string' && raw.id ? raw.id : key, raw)
  }
  for (const k of removed) delete places[k]
  return { places, removed: joinKeys(removed) }
}

/** The counter for a change to `existing` made now: past the entry's own, whatever the clock says. */
export const nextAt = (existing?: Pick<WidgetPlace, 'at'>) => Math.max(Date.now(), (existing?.at ?? 0) + 1)

/** Old saves used screen pixels and can still infer their screen class from the width. */
export const placedOnPhone = (p: WidgetPlace) => p.phone ?? p.vw < 720

/** Whether `a` wins over `b`: the higher counter, then (a tie) the same pick on every device. */
export function wins(a: WidgetPlace, b: WidgetPlace): boolean {
  if (a.at !== b.at) return a.at > b.at
  if (placedOnPhone(a) !== placedOnPhone(b)) return !placedOnPhone(a)
  if (a.vw !== b.vw) return a.vw > b.vw
  return JSON.stringify(place(a.id, a)) > JSON.stringify(place(b.id, b))
}

/** Per entry, the side that changed it last wins; entries only one side has are kept; removed is removed. */
export function mergeSets(local: WidgetSet, remote: WidgetSet): WidgetSet {
  const removed = new Set([...removedKeys(remote), ...removedKeys(local)])
  const places: Record<string, WidgetPlace> = {}
  for (const [k, r] of Object.entries(remote.places)) if (!removed.has(k)) places[k] = r
  for (const [k, l] of Object.entries(local.places)) if (!removed.has(k) && (!places[k] || wins(l, places[k]))) places[k] = l
  return { places, removed: joinKeys(removed) }
}

/** The widgets on the desktop. */
export const liveWidgets = (set: WidgetSet) =>
  Object.keys(set.places)
    .sort()
    .map((k) => set.places[k])

/** The entries of a widget on the desktop (one, unless two devices put it back at once), first key first. */
export const entriesOf = (set: WidgetSet, id: string) =>
  Object.keys(set.places)
    .filter((k) => set.places[k].id === id)
    .sort()
    .map((key) => ({ key, place: set.places[key] }))

/** A key for a new entry of widget `id`: its id, unless that was used before. */
export function newKey(set: WidgetSet, id: string): string {
  const removed = removedKeys(set)
  if (!set.places[id] && !removed.has(id)) return id
  let key: string
  do key = `${id}~${Math.random().toString(36).slice(2, 7)}`
  while (set.places[key] || removed.has(key))
  return key
}

/** `set` with these entries changed or added and these keys removed. */
export function changeSet(set: WidgetSet, put: Record<string, WidgetPlace>, remove: string[] = []): WidgetSet {
  const removed = removedKeys(set)
  const places = { ...set.places }
  for (const [k, p] of Object.entries(put)) if (!removed.has(k)) places[k] = p
  for (const k of remove) delete places[k]
  return { places, removed: remove.length ? joinKeys([...removed, ...remove]) : set.removed }
}

/** Pure legacy-layout import. A variant entry already carrying this note/widget identity must
 * not gain a duplicate original key. Untouched original imports can still prefer desktop. */
export function importPlaces(set: WidgetSet, found: Omit<WidgetPlace, 'at'>[]): WidgetSet {
  const put: Record<string, WidgetPlace> = {}
  for (const f of found) {
    if (!f.id || !KEY.test(f.id) || removedKeys(set).has(f.id)) continue
    const entries = entriesOf(set, f.id)
    if (!entries.length || entries.length === 1 && entries[0].key === f.id && entries[0].place.at === 0 && wins({ ...f, at: 0 }, entries[0].place)) put[f.id] = { ...f, at: 0 }
  }
  return Object.keys(put).length ? changeSet(set, put) : set
}

