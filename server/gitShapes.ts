import type { GitComment, GitCommit, GitCommitItem, GitFile, GitFileStatus, GitIssue, GitIssueItem, GitPerson, GitPull, GitReadme, GitRepo, GitState, Label } from '../src/data/gitTypes.ts'

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

export const normComment = (c: RawComment): GitComment => ({ id: c.id, author: person(c.user), body: c.body ?? '', createdAt: c.created_at, updatedAt: c.updated_at ?? null, url: c.html_url ?? null })

export function normIssue(i: RawIssue, comments: RawComment[], pull = !!i.pull_request): GitIssue {
  const item = normIssueItem(i, pull)
  return {
    ...item,
    body: i.body ?? '',
    assignees: (i.assignees ?? []).map(person).filter((p): p is GitPerson => !!p),
    milestone: i.milestone?.title ?? null,
    commentList: comments.map(normComment),
    moreComments: item.comments !== null && item.comments > comments.length,
  }
}

/** `issue` is the same number from the issues API: GitHub's pull answer has no comment count. */
export function normPull(p: RawPull, comments: RawComment[], issue?: RawIssue | null): GitPull {
  const base = normIssue({ ...p, comments: p.comments ?? issue?.comments, labels: p.labels ?? issue?.labels }, comments, true)
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
