import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GitBranch, GitCommit, GitCommitItem, GitFile, GitFileList, GitIssue, GitIssueItem, GitPage, GitPull, GitRepoList, GitRepoOverview } from '../src/data/gitTypes.ts'
import type { User } from './auth.ts'
import { onUserGone } from './db.ts'
import { sources, type Source } from './forges.ts'
import { HttpError, json } from './http.ts'
import { list, repoList } from './search.ts'
import { capPatches, normCommit, normCommitItem, normFile, normIssue, normIssueItem, normPull, normReadme, normRepo, parseUnifiedDiff, type RawComment, type RawCommit, type RawFile, type RawIssue, type RawPull, type RawRepo } from './gitShapes.ts'

// The Git app's read-only API (src/apps/Git.tsx): a signed-in user's repositories on GitHub and
// linked Gitea/Forgejo instances, and per repository its README, pull requests, issues and
// commits with their diffs. Every route is spelled out below and every part of the path is
// checked, so this is no open proxy to the hosts' APIs; it only reads. Answers are kept a minute
// per user, so going back and forth doesn't spend the hosts' rate limits.
//
//   GET /api/repos                                         repositories, from every host
//   GET /api/repos/:source/:owner/:repo                    the repository and its README
//   GET /api/repos/:source/:owner/:repo/branches
//   GET /api/repos/:source/:owner/:repo/pulls?state=&page=  open, closed, merged or all
//   GET /api/repos/:source/:owner/:repo/pulls/:n           body, meta and comments
//   GET /api/repos/:source/:owner/:repo/pulls/:n/commits?page=
//   GET /api/repos/:source/:owner/:repo/pulls/:n/files     with their patches
//   GET /api/repos/:source/:owner/:repo/issues?state=&page=
//   GET /api/repos/:source/:owner/:repo/issues/:n          body and comments
//   GET /api/repos/:source/:owner/:repo/commits?ref=&page=
//   GET /api/repos/:source/:owner/:repo/commits/:sha       message, files and patches
//
// :source is "github" or "forge:<id>" (server/forges.ts).

const PER_PAGE = 30
const TTL = 60_000
/** A commit by its full hash never changes. */
const COMMIT_TTL = 60 * 60_000

const SOURCE = /^(github|forge:\d{1,9})$/
const OWNER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
const NUMBER = /^[1-9]\d{0,9}$/
const SHA = /^[0-9a-fA-F]{7,64}$/
const PAGE = /^[1-9]\d{0,2}$/

const dots = (s: string) => /^\.+$/.test(s)
export const validOwner = (s: string) => OWNER.test(s) && !dots(s)
export const validRepo = (s: string) => REPO.test(s) && !dots(s) && !s.toLowerCase().endsWith('.git')
/** A branch or tag name: Git's own rules, near enough (no "..", no "//", no leading "-" or "/"). */
export const validRef = (s: string) => /^[A-Za-z0-9._/+@-]{1,200}$/.test(s) && !s.includes('..') && !s.includes('//') && !/^[-/.]/.test(s) && !/[/.]$/.test(s) && !s.endsWith('.lock')

export type GitRoute =
  | { kind: 'repos' }
  | { kind: 'repo' | 'branches' | 'pulls' | 'issues' | 'commits'; source: string; owner: string; repo: string }
  | { kind: 'pull' | 'pullCommits' | 'pullFiles' | 'issue'; source: string; owner: string; repo: string; number: number }
  | { kind: 'commit'; source: string; owner: string; repo: string; sha: string }

