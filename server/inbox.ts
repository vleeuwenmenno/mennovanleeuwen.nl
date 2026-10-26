import { privateRequestAuthority, requirePrivateRequest } from './privateRequest.ts'
import type { IssueHit } from '../src/data/code.ts'
import type { User } from './auth.ts'
import { onUserGone } from './db.ts'
import { sources, type Source } from './forges.ts'
import { list, toIssue, type ApiIssue } from './search.ts'

// The Code inbox widget: open pull requests waiting for your review, your own open pull requests
// and issues assigned to you, on GitHub and every linked Gitea/Forgejo instance. Read-only, with
// the access sign-in and linking already gave; cached for a minute.

export type Inbox = { review: IssueHit[]; mine: IssueHit[]; assigned: IssueHit[]; errors: string[] }

const CACHE_MS = 60_000
const cache = new Map<number, { at: number; authority: object | undefined; pending: boolean; value: Promise<Inbox> }>()
onUserGone((id) => cache.delete(id))

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
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS && (!hit.pending || hit.authority === privateRequestAuthority())) return hit.value
  const value = (async () => {
    const errors: string[] = []
    const boxes = await Promise.all(sources(user).map((src) => (src.kind === 'github' ? githubBox(src) : giteaBox(src)).catch((e: Error) => (errors.push(e.message), { review: [], mine: [], assigned: [] }))))
    requirePrivateRequest(user)
    const byUpdate = (a: IssueHit, b: IssueHit) => b.updatedAt.localeCompare(a.updatedAt)
    return {
      review: boxes.flatMap((b) => b.review).sort(byUpdate),
      mine: boxes.flatMap((b) => b.mine).sort(byUpdate),
      assigned: boxes.flatMap((b) => b.assigned).sort(byUpdate),
      errors,
    }
  })()
  const entry = { at: Date.now(), authority: privateRequestAuthority(), pending: true, value }
  cache.set(user.id, entry)
  value.then(() => { entry.pending = false }, () => { if (cache.get(user.id) === entry) cache.delete(user.id) })
  return value
}
