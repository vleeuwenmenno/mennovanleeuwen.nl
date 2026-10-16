import type { GitComment, GitCommit, GitCommitItem, GitEvent, GitEventKind, GitFile, GitFileStatus, GitIssue, GitIssueItem, GitPerson, GitPull, GitReadme, GitRef, GitRepo, GitReviewComment, GitReviewState, GitState, GitTimeline, GitTimelineItem, Label } from '../src/data/gitTypes.ts'

// GitHub and Gitea/Forgejo answers turned into the one shape the Git app reads
// (src/data/gitTypes.ts). Pure functions without I/O, so they can be checked against fixtures on
// their own. Both APIs are close relatives: the differences are in field names (stargazers_count
// and stars_count), what a list includes (GitHub's pull list has no comment count) and where
// patches come from (GitHub puts them in the files; Gitea answers a .diff, see parseUnifiedDiff).

/** The host a raw answer came from, for the fields only that host fills in. */
export type ShapeSource = { id: string; label: string; kind: 'github' | 'gitea' }

type RawUser = { login?: string; username?: string; full_name?: string; name?: string; avatar_url?: string } | null | undefined
type RawLabel = { name: string; color?: string }

export type RawRepo = {
  full_name: string
  name?: string
  owner?: RawUser
  html_url: string
  description?: string | null
  homepage?: string | null
  website?: string | null
  private?: boolean
  fork?: boolean
  archived?: boolean
  stargazers_count?: number
  stars_count?: number
  forks_count?: number
  watchers_count?: number
  subscribers_count?: number
  open_issues_count?: number
  open_pr_counter?: number
  language?: string | null
  topics?: string[] | null
  license?: { spdx_id?: string | null; name?: string | null } | null
  licenses?: string[] | null
  default_branch?: string
  created_at?: string | null
  pushed_at?: string | null
  updated_at?: string | null
  clone_url?: string
  ssh_url?: string | null
}

export type RawIssue = {
  id?: number
  number: number
  title: string
  state: string
  html_url: string
  user?: RawUser
  labels?: RawLabel[] | null
  comments?: number
  created_at: string
  updated_at: string
  closed_at?: string | null
  body?: string | null
  draft?: boolean
  assignees?: RawUser[] | null
  milestone?: { title?: string } | null
  pull_request?: { merged_at?: string | null; merged?: boolean } | null
}

export type RawPull = RawIssue & {
  merged?: boolean
  merged_at?: string | null
  merged_by?: RawUser
  head?: { ref?: string; label?: string; sha?: string } | null
  base?: { ref?: string; label?: string } | null
  additions?: number
  deletions?: number
  changed_files?: number
  commits?: number
}

export type RawComment = { id: number; user?: RawUser; body?: string | null; created_at: string; updated_at?: string | null; html_url?: string | null }

type RawGitPerson = { name?: string; email?: string; date?: string } | null | undefined
export type RawCommit = {
  sha: string
  html_url?: string | null
  created?: string
  commit?: { message?: string; author?: RawGitPerson; committer?: RawGitPerson } | null
  author?: RawUser
  committer?: RawUser
  parents?: { sha: string }[] | null
  stats?: { additions?: number; deletions?: number; total?: number } | null
  files?: RawFile[] | null
}

export type RawFile = {
  filename: string
  previous_filename?: string | null
  status?: string
  additions?: number
  deletions?: number
  changes?: number
  patch?: string | null
}

/** One file's patch above this many characters shows "too large" (and a link to the web). */
export const PATCH_MAX = 96 * 1024
/** All patches of one answer together. */
export const PATCHES_TOTAL_MAX = 2 * 1024 * 1024
/** A README above this is cut off (and says so). */
export const README_MAX = 256 * 1024

export const person = (u: RawUser): GitPerson | null => (u ? { login: u.login ?? u.username ?? null, name: u.full_name || u.name || null, avatar: u.avatar_url || null } : null)

const labels = (l?: RawLabel[] | null): Label[] => (l ?? []).map((x) => ({ name: x.name, color: x.color ? (x.color.startsWith('#') ? x.color : `#${x.color}`) : '#888888' }))

