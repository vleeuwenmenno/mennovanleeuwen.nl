import type { BranchHit, Hit, IssueHit, Label, ParsedQuery, RepoHit, SearchResponse } from '../src/data/code.ts'
import { parseQuery } from '../src/data/code.ts'
import type { User } from './auth.ts'
import { sources, type Source } from './forges.ts'

// Spotlight's code search over GitHub and linked Gitea/Forgejo instances. The query grammar is
// in src/data/code.ts (parseQuery). Repository lists, branch lists and pull request lists are
// cached per user for a few minutes, so typing doesn't hammer the APIs; lookups by number and
// text searches go out live.

const REPO_TTL = 5 * 60_000
const LIST_TTL = 2 * 60_000
const cache = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>()

function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value as Promise<T>
  const value = load()
  cache.set(key, { at: Date.now(), ttl, value })
  // Failures aren't cached.
  value.catch(() => cache.get(key)?.value === value && cache.delete(key))
  if (cache.size > 2000) for (const [k, v] of cache) if (Date.now() - v.at > v.ttl) cache.delete(k)
  return value
}

/** Forget a user's cached lists (after linking or unlinking an instance). */
export function clearSearchCache(user: User) {
  for (const k of cache.keys()) if (k.startsWith(`${user.id}|`)) cache.delete(k)
}

// ---------------------------------------------------------------------------------------------
// API shapes, only the fields used

type GhRepo = { full_name: string; html_url: string; description: string | null; private: boolean; fork: boolean; archived: boolean; stargazers_count?: number; stars_count?: number; open_issues_count: number; language: string | null; default_branch: string; pushed_at?: string | null; updated_at?: string; clone_url: string; ssh_url?: string }
export type ApiIssue = {
  number: number
  title: string
  state: string
  html_url: string
  user?: { login: string } | null
  labels?: { name: string; color: string }[]
  comments: number
  created_at: string
  updated_at: string
  body?: string | null
  draft?: boolean
  repository_url?: string
  repository?: { full_name: string }
  pull_request?: { merged_at?: string | null; merged?: boolean } | null
}
type ApiPull = { number: number; title: string; state: string; html_url: string; merged_at?: string | null; merged?: boolean; draft?: boolean; head?: { ref: string }; base?: { ref: string } }
type ApiBranch = { name: string; protected?: boolean; commit: { sha?: string; id?: string; message?: string; timestamp?: string } }

/** Some endpoints answer an error object instead of a list (e.g. pulls on a repo without them). */
export const list = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : [])
const excerpt = (s: string | null | undefined) => (s ?? '').replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 600)
const labels = (l?: { name: string; color: string }[]): Label[] => (l ?? []).map((x) => ({ name: x.name, color: x.color.startsWith('#') ? x.color : `#${x.color}` }))
const isDraft = (title: string, draft?: boolean) => draft ?? /^\s*(\[?wip\]?|draft)[:\s]/i.test(title)

function toRepo(src: Source, r: GhRepo): RepoHit {
  return {
    kind: 'repo',
    source: src.id,
    sourceLabel: src.label,
    url: r.html_url,
    fullName: r.full_name,
    description: r.description || null,
    private: r.private,
    fork: r.fork,
    archived: r.archived,
    stars: r.stargazers_count ?? r.stars_count ?? 0,
    openIssues: r.open_issues_count,
    language: r.language || null,
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at ?? r.updated_at ?? null,
    cloneUrl: r.ssh_url || r.clone_url,
  }
}

function prState(p: { state: string; merged_at?: string | null; merged?: boolean }): IssueHit['state'] {
  return p.merged || p.merged_at ? 'merged' : p.state === 'open' ? 'open' : 'closed'
}

export function toIssue(src: Source, i: ApiIssue, repo?: string, pull?: ApiPull | null): IssueHit {
  const full = repo ?? i.repository?.full_name ?? i.repository_url?.split('/repos/')[1] ?? ''
  const pr = !!i.pull_request
  return {
    kind: pr ? 'pr' : 'issue',
    source: src.id,
    sourceLabel: src.label,
    url: i.html_url,
    repo: full,
    number: i.number,
    title: i.title,
    state: pr ? prState({ state: i.state, merged_at: pull?.merged_at ?? i.pull_request?.merged_at, merged: pull?.merged ?? i.pull_request?.merged }) : i.state === 'open' ? 'open' : 'closed',
    draft: pr && isDraft(i.title, pull?.draft ?? i.draft),
    author: i.user?.login ?? null,
    labels: labels(i.labels),
    comments: i.comments,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    body: excerpt(i.body),
    headRef: pull?.head?.ref,
    baseRef: pull?.base?.ref,
  }
}

