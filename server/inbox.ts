import type { IssueHit } from '../src/data/code.ts'
import type { User } from './auth.ts'
import { sources, type Source } from './forges.ts'
import { list, toIssue, type ApiIssue } from './search.ts'

// The Code inbox widget: open pull requests waiting for your review, your own open pull requests
// and issues assigned to you, on GitHub and every linked Gitea/Forgejo instance. Read-only, with
// the access sign-in and linking already gave; cached for a minute.

export type Inbox = { review: IssueHit[]; mine: IssueHit[]; assigned: IssueHit[]; errors: string[] }

const CACHE_MS = 60_000
const cache = new Map<number, { at: number; value: Promise<Inbox> }>()

async function githubBox(src: Source): Promise<Omit<Inbox, 'errors'>> {
  const q = (query: string) =>
    src.api<{ items: ApiIssue[] }>(`/search/issues?q=${encodeURIComponent(`${query} archived:false`)}&sort=updated&order=desc&per_page=20`).then((r) => (r?.items ?? []).map((i) => toIssue(src, i)))
  const [review, mine, assigned] = await Promise.all([q(`is:open is:pr review-requested:${src.login}`), q(`is:open is:pr author:${src.login}`), q(`is:open is:issue assignee:${src.login}`)])
  return { review, mine, assigned }
}

async function giteaBox(src: Source): Promise<Omit<Inbox, 'errors'>> {
  const q = (params: string) => src.api<ApiIssue[]>(`/repos/issues/search?state=open&limit=20&${params}`).then((r) => list<ApiIssue>(r).map((i) => toIssue(src, i)))
  const [review, mine, assigned] = await Promise.all([q('type=pulls&review_requested=true'), q('type=pulls&created=true'), q('type=issues&assigned=true')])
  return { review, mine, assigned }
}

export function inbox(user: User, fresh = false): Promise<Inbox> {
  const hit = cache.get(user.id)
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const value = (async () => {
    const errors: string[] = []
    const boxes = await Promise.all(sources(user).map((src) => (src.kind === 'github' ? githubBox(src) : giteaBox(src)).catch((e: Error) => (errors.push(e.message), { review: [], mine: [], assigned: [] }))))
    const byUpdate = (a: IssueHit, b: IssueHit) => b.updatedAt.localeCompare(a.updatedAt)
    return {
      review: boxes.flatMap((b) => b.review).sort(byUpdate),
      mine: boxes.flatMap((b) => b.mine).sort(byUpdate),
      assigned: boxes.flatMap((b) => b.assigned).sort(byUpdate),
      errors,
    }
  })()
  cache.set(user.id, { at: Date.now(), value })
  value.catch(() => cache.delete(user.id))
  return value
}
