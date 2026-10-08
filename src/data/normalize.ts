// Normalizers shared by the browser (live GitHub feed) and scripts/fetch-recents.ts
// (build-time snapshot, which can also reach git.mvl.sh because Forgejo sends no CORS headers).
// Keep this file free of DOM and Node APIs so both runtimes can import it.

export type ActivityKind = 'push' | 'pr' | 'merge' | 'issue' | 'release' | 'create' | 'star' | 'comment' | 'fork'

export type Activity = {
  id: string
  source: 'github' | 'forgejo'
  kind: ActivityKind
  repo: string
  title: string
  detail?: string
  url: string
  date: string
  /** Pushes: the head commit, linked from the activity list. */
  sha?: string
  /** The branch or tag it happened on, linked from the activity list. */
  ref?: { type: 'branch' | 'tag'; name: string; url: string }
}

const enc = (ref: string) => ref.split('/').map(encodeURIComponent).join('/')
const ghBranch = (repoUrl: string, name: string) => ({ type: 'branch' as const, name, url: `${repoUrl}/tree/${enc(name)}` })
const ghTag = (repoUrl: string, name: string) => ({ type: 'tag' as const, name, url: `${repoUrl}/releases/tag/${enc(name)}` })
const fjBranch = (repoUrl: string, name: string) => ({ type: 'branch' as const, name, url: `${repoUrl}/src/branch/${enc(name)}` })
const fjTag = (repoUrl: string, name: string) => ({ type: 'tag' as const, name, url: `${repoUrl}/releases/tag/${enc(name)}` })

type Json = Record<string, any>

const firstLine = (s: string | undefined | null) => (s ?? '').split('\n')[0].trim()

export function normalizeGithubEvents(events: Json[]): Activity[] {
  const out: Activity[] = []
  const seen = new Set<string>()
  const push = (a: Activity, key: string) => {
    if (seen.has(key)) return
    seen.add(key)
    out.push(a)
  }

  for (const e of events) {
    const repo: string = e.repo?.name ?? ''
    const repoUrl = `https://github.com/${repo}`
    const p = e.payload ?? {}
    const base = { source: 'github' as const, repo, date: e.created_at as string }

    switch (e.type) {
      case 'PushEvent': {
        const branch = String(p.ref ?? '').replace('refs/heads/', '')
        const count = Array.isArray(p.commits) ? p.commits.length : 0
        const msg = Array.isArray(p.commits) && p.commits.length ? firstLine(p.commits[p.commits.length - 1].message) : ''
        // Collapse a burst of pushes to the same branch on the same day into one row.
        push(
          {
            ...base,
            id: `gh-${e.id}`,
            kind: 'push',
            title: count ? `Pushed ${count} commit${count === 1 ? '' : 's'} to ${branch}` : `Pushed to ${branch}`,
            detail: msg || undefined,
            url: p.head ? `${repoUrl}/commit/${p.head}` : repoUrl,
            sha: p.head || undefined,
            ref: branch ? ghBranch(repoUrl, branch) : undefined,
          },
          `push-${repo}-${branch}-${base.date.slice(0, 10)}`,
        )
        break
      }
      case 'PullRequestEvent': {
        // Since 2025 the events API sends a trimmed pull_request (no title or merged flag),
        // so fall back to the head branch name for context.
        const pr = p.pull_request ?? {}
        const number = p.number ?? pr.number
        const url = pr.html_url ?? `${repoUrl}/pull/${number}`
        const detail = pr.title ?? pr.head?.ref
        // Only link the branch when it lives in this repo, not in a contributor's fork.
        const headRepo: string | undefined = pr.head?.repo?.full_name ?? pr.head?.repo?.url?.replace('https://api.github.com/repos/', '')
        const ref = pr.head?.ref && (!headRepo || headRepo === repo) ? ghBranch(repoUrl, pr.head.ref) : undefined
        if (p.action === 'opened') {
          push({ ...base, id: `gh-${e.id}`, kind: 'pr', title: `Opened PR #${number}`, detail, url, ref }, `pr-open-${repo}-${number}`)
        } else if (p.action === 'closed') {
          const merged = pr.merged ?? pr.merged_at ?? true
          push(
            { ...base, id: `gh-${e.id}`, kind: merged ? 'merge' : 'pr', title: `${merged ? 'Merged' : 'Closed'} PR #${number}`, detail, url, ref },
            `pr-close-${repo}-${number}`,
          )
        }
        break
      }
      case 'IssuesEvent': {
        const issue = p.issue ?? {}
        if (p.action !== 'opened' && p.action !== 'closed') break
        push(
          {
            ...base,
            id: `gh-${e.id}`,
            kind: 'issue',
            title: `${p.action === 'opened' ? 'Opened' : 'Closed'} issue #${issue.number}`,
            detail: issue.title,
            url: issue.html_url ?? repoUrl,
          },
          `issue-${p.action}-${repo}-${issue.number}`,
        )
        break
      }
      case 'IssueCommentEvent': {
        const issue = p.issue ?? {}
        push(
          {
            ...base,
            id: `gh-${e.id}`,
            kind: 'comment',
            title: `Commented on #${issue.number}`,
            detail: issue.title,
            url: p.comment?.html_url ?? issue.html_url ?? repoUrl,
          },
          `comment-${repo}-${issue.number}-${base.date.slice(0, 10)}`,
        )
        break
      }
      case 'ReleaseEvent': {
        const r = p.release ?? {}
        if (p.action !== 'published') break
        push(
          { ...base, id: `gh-${e.id}`, kind: 'release', title: `Released ${r.name || r.tag_name}`, url: r.html_url ?? repoUrl, ref: r.tag_name ? ghTag(repoUrl, r.tag_name) : undefined },
          `release-${repo}-${r.tag_name}`,
        )
        break
      }
      case 'CreateEvent': {
        if (p.ref_type === 'repository') {
          push({ ...base, id: `gh-${e.id}`, kind: 'create', title: `Created ${repo}`, detail: p.description || undefined, url: repoUrl }, `create-${repo}`)
        } else if (p.ref_type === 'tag') {
          push({ ...base, id: `gh-${e.id}`, kind: 'create', title: `Tagged ${p.ref}`, url: `${repoUrl}/releases/tag/${p.ref}`, ref: ghTag(repoUrl, p.ref) }, `tag-${repo}-${p.ref}`)
        } else if (p.ref_type === 'branch') {
          push({ ...base, id: `gh-${e.id}`, kind: 'create', title: `Created branch ${p.ref}`, url: `${repoUrl}/tree/${enc(p.ref)}`, ref: ghBranch(repoUrl, p.ref) }, `branch-${repo}-${p.ref}`)
        }
        break
      }
      case 'WatchEvent':
        push({ ...base, id: `gh-${e.id}`, kind: 'star', title: `Starred ${repo}`, url: repoUrl }, `star-${repo}`)
        break
      case 'ForkEvent':
        push({ ...base, id: `gh-${e.id}`, kind: 'fork', title: `Forked ${repo}`, url: p.forkee?.html_url ?? repoUrl }, `fork-${repo}`)
        break
    }
  }
  return out
}

