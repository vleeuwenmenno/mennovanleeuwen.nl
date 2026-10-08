// Builds the data snapshots the site reads at runtime:
//
//   public/recents.json        recent activity, shown before (or instead of) the live GitHub API
//   public/contributions.json  a year of daily contribution counts, GitHub + git.mvl.sh
//
// Neither git.mvl.sh nor GitHub's contribution calendar send CORS headers, so this data can only
// reach the browser through these files. Run with `pnpm data` (Node 22.18+ strips the types).
// Set GITHUB_TOKEN to avoid the 60 requests/hour anonymous API limit in CI.

import { writeFile } from 'node:fs/promises'
import { mergeActivity, normalizeForgejoFeed, normalizeGithubEvents, normalizeGithubReleases, type Activity } from '../src/data/normalize.ts'

const GITHUB_USER = 'vleeuwenmenno'
const GITHUB_RELEASE_REPOS = ['vleeuwenmenno/boltwarden', 'vleeuwenmenno/omasoloist']
const FORGEJO = 'https://git.mvl.sh'
const FORGEJO_ORGS = ['pepper']
const FORGEJO_REPOS = ['vleeuwenmenno/golinks']

const ghHeaders: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'mennovanleeuwen.nl' }
if (process.env.GITHUB_TOKEN) ghHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

async function json(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

async function attempt(label: string, fn: () => Promise<Activity[]>): Promise<Activity[]> {
  try {
    const items = await fn()
    console.log(`  ${label}: ${items.length} items`)
    return items
  } catch (err) {
    console.warn(`  ${label}: skipped (${(err as Error).message})`)
    return []
  }
}

console.log('Fetching recent activity')
const lists = await Promise.all([
  attempt('github events', async () => normalizeGithubEvents(await json(`https://api.github.com/users/${GITHUB_USER}/events/public?per_page=100`, ghHeaders))),
  ...GITHUB_RELEASE_REPOS.map((repo) =>
    attempt(`${repo} releases`, async () => normalizeGithubReleases(repo, await json(`https://api.github.com/repos/${repo}/releases?per_page=10`, ghHeaders))),
  ),
  ...FORGEJO_REPOS.map((repo) =>
    attempt(`${FORGEJO}/${repo}`, async () => normalizeForgejoFeed(FORGEJO, await json(`${FORGEJO}/api/v1/repos/${repo}/activities/feeds?limit=30`))),
  ),
  ...FORGEJO_ORGS.map((org) =>
    attempt(`${FORGEJO}/${org}`, async () => normalizeForgejoFeed(FORGEJO, await json(`${FORGEJO}/api/v1/orgs/${org}/activities/feeds?limit=50`))),
  ),
])

const items = mergeActivity(...lists).slice(0, 150)
await writeFile(new URL('../public/recents.json', import.meta.url), JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2) + '\n')
console.log(`Wrote public/recents.json with ${items.length} items`)

// ---------------------------------------------------------------------------------------------
// Contributions

const DAY = 864e5
const today = new Date()
const yearAgo = new Date(today.getTime() - 371 * DAY)
const iso = (d: Date) => d.toISOString().slice(0, 10)

/** GitHub's own contribution calendar, read from the HTML fragment the profile page loads. */
async function githubCalendar(): Promise<Record<string, number>> {
  const res = await fetch(`https://github.com/users/${GITHUB_USER}/contributions`, { headers: { 'User-Agent': 'mennovanleeuwen.nl' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  const dateById = new Map<string, string>()
  for (const m of html.matchAll(/<td[^>]*data-date="(\d{4}-\d{2}-\d{2})"[^>]*id="([^"]+)"/g)) dateById.set(m[2], m[1])
  const out: Record<string, number> = {}
  for (const m of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const date = dateById.get(m[1])
    if (!date) continue
    const n = /^(\d+) contribution/.exec(m[2])
    out[date] = n ? parseInt(n[1], 10) : 0
  }
  if (!Object.keys(out).length) throw new Error('calendar markup not recognised')
  return out
}

// Forgejo's own /heatmap counts mirror syncs of GitHub repos as contributions, which would count
// GitHub work twice. Count real work from the activity feed instead: commits (one per commit, like
// GitHub), new repos, releases, pull requests and issues.
const FORGEJO_COUNTED = new Set(['commit_repo', 'create_repo', 'publish_release', 'create_pull_request', 'merge_pull_request', 'create_issue', 'comment_issue', 'approve_pull_request'])

async function forgejoCalendar(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (let page = 1; page <= 120; page++) {
    const feed: { op_type: string; created: string; content: string }[] = await json(`${FORGEJO}/api/v1/users/${GITHUB_USER}/activities/feeds?only-performed-by=true&limit=50&page=${page}`)
    if (!feed.length) break
    for (const a of feed) {
      if (!FORGEJO_COUNTED.has(a.op_type)) continue
      let n = 1
      if (a.op_type === 'commit_repo') {
        try {
          const c = JSON.parse(a.content || '{}')
          n = c.Len || c.Commits?.length || 1
        } catch {
          /* not JSON: count the push once */
        }
      }
      const day = iso(new Date(a.created))
      out[day] = (out[day] ?? 0) + n
    }
    if (new Date(feed[feed.length - 1].created) < yearAgo) break
  }
  return out
}

const [gh, fj] = await Promise.all([
  githubCalendar().catch((err) => (console.warn(`  github calendar: skipped (${err.message})`), {} as Record<string, number>)),
  forgejoCalendar().catch((err) => (console.warn(`  forgejo feed: skipped (${err.message})`), {} as Record<string, number>)),
])

// 53 full weeks ending today, starting on a Sunday like GitHub's graph.
const start = new Date(today.getTime() - 364 * DAY)
start.setUTCDate(start.getUTCDate() - start.getUTCDay())
const days: { date: string; github: number; forgejo: number }[] = []
for (let d = start; d <= today; d = new Date(d.getTime() + DAY)) {
  const k = iso(d)
  days.push({ date: k, github: gh[k] ?? 0, forgejo: fj[k] ?? 0 })
}
const total = (k: 'github' | 'forgejo') => days.reduce((a, d) => a + d[k], 0)
await writeFile(new URL('../public/contributions.json', import.meta.url), JSON.stringify({ generatedAt: new Date().toISOString(), days }) + '\n')
console.log(`Wrote public/contributions.json: ${days.length} days, ${total('github')} on GitHub, ${total('forgejo')} on git.mvl.sh`)