// ---------------------------------------------------------------------------------------------
// Repository lists

async function pages<T>(src: Source, path: (page: number) => string, per: number, max: number): Promise<T[]> {
  const out: T[] = []
  for (let page = 1; page <= max; page++) {
    const batch = list<T>(await src.api<T[]>(path(page)))
    out.push(...batch)
    if (batch.length < per) break
  }
  return out
}

/** Every repository the user owns, collaborates on or reaches through an organisation. */
function repoList(user: User, src: Source): Promise<RepoHit[]> {
  return cached(`${user.id}|${src.id}|repos`, REPO_TTL, async () => {
    let raw: GhRepo[]
    if (src.kind === 'github') {
      raw = await pages<GhRepo>(src, (p) => `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${p}`, 100, 5)
    } else {
      const own = await pages<GhRepo>(src, (p) => `/user/repos?limit=50&page=${p}`, 50, 10)
      const orgs = list<{ username?: string; name?: string }>(await src.api('/user/orgs?limit=50'))
      const orgRepos = await Promise.all(orgs.map((o) => pages<GhRepo>(src, (p) => `/orgs/${encodeURIComponent(o.username ?? o.name ?? '')}/repos?limit=50&page=${p}`, 50, 4).catch(() => [])))
      raw = [...own, ...orgRepos.flat()]
    }
    const seen = new Set<string>()
    return raw
      .filter((r) => !seen.has(r.full_name.toLowerCase()) && seen.add(r.full_name.toLowerCase()))
      .map((r) => toRepo(src, r))
      .sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''))
  })
}

/** Higher is better; 0 is no match. In-order letters ("bw" for boltwarden) only with `fuzzy`. */
function score(text: string, q: string, fuzzy = true): number {
  const t = text.toLowerCase()
  if (!q) return 1
  if (t === q) return 100
  if (t.startsWith(q)) return 80
  if (t.split(/[\s/._-]+/).some((w) => w.startsWith(q))) return 60
  if (t.includes(q)) return 40
  if (!fuzzy) return 0
  let i = 0
  for (const ch of t) if (ch === q[i]) i++
  return i === q.length && q.length >= 2 ? 15 : 0
}

const shortName = (full: string) => full.split('/').pop()!

/** The repositories a "repo" or "owner/repo" part of a query refers to, per source. */
async function resolveRepo(user: User, all: Source[], spec: string, errors: string[]): Promise<{ src: Source; repo: RepoHit }[]> {
  const want = spec.toLowerCase()
  if (spec.split('/').some((part) => /^\.+$/.test(part))) return []
  const lists = await Promise.all(all.map((src) => repoList(user, src).then((repos) => ({ src, repos })).catch((e: Error) => (errors.push(e.message), { src, repos: [] as RepoHit[] }))))
  const flat = lists.flatMap(({ src, repos }) => repos.map((repo) => ({ src, repo })))
  if (want.includes('/')) {
    const exact = flat.filter((x) => x.repo.fullName.toLowerCase() === want)
    if (exact.length) return exact
    // Not one of "mine": look it up directly, so facebook/react#1 works too.
    const found = await Promise.all(all.map((src) => src.api<GhRepo>(`/repos/${spec}`).then((r) => (r ? { src, repo: toRepo(src, r) } : null)).catch(() => null)))
    return found.filter((x): x is { src: Source; repo: RepoHit } => !!x)
  }
  for (const test of [(n: string) => n === want, (n: string) => n.startsWith(want), (n: string) => n.includes(want)]) {
    const match = flat.filter((x) => test(shortName(x.repo.fullName).toLowerCase()))
    if (match.length) return match.slice(0, 3)
  }
  return []
}

async function recentRepos(user: User, all: Source[], n: number, errors: string[]) {
  const lists = await Promise.all(all.map((src) => repoList(user, src).then((repos) => repos.map((repo) => ({ src, repo }))).catch((e: Error) => (errors.push(e.message), []))))
  return lists
    .flat()
    .filter((x) => !x.repo.archived)
    .sort((a, b) => (b.repo.pushedAt ?? '').localeCompare(a.repo.pushedAt ?? ''))
    .slice(0, n)
}

// ---------------------------------------------------------------------------------------------
// Issues, pull requests, branches

async function issueByNumber(src: Source, repo: string, n: number): Promise<IssueHit | null> {
  const issue = await src.api<ApiIssue>(`/repos/${repo}/issues/${n}`)
  if (!issue) return null
  const pull = issue.pull_request ? await src.api<ApiPull>(`/repos/${repo}/pulls/${n}`).catch(() => null) : null
  return toIssue(src, issue, repo, pull)
}

