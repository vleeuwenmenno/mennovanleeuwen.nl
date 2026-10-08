// What /api/search returns: repositories, issues, pull requests and branches from GitHub and
// linked Gitea/Forgejo instances, in one shape. Shared by the server (server/search.ts) and
// Spotlight; type-only, so the server image needs nothing from here at runtime.

export type Label = { name: string; color: string }

type Base = { source: string; sourceLabel: string; url: string }

export type RepoHit = Base & {
  kind: 'repo'
  fullName: string
  description: string | null
  private: boolean
  fork: boolean
  archived: boolean
  stars: number
  openIssues: number
  language: string | null
  defaultBranch: string
  pushedAt: string | null
  /** For "Copy clone command" */
  cloneUrl: string
}

export type IssueHit = Base & {
  kind: 'issue' | 'pr'
  repo: string
  number: number
  title: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  author: string | null
  labels: Label[]
  comments: number
  createdAt: string
  updatedAt: string
  /** First part of the description */
  body: string
  headRef?: string
  baseRef?: string
}

export type BranchHit = Base & {
  kind: 'branch'
  repo: string
  name: string
  sha: string
  isDefault: boolean
  protected: boolean
  commitMessage?: string
  commitDate?: string
  /** The newest pull request from this branch, if any */
  pr?: { number: number; title: string; state: 'open' | 'closed' | 'merged'; url: string }
}

export type Hit = RepoHit | IssueHit | BranchHit

/** How the query was read, so Spotlight can explain it. */
export type ParsedQuery =
  | { mode: 'text'; text: string }
  | { mode: 'number'; repo?: string; number: number }
  | { mode: 'issues'; repo?: string; text: string }
  | { mode: 'branches'; repo?: string; text: string }

export type SearchResponse = { query: ParsedQuery; hits: Hit[]; errors: string[] }

const REPO = '[\\w.-]+(?:/[\\w.-]+)?'

/**
 *   text            repositories (and, from three letters, issues and PRs) matching text
 *   #123            issue or PR 123 in the repos pushed to most recently
 *   repo#123        issue or PR 123 in repo (name or owner/name)
 *   #text, repo#    issues and PRs matching text, everywhere or in one repo
 *   repo@text, @x   branches matching text in repo, or in recently pushed repos
 */
export function parseQuery(q: string): ParsedQuery {
  const s = q.trim()
  let m = new RegExp(`^(${REPO})?#(\\d+)$`).exec(s)
  if (m) return { mode: 'number', repo: m[1], number: Number(m[2]) }
  m = new RegExp(`^(${REPO})?#(.*)$`).exec(s)
  if (m) return { mode: 'issues', repo: m[1], text: m[2].trim() }
  m = new RegExp(`^(${REPO})?@(.*)$`).exec(s)
  if (m) return { mode: 'branches', repo: m[1], text: m[2].trim() }
  return { mode: 'text', text: s }
}

/** Whether a query is one of the code forms above (and should lead Spotlight's results). */
export const isCodeQuery = (q: string) => parseQuery(q).mode !== 'text'