/** "/api/repos/github/a/b/pulls/3" → its route, or null for anything this API doesn't answer. */
export function parseRoute(path: string): GitRoute | null {
  if (path === '/api/repos' || path === '/api/repos/') return { kind: 'repos' }
  if (!path.startsWith('/api/repos/')) return null
  let parts: string[]
  try {
    parts = path.slice('/api/repos/'.length).split('/').map(decodeURIComponent)
  } catch {
    return null
  }
  const [source, owner, repo, section, id, sub, ...rest] = parts
  if (rest.length || parts.length < 3 || !SOURCE.test(source) || !validOwner(owner) || !validRepo(repo)) return null
  const at = { source, owner, repo }
  if (section === undefined) return { kind: 'repo', ...at }
  if (section === 'branches' && id === undefined) return { kind: 'branches', ...at }
  if (section === 'pulls' || section === 'issues' || section === 'commits') {
    if (id === undefined) return { kind: section, ...at }
    if (section === 'commits') return SHA.test(id) && sub === undefined ? { kind: 'commit', ...at, sha: id.toLowerCase() } : null
    if (!NUMBER.test(id)) return null
    const number = Number(id)
    if (section === 'issues') return sub === undefined ? { kind: 'issue', ...at, number } : null
    if (sub === undefined) return { kind: 'pull', ...at, number }
    if (sub === 'commits') return { kind: 'pullCommits', ...at, number }
    if (sub === 'files') return { kind: 'pullFiles', ...at, number }
  }
  return null
}

/** ?page= as a number (1 when absent); anything odd is a 400. */
export function pageParam(v: string | null): number {
  if (v === null || v === '') return 1
  if (!PAGE.test(v)) throw new HttpError(400, 'Bad page')
  return Number(v)
}

export function stateParam<T extends string>(v: string | null, allowed: readonly T[], fallback: T): T {
  if (v === null || v === '') return fallback
  if (!(allowed as readonly string[]).includes(v)) throw new HttpError(400, 'Bad state')
  return v as T
}

// ---------------------------------------------------------------------------------------------

const cache = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>()
function cachedAnswer<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value as Promise<T>
  const value = load()
  cache.set(key, { at: Date.now(), ttl, value })
  value.catch(() => cache.get(key)?.value === value && cache.delete(key))
  if (cache.size > 1000) for (const [k, v] of cache) if (Date.now() - v.at > v.ttl) cache.delete(k)
  return value
}
onUserGone((id) => {
  for (const k of cache.keys()) if (k.startsWith(`${id}|`)) cache.delete(k)
})

const enc = encodeURIComponent
const notFound = (what: string) => new HttpError(404, `${what} was not found, or this account can't see it`)

async function repoOverview(src: Source, o: string, r: string): Promise<GitRepoOverview> {
  const raw = await src.api<RawRepo>(`/repos/${o}/${r}`)
  if (!raw) throw notFound('That repository')
  const repo = normRepo(src, raw)
  type Content = { name?: string; path?: string; type?: string; content?: string | null; encoding?: string | null; html_url?: string | null }
  let readme = null
  try {
    if (src.kind === 'github') readme = normReadme(await src.api<Content>(`/repos/${o}/${r}/readme`))
    else {
      // Gitea has no /readme: find one at the top of the default branch.
      const root = list<Content>(await src.api(`/repos/${o}/${r}/contents?ref=${enc(repo.defaultBranch)}`))
      const files = root.filter((f) => f.type === 'file' && /^readme(\.(md|markdown|mdown|txt))?$/i.test(f.name ?? ''))
      const pick = files.find((f) => /\.(md|markdown|mdown)$/i.test(f.name ?? '')) ?? files[0]
      if (pick?.path) readme = normReadme(await src.api<Content>(`/repos/${o}/${r}/contents/${pick.path.split('/').map(enc).join('/')}?ref=${enc(repo.defaultBranch)}`))
    }
  } catch {
    // An empty repository, or one without contents access: no README, the rest still shows.
  }
  return { repo, readme }
}