async function searchIssues(src: Source, text: string, repo?: string): Promise<IssueHit[]> {
  if (src.kind === 'github') {
    if (repo && !text) {
      return list<ApiIssue>(await src.api(`/repos/${repo}/issues?state=open&sort=updated&per_page=10`)).map((i) => toIssue(src, i, repo))
    }
    // GitHub's issue search wants is:issue or is:pr, so ask for both.
    const lists = await Promise.all(
      ['is:issue', 'is:pr'].map((kind) => {
        const q = [text, repo ? `repo:${repo}` : `involves:${src.login}`, kind, text ? '' : 'is:open'].filter(Boolean).join(' ')
        return src.api<{ items: ApiIssue[] }>(`/search/issues?q=${encodeURIComponent(q)}&sort=updated&per_page=${repo ? 10 : 8}`)
      }),
    )
    return lists.flatMap((res) => (res?.items ?? []).map((i) => toIssue(src, i)))
  }
  const params = new URLSearchParams({ state: text ? 'all' : 'open', limit: repo ? '10' : '8' })
  if (text) params.set('q', text)
  return list<ApiIssue>(await src.api(repo ? `/repos/${repo}/issues?${params}` : `/repos/issues/search?${params}`)).map((i) => toIssue(src, i, repo))
}

/** The repo's most recently updated issues and pull requests, open or closed. */
function recentIssues(user: User, src: Source, repo: string): Promise<IssueHit[]> {
  return cached(`${user.id}|${src.id}|issues|${repo}`, LIST_TTL, async () =>
    list<ApiIssue>(await src.api(src.kind === 'github' ? `/repos/${repo}/issues?state=all&sort=updated&per_page=100` : `/repos/${repo}/issues?state=all&limit=50`)).map((i) => toIssue(src, i, repo)),
  )
}

/** Search APIs match whole words; this also finds what is half typed ("gen" for "generator"). */
async function issuesInRepos(user: User, targets: { src: Source; repo: RepoHit }[], text: string, errors: string[]): Promise<IssueHit[]> {
  const q = text.toLowerCase()
  const [searched, recent] = await Promise.all([
    each(targets, ({ src, repo }) => searchIssues(src, text, repo.fullName), errors),
    text ? each(targets, ({ src, repo }) => recentIssues(user, src, repo.fullName).then((l) => l.filter((i) => i.title.toLowerCase().includes(q))), errors) : Promise.resolve([] as IssueHit[]),
  ])
  const seen = new Set<string>()
  return [...searched, ...recent].filter((i) => {
    const k = `${i.source}|${i.repo.toLowerCase()}|${i.number}`
    return !seen.has(k) && !!seen.add(k)
  })
}

function branchList(user: User, src: Source, repo: string): Promise<ApiBranch[]> {
  return cached(`${user.id}|${src.id}|branches|${repo}`, LIST_TTL, () =>
    src.kind === 'github' ? pages<ApiBranch>(src, (p) => `/repos/${repo}/branches?per_page=100&page=${p}`, 100, 3) : pages<ApiBranch>(src, (p) => `/repos/${repo}/branches?limit=50&page=${p}`, 50, 4),
  )
}

/** Recent pull requests by head branch name, newest first. */
function pullsByHead(user: User, src: Source, repo: string): Promise<Map<string, ApiPull>> {
  return cached(`${user.id}|${src.id}|pulls|${repo}`, LIST_TTL, async () => {
    const pulls = list<ApiPull>(await src.api(src.kind === 'github' ? `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100` : `/repos/${repo}/pulls?state=all&sort=recentupdate&limit=50`))
    const map = new Map<string, ApiPull>()
    for (const p of pulls) if (p.head?.ref && !map.has(p.head.ref)) map.set(p.head.ref, p)
    return map
  })
}

function commitInfo(user: User, src: Source, repo: string, sha: string) {
  return cached(`${user.id}|${src.id}|commit|${repo}|${sha}`, 24 * 3600_000, async () => {
    const c = await src.api<{ commit: { message: string; committer?: { date: string } } }>(`/repos/${repo}/commits/${sha}`)
    return c ? { message: c.commit.message.split('\n')[0], date: c.commit.committer?.date } : null
  })
}

