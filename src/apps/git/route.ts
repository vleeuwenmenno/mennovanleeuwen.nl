// Where the Git app is: the repository list, a repository (and its tab), or one pull request,
// issue or commit in it. Written as a short path for the window's `route` prop, so Spotlight and
// links can open the app on a repository, a pull request or an issue:
//
//   github/owner/repo                    the repository (overview)
//   github/owner/repo/pulls              its pull requests (also issues, commits)
//   github/owner/repo/pull/12            pull request 12 (…/pull/12/files, …/pull/12/commits)
//   forge:3/owner/repo/issue/4           issue 4 on a linked Gitea/Forgejo instance
//   github/owner/repo/commit/<sha>

export type RepoTab = 'overview' | 'pulls' | 'issues' | 'commits'
export type PullTab = 'conversation' | 'commits' | 'files'
export type At = { src: string; owner: string; repo: string }

export type GitView =
  | { v: 'list' }
  | (At & { v: 'repo'; tab: RepoTab; filter?: string; ref?: string })
  | (At & { v: 'pull'; number: number; tab: PullTab })
  | (At & { v: 'issue'; number: number })
  | (At & { v: 'commit'; sha: string })

const SRC = /^(github|forge:\d{1,9})$/
const NAME = /^[A-Za-z0-9_.-]{1,100}$/
const okName = (s: string | undefined): s is string => !!s && NAME.test(s) && !/^\.+$/.test(s)

export function viewToRoute(v: GitView): string {
  if (v.v === 'list') return ''
  const base = `${v.src}/${v.owner}/${v.repo}`
  if (v.v === 'repo') return v.tab === 'overview' ? base : `${base}/${v.tab}`
  if (v.v === 'pull') return `${base}/pull/${v.number}${v.tab === 'conversation' ? '' : `/${v.tab}`}`
  if (v.v === 'issue') return `${base}/issue/${v.number}`
  return `${base}/commit/${v.sha}`
}

/** The view a route names, or null when it names none. */
export function routeToView(route: string | undefined): GitView | null {
  if (!route) return null
  const [src, owner, repo, kind, id, sub, ...rest] = route.replace(/^\/+|\/+$/g, '').split('/')
  if (rest.length || !SRC.test(src ?? '') || !okName(owner) || !okName(repo)) return null
  const at = { src, owner, repo }
  if (!kind) return { v: 'repo', ...at, tab: 'overview' }
  if ((kind === 'pulls' || kind === 'issues' || kind === 'commits') && !id) return { v: 'repo', ...at, tab: kind }
  if ((kind === 'pull' || kind === 'issue') && /^[1-9]\d{0,9}$/.test(id ?? '')) {
    if (kind === 'issue') return sub ? null : { v: 'issue', ...at, number: Number(id) }
    if (sub && sub !== 'files' && sub !== 'commits') return null
    return { v: 'pull', ...at, number: Number(id), tab: (sub as PullTab | undefined) ?? 'conversation' }
  }
  if (kind === 'commit' && /^[0-9a-fA-F]{7,64}$/.test(id ?? '') && !sub) return { v: 'commit', ...at, sha: id!.toLowerCase() }
  return null
}

/** The way back from a view: the list, its repository, then the view itself. */
export function stackFor(v: GitView): GitView[] {
  if (v.v === 'list') return [v]
  const repo: GitView = { v: 'repo', src: v.src, owner: v.owner, repo: v.repo, tab: v.v === 'repo' ? v.tab : v.v === 'pull' ? 'pulls' : v.v === 'issue' ? 'issues' : 'commits' }
  return v.v === 'repo' ? [{ v: 'list' }, v] : [{ v: 'list' }, repo, v]
}

/** The repository API path of a view's repository. */
export const repoApi = (a: At) => `/api/repos/${encodeURIComponent(a.src)}/${a.owner}/${a.repo}`

export const sameRepo = (a: At, b: At) => a.src === b.src && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()

/** Props that open the Git app on a repository, pull request or issue (Spotlight's "Open in Git"). */
export const gitProps = (source: string, fullName: string, item?: { kind: 'pr' | 'issue'; number: number }) => ({
  route: `${source}/${fullName}${item ? `/${item.kind === 'pr' ? 'pull' : 'issue'}/${item.number}` : ''}`,
  t: String(Date.now()),
})
