import { useEffect, useState, useSyncExternalStore } from 'react'
import { notify } from '../os/notify'
import { setOn, sourceOn } from '../os/notifyPrefs'
import { api, signedIn } from '../os/account'

// Status of the Minecraft server Menno hosts. Browsers cannot open a raw TCP connection to
// port 25565, so the site's own server pings it (server/minecraft.ts, served at /api/minecraft).
// Where that endpoint is missing (a plain static host), it falls back to two public status APIs
// that allow cross-origin requests. Those cache for minutes and either one sometimes reports a
// running server as offline, so then the server counts as online if either sees it.

export const MC_ADDRESS = 'cloud.mvl.sh'
export const MC_PORT = 25565
const APIS = {
  mcstatus: `https://api.mcstatus.io/v2/status/java/${MC_ADDRESS}:${MC_PORT}`,
  mcsrvstat: `https://api.mcsrvstat.us/3/${MC_ADDRESS}:${MC_PORT}`,
}
// Both APIs cache for about a minute, so a join can take a minute or two to show up.
const REFRESH_MS = 30_000

export type McStatus = {
  online: boolean
  version?: string
  motd?: string
  /** `list` is the named part of the sample; `hidden` counts those in it who hide their name. */
  players: { online: number; max: number; list: string[]; hidden?: number }
  icon?: string
  /** Milliseconds for the site's server to get an answer (only from /api/minecraft). */
  latency?: number
  checkedAt: number
  /** Over RCON, when the site's server has it set up (server/minecraft.ts); never from the public APIs. */
  world?: McWorld
  playerInfo?: Record<string, McPlayerInfo>
  settings?: { difficulty?: string; border?: number; software?: string }
}

/** In-game day and time: `ticks` into the day (0 is 06:00), `clock` that as HH:MM. */
export type McWorld = { day: number; ticks: number; clock: string; phase: 'day' | 'dusk' | 'night' | 'dawn' }
/** `dimension` is overworld, nether, end or a datapack's own; `health` is 0..20 (two per heart). */
export type McPlayerInfo = { dimension?: string; level?: number; health?: number }

const PHASE_ICON: Record<McWorld['phase'], string> = { day: '☀', dusk: '◐', night: '☾', dawn: '◑' }
/** "☀ Day 412 · 14:20", for the window's header, the top bar popup and the widget. */
export const worldLine = (w: McWorld) => `${PHASE_ICON[w.phase]} Day ${w.day} · ${w.clock}`

type State = { status: McStatus | null; error?: string; loading: boolean }

let state: State = { status: null, loading: false }
const listeners = new Set<() => void>()
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

let inflight: Promise<State> | null = null

export function fetchMinecraft(force = false): Promise<State> {
  if (inflight) return inflight
  if (!force && state.status && Date.now() - state.status.checkedAt < REFRESH_MS / 2) return Promise.resolve(state)
  set({ loading: true })
  const get = (url: string) =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    })
  inflight = get('/api/minecraft')
    .then((j: McStatus) => {
      if (typeof j?.online !== 'boolean') throw new Error('no status endpoint')
      const status = { ...j, checkedAt: Date.now() }
      watch(status, true)
      set({ loading: false, error: undefined, status })
      return state
    })
    .catch(() => fromPublicApis(get))
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Players who switched off "Allow Server Listings" come through as "Anonymous Player": leave them out. */
const named = (list: Json[] | undefined) => (list ?? []).filter((p) => p.uuid !== '00000000-0000-0000-0000-000000000000')