async function branches(src: Source, o: string, r: string): Promise<GitBranch[]> {
  type Raw = { name: string; protected?: boolean; commit?: { sha?: string; id?: string } }
  const raw = list<Raw>(await src.api(src.kind === 'github' ? `/repos/${o}/${r}/branches?per_page=100` : `/repos/${o}/${r}/branches?limit=50`))
  return raw.map((b) => ({ name: b.name, sha: b.commit?.sha ?? b.commit?.id ?? null, protected: !!b.protected }))
}

const nextPage = (got: number, page: number, per = PER_PAGE) => (got >= per && page < 100 ? page + 1 : null)

async function pulls(src: Source, o: string, r: string, state: 'open' | 'closed' | 'merged' | 'all', page: number): Promise<GitPage<GitIssueItem>> {
  if (src.kind === 'github') {
    if (state === 'merged') {
      // The pull list can't filter on merged; the search API can (it has its own, smaller rate limit).
      const res = await src.api<{ items: RawIssue[]; total_count: number }>(`/search/issues?q=${enc(`repo:${o}/${r} is:pr is:merged`)}&sort=updated&order=desc&per_page=${PER_PAGE}&page=${page}`)
      const items = (res?.items ?? []).map((i) => ({ ...normIssueItem(i, true), state: 'merged' as const }))
      return { items, next: res && page * PER_PAGE < Math.min(res.total_count, 1000) ? page + 1 : null }
    }
    const raw = list<RawPull>(await src.api(`/repos/${o}/${r}/pulls?state=${state}&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`))
    return { items: raw.map((p) => normIssueItem(p, true)), next: nextPage(raw.length, page) }
  }
  const raw = list<RawPull>(await src.api(`/repos/${o}/${r}/pulls?state=${state === 'merged' ? 'closed' : state}&sort=recentupdate&limit=${PER_PAGE}&page=${page}`))
  const items = raw.map((p) => normIssueItem(p, true))
  return { items: state === 'merged' ? items.filter((i) => i.state === 'merged') : items, next: nextPage(raw.length, page) }
}

async function issues(src: Source, o: string, r: string, state: 'open' | 'closed' | 'all', page: number): Promise<GitPage<GitIssueItem>> {
  if (src.kind === 'github') {
    // GitHub's issue list has pull requests in it too. They are left out, reading on (a few pages of
    // 100 at most) until there is something to show, so a repository busy with pull requests
    // doesn't answer with empty pages.
    const items: GitIssueItem[] = []
    let at = page
    while (at < page + 3 && at <= 100) {
      const raw = list<RawIssue>(await src.api(`/repos/${o}/${r}/issues?state=${state}&sort=updated&direction=desc&per_page=100&page=${at}`))
      items.push(...raw.filter((i) => !i.pull_request).map((i) => normIssueItem(i, false)))
      at++
      if (raw.length < 100) return { items, next: null }
      if (items.length) break
    }
    return { items, next: at <= 100 ? at : null }
  }
  const raw = list<RawIssue>(await src.api(`/repos/${o}/${r}/issues?type=issues&state=${state}&limit=${PER_PAGE}&page=${page}`))
  return { items: raw.map((i) => normIssueItem(i, false)), next: nextPage(raw.length, page) }
}

const commentsOf = async (src: Source, o: string, r: string, n: number) =>
  list<RawComment>(await src.api(src.kind === 'github' ? `/repos/${o}/${r}/issues/${n}/comments?per_page=100` : `/repos/${o}/${r}/issues/${n}/comments`)).slice(0, 200)

async function issue(src: Source, o: string, r: string, n: number): Promise<GitIssue> {
  const [raw, comments] = await Promise.all([src.api<RawIssue>(`/repos/${o}/${r}/issues/${n}`), commentsOf(src, o, r, n).catch(() => [])])
  if (!raw) throw notFound(`Issue #${n}`)
  return normIssue(raw, comments, !!raw.pull_request)
}

