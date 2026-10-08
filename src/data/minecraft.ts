import { useEffect, useSyncExternalStore } from 'react'
import { notify } from '../os/notify'

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
  players: { online: number; max: number; list: string[] }
  icon?: string
  checkedAt: number
}

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
const NOTIFY_KEY = 'mvlos.mc.notify'
let notifyOn = (() => {
  try {
    return localStorage.getItem(NOTIFY_KEY) !== 'off'
  } catch {
    return true
  }
})()
export const mcNotificationsOn = () => notifyOn
export function setMcNotifications(on: boolean) {
  notifyOn = on
  try {
    localStorage.setItem(NOTIFY_KEY, on ? 'on' : 'off')
  } catch {
    /* preference just won't persist */
  }
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

  const tell = (n: Parameters<typeof notify>[0]) => notifyOn && notify(n)
  if (prev.online !== st.online) {
    tell({ title: st.online ? "Menno's Minecraft server is back online" : "Menno's Minecraft server went offline", body: MC_ADDRESS })
    if (!st.online) return
  }
  if (!st.online) return

  const joined = st.players.list.filter((p) => !prev.misses.has(p))
  const left: string[] = []
  for (const [name, n] of prev.misses) {
    if (misses.has(name)) continue
    if (live || n + 1 >= 2) left.push(name)
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
    players: { online: j.players?.online ?? 0, max: j.players?.max ?? 0, list: (j.players?.list ?? []).map((p: Json) => p.name_clean) },
    icon: j.icon || undefined,
    checkedAt: Date.now(),
  }
}

function fromMcsrvstatJson(j: Json): McStatus {
  return {
    online: !!j.online,
    version: typeof j.version === 'string' ? j.version.replace(/^Paper |^Spigot /, '') : undefined,
    motd: Array.isArray(j.motd?.clean) ? j.motd.clean.join(' ').trim() : undefined,
    players: { online: j.players?.online ?? 0, max: j.players?.max ?? 0, list: (j.players?.list ?? []).map((p: Json) => p.name) },
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
