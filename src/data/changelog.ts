import { useEffect, useSyncExternalStore } from 'react'

// MvL OS releases for the Changelog app: GitHub's public releases API, preferably through the
// site's cached /api/git proxy (server/github.ts), with a direct fallback when that is absent.

const REPO = 'vleeuwenmenno/mennovanleeuwen.nl'
const PATH = `${REPO}/releases?per_page=30`
const CACHE_KEY = 'mvlos.changelog.v1'
const CACHE_TTL = 10 * 60 * 1000

export type Release = {
  id: number
  tag: string
  name: string
  body: string
  url: string
  publishedAt: string
  prerelease: boolean
}

type State = {
  releases: Release[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
}

let state: State = { releases: [], status: 'idle' }
const listeners = new Set<() => void>()
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

function readCache(): Release[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const { at, releases } = JSON.parse(raw) as { at: number; releases: Release[] }
    return Date.now() - at < CACHE_TTL && Array.isArray(releases) ? releases : null
  } catch {
    return null
  }
}

function writeCache(releases: Release[]) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), releases }))
  } catch {
    /* private mode or quota */
  }
}

type GhRelease = {
  id: number
  tag_name?: string
  name?: string | null
  body?: string | null
  html_url?: string
  published_at?: string | null
  created_at?: string
  prerelease?: boolean
  draft?: boolean
}

function normalize(raw: unknown): Release[] {
  if (!Array.isArray(raw)) return []
  return (raw as GhRelease[])
    .filter((r) => r && !r.draft && typeof r.tag_name === 'string')
    .map((r) => ({
      id: r.id,
      tag: r.tag_name!,
      name: (r.name && r.name.trim()) || r.tag_name!,
      body: (r.body ?? '').trim(),
      url: r.html_url || `https://github.com/${REPO}/releases/tag/${encodeURIComponent(r.tag_name!)}`,
      publishedAt: r.published_at || r.created_at || new Date(0).toISOString(),
      prerelease: !!r.prerelease,
    }))
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

/** Prefer the site's proxy; fall back to GitHub directly (CORS allows public releases). */
async function loadReleases(): Promise<Release[]> {
  try {
    return normalize(await fetchJson(`/api/git/${PATH}`))
  } catch {
    return normalize(await fetchJson(`https://api.github.com/repos/${PATH}`))
  }
}

let inflight: Promise<void> | null = null

/** Releases for the Changelog app and the `changelog` terminal command (throws if GitHub is unreachable and nothing is cached). */
export async function loadChangelog(): Promise<Release[]> {
  await ensureChangelog()
  if (state.releases.length) return state.releases
  throw new Error(state.error || 'GitHub did not answer')
}

export function refreshChangelog(): Promise<void> {
  inflight = null
  return ensureChangelog()
}

export function ensureChangelog(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    const cached = readCache()
    if (cached?.length) set({ releases: cached, status: 'ready' })
    else set({ status: 'loading' })
    try {
      const releases = await loadReleases()
      writeCache(releases)
      set({ releases, status: 'ready', error: undefined })
    } catch (err) {
      if (!state.releases.length) set({ status: 'error', error: (err as Error).message })
    }
  })()
  return inflight
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export function useChangelog() {
  const s = useSyncExternalStore(subscribe, () => state, () => state)
  useEffect(() => {
    void ensureChangelog()
  }, [])
  return { ...s, refresh: refreshChangelog }
}