async function pull(src: Source, o: string, r: string, n: number): Promise<GitPull> {
  const [raw, asIssue, comments] = await Promise.all([
    src.api<RawPull>(`/repos/${o}/${r}/pulls/${n}`),
    // GitHub's pull answer has no comment count or (on older answers) labels; its issue does.
    src.kind === 'github' ? src.api<RawIssue>(`/repos/${o}/${r}/issues/${n}`).catch(() => null) : Promise.resolve(null),
    commentsOf(src, o, r, n).catch(() => []),
  ])
  if (!raw) throw notFound(`Pull request #${n}`)
  return normPull(raw, comments, asIssue)
}

async function pullCommits(src: Source, o: string, r: string, n: number, page: number): Promise<GitPage<GitCommitItem>> {
  const per = src.kind === 'github' ? 100 : 50
  const raw = await src.api<RawCommit[]>(src.kind === 'github' ? `/repos/${o}/${r}/pulls/${n}/commits?per_page=${per}&page=${page}` : `/repos/${o}/${r}/pulls/${n}/commits?limit=${per}&page=${page}&files=false&verification=false`)
  if (!raw) throw notFound(`Pull request #${n}`)
  const items = list<RawCommit>(raw)
  return { items: items.map(normCommitItem), next: nextPage(items.length, page, per) }
}

/** A Gitea diff that can't be read here (too big) leaves the file list without patches. */
async function giteaDiff(src: Source, path: string): Promise<GitFile[] | null> {
  try {
    const text = await src.text(path)
    return text === null ? null : parseUnifiedDiff(text)
  } catch (e) {
    if (e instanceof HttpError && e.status === 413) return null
    throw e
  }
}

async function pullFiles(src: Source, o: string, r: string, n: number): Promise<GitFileList> {
  if (src.kind === 'github') {
    const files: RawFile[] = []
    let truncated = false
    for (let page = 1; page <= 3; page++) {
      const raw = await src.api<RawFile[]>(`/repos/${o}/${r}/pulls/${n}/files?per_page=100&page=${page}`)
      if (!raw) throw notFound(`Pull request #${n}`)
      files.push(...list<RawFile>(raw))
      if (raw.length < 100) break
      if (page === 3) truncated = true
    }
    return { files: capPatches(files.map(normFile)), truncated }
  }
  const parsed = await giteaDiff(src, `/repos/${o}/${r}/pulls/${n}.diff`)
  if (parsed) return { files: capPatches(parsed), truncated: false }
  // Too big for a diff here: the names only (Gitea 1.19 and later list them).
  const raw = list<RawFile>(await src.api(`/repos/${o}/${r}/pulls/${n}/files?limit=50`).catch(() => []))
  return { files: raw.map((f) => ({ ...normFile(f), patch: null, binary: false, tooLarge: true })), truncated: true }
}

async function commits(src: Source, o: string, r: string, ref: string | null, page: number): Promise<GitPage<GitCommitItem>> {
  const sha = ref ? `&sha=${enc(ref)}` : ''
  const raw = list<RawCommit>(await src.api(src.kind === 'github' ? `/repos/${o}/${r}/commits?per_page=${PER_PAGE}&page=${page}${sha}` : `/repos/${o}/${r}/commits?limit=${PER_PAGE}&page=${page}&stat=false&files=false&verification=false${sha}`))
  return { items: raw.map(normCommitItem), next: nextPage(raw.length, page) }
}

async function commit(src: Source, o: string, r: string, sha: string): Promise<GitCommit> {
  if (src.kind === 'github') {
    const raw = await src.api<RawCommit>(`/repos/${o}/${r}/commits/${sha}`)
    if (!raw) throw notFound(`Commit ${sha.slice(0, 7)}`)
    // GitHub lists at most 300 files of a commit here.
    return { ...normCommit(raw), filesTruncated: (raw.files?.length ?? 0) >= 300 }
  }
  const [raw, parsed] = await Promise.all([src.api<RawCommit>(`/repos/${o}/${r}/git/commits/${sha}`), giteaDiff(src, `/repos/${o}/${r}/git/commits/${sha}.diff`).catch(() => null)])
  if (!raw) throw notFound(`Commit ${sha.slice(0, 7)}`)
  if (parsed) return normCommit(raw, parsed)
  return { ...normCommit(raw, (raw.files ?? []).map((f) => ({ ...normFile(f), tooLarge: true }))), filesTruncated: false }
}

