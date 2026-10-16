import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GitBranch, GitComment, GitCommit, GitCommitItem, GitFile, GitFileList, GitIssue, GitIssueItem, GitPage, GitPull, GitRepoList, GitRepoOverview, GitTimeline } from '../src/data/gitTypes.ts'
import type { User } from './auth.ts'
import { onUserGone } from './db.ts'
import { sources, type Source } from './forges.ts'
import { HttpError, json, readJson } from './http.ts'
import { list, repoList } from './search.ts'
import {
  authorLogin,
  capPatches,
  normComment,
  normCommit,
  normCommitItem,
  normFile,
  normGiteaTimeline,
  normGithubTimeline,
  normIssue,
  normIssueItem,
  normPull,
  normReadme,
  normRepo,
  parseUnifiedDiff,
  TIMELINE_MAX,
  type RawComment,
  type RawCommit,
  type RawFile,
  type RawGiteaEvent,
  type RawGiteaReview,
  type RawGithubEvent,
  type RawIssue,
  type RawPull,
  type RawRepo,
  type RawReviewComment,
} from './gitShapes.ts'

// The Git app's API (src/apps/Git.tsx): a signed-in user's repositories on GitHub and linked
// Gitea/Forgejo instances, and per repository its README, pull requests, issues and commits with
// their diffs and conversations. Every route is spelled out below and every part of the path is
// checked, so this is no open proxy to the hosts' APIs. It mostly reads; the only changes are
// comments, and the descriptions and comments the user wrote. Answers are kept a minute per user,
// so going back and forth doesn't spend the hosts' rate limits; a change forgets that repository's.
//
//   GET   /api/repos                                         repositories, from every host
//   GET   /api/repos/:source/:owner/:repo                    the repository and its README
//   GET   /api/repos/:source/:owner/:repo/branches
//   GET   /api/repos/:source/:owner/:repo/pulls?state=&page=  open, closed, merged or all
//   GET   /api/repos/:source/:owner/:repo/pulls/:n           body and meta
//   GET   /api/repos/:source/:owner/:repo/pulls/:n/timeline  comments, reviews, commits, events
//   GET   /api/repos/:source/:owner/:repo/pulls/:n/commits?page=
//   GET   /api/repos/:source/:owner/:repo/pulls/:n/files     with their patches
//   GET   /api/repos/:source/:owner/:repo/issues?state=&page=
//   GET   /api/repos/:source/:owner/:repo/issues/:n          body and meta
//   GET   /api/repos/:source/:owner/:repo/issues/:n/timeline comments and events
//   GET   /api/repos/:source/:owner/:repo/commits?ref=&page=
//   GET   /api/repos/:source/:owner/:repo/commits/:sha       message, files and patches
//
//   PATCH /api/repos/:source/:owner/:repo/issues/:n           { body }: your own issue's or pull request's description
//   POST  /api/repos/:source/:owner/:repo/issues/:n/comments  { body }: a comment (pull requests too)
//   PATCH /api/repos/:source/:owner/:repo/issues/comments/:id { body }: your own comment
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

const COMMENT_ID = /^[1-9]\d{0,15}$/

/** GitHub's own limit for an issue or comment body, in characters. */
export const BODY_MAX = 65536

export type GitRoute =
  | { kind: 'repos' }
  | { kind: 'repo' | 'branches' | 'pulls' | 'issues' | 'commits'; source: string; owner: string; repo: string }
  | { kind: 'pull' | 'pullCommits' | 'pullFiles' | 'pullTimeline' | 'issue' | 'issueTimeline' | 'issueComments'; source: string; owner: string; repo: string; number: number }
  | { kind: 'comment'; source: string; owner: string; repo: string; id: number }
  | { kind: 'commit'; source: string; owner: string; repo: string; sha: string }