function fromPublicApis(get: (url: string) => Promise<Json>): Promise<State> {
  return Promise.allSettled([get(APIS.mcstatus), get(APIS.mcsrvstat)])
    .then(([a, b]) => {
      const fromMcstatus = a.status === 'fulfilled' ? fromMcstatusJson(a.value) : null
      const fromMcsrvstat = b.status === 'fulfilled' ? fromMcsrvstatJson(b.value) : null
      if (!fromMcstatus && !fromMcsrvstat) throw new Error(a.status === 'rejected' ? String(a.reason?.message ?? a.reason) : 'no answer')
      const picked = [fromMcstatus, fromMcsrvstat].find((x) => x?.online) ?? fromMcstatus ?? fromMcsrvstat!
      // The two caches refresh at different times; listing everyone either one sees keeps a
      // player from flickering in and out between polls.
      const seen = [fromMcstatus, fromMcsrvstat].filter((x) => x?.online).flatMap((x) => x!.players.list)
      const status = { ...picked, players: { ...picked.players, list: [...new Set(seen)] } }
      watch(status)
      set({ loading: false, error: undefined, status })
      return state
    })
    .catch((err: Error) => {
      set({ loading: false, error: err.message })
      return state
    })
}

// Join, leave and up/down notifications. The first answer is the baseline. A live answer from the
// server itself is trusted at once; with the public APIs a player only counts as gone after two
// polls in a row without them, since their caches can briefly disagree.
// Switched on and off with the other notifications (Settings → Notifications, src/os/notifyPrefs.ts).
export const mcNotificationsOn = () => sourceOn('minecraft.players') || sourceOn('minecraft.status')
export function setMcNotifications(on: boolean) {
  setOn('minecraft', on)
  if (on) setOn('minecraft.players', true), setOn('minecraft.status', true)
  listeners.forEach((l) => l())
}

let last: { online: boolean; count: number; misses: Map<string, number> } | null = null
const head = (name: string) => `https://mc-heads.net/avatar/${encodeURIComponent(name)}/32`

function watch(st: McStatus, live = false) {
  const prev = last
  const misses = new Map<string, number>()
  last = { online: st.online, count: st.players.online, misses }
  for (const name of st.players.list) misses.set(name, 0)
  if (!prev) return

  // Signed in, the server's notification hub watches the server and tells the account (server/watchers.ts).
  const tell = (n: Parameters<typeof notify>[0]) => !signedIn() && notify({ source: 'minecraft.players', action: { app: 'mcserver' }, ...n })
  if (prev.online !== st.online) {
    tell({ title: st.online ? "Menno's Minecraft server is back online" : "Menno's Minecraft server went offline", body: MC_ADDRESS, source: 'minecraft.status' })
    if (!st.online) return
  }
  if (!st.online) return

  const joined = st.players.list.filter((p) => !prev.misses.has(p))
  const left: string[] = []
  // With fewer names than players (some hide theirs, and can switch between pings) a missing name
  // may still be on: only a complete list says who left.
  const complete = st.players.list.length >= st.players.online
  for (const [name, n] of prev.misses) {
    if (misses.has(name)) continue
    if (!complete) misses.set(name, n)
    else if (live || n + 1 >= 2) left.push(name)
    else misses.set(name, n + 1) // missing once: keep watching
  }
  const total = `${st.players.online} of ${st.players.max} players online · ${MC_ADDRESS}`
  if (joined.length > 2) tell({ title: `${joined.length} players joined Menno's Minecraft server`, body: total })
  else joined.forEach((p) => tell({ title: `${p} joined Menno's Minecraft server`, body: total, icon: head(p) }))
  if (left.length > 2) tell({ title: `${left.length} players left Menno's Minecraft server`, body: total })
  else left.forEach((p) => tell({ title: `${p} left Menno's Minecraft server`, body: total, icon: head(p) }))

  // Servers that hide their player list still report a count.
  if (!st.players.list.length && !prev.misses.size && st.players.online !== prev.count) {
    tell({ title: `Someone ${st.players.online > prev.count ? 'joined' : 'left'} Menno's Minecraft server`, body: total })
  }
}

type Json = Record<string, any>

function fromMcstatusJson(j: Json): McStatus {
  return {
    online: !!j.online,
    version: j.version?.name_clean,
    motd: j.motd?.clean,
    players: { online: j.players?.online ?? 0, max: j.players?.max ?? 0, list: named(j.players?.list).map((p: Json) => p.name_clean) },
    icon: j.icon || undefined,
    checkedAt: Date.now(),
  }
}