/** Gitea marks a draft with a "WIP:" title prefix; GitHub has a flag. */
const isDraft = (title: string, draft?: boolean) => draft ?? /^\s*(\[?wip\]?|draft)[:\s]/i.test(title)

export function normRepo(src: ShapeSource, r: RawRepo): GitRepo {
  const [owner, name] = r.full_name.split('/')
  return {
    source: src.id,
    sourceLabel: src.label,
    kind: src.kind,
    fullName: r.full_name,
    owner: r.owner?.login ?? r.owner?.username ?? owner,
    name: r.name ?? name,
    url: r.html_url,
    description: r.description || null,
    homepage: r.homepage || r.website || null,
    private: !!r.private,
    fork: !!r.fork,
    archived: !!r.archived,
    stars: r.stargazers_count ?? r.stars_count ?? 0,
    forks: r.forks_count ?? 0,
    // GitHub's watchers_count is its star count; subscribers_count is who watches.
    watchers: src.kind === 'github' ? (r.subscribers_count ?? 0) : (r.watchers_count ?? 0),
    openIssues: r.open_issues_count ?? 0,
    openPulls: typeof r.open_pr_counter === 'number' ? r.open_pr_counter : null,
    language: r.language || null,
    topics: r.topics ?? [],
    license: r.license ? (r.license.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : (r.license.name ?? null)) : r.licenses?.length ? r.licenses.join(', ') : null,
    defaultBranch: r.default_branch ?? 'main',
    createdAt: r.created_at ?? null,
    pushedAt: r.pushed_at ?? r.updated_at ?? null,
    cloneUrl: r.clone_url ?? `${r.html_url}.git`,
    sshUrl: r.ssh_url || null,
  }
}

/** A README from a contents answer ({ content, encoding: "base64" }). */
export function normReadme(raw: { name?: string; path?: string; content?: string | null; encoding?: string | null; html_url?: string | null } | null): GitReadme | null {
  if (!raw?.content) return null
  const bytes = raw.encoding === 'base64' ? Buffer.from(raw.content, 'base64') : Buffer.from(raw.content, 'utf8')
  const truncated = bytes.length > README_MAX
  return { name: raw.name ?? raw.path ?? 'README', text: bytes.subarray(0, README_MAX).toString('utf8'), url: raw.html_url ?? null, truncated }
}

function state(i: RawPull, pull: boolean): GitState {
  if (pull && (i.merged || i.merged_at || i.pull_request?.merged || i.pull_request?.merged_at)) return 'merged'
  return i.state === 'open' ? 'open' : 'closed'
}

/** An issue or pull request from a list (GitHub's /issues, /pulls or search, Gitea's /issues or /pulls). */
export function normIssueItem(i: RawPull, pull = !!i.pull_request || !!i.head): GitIssueItem {
  return {
    number: i.number,
    title: i.title,
    state: state(i, pull),
    draft: pull && isDraft(i.title, i.draft),
    pull,
    author: person(i.user),
    labels: labels(i.labels),
    // GitHub's pull list leaves the count out (its issue list has it).
    comments: typeof i.comments === 'number' ? i.comments : null,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    closedAt: i.closed_at ?? null,
    url: i.html_url,
  }
}

/** Changed after it was posted: a few seconds' leeway, since some hosts stamp the two apart. */
const wasEdited = (created: string, updated?: string | null) => !!updated && Date.parse(updated) - Date.parse(created) > 5000

export const normComment = (c: RawComment): GitComment => ({ id: c.id, author: person(c.user), body: c.body ?? '', createdAt: c.created_at, updatedAt: c.updated_at ?? null, url: c.html_url ?? null, edited: wasEdited(c.created_at, c.updated_at) })

/** Who wrote an issue, pull request or comment, as the host's login in lower case (for "only your own" checks). */
export const authorLogin = (x: { user?: RawUser } | null | undefined): string => (x?.user?.login ?? x?.user?.username ?? '').toLowerCase()

