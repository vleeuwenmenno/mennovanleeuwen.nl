import { mergeActivity, normalizeForgejoFeed, type Activity } from '../src/data/normalize.ts'

// git.mvl.sh's API sends no CORS headers, so browsers can't read it. The site's server fetches the
// same feeds as scripts/fetch-data.ts (fixed URLs only), cached for a minute for every visitor.

const FORGEJO = 'https://git.mvl.sh'
const FEEDS = [`${FORGEJO}/api/v1/repos/vleeuwenmenno/golinks/activities/feeds?limit=30`, `${FORGEJO}/api/v1/orgs/pepper/activities/feeds?limit=50`]
const CACHE_MS = 60_000

let cached: { at: number; value: Promise<Activity[]> } | null = null

export function forgejoActivity(): Promise<Activity[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const value = Promise.all(
    FEEDS.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(8000) })
        .then((r) => (r.ok ? r.json() : []))
        .then((feed) => normalizeForgejoFeed(FORGEJO, feed))
        .catch(() => [] as Activity[]),
    ),
  ).then((lists) => mergeActivity(...lists))
  cached = { at: Date.now(), value }
  return value
}
