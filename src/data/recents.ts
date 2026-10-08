import { useEffect, useSyncExternalStore } from 'react'
import { mergeActivity, normalizeGithubEvents, normalizeGithubReleases, type Activity } from './normalize.ts'

export type { Activity } from './normalize.ts'

const GITHUB_USER = 'vleeuwenmenno'
const RELEASE_REPOS = ['vleeuwenmenno/boltwarden']
const CACHE_KEY = 'mvlos.recents.v1'
const CACHE_TTL = 10 * 60 * 1000

export type RecentsState = {
  items: Activity[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  live: boolean
  snapshotAt?: string
  error?: string
}

let state: RecentsState = { items: [], status: 'idle', live: false }
const listeners = new Set<() => void>()
const set = (patch: Partial<RecentsState>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

function readCache(): Activity[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const { at, items } = JSON.parse(raw)
    return Date.now() - at < CACHE_TTL ? items : null
  } catch {
    return null
  }
}

function writeCache(items: Activity[]) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), items }))
  } catch {
    /* private mode or quota: the snapshot still works */
  }
}

async function getJson(url: string) {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

let inflight: Promise<RecentsState> | null = null

/** Loads the build-time snapshot first, then layers the live GitHub API on top. */
export function loadRecents(): Promise<RecentsState> {
  if (inflight) return inflight
  inflight = (async () => {
    set({ status: 'loading' })
    let snapshot: Activity[] = []
    try {
      const data = await getJson('/recents.json')
      snapshot = data.items ?? []
      set({ items: snapshot, snapshotAt: data.generatedAt, status: 'ready' })
    } catch {
      /* no snapshot in dev until `pnpm recents` has run */
    }

    const cached = readCache()
    if (cached) {
      set({ items: mergeActivity(snapshot, cached), live: true, status: 'ready' })
      return state
    }

    try {
      const [events, ...releases] = await Promise.all([
        getJson(`https://api.github.com/users/${GITHUB_USER}/events/public?per_page=100`),
        ...RELEASE_REPOS.map((r) => getJson(`https://api.github.com/repos/${r}/releases?per_page=10`)),
      ])
      const live = mergeActivity(normalizeGithubEvents(events), ...releases.map((r, i) => normalizeGithubReleases(RELEASE_REPOS[i], r)))
      writeCache(live)
      set({ items: mergeActivity(snapshot, live), live: true, status: 'ready' })
    } catch (err) {
      set({ status: snapshot.length ? 'ready' : 'error', error: (err as Error).message })
    }
    return state
  })()
  return inflight
}

export function useRecents() {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
  useEffect(() => {
    loadRecents()
  }, [])
  return s
}

const repoStars = new Map<string, Promise<number | null>>()

/** Live star count for a GitHub repo, memoized for the page's lifetime. */
export function fetchStars(repo: string): Promise<number | null> {
  let p = repoStars.get(repo)
  if (!p) {
    p = getJson(`https://api.github.com/repos/${repo}`)
      .then((r) => r.stargazers_count as number)
      .catch(() => null)
    repoStars.set(repo, p)
  }
  return p
}

export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  return mo < 12 ? `${mo}mo ago` : `${Math.round(mo / 12)}y ago`
}