export function normIssue(i: RawIssue, pull = !!i.pull_request): GitIssue {
  const item = normIssueItem(i, pull)
  return {
    ...item,
    body: i.body ?? '',
    assignees: (i.assignees ?? []).map(person).filter((p): p is GitPerson => !!p),
    milestone: i.milestone?.title ?? null,
  }
}

/** `issue` is the same number from the issues API: GitHub's pull answer has no comment count. */
export function normPull(p: RawPull, issue?: RawIssue | null): GitPull {
  const base = normIssue({ ...p, comments: p.comments ?? issue?.comments, labels: p.labels ?? issue?.labels }, true)
  return {
    ...base,
    head: { ref: p.head?.ref ?? '', label: p.head?.label ?? p.head?.ref ?? '', sha: p.head?.sha ?? null },
    base: { ref: p.base?.ref ?? '', label: p.base?.label ?? p.base?.ref ?? '' },
    merged: base.state === 'merged',
    mergedAt: p.merged_at ?? null,
    mergedBy: person(p.merged_by),
    additions: p.additions ?? null,
    deletions: p.deletions ?? null,
    changedFiles: p.changed_files ?? null,
    commitCount: p.commits ?? null,
  }
}

export function normCommitItem(c: RawCommit): GitCommitItem {
  const a = c.commit?.author
  return {
    sha: c.sha,
    message: c.commit?.message ?? '',
    author: { login: c.author?.login ?? c.author?.username ?? null, name: a?.name || null, avatar: c.author?.avatar_url || null },
    date: a?.date ?? c.commit?.committer?.date ?? c.created ?? null,
    url: c.html_url ?? null,
  }
}

const STATUS: Record<string, GitFileStatus> = { added: 'added', removed: 'removed', deleted: 'removed', modified: 'modified', renamed: 'renamed', copied: 'copied', changed: 'changed', unchanged: 'changed' }

/** A GitHub file entry (with its patch, when GitHub gave one). */
export function normFile(f: RawFile): GitFile {
  const status = STATUS[f.status ?? ''] ?? 'modified'
  const additions = f.additions ?? 0
  const deletions = f.deletions ?? 0
  const patch = f.patch ?? null
  // GitHub leaves the patch out for binary files and very large diffs.
  const pureRename = status === 'renamed' && additions + deletions === 0
  return {
    filename: f.filename,
    previousFilename: f.previous_filename ?? null,
    status,
    additions,
    deletions,
    patch,
    binary: !patch && !pureRename && additions + deletions === 0,
    tooLarge: !patch && !pureRename && additions + deletions > 0,
  }
}

/** Patches past the limits become null with tooLarge set, so one answer stays small. */
export function capPatches(files: GitFile[]): GitFile[] {
  let total = 0
  return files.map((f) => {
    if (!f.patch) return f
    if (f.patch.length > PATCH_MAX || total + f.patch.length > PATCHES_TOTAL_MAX) return { ...f, patch: null, tooLarge: true }
    total += f.patch.length
    return f
  })
}

export function normCommit(c: RawCommit, files: GitFile[] = (c.files ?? []).map(normFile)): GitCommit {
  return {
    ...normCommitItem(c),
    committer: c.commit?.committer ? { login: c.committer?.login ?? c.committer?.username ?? null, name: c.commit.committer.name || null, avatar: c.committer?.avatar_url || null } : null,
    parents: (c.parents ?? []).map((p) => p.sha),
    additions: c.stats?.additions ?? null,
    deletions: c.stats?.deletions ?? null,
    files: capPatches(files),
    filesTruncated: false,
  }
}

/** "a/src/x.ts" → "src/x.ts"; quoted names ("a/with space") lose their quotes. */
function diffPath(p: string): string | null {
  let s = p.replace(/\t.*$/, '').trim()
  if (s === '/dev/null') return null
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).replace(/\\(.)/g, '$1')
  return s.replace(/^[ab]\//, '')
}

