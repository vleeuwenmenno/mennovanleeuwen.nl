// git log / git show for the terminal, through the site's server: cached for a minute and, with
// GITHUB_TOKEN set, under the authenticated rate limit instead of each visitor's 60 an hour.
// Only commit endpoints of the repos the site shows are passed through.

const REPOS = new Set(['vleeuwenmenno/mennovanleeuwen.nl', 'vleeuwenmenno/boltwarden', 'vleeuwenmenno/omasoloist', 'maajix/omarchy-spotlight', 'chr0nzz/omarchy-omafile'])
const CACHE_MS = 60_000
const cache = new Map<string, { at: number; value: Promise<{ status: number; body: string }> }>()

/** `path` is e.g. "vleeuwenmenno/boltwarden/commits?per_page=10" or ".../commits/<sha>". */
export function githubCommits(path: string): Promise<{ status: number; body: string }> {
  const m = /^([\w.-]+\/[\w.-]+)\/commits(\/[0-9a-zA-Z._-]+)?(\?per_page=\d{1,3})?$/.exec(path)
  if (!m || !REPOS.has(m[1])) return Promise.resolve({ status: 404, body: '{"message":"Not Found"}' })
  const hit = cache.get(path)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'mvlos' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const value = fetch(`https://api.github.com/repos/${path}`, { headers, signal: AbortSignal.timeout(8000) })
    .then(async (r) => ({ status: r.status, body: await r.text() }))
    .catch(() => ({ status: 502, body: '{"message":"GitHub did not answer"}' }))
  cache.set(path, { at: Date.now(), value })
  return value
}