async function branches(user: User, src: Source, repo: RepoHit, text: string, limit: number): Promise<BranchHit[]> {
  const q = text.toLowerCase()
  const [all, pulls] = await Promise.all([branchList(user, src, repo.fullName), pullsByHead(user, src, repo.fullName).catch(() => new Map<string, ApiPull>())])
  const ranked = all
    .map((b) => ({ b, s: score(b.name, q) }))
    .filter((x) => x.s > 0)
    // Among equal matches: the default branch, then branches with a pull request.
    .map((x) => ({ ...x, s: x.s + (x.b.name === repo.defaultBranch ? 0.5 : 0) + (pulls.has(x.b.name) ? 0.3 : 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
  return Promise.all(
    ranked.map(async ({ b }) => {
      const sha = b.commit.sha ?? b.commit.id ?? ''
      const info = b.commit.message ? { message: b.commit.message.split('\n')[0], date: b.commit.timestamp } : src.kind === 'github' && sha ? await commitInfo(user, src, repo.fullName, sha).catch(() => null) : null
      const pr = pulls.get(b.name)
      return {
        kind: 'branch' as const,
        source: src.id,
        sourceLabel: src.label,
        url: src.kind === 'github' ? `${repo.url}/tree/${b.name}` : `${repo.url}/src/branch/${b.name}`,
        repo: repo.fullName,
        name: b.name,
        sha,
        isDefault: b.name === repo.defaultBranch,
        protected: !!b.protected,
        commitMessage: info?.message,
        commitDate: info?.date,
        pr: pr ? { number: pr.number, title: pr.title, state: prState(pr), url: pr.html_url } : undefined,
      }
    }),
  )
}

// ---------------------------------------------------------------------------------------------

/** Runs `fn` per item, collecting results and turning failures into messages. */
async function each<T, R>(items: T[], fn: (x: T) => Promise<R[] | R | null>, errors: string[]): Promise<R[]> {
  const out = await Promise.all(items.map((x) => fn(x).catch((e: Error) => (errors.push(e.message), null))))
  return out.flatMap((r) => (r === null ? [] : Array.isArray(r) ? r : [r]))
}

export async function search(user: User, raw: string): Promise<SearchResponse> {
  const query: ParsedQuery = parseQuery(raw.slice(0, 200))
  const all = sources(user)
  const errors: string[] = []
  let hits: Hit[] = []

  if (query.mode === 'text') {
    const q = query.text.toLowerCase()
    if (q.length < 2) return { query, hits, errors }
    const lists = await each(all, (src) => repoList(user, src), errors)
    const repos = lists
      .map((r) => ({ r, s: Math.max(score(shortName(r.fullName), q) * 1.2, score(r.fullName, q, false), score(r.description ?? '', q, false) * 0.5) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || (b.r.pushedAt ?? '').localeCompare(a.r.pushedAt ?? ''))
      .slice(0, 8)
      .map((x) => x.r)
    const issues = q.length >= 3 ? await each(all, (src) => searchIssues(src, query.text), errors) : []
    hits = [...repos, ...issues.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8)]
  } else if (query.mode === 'number') {
    const targets = query.repo ? await resolveRepo(user, all, query.repo, errors) : await recentRepos(user, all, 8, errors)
    hits = await each(targets, ({ src, repo }) => issueByNumber(src, repo.fullName, query.number), errors)
    // Most recently touched first: with no repo given that is usually the one meant.
    hits.sort((a, b) => ((b as IssueHit).updatedAt ?? '').localeCompare((a as IssueHit).updatedAt ?? ''))
  } else if (query.mode === 'issues') {
    if (query.repo) {
      hits = await issuesInRepos(user, await resolveRepo(user, all, query.repo, errors), query.text, errors)
    } else {
      // Everywhere: the search APIs, plus half-typed matches in the repos pushed to most recently.
      const [found, recent] = await Promise.all([each(all, (src) => searchIssues(src, query.text), errors), query.text ? recentRepos(user, all, 4, errors).then((t) => issuesInRepos(user, t, query.text, errors)) : []])
      const seen = new Set<string>()
      hits = [...found, ...recent].filter((i) => {
        const k = `${i.source}|${(i as IssueHit).repo.toLowerCase()}|${(i as IssueHit).number}`
        return !seen.has(k) && !!seen.add(k)
      })
    }
    // Open ones first, then the most recently updated.
    hits.sort((a, b) => +((b as IssueHit).state === 'open') - +((a as IssueHit).state === 'open') || ((b as IssueHit).updatedAt ?? '').localeCompare((a as IssueHit).updatedAt ?? ''))
    hits = hits.slice(0, 15)
  } else {
    if (!query.repo && !query.text) return { query, hits, errors }
    const targets = query.repo ? await resolveRepo(user, all, query.repo, errors) : await recentRepos(user, all, 6, errors)
    hits = await each(targets, ({ src, repo }) => branches(user, src, repo, query.text, query.repo ? 12 : 4), errors)
  }
  return { query, hits, errors: [...new Set(errors)] }
}