/** A whole unified diff (Gitea's .diff answers) split into files with their hunks. */
export function parseUnifiedDiff(text: string): GitFile[] {
  const files: GitFile[] = []
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split('\n')
    const head = /^"?a\/(.*?)"? "?b\/(.*?)"?$/.exec(lines[0])
    let from: string | null = head?.[1] ?? null
    let to: string | null = head?.[2] ?? null
    let status: GitFileStatus = 'modified'
    let binary = false
    let i = 1
    for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const l = lines[i]
      if (l.startsWith('new file mode')) status = 'added'
      else if (l.startsWith('deleted file mode')) status = 'removed'
      else if (l.startsWith('rename from ')) (from = l.slice(12)), (status = 'renamed')
      else if (l.startsWith('rename to ')) to = l.slice(10)
      else if (l.startsWith('copy from ')) (from = l.slice(10)), (status = 'copied')
      else if (l.startsWith('copy to ')) to = l.slice(8)
      else if (l.startsWith('--- ')) from = diffPath(l.slice(4)) ?? from
      else if (l.startsWith('+++ ')) to = diffPath(l.slice(4)) ?? to
      else if (l.startsWith('Binary files') || l.startsWith('GIT binary patch')) binary = true
    }
    const hunks = lines.slice(i)
    while (hunks.length && hunks[hunks.length - 1] === '') hunks.pop()
    let additions = 0
    let deletions = 0
    for (const l of hunks) {
      if (l.startsWith('+')) additions++
      else if (l.startsWith('-')) deletions++
    }
    const filename = (status === 'removed' ? from : to) ?? from ?? '?'
    files.push({
      filename,
      previousFilename: status === 'renamed' || status === 'copied' ? from : null,
      status,
      additions,
      deletions,
      patch: hunks.length ? hunks.join('\n') : null,
      binary,
      tooLarge: false,
    })
  }
  return files
}

// ---------------------------------------------------------------------------------------------
// Conversations: GitHub's issue timeline and Gitea's, as one list of comments, reviews, blocks of
// commits and small events. Event types this doesn't know are left out.

/** At most this many timeline entries are read; past it the conversation links to the web. */
export const TIMELINE_MAX = 300

export type RawReviewComment = {
  id: number
  user?: RawUser
  body?: string | null
  path?: string
  line?: number | null
  original_line?: number | null
  position?: number | null
  original_position?: number | null
  created_at: string
  html_url?: string | null
  pull_request_review_id?: number | null
  in_reply_to_id?: number | null
}

type RawRefIssue = { number?: number; title?: string; html_url?: string; state?: string; pull_request?: { merged_at?: string | null } | null; repository?: { full_name?: string } | null }

/** One entry of GitHub's GET /repos/{o}/{r}/issues/{n}/timeline */
export type RawGithubEvent = {
  event?: string
  id?: number
  actor?: RawUser
  user?: RawUser
  created_at?: string
  updated_at?: string | null
  submitted_at?: string | null
  body?: string | null
  html_url?: string | null
  state?: string
  commit_id?: string | null
  commit_url?: string | null
  label?: RawLabel | null
  assignee?: RawUser
  requested_reviewer?: RawUser
  requested_team?: { name?: string } | null
  rename?: { from?: string; to?: string } | null
  source?: { type?: string; issue?: RawRefIssue | null } | null
  // A "committed" entry: the commit's own fields
  sha?: string
  message?: string
  author?: { name?: string; date?: string } | null
  committer?: { name?: string; date?: string } | null
}

/** One entry of Gitea's GET /repos/{o}/{r}/issues/{n}/timeline (its "TimelineComment") */
export type RawGiteaEvent = {
  id: number
  type?: string
  user?: RawUser
  created_at: string
  updated_at?: string | null
  body?: string | null
  html_url?: string | null
  old_title?: string
  new_title?: string
  old_ref?: string
  new_ref?: string
  ref_commit_sha?: string
  ref_issue?: RawRefIssue | null
  review_id?: number
  label?: RawLabel | null
  assignee?: RawUser
  assignee_team?: { name?: string } | null
  removed_assignee?: boolean
}

/** One of Gitea's GET /repos/{o}/{r}/pulls/{n}/reviews */
export type RawGiteaReview = { id: number; user?: RawUser; state?: string; body?: string | null; submitted_at?: string | null; html_url?: string | null; dismissed?: boolean; comments_count?: number }

