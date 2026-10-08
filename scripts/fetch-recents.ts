// Builds public/recents.json: a snapshot of recent activity that the Recents app and the
// `recent` terminal command show before (or instead of) the live GitHub API. git.mvl.sh does
// not send CORS headers, so Pepper's activity can only come in through this snapshot.
//
// Run with `pnpm recents` (Node 22.18+ strips the types). Set GITHUB_TOKEN to avoid the
// 60 requests/hour anonymous limit in CI.

import { writeFile } from 'node:fs/promises'
import { mergeActivity, normalizeForgejoFeed, normalizeGithubEvents, normalizeGithubReleases, type Activity } from '../src/data/normalize.ts'

const GITHUB_USER = 'vleeuwenmenno'
const GITHUB_RELEASE_REPOS = ['vleeuwenmenno/boltwarden', 'vleeuwenmenno/omasoloist']
const FORGEJO = 'https://git.mvl.sh'
const FORGEJO_ORGS = ['pepper']

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
  ...FORGEJO_ORGS.map((org) =>
    attempt(`${FORGEJO}/${org}`, async () => normalizeForgejoFeed(FORGEJO, await json(`${FORGEJO}/api/v1/orgs/${org}/activities/feeds?limit=50`))),
  ),
])

const items = mergeActivity(...lists).slice(0, 150)
await writeFile(new URL('../public/recents.json', import.meta.url), JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2) + '\n')
console.log(`Wrote public/recents.json with ${items.length} items`)
