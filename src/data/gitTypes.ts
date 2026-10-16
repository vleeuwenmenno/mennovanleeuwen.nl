// What the Git app's API (/api/repos/..., server/git.ts) answers: repositories, pull requests,
// issues and commits from GitHub and linked Gitea/Forgejo instances, in one shape. Shared by the
// server and src/apps/Git*.tsx; type-only, so the server image needs nothing from here at runtime.

import type { Label, RepoHit } from './code.ts'

export type { Label, RepoHit }

export type GitPerson = { login: string | null; name: string | null; avatar: string | null }

export type GitSourceInfo = { id: string; label: string; kind: 'github' | 'gitea'; web: string; login: string }

/** GET /api/repos */
export type GitRepoList = {
  repos: RepoHit[]
  sources: GitSourceInfo[]
  errors: string[]
  /** Whether GitHub's token can see private repositories (Settings → Code hosts, "Allow private") */
  privateScope: boolean
}

export type GitRepo = {
  source: string
  sourceLabel: string
  kind: 'github' | 'gitea'
  fullName: string
  owner: string
  name: string
  url: string
  description: string | null
  homepage: string | null
  private: boolean
  fork: boolean
  archived: boolean
  stars: number
  forks: number
  watchers: number
  /** Issues and PRs on GitHub (it counts them together), issues only on Gitea */
  openIssues: number
  /** Gitea counts these apart; null where the host doesn't say */
  openPulls: number | null
  language: string | null
  topics: string[]
  license: string | null
  defaultBranch: string
  createdAt: string | null
  pushedAt: string | null
  cloneUrl: string
  sshUrl: string | null
}

export type GitReadme = { name: string; text: string; url: string | null; truncated: boolean }

/** GET /api/repos/:source/:owner/:repo */
export type GitRepoOverview = { repo: GitRepo; readme: GitReadme | null }

export type GitState = 'open' | 'closed' | 'merged'

/** A row in the pull request or issue list. */
export type GitIssueItem = {
  number: number
  title: string
  state: GitState
  draft: boolean
  pull: boolean
  author: GitPerson | null
  labels: Label[]
  /** null where the host's list leaves it out (GitHub's pull request list) */
  comments: number | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
  url: string
}

/** An issue comment (also on a pull request's conversation). `edited`: changed after it was posted. */
export type GitComment = { id: number; author: GitPerson | null; body: string; createdAt: string; updatedAt: string | null; url: string | null; edited: boolean }

/** GET .../issues/:n (its comments and events: .../issues/:n/timeline) */
export type GitIssue = GitIssueItem & {
  body: string
  assignees: GitPerson[]
  milestone: string | null
}

/** GET .../pulls/:n */
export type GitPull = GitIssue & {
  head: { ref: string; label: string; sha: string | null }
  base: { ref: string; label: string }
  merged: boolean
  mergedAt: string | null
  mergedBy: GitPerson | null
  additions: number | null
  deletions: number | null
  changedFiles: number | null
  commitCount: number | null
}

export type GitCommitItem = {
  sha: string
  message: string
  author: GitPerson
  date: string | null
  url: string | null
}

export type GitFileStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed'

export type GitFile = {
  filename: string
  previousFilename: string | null
  status: GitFileStatus
  additions: number
  deletions: number
  /** The unified diff's hunks (from the first @@), or null: binary, too large, or not given */
  patch: string | null
  binary: boolean
  tooLarge: boolean
}

/** GET .../commits/:sha */
export type GitCommit = GitCommitItem & {
  committer: GitPerson | null
  parents: string[]
  additions: number | null
  deletions: number | null
  files: GitFile[]
  /** More files than were fetched */
  filesTruncated: boolean
}

/** GET .../pulls/:n/files */
export type GitFileList = { files: GitFile[]; truncated: boolean }

export type GitBranch = { name: string; sha: string | null; protected: boolean }

/** One page of a list; `next` is the page to ask for next, or null at the end. */
export type GitPage<T> = { items: T[]; next: number | null }

// ---------------------------------------------------------------------------------------------
// The conversation of a pull request or issue: GET .../pulls/:n/timeline and .../issues/:n/timeline

export type GitReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed'

/** A comment on a line of the diff, made in a review. */
export type GitReviewComment = { id: number; author: GitPerson | null; body: string; path: string; line: number | null; createdAt: string; url: string | null; reply: boolean }

export type GitEventKind =
  | 'closed'
  | 'reopened'
  | 'merged'
  | 'force_pushed'
  | 'renamed'
  | 'labeled'
  | 'unlabeled'
  | 'assigned'
  | 'unassigned'
  | 'review_requested'
  | 'review_request_removed'
  | 'referenced'
  | 'cross_referenced'
  | 'ready_for_review'
  | 'converted_to_draft'
  | 'head_ref_deleted'
  | 'head_ref_restored'
  | 'base_changed'
  | 'locked'
  | 'unlocked'

/** Another issue or pull request that mentioned this one. `repo` is "owner/name". */
export type GitRef = { repo: string; number: number; title: string; url: string; pull: boolean; state: GitState }

export type GitEvent = {
  type: 'event'
  id: string
  event: GitEventKind
  actor: GitPerson | null
  createdAt: string
  /** A commit hash (merged, referenced, force-pushed to) */
  commit?: string | null
  /** The repository ("owner/name") `commit` is in, when it may be another one (referenced) */
  commitRepo?: string | null
  label?: Label
  /** Renamed (titles), base changed (branches), force-pushed (hashes) */
  from?: string | null
  to?: string | null
  /** Who was assigned or asked for a review (a login or a team's name) */
  subject?: string | null
  ref?: GitRef
}

export type GitTimelineItem =
  | (GitComment & { type: 'comment' })
  | { type: 'review'; id: number; author: GitPerson | null; state: GitReviewState; body: string; createdAt: string; url: string | null; comments: GitReviewComment[] }
  /** Commits pushed one after another, shown as one block */
  | { type: 'commits'; id: string; createdAt: string; commits: GitCommitItem[] }
  | GitEvent

export type GitTimeline = {
  items: GitTimelineItem[]
  /** More than were fetched: the rest is on the web */
  truncated: boolean
}