function reviewState(s: string | undefined, dismissed?: boolean): GitReviewState | null {
  if (dismissed) return 'dismissed'
  switch ((s ?? '').toLowerCase()) {
    case 'approved':
      return 'approved'
    case 'changes_requested':
    case 'request_changes':
      return 'changes_requested'
    case 'commented':
    case 'comment':
      return 'commented'
    case 'dismissed':
      return 'dismissed'
    default:
      // Pending (not sent yet), and Gitea's placeholders for a requested review
      return null
  }
}

const normReviewComment = (c: RawReviewComment): GitReviewComment => ({
  id: c.id,
  author: person(c.user),
  body: c.body ?? '',
  path: c.path ?? '',
  line: c.line || c.original_line || c.position || c.original_position || null,
  createdAt: c.created_at,
  url: c.html_url ?? null,
  reply: !!c.in_reply_to_id,
})

function refOf(i: RawRefIssue | null | undefined): GitRef | undefined {
  if (!i?.number || !i.html_url) return undefined
  const pull = !!i.pull_request || /\/pulls?\/\d+/.test(i.html_url)
  const repo = i.repository?.full_name ?? /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\//.exec(i.html_url)?.[1] ?? ''
  return { repo, number: i.number, title: i.title ?? '', url: i.html_url, pull, state: pull && i.pull_request?.merged_at ? 'merged' : i.state === 'open' ? 'open' : 'closed' }
}