/** The methods each route answers; anything else is a 405. */
const METHODS: Record<GitRoute['kind'], readonly string[]> = {
  repos: ['GET'],
  repo: ['GET'],
  branches: ['GET'],
  pulls: ['GET'],
  issues: ['GET'],
  commits: ['GET'],
  pull: ['GET'],
  pullCommits: ['GET'],
  pullFiles: ['GET'],
  pullTimeline: ['GET'],
  issue: ['GET', 'PATCH'],
  issueTimeline: ['GET'],
  issueComments: ['POST'],
  comment: ['PATCH'],
  commit: ['GET'],
}
export const allowedMethods = (kind: GitRoute['kind']) => METHODS[kind]

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
    if (section === 'issues' && id === 'comments') return sub !== undefined && COMMENT_ID.test(sub) ? { kind: 'comment', ...at, id: Number(sub) } : null
    if (!NUMBER.test(id)) return null
    const number = Number(id)
    if (section === 'issues') {
      if (sub === undefined) return { kind: 'issue', ...at, number }
      if (sub === 'timeline') return { kind: 'issueTimeline', ...at, number }
      if (sub === 'comments') return { kind: 'issueComments', ...at, number }
      return null
    }
    if (sub === undefined) return { kind: 'pull', ...at, number }
    if (sub === 'commits') return { kind: 'pullCommits', ...at, number }
    if (sub === 'files') return { kind: 'pullFiles', ...at, number }
    if (sub === 'timeline') return { kind: 'pullTimeline', ...at, number }
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

async function issue(src: Source, o: string, r: string, n: number): Promise<GitIssue> {
  const raw = await src.api<RawIssue>(`/repos/${o}/${r}/issues/${n}`)
  if (!raw) throw notFound(`Issue #${n}`)
  return normIssue(raw, !!raw.pull_request)
}

async function pull(src: Source, o: string, r: string, n: number): Promise<GitPull> {
  const [raw, asIssue] = await Promise.all([
    src.api<RawPull>(`/repos/${o}/${r}/pulls/${n}`),
    // GitHub's pull answer has no comment count or (on older answers) labels; its issue does.
    src.kind === 'github' ? src.api<RawIssue>(`/repos/${o}/${r}/issues/${n}`).catch(() => null) : Promise.resolve(null),
  ])
  if (!raw) throw notFound(`Pull request #${n}`)
  return normPull(raw, asIssue)
}

/** Up to `max` entries of a list, a page after another; `more`: the host had more than that. */
async function pages<T>(src: Source, path: (page: number) => string, per: number, max: number): Promise<{ items: T[]; more: boolean } | null> {
  const items: T[] = []
  for (let page = 1; items.length < max; page++) {
    const raw = await src.api<T[]>(path(page))
    if (raw === null) {
      if (page === 1) return null
      break
    }
    const got = list<T>(raw)
    items.push(...got)
    // Gitea may hand out fewer per page than asked (its MAX_RESPONSE_ITEMS): an empty page ends it.
    if (!got.length || (src.kind === 'github' && got.length < per)) return { items, more: false }
  }
  return { items: items.slice(0, max), more: true }
}

