import { useEffect, useSyncExternalStore } from 'react'

// Status of the Minecraft server Menno hosts. Browsers cannot open a raw TCP connection to
// port 25565, so this asks two public status APIs that allow cross-origin requests. Either one
// sometimes reports a running server as offline, so the server counts as online if either sees it.

export const MC_ADDRESS = 'cloud.mvl.sh'
export const MC_PORT = 25565
const APIS = {
  mcstatus: `https://api.mcstatus.io/v2/status/java/${MC_ADDRESS}:${MC_PORT}`,
  mcsrvstat: `https://api.mcsrvstat.us/3/${MC_ADDRESS}:${MC_PORT}`,
}
const REFRESH_MS = 60_000

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
  inflight = Promise.allSettled([get(APIS.mcstatus), get(APIS.mcsrvstat)])
    .then(([a, b]) => {
      const fromMcstatus = a.status === 'fulfilled' ? fromMcstatusJson(a.value) : null
      const fromMcsrvstat = b.status === 'fulfilled' ? fromMcsrvstatJson(b.value) : null
      if (!fromMcstatus && !fromMcsrvstat) throw new Error(a.status === 'rejected' ? String(a.reason?.message ?? a.reason) : 'no answer')
      const status = [fromMcstatus, fromMcsrvstat].find((x) => x?.online) ?? fromMcstatus ?? fromMcsrvstat!
      set({ loading: false, error: undefined, status })
      return state
    })
    .catch((err: Error) => {
      set({ loading: false, error: err.message })
      return state
    })
    .finally(() => {
      inflight = null
    })
  return inflight
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
  useEffect(() => {
    fetchMinecraft()
    const t = setInterval(() => document.visibilityState === 'visible' && fetchMinecraft(true), REFRESH_MS)
    return () => clearInterval(t)
  }, [])
  return s
}