/** ".../repos/owner/name/commits/<sha>" → "owner/name" */
const repoOfCommitUrl = (u: string | null | undefined) => (u ? (/\/repos\/([^/]+\/[^/]+)\/(?:git\/)?commits\//.exec(u)?.[1] ?? null) : null)

type Entry = GitTimelineItem | { type: 'commit'; commit: GitCommitItem; createdAt: string }

/** Commits next to each other become one block, dated by its first commit. */
function groupCommits(items: Entry[]): GitTimelineItem[] {
  const out: GitTimelineItem[] = []
  for (const it of items) {
    if (it.type !== 'commit') {
      out.push(it)
      continue
    }
    const last = out[out.length - 1]
    if (last?.type === 'commits') last.commits.push(it.commit)
    else out.push({ type: 'commits', id: `commits-${it.commit.sha}`, createdAt: it.createdAt, commits: [it.commit] })
  }
  return out
}

/**
 * GitHub's timeline, in its own order. `commits` are the pull request's (they carry the logins
 * and avatars a timeline commit lacks); `reviewComments` its comments on lines, put under the
 * review they were sent with.
 */
export function normGithubTimeline(raw: RawGithubEvent[], opts: { commits?: RawCommit[]; reviewComments?: RawReviewComment[]; truncated?: boolean } = {}): GitTimeline {
  const known = new Map((opts.commits ?? []).map((c) => [c.sha, normCommitItem(c)]))
  const byReview = new Map<number, GitReviewComment[]>()
  for (const c of opts.reviewComments ?? []) if (c.pull_request_review_id) byReview.set(c.pull_request_review_id, [...(byReview.get(c.pull_request_review_id) ?? []), normReviewComment(c)])
  const items: Entry[] = []
  raw.forEach((e, i) => {
    const at = e.created_at ?? ''
    const ev = (event: GitEventKind, extra: Partial<GitEvent> = {}) => void items.push({ type: 'event', id: `${e.event}-${e.id ?? i}`, event, actor: person(e.actor ?? e.user), createdAt: at, ...extra })
    switch (e.event) {
      case 'commented':
        if (typeof e.id === 'number') items.push({ type: 'comment', ...normComment({ id: e.id, user: e.user ?? e.actor, body: e.body, created_at: at, updated_at: e.updated_at, html_url: e.html_url }) })
        return
      case 'committed': {
        if (!e.sha) return
        const date = e.committer?.date ?? e.author?.date ?? ''
        const commit = known.get(e.sha) ?? { sha: e.sha, message: e.message ?? '', author: { login: null, name: e.author?.name || null, avatar: null }, date: e.author?.date ?? (date || null), url: e.html_url ?? null }
        items.push({ type: 'commit', commit, createdAt: date })
        return
      }
      case 'reviewed': {
        const state = reviewState(e.state)
        if (!state || typeof e.id !== 'number') return
        const comments = byReview.get(e.id) ?? []
        // An empty "commented" review carries nothing to show.
        if (!(e.body ?? '').trim() && !comments.length && state === 'commented') return
        items.push({ type: 'review', id: e.id, author: person(e.user ?? e.actor), state, body: e.body ?? '', createdAt: e.submitted_at ?? at, url: e.html_url ?? null, comments })
        return
      }
      case 'closed':
        return ev('closed')
      case 'reopened':
        return ev('reopened')
      case 'merged':
        return ev('merged', { commit: e.commit_id ?? null, commitRepo: repoOfCommitUrl(e.commit_url) })
      case 'head_ref_force_pushed':
        return ev('force_pushed', { commit: e.commit_id ?? null })
      case 'renamed':
        return ev('renamed', { from: e.rename?.from ?? null, to: e.rename?.to ?? null })
      case 'labeled':
      case 'unlabeled':
        return e.label ? ev(e.event as GitEventKind, { label: labels([e.label])[0] }) : undefined
      case 'assigned':
      case 'unassigned':
        return ev(e.event as GitEventKind, { subject: e.assignee?.login ?? null })
      case 'review_requested':
      case 'review_request_removed':
        return ev(e.event as GitEventKind, { subject: e.requested_reviewer?.login ?? e.requested_team?.name ?? null })
      case 'referenced':
        return e.commit_id ? ev('referenced', { commit: e.commit_id, commitRepo: repoOfCommitUrl(e.commit_url) }) : undefined
      case 'cross-referenced': {
        const ref = refOf(e.source?.issue)
        return ref ? ev('cross_referenced', { ref }) : undefined
      }
      case 'ready_for_review':
        return ev('ready_for_review')
      case 'convert_to_draft':
        return ev('converted_to_draft')
      case 'head_ref_deleted':
        return ev('head_ref_deleted')
      case 'head_ref_restored':
        return ev('head_ref_restored')
      case 'base_ref_changed':
        return ev('base_changed')
      case 'locked':
        return ev('locked')
      case 'unlocked':
        return ev('unlocked')
      default:
        // mentioned, subscribed, line-commented (those comments come with their reviews), and the rest
        return
    }
  })
  return { items: groupCommits(items), truncated: !!opts.truncated }
}

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0)

type GiteaPush = { is_force_push?: boolean; commit_ids?: string[] }
function giteaPush(e: RawGiteaEvent): GiteaPush | null {
  try {
    const p = JSON.parse(e.body ?? '') as unknown
    return p && typeof p === 'object' ? (p as GiteaPush) : null
  } catch {
    return null
  }
}

/**
 * Gitea's timeline, or (before Gitea 1.20, which has none: `raw` null) its plain `comments`. A
 * pull request's commits that no push in the timeline names were there when it was opened, so
 * they go right after the opening. `reviews` and their line comments fill in what the timeline's
 * review entries leave out (the verdict, files and lines).
 */
export function normGiteaTimeline(
  raw: RawGiteaEvent[] | null,
  opts: { comments?: RawComment[]; commits?: RawCommit[]; reviews?: RawGiteaReview[]; reviewComments?: Map<number, RawReviewComment[]>; createdAt: string; truncated?: boolean },
): GitTimeline {
  const commits = new Map((opts.commits ?? []).map((c) => [c.sha, normCommitItem(c)]))
  const reviews = new Map((opts.reviews ?? []).map((r) => [r.id, r]))
  const shown = new Set<number>()
  const entries: RawGiteaEvent[] = raw ?? (opts.comments ?? []).map((c) => ({ ...c, type: 'comment' }))
  const pushed = new Set<string>()
  for (const e of entries) {
    const p = e.type === 'pull_push' ? giteaPush(e) : null
    if (p && !p.is_force_push) for (const sha of p.commit_ids ?? []) pushed.add(sha)
  }

  const items: Entry[] = []
  const addCommits = (list: GitCommitItem[], at: string) => {
    for (const commit of list.sort((a, b) => time(a.date) - time(b.date))) items.push({ type: 'commit', commit, createdAt: at })
  }
  addCommits([...commits.values()].filter((c) => !pushed.has(c.sha)), opts.createdAt)

  const addReview = (r: RawGiteaReview, at: string, fallbackBody = '') => {
    const state = reviewState(r.state, r.dismissed)
    if (!state || shown.has(r.id)) return
    shown.add(r.id)
    const comments = (opts.reviewComments?.get(r.id) ?? []).map(normReviewComment)
    const body = r.body || fallbackBody
    if (!body.trim() && !comments.length && state === 'commented') return
    items.push({ type: 'review', id: r.id, author: person(r.user), state, body, createdAt: r.submitted_at ?? at, url: r.html_url ?? null, comments })
  }

  for (const e of entries) {
    const ev = (event: GitEventKind, extra: Partial<GitEvent> = {}) => void items.push({ type: 'event', id: `${e.type}-${e.id}`, event, actor: person(e.user), createdAt: e.created_at, ...extra })
    const who = (u: RawUser) => u?.login ?? u?.username ?? null
    switch (e.type) {
      case 'comment':
        items.push({ type: 'comment', ...normComment(e) })
        break
      case 'pull_push': {
        const p = giteaPush(e)
        if (p?.is_force_push) ev('force_pushed', { from: p.commit_ids?.[0] ?? null, to: p.commit_ids?.[1] ?? null, commit: p.commit_ids?.[1] ?? null })
        else addCommits((p?.commit_ids ?? []).map((sha) => commits.get(sha)).filter((c): c is GitCommitItem => !!c), e.created_at)
        break
      }
      case 'review': {
        const r = e.review_id ? reviews.get(e.review_id) : undefined
        if (r) addReview(r, e.created_at, e.body ?? '')
        break
      }
      case 'close':
        ev('closed')
        break
      case 'reopen':
        ev('reopened')
        break
      case 'merge_pull':
        ev('merged', { commit: e.ref_commit_sha || null })
        break
      case 'change_title':
        ev('renamed', { from: e.old_title ?? null, to: e.new_title ?? null })
        break
      case 'label':
        // Gitea writes "1" in the body for a label put on, nothing for one taken off.
        if (e.label) ev(e.body === '1' ? 'labeled' : 'unlabeled', { label: labels([e.label])[0] })
        break
      case 'assignees':
        ev(e.removed_assignee ? 'unassigned' : 'assigned', { subject: who(e.assignee) })
        break
      case 'review_request':
        ev(e.removed_assignee ? 'review_request_removed' : 'review_requested', { subject: who(e.assignee) ?? e.assignee_team?.name ?? null })
        break
      case 'commit_ref':
        if (e.ref_commit_sha) ev('referenced', { commit: e.ref_commit_sha })
        break
      case 'issue_ref':
      case 'pull_ref':
      case 'comment_ref': {
        const ref = refOf(e.ref_issue)
        if (ref) ev('cross_referenced', { ref })
        break
      }
      case 'change_target_branch':
        ev('base_changed', { from: e.old_ref ?? null, to: e.new_ref ?? null })
        break
      case 'delete_branch':
        ev('head_ref_deleted', { from: e.old_ref ?? null })
        break
      case 'lock':
        ev('locked')
        break
      case 'unlock':
        ev('unlocked')
        break
      default:
        // "code" (a line comment: it comes with its review), time tracking, milestones, projects, pins…
        break
    }
  }
  // Reviews the timeline didn't mention (a Gitea without one): when they were sent.
  for (const r of reviews.values()) addReview(r, r.submitted_at ?? opts.createdAt)
  // The timeline is in order already; the opening's commits and any reviews added above go to
  // their place (a stable sort keeps the rest as it was).
  // Gitea writes times with the server's offset ("+02:00"), so they are compared as times.
  const at = (x: Entry) => time(x.createdAt) || time(opts.createdAt)
  const sorted = items
    .map((x, i) => [x, i] as const)
    .sort((a, b) => at(a[0]) - at(b[0]) || a[1] - b[1])
    .map(([x]) => x)
  return { items: groupCommits(sorted), truncated: !!opts.truncated }
}