async function repos(user: User): Promise<GitRepoList> {
  const all = sources(user)
  const errors: string[] = []
  const lists = await Promise.all(all.map((src) => repoList(user, src).catch((e: Error) => (errors.push(e.message), []))))
  return {
    repos: lists.flat(),
    sources: all.map((s) => ({ id: s.id, label: s.label, kind: s.kind, web: s.web, login: s.login })),
    errors: [...new Set(errors)],
    privateScope: user.githubScopes.includes('repo'),
  }
}

// ---------------------------------------------------------------------------------------------

export async function handleGitApi(req: IncomingMessage, res: ServerResponse, url: URL, user: User): Promise<boolean> {
  const route = parseRoute(url.pathname)
  if (!route) throw new HttpError(404, 'Not found')
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Read only')
  if (route.kind === 'repos') {
    // The repository lists themselves are cached in server/search.ts (shared with Spotlight).
    return json(res, 200, await repos(user)), true
  }

  const src = sources(user).find((s) => s.id === route.source)
  if (!src) throw new HttpError(404, 'That code host is not linked to this account')
  const { owner: o, repo: r } = route
  const q = url.searchParams
  // ?fresh (the app's Reload) skips the minute-long cache.
  const fresh = q.has('fresh')
  const cached = <T>(k: string, ttl: number, load: () => Promise<T>) => {
    if (fresh) cache.delete(k)
    return cachedAnswer(k, ttl, load)
  }
  const key = (extra: string) => `${user.id}|${src.id}|${o}/${r}|${route.kind}|${extra}`
  let body: Promise<unknown>
  switch (route.kind) {
    case 'repo':
      body = cached(key(''), TTL, () => repoOverview(src, o, r))
      break
    case 'branches':
      body = cached(key(''), TTL, () => branches(src, o, r))
      break
    case 'pulls': {
      const state = stateParam(q.get('state'), ['open', 'closed', 'merged', 'all'] as const, 'open')
      const page = pageParam(q.get('page'))
      body = cached(key(`${state}|${page}`), TTL, () => pulls(src, o, r, state, page))
      break
    }
    case 'issues': {
      const state = stateParam(q.get('state'), ['open', 'closed', 'all'] as const, 'open')
      const page = pageParam(q.get('page'))
      body = cached(key(`${state}|${page}`), TTL, () => issues(src, o, r, state, page))
      break
    }
    case 'commits': {
      const ref = q.get('ref') || null
      if (ref !== null && !validRef(ref)) throw new HttpError(400, 'Bad branch name')
      const page = pageParam(q.get('page'))
      body = cached(key(`${ref ?? ''}|${page}`), TTL, () => commits(src, o, r, ref, page))
      break
    }
    case 'pull':
      body = cached(key(String(route.number)), TTL, () => pull(src, o, r, route.number))
      break
    case 'pullCommits': {
      const page = pageParam(q.get('page'))
      body = cached(key(`${route.number}|${page}`), TTL, () => pullCommits(src, o, r, route.number, page))
      break
    }
    case 'pullFiles':
      body = cached(key(String(route.number)), TTL, () => pullFiles(src, o, r, route.number))
      break
    case 'issue':
      body = cached(key(String(route.number)), TTL, () => issue(src, o, r, route.number))
      break
    case 'commit':
      body = cached(key(route.sha), route.sha.length === 40 || route.sha.length === 64 ? COMMIT_TTL : TTL, () => commit(src, o, r, route.sha))
      break
  }
  json(res, 200, await body)
  return true
}
