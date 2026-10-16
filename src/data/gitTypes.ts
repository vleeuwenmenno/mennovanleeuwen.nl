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

export type GitComment = { id: number; author: GitPerson | null; body: string; createdAt: string; updatedAt: string | null; url: string | null }

/** GET .../issues/:n */
export type GitIssue = GitIssueItem & {
  body: string
  assignees: GitPerson[]
  milestone: string | null
  commentList: GitComment[]
  /** More comments than were fetched: the rest are on the web */
  moreComments: boolean
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
