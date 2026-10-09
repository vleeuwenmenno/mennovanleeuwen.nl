import type { Hit } from './code'
import { synced } from '../os/synced'

// Repositories, issues, pull requests and branches you opened from Spotlight, so they come back
// first (and at once, without asking GitHub) the next time you type part of their name. Kept per
// browser, synced when signed in; the 40 most used and recent.

export type RecentHit = { hit: Hit; count: number; at: number }

const MAX = 40
const store = synced<RecentHit[]>('spotlight-recent', [], { normalize: (v) => (Array.isArray(v) ? v.filter((r) => r && r.hit && typeof r.at === 'number') : []) })

export const useRecentHits = store.use

/** One key per thing, whichever search found it. */
export const hitKey = (h: Hit) => `${h.source}|${h.kind}|${'fullName' in h ? h.fullName : h.repo}|${'number' in h ? h.number : 'name' in h ? h.name : ''}`

export function rememberHit(hit: Hit) {
  const key = hitKey(hit)
  store.set((all) => {
    const old = all.find((r) => hitKey(r.hit) === key)
    const next = [{ hit, count: (old?.count ?? 0) + 1, at: Date.now() }, ...all.filter((r) => hitKey(r.hit) !== key)]
    // Keep the most useful: often and lately opened.
    return next.length <= MAX ? next : next.sort((a, b) => weight(b) - weight(a)).slice(0, MAX)
  })
}

export const forgetHit = (hit: Hit) => store.set((all) => all.filter((r) => hitKey(r.hit) !== hitKey(hit)))

/** How much a remembered hit counts: how often, fading over a couple of weeks. */
export const weight = (r: RecentHit) => Math.log2(1 + r.count) * Math.exp(-(Date.now() - r.at) / (14 * 864e5))
