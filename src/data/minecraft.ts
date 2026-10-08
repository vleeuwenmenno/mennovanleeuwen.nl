import { useEffect, useSyncExternalStore } from 'react'

// Status of the Minecraft server Menno hosts. Browsers cannot open a raw TCP connection to
// port 25565, so this asks mcstatus.io (which allows cross-origin requests and caches ~1 minute).

export const MC_ADDRESS = 'cloud.mvl.sh'
export const MC_PORT = 25565
const API = `https://api.mcstatus.io/v2/status/java/${MC_ADDRESS}:${MC_PORT}`
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
  inflight = fetch(API)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    })
    .then((j) => {
      set({
        loading: false,
        error: undefined,
        status: {
          online: !!j.online,
          version: j.version?.name_clean,
          motd: j.motd?.clean,
          players: { online: j.players?.online ?? 0, max: j.players?.max ?? 0, list: (j.players?.list ?? []).map((p: { name_clean: string }) => p.name_clean) },
          icon: j.icon || undefined,
          checkedAt: Date.now(),
        },
      })
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