function fromMcsrvstatJson(j: Json): McStatus {
  return {
    online: !!j.online,
    version: typeof j.version === 'string' ? j.version.replace(/^Paper |^Spigot /, '') : undefined,
    motd: Array.isArray(j.motd?.clean) ? j.motd.clean.join(' ').trim() : undefined,
    players: { online: j.players?.online ?? 0, max: j.players?.max ?? 0, list: named(j.players?.list).map((p: Json) => p.name) },
    icon: j.icon || undefined,
    checkedAt: Date.now(),
  }
}

export function useMinecraft() {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
  useEffect(startPolling, [])
  return s
}

// One poller for the whole page, however many widgets show the status. Paused while the tab is hidden.
let polling = false
function startPolling() {
  if (polling) return
  polling = true
  fetchMinecraft()
  setInterval(() => document.visibilityState === 'visible' && fetchMinecraft(true), REFRESH_MS)
}

// ---------------------------------------------------------------------------------------------
// History, for the Minecraft server window: the site's server pings every 30 s and keeps 30 days
// (server/minecraft.ts). Only there; on a static host the window shows the live status alone.

export type McRange = '24h' | '7d' | '30d'
/** Who was on in a bucket (earliest first, at most 12; `more` the rest), `joined`/`left` when inside it. */
export type McBucket = {
  from: number
  to: number
  peak: number | null
  avg: number | null
  uptime: number | null
  players?: { name: string; joined?: number; left?: number }[]
  more?: number
  joins?: number
}
export type McOverview = {
  status: McStatus
  tracking: boolean
  trackedSince: number | null
  stateSince: number | null
  uptime: { day: number | null; week: number | null; month: number | null }
  latency: number | null
  peak: { players: number; at: number } | null
  range: McRange
  buckets: McBucket[]
  online: { name: string; since: number }[]
  recent: { name: string; joinedAt: number; leftAt: number | null }[]
  top: { name: string; ms: number; visits: number; lastSeen: number | null }[]
}

/** The overview for `range`, refreshed every 30 s while shown. `missing` when the endpoint isn't there. */
export function useMcOverview(range: McRange) {
  const [state, setState] = useState<{ data: McOverview | null; missing: boolean; loading: boolean }>({ data: null, missing: false, loading: true })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const ctl = new AbortController()
    setState((s) => ({ ...s, loading: true }))
    fetch(`/api/minecraft/overview?range=${range}`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: McOverview) => {
        if (!Array.isArray(data?.buckets)) throw new Error('no overview endpoint')
        setState({ data, missing: false, loading: false })
      })
      .catch((e: Error) => e.name !== 'AbortError' && setState((s) => ({ data: s.data, missing: !s.data, loading: false })))
    // A hidden tab waits until it is looked at again.
    const bump = () => setTick((n) => n + 1)
    const t = setTimeout(() => (document.visibilityState === 'visible' ? bump() : document.addEventListener('visibilitychange', bump, { once: true })), REFRESH_MS)
    return () => {
      ctl.abort()
      clearTimeout(t)
      document.removeEventListener('visibilitychange', bump)
    }
  }, [range, tick])
  return { ...state, refresh: () => setTick((n) => n + 1) }
}

// ---------------------------------------------------------------------------------------------
// The RCON panel in the Minecraft server window, for admins (POST /api/minecraft/rcon checks that).

export type McAdminRequest =
  | { action: 'command'; command: string }
  | { action: 'say'; text: string }
  | { action: 'tell'; name: string; text: string }
  | { action: 'kick'; name: string; reason?: string }
  | { action: 'whitelist'; op: 'list' | 'add' | 'remove'; name?: string }
export type McAdminResult = { command: string; output: string; whitelist?: string[] }

export const mcAdmin = (req: McAdminRequest) => api<McAdminResult>('/api/minecraft/rcon', { method: 'POST', json: req })
export const mcAdminInfo = () => api<{ configured: boolean }>('/api/minecraft/rcon')