/** The conversation of an issue or pull request: its comments, events and (a pull request's) reviews and commits. */
async function timeline(src: Source, o: string, r: string, n: number, isPull: boolean): Promise<GitTimeline> {
  if (src.kind === 'github') {
    const [events, commits, reviewComments] = await Promise.all([
      pages<RawGithubEvent>(src, (p) => `/repos/${o}/${r}/issues/${n}/timeline?per_page=100&page=${p}`, 100, TIMELINE_MAX),
      isPull ? src.api<RawCommit[]>(`/repos/${o}/${r}/pulls/${n}/commits?per_page=100`).catch(() => null) : null,
      isPull ? pages<RawReviewComment>(src, (p) => `/repos/${o}/${r}/pulls/${n}/comments?per_page=100&page=${p}`, 100, 200).catch(() => null) : null,
    ])
    if (!events) throw notFound(isPull ? `Pull request #${n}` : `Issue #${n}`)
    return normGithubTimeline(events.items, { commits: list<RawCommit>(commits), reviewComments: reviewComments?.items ?? [], truncated: events.more })
  }
  // Gitea: the item for its opening time, the timeline (1.20 and later) or else its comments.
  const item = await src.api<RawIssue>(`/repos/${o}/${r}/issues/${n}`)
  if (!item) throw notFound(isPull ? `Pull request #${n}` : `Issue #${n}`)
  const pullToo = isPull || !!item.pull_request
  const [events, commits, reviews] = await Promise.all([
    pages<RawGiteaEvent>(src, (p) => `/repos/${o}/${r}/issues/${n}/timeline?limit=50&page=${p}`, 50, TIMELINE_MAX),
    pullToo ? pages<RawCommit>(src, (p) => `/repos/${o}/${r}/pulls/${n}/commits?limit=50&page=${p}&files=false&verification=false`, 50, 100).catch(() => null) : null,
    pullToo ? src.api<RawGiteaReview[]>(`/repos/${o}/${r}/pulls/${n}/reviews?limit=50`).catch(() => null) : null,
  ])
  const comments = events ? null : await pages<RawComment>(src, (p) => `/repos/${o}/${r}/issues/${n}/comments?limit=50&page=${p}`, 50, TIMELINE_MAX)
  const reviewList = list<RawGiteaReview>(reviews)
  // The line comments of the reviews that have any (the first twenty such reviews).
  const reviewComments = new Map<number, RawReviewComment[]>()
  await Promise.all(
    reviewList
      .filter((rv) => (rv.comments_count ?? 0) > 0)
      .slice(0, 20)
      .map(async (rv) => reviewComments.set(rv.id, list<RawReviewComment>(await src.api(`/repos/${o}/${r}/pulls/${n}/reviews/${rv.id}/comments`).catch(() => null)))),
  )
  return normGiteaTimeline(events?.items ?? null, {
    comments: comments?.items ?? [],
    commits: commits?.items ?? [],
    reviews: reviewList,
    reviewComments,
    createdAt: item.created_at,
    truncated: !!(events?.more || comments?.more),
  })
}

// ---------------------------------------------------------------------------------------------
// Changes: a new comment, and the description or a comment the user wrote

/** The new text from a { body } request: a string of at most BODY_MAX characters; a comment can't be empty. */
export function bodyParam(raw: unknown, allowEmpty: boolean): string {
  const body = (raw as { body?: unknown } | null)?.body
  if (typeof body !== 'string') throw new HttpError(400, 'Expected { body: string }')
  if ([...body].length > BODY_MAX) throw new HttpError(413, `That is longer than ${BODY_MAX} characters`)
  if (!allowEmpty && !body.trim()) throw new HttpError(400, 'Write something first')
  return body
}

/** GitHub writes need a token granted with repo (or public_repo); the default sign-in only reads. */
export function canWriteGithub(user: User) {
  return user.githubScopes.some((s) => s === 'repo' || s === 'public_repo')
}

const NOT_YOURS = 'Only what you wrote yourself can be edited here'

export const isMine = (src: Pick<Source, 'login'>, x: { user?: RawIssue['user'] } | null | undefined) => !!src.login && authorLogin(x) === src.login.toLowerCase()

async function addComment(src: Source, o: string, r: string, n: number, body: string): Promise<GitComment> {
  return normComment(await src.send<RawComment>('POST', `/repos/${o}/${r}/issues/${n}/comments`, { body }))
}

async function editDescription(src: Source, o: string, r: string, n: number, body: string): Promise<{ body: string }> {
  // Read past the cache: who wrote it, and whether it is a pull request (Gitea edits those as pulls).
  const item = await src.api<RawIssue>(`/repos/${o}/${r}/issues/${n}`)
  if (!item) throw notFound(`#${n}`)
  if (!isMine(src, item)) throw new HttpError(403, NOT_YOURS)
  const path = src.kind === 'gitea' && item.pull_request ? `/repos/${o}/${r}/pulls/${n}` : `/repos/${o}/${r}/issues/${n}`
  const saved = await src.send<RawIssue>('PATCH', path, { body })
  return { body: typeof saved.body === 'string' ? saved.body : body }
}