export function normalizeGithubReleases(repo: string, releases: Json[]): Activity[] {
  return releases
    .filter((r) => !r.draft && r.published_at)
    .map((r) => ({
      id: `ghrel-${r.id}`,
      source: 'github' as const,
      kind: 'release' as const,
      repo,
      title: `Released ${r.name || r.tag_name}`,
      detail: firstLine(r.body) || undefined,
      url: r.html_url,
      date: r.published_at,
      ref: r.tag_name ? ghTag(`https://github.com/${repo}`, r.tag_name) : undefined,
    }))
}

export function normalizeForgejoFeed(base: string, feed: Json[]): Activity[] {
  const out: Activity[] = []
  for (const a of feed) {
    const repo: string = a.repo?.full_name ?? ''
    const repoUrl = `${base}/${repo}`
    const date = new Date(a.created).toISOString()
    if (a.op_type === 'publish_release') {
      const tag = String(a.ref_name ?? '').replace('refs/tags/', '')
      out.push({ id: `fj-${a.id}`, source: 'forgejo', kind: 'release', repo, title: `Released ${tag}`, url: `${repoUrl}/releases/tag/${tag}`, ref: tag ? fjTag(repoUrl, tag) : undefined, date })
    } else if (a.op_type === 'commit_repo') {
      let commits: Json[] = []
      try {
        commits = JSON.parse(a.content || '{}').Commits ?? []
      } catch {
        /* content is not always JSON */
      }
      const branch = String(a.ref_name ?? '').replace('refs/heads/', '')
      const head = commits[0]
      out.push({
        id: `fj-${a.id}`,
        source: 'forgejo',
        kind: 'push',
        repo,
        title: `Pushed ${commits.length || ''} commit${commits.length === 1 ? '' : 's'} to ${branch}`.replace('  ', ' '),
        detail: head ? firstLine(head.Message) : undefined,
        url: head ? `${repoUrl}/commit/${head.Sha1}` : repoUrl,
        sha: head?.Sha1,
        ref: branch ? fjBranch(repoUrl, branch) : undefined,
        date,
      })
    } else if (a.op_type === 'create_repo') {
      out.push({ id: `fj-${a.id}`, source: 'forgejo', kind: 'create', repo, title: `Created ${repo}`, url: repoUrl, date })
    }
  }
  return out
}

export function mergeActivity(...lists: Activity[][]): Activity[] {
  // The same release can arrive both as a ReleaseEvent and from the releases API.
  const byKey = new Map<string, Activity>()
  for (const list of lists) for (const a of list) byKey.set(a.kind === 'release' ? `${a.repo}|${a.title}` : a.id, a)
  return [...byKey.values()].sort((a, b) => b.date.localeCompare(a.date))
}
