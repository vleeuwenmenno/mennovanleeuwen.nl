// git log / git show for the terminal, and MvL OS release notes for the Changelog app, through
// the site's server: cached for a minute and, with GITHUB_TOKEN set, under the authenticated rate
// limit instead of each visitor's 60 an hour. Only commit and releases endpoints of the repos the
// site shows are passed through. At most 500 answers are kept (failures for 5 seconds) and 6
// requests to GitHub run at once; past that the answer is a quick 503.

import { boundedCache } from './boundedcache.ts'

const REPOS = new Set(['vleeuwenmenno/mennovanleeuwen.nl', 'vleeuwenmenno/boltwarden', 'vleeuwenmenno/omasoloist', 'maajix/omarchy-spotlight', 'chr0nzz/omarchy-omafile'])
const CACHE_MS = 60_000
const cache = boundedCache<{ status: number; body: string }>({ max: 500, ttlMs: CACHE_MS, failTtlMs: 5_000, maxInFlight: 6 })
const BUSY = { status: 503, body: '{"message":"Too many requests to GitHub right now"}' }

/** Entries held and requests running, for the check script. */
export const githubCacheStats = () => ({ size: cache.size(), inFlight: cache.inFlight() })

const COMMITS = /^([\w.-]+\/[\w.-]+)\/commits(\/[0-9a-zA-Z._-]+)?(\?per_page=\d{1,3})?$/
const RELEASES = /^([\w.-]+\/[\w.-]+)\/releases(\?per_page=\d{1,3})?$/

/** `path` is e.g. "vleeuwenmenno/boltwarden/commits?per_page=10", ".../commits/<sha>", or ".../releases?per_page=30". */
export function githubCommits(path: string): Promise<{ status: number; body: string }> {
  const m = COMMITS.exec(path) ?? RELEASES.exec(path)
  if (!m || !REPOS.has(m[1])) return Promise.resolve({ status: 404, body: '{"message":"Not Found"}' })
  return cache.get(
    path,
    () => {
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'mvlos' }
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
      return fetch(`https://api.github.com/repos/${path}`, { headers, signal: AbortSignal.timeout(8000) })
        .then(async (r) => ({ value: { status: r.status, body: await r.text() }, ok: r.ok }))
        .catch(() => ({ value: { status: 502, body: '{"message":"GitHub did not answer"}' }, ok: false }))
    },
    BUSY,
  )
}