async function editComment(src: Source, o: string, r: string, id: number, body: string): Promise<GitComment> {
  const comment = await src.api<RawComment>(`/repos/${o}/${r}/issues/comments/${id}`)
  if (!comment) throw notFound('That comment')
  if (!isMine(src, comment)) throw new HttpError(403, NOT_YOURS)
  const saved = await src.send<RawComment>('PATCH', `/repos/${o}/${r}/issues/comments/${id}`, { body })
  return normComment({ ...comment, ...saved, body: typeof saved.body === 'string' ? saved.body : body })
}

/** After a change: this user's answers about that repository are read again. */
function forgetRepo(user: User, src: Source, o: string, r: string) {
  const prefix = `${user.id}|${src.id}|${o.toLowerCase()}/${r.toLowerCase()}|`
  for (const k of cache.keys()) if (k.toLowerCase().startsWith(prefix)) cache.delete(k)
}

export type WriteRoute = { kind: 'issue' | 'issueComments'; owner: string; repo: string; number: number } | { kind: 'comment'; owner: string; repo: string; id: number }

async function handleWrite(req: IncomingMessage, route: WriteRoute, src: Source, user: User): Promise<{ status: number; body: unknown }> {
  // A body of BODY_MAX characters fits easily, even with every character escaped.
  return applyWrite(route, src, user, await readJson<unknown>(req, 8 * BODY_MAX))
}

/** A change with its JSON body read: checked, sent to the host, and that repository's cached answers dropped. */
export async function applyWrite(route: WriteRoute, src: Source, user: User, input: unknown): Promise<{ status: number; body: unknown }> {
  if (src.kind === 'github' && !canWriteGithub(user)) throw new HttpError(403, "GitHub didn't allow this — sign in again with private repositories allowed (Settings → Code hosts)")
  const { owner: o, repo: r } = route
  try {
    if (route.kind === 'comment') return { status: 200, body: await editComment(src, o, r, route.id, bodyParam(input, false)) }
    if (route.kind === 'issueComments') return { status: 201, body: await addComment(src, o, r, route.number, bodyParam(input, false)) }
    return { status: 200, body: await editDescription(src, o, r, route.number, bodyParam(input, true)) }
  } finally {
    forgetRepo(user, src, o, r)
  }
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
  const method = req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET')
  if (!allowedMethods(route.kind).includes(method)) throw new HttpError(405, allowedMethods(route.kind).length === 1 && method !== 'GET' ? 'Read only' : 'Not allowed here')
  if (route.kind === 'repos') {
    // The repository lists themselves are cached in server/search.ts (shared with Spotlight).
    return json(res, 200, await repos(user)), true
  }

  const src = sources(user).find((s) => s.id === route.source)
  if (!src) throw new HttpError(404, 'That code host is not linked to this account')
  const { owner: o, repo: r } = route
  if (method !== 'GET' && (route.kind === 'issue' || route.kind === 'issueComments' || route.kind === 'comment')) {
    const out = await handleWrite(req, route as WriteRoute, src, user)
    return json(res, out.status, out.body), true
  }
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
    case 'pullTimeline':
    case 'issueTimeline':
      body = cached(key(String(route.number)), TTL, () => timeline(src, o, r, route.number, route.kind === 'pullTimeline'))
      break
    case 'issueComments':
    case 'comment':
      throw new HttpError(405, 'Not allowed here')
    case 'commit':
      body = cached(key(route.sha), route.sha.length === 40 || route.sha.length === 64 ? COMMIT_TTL : TTL, () => commit(src, o, r, route.sha))
      break
  }
  json(res, 200, await body)
  return true
}
