import { useMemo, useState, type ReactNode } from 'react'
import type { GitComment, GitEvent, GitIssue, GitPerson, GitReviewState, GitTimeline, GitTimelineItem } from '../../data/gitTypes'
import { MarkdownPreview } from '../../data/markdown/MarkdownPreview'
import { forgetLists, send, useGet } from './data'
import { itemKey, MarkdownEditor } from './Editor'
import { hostUrlResolver, htmlToMarkdown } from './markdown'
import { repoApi, type At } from './route'
import { ago, Avatar, ErrorBox, ExtLink, fullDate, Labels, Loading, who } from './ui'
import type { Nav } from './views'

// The conversation of a pull request or issue, like the host's own page: the description, then
// comments, reviews (with their comments on lines), blocks of commits and small events in the
// order they happened (server/git.ts, …/timeline), and at the bottom a box to add a comment.
// The description and comments you wrote have an Edit button.

const firstLine = (s: string) => s.split('\n')[0]
const short = (sha: string) => sha.slice(0, 7)

/** One comment's card (the description is the first). `actions` go in its header. */
function Card({ author, date, verb, body, url, host, resolve, edited, first = false, actions, children }: { author: GitPerson | null; date: string; verb: string; body: string; url: string | null; host: string; resolve: (u: string) => string; edited?: boolean; first?: boolean; actions?: ReactNode; children?: ReactNode }) {
  const text = useMemo(() => htmlToMarkdown(body), [body])
  return (
    <article className={`git-comment ${first ? 'is-first' : ''}`}>
      <header className="git-comment-head">
        <Avatar p={author} size={20} />
        <strong>{who(author)}</strong>
        <span className="muted" title={fullDate(date)}>
          {verb} {ago(date)}
        </span>
        {edited && <span className="git-edited muted">edited</span>}
        <span className="git-comment-tools">
          {actions}
          {url && (
            <a className="git-comment-link muted" href={url} target="_blank" rel="noopener noreferrer" title={`On ${host}`} aria-label={`This on ${host}`}>
              ↗
            </a>
          )}
        </span>
      </header>
      {children ?? <div className="git-md selectable">{body.trim() ? <MarkdownPreview text={text} resolveUrl={resolve} /> : <p className="muted">No description provided.</p>}</div>}
    </article>
  )
}

const REVIEW: Record<GitReviewState, { verb: string; mark: string; tone: string }> = {
  approved: { verb: 'approved these changes', mark: '✓', tone: 'is-ok' },
  changes_requested: { verb: 'requested changes', mark: '±', tone: 'is-bad' },
  commented: { verb: 'reviewed', mark: '◉', tone: '' },
  dismissed: { verb: 'reviewed (dismissed)', mark: '◌', tone: 'is-muted' },
}

function Review({ r, host, resolve }: { r: Extract<GitTimelineItem, { type: 'review' }>; host: string; resolve: (u: string) => string }) {
  const s = REVIEW[r.state]
  const text = useMemo(() => htmlToMarkdown(r.body), [r.body])
  return (
    <article className={`git-comment git-review ${s.tone}`}>
      <header className="git-comment-head">
        <span className={`git-review-mark ${s.tone}`} aria-hidden>
          {s.mark}
        </span>
        <Avatar p={r.author} size={20} />
        <strong>{who(r.author)}</strong>
        <span className="muted" title={fullDate(r.createdAt)}>
          {s.verb} {ago(r.createdAt)}
        </span>
        <span className="git-comment-tools">
          {r.url && (
            <a className="git-comment-link muted" href={r.url} target="_blank" rel="noopener noreferrer" title={`This review on ${host}`} aria-label={`This review on ${host}`}>
              ↗
            </a>
          )}
        </span>
      </header>
      {r.body.trim() && (
        <div className="git-md selectable">
          <MarkdownPreview text={text} resolveUrl={resolve} />
        </div>
      )}
      {r.comments.length > 0 && (
        <ul className="git-rc-list">
          {r.comments.map((c) => (
            <ReviewComment key={c.id} c={c} reviewer={r.author} host={host} resolve={resolve} />
          ))}
        </ul>
      )}
    </article>
  )
}

function ReviewComment({ c, reviewer, host, resolve }: { c: Extract<GitTimelineItem, { type: 'review' }>['comments'][number]; reviewer: GitPerson | null; host: string; resolve: (u: string) => string }) {
  const text = useMemo(() => htmlToMarkdown(c.body), [c.body])
  const other = c.author?.login && c.author.login !== reviewer?.login
  return (
    <li className="git-rc">
      <div className="git-rc-head">
        <code className="git-rc-path">
          {c.path}
          {c.line ? `:${c.line}` : ''}
        </code>
        {(other || c.reply) && (
          <span className="muted">
            {c.reply ? 'reply' : ''}
            {other ? `${c.reply ? ' from ' : ''}${who(c.author)}` : ''}
          </span>
        )}
        {c.url && (
          <a className="git-comment-link muted" href={c.url} target="_blank" rel="noopener noreferrer" title={`This comment on ${host}`} aria-label={`This comment on ${host}`}>
            ↗
          </a>
        )}
      </div>
      <div className="git-md git-rc-body selectable">
        <MarkdownPreview text={text} resolveUrl={resolve} />
      </div>
    </li>
  )
}

function Commits({ item, onOpen }: { item: Extract<GitTimelineItem, { type: 'commits' }>; onOpen: (sha: string) => void }) {
  const authors = [...new Set(item.commits.map((c) => who(c.author)))]
  const n = item.commits.length
  return (
    <div className="git-tl-commits">
      <p className="git-tl-line">
        <span className="git-tl-dot" aria-hidden />
        <span>
          {authors.length === 1 ? <strong>{authors[0]}</strong> : null} {authors.length === 1 ? 'added' : 'Added'} {n} {n === 1 ? 'commit' : 'commits'}{' '}
          <span className="muted" title={fullDate(item.createdAt)}>
            {ago(item.createdAt)}
          </span>
        </span>
      </p>
      <ul className="git-tl-commit-list">
        {item.commits.map((c) => (
          <li key={c.sha}>
            <button className="git-tl-commit" onClick={() => onOpen(c.sha)} title={c.message}>
              <Avatar p={c.author} size={16} />
              <span className="git-tl-commit-msg">{firstLine(c.message)}</span>
              <code className="git-sha">{short(c.sha)}</code>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function EventLine({ e, at, nav }: { e: GitEvent; at: At; nav: Nav }) {
  const commit = (sha: string | null | undefined, repo?: string | null) => {
    if (!sha) return null
    const [owner, name] = (repo ?? `${at.owner}/${at.repo}`).split('/')
    return (
      <button className="git-linkish" onClick={() => nav.go({ v: 'commit', src: at.src, owner, repo: name, sha })} title={repo && repo.toLowerCase() !== `${at.owner}/${at.repo}`.toLowerCase() ? `In ${repo}` : undefined}>
        <code>{short(sha)}</code>
      </button>
    )
  }
  let what: ReactNode
  switch (e.event) {
    case 'closed':
      what = 'closed this'
      break
    case 'reopened':
      what = 'reopened this'
      break
    case 'merged':
      what = <>merged {e.commit ? <>commit {commit(e.commit, e.commitRepo)}</> : 'this'}</>
      break
    case 'force_pushed':
      what = e.from && e.to ? <>force-pushed the branch from <code>{short(e.from)}</code> to {commit(e.to)}</> : <>force-pushed the branch{e.commit ? <> to {commit(e.commit)}</> : null}</>
      break
    case 'renamed':
      what = (
        <>
          changed the title <s className="muted">{e.from}</s> to <strong>{e.to}</strong>
        </>
      )
      break
    case 'labeled':
    case 'unlabeled':
      what = <>{e.event === 'labeled' ? 'added' : 'removed'} {e.label ? <Labels labels={[e.label]} /> : 'a label'}</>
      break
    case 'assigned':
      what = e.subject && e.actor?.login === e.subject ? 'self-assigned this' : <>assigned <strong>{e.subject ?? 'someone'}</strong></>
      break
    case 'unassigned':
      what = e.subject && e.actor?.login === e.subject ? 'removed their assignment' : <>unassigned <strong>{e.subject ?? 'someone'}</strong></>
      break
    case 'review_requested':
      what = <>requested a review from <strong>{e.subject ?? 'someone'}</strong></>
      break
    case 'review_request_removed':
      what = <>removed the review request for <strong>{e.subject ?? 'someone'}</strong></>
      break
    case 'referenced':
      what = <>referenced this in commit {commit(e.commit, e.commitRepo)}</>
      break
    case 'cross_referenced': {
      const ref = e.ref!
      const [owner, name] = ref.repo.split('/')
      const same = ref.repo.toLowerCase() === `${at.owner}/${at.repo}`.toLowerCase()
      what = (
        <>
          mentioned this in{' '}
          {owner && name ? (
            <button className="git-linkish" onClick={() => nav.go(ref.pull ? { v: 'pull', src: at.src, owner, repo: name, number: ref.number, tab: 'conversation' } : { v: 'issue', src: at.src, owner, repo: name, number: ref.number })}>
              {same ? '' : ref.repo}#{ref.number} {ref.title}
            </button>
          ) : (
            <a href={ref.url} target="_blank" rel="noopener noreferrer">
              #{ref.number} {ref.title}
            </a>
          )}
        </>
      )
      break
    }
    case 'ready_for_review':
      what = 'marked this as ready for review'
      break
    case 'converted_to_draft':
      what = 'marked this as a draft'
      break
    case 'head_ref_deleted':
      what = <>deleted the branch{e.from ? <> <code className="git-ref">{e.from}</code></> : null}</>
      break
    case 'head_ref_restored':
      what = 'restored the branch'
      break
    case 'base_changed':
      what = e.from && e.to ? <>changed the base branch from <code className="git-ref">{e.from}</code> to <code className="git-ref">{e.to}</code></> : 'changed the base branch'
      break
    case 'locked':
      what = 'locked the conversation'
      break
    case 'unlocked':
      what = 'unlocked the conversation'
      break
  }
  return (
    <p className={`git-tl-line is-${e.event}`}>
      <span className="git-tl-dot" aria-hidden />
      <Avatar p={e.actor} size={16} />
      <span>
        <strong>{who(e.actor)}</strong> {what}{' '}
        <span className="muted" title={fullDate(e.createdAt)}>
          {ago(e.createdAt)}
        </span>
      </span>
    </p>
  )
}

/** Events and commit blocks next to each other share one rail; cards stand on their own. */
function railed(items: GitTimelineItem[]): (GitTimelineItem | GitTimelineItem[])[] {
  const out: (GitTimelineItem | GitTimelineItem[])[] = []
  for (const it of items) {
    const small = it.type === 'event' || it.type === 'commits'
    const last = out[out.length - 1]
    if (small && Array.isArray(last)) last.push(it)
    else out.push(small ? [it] : it)
  }
  return out
}

export function Conversation({ item, at, host, web, nav, reloadItem }: { item: GitIssue; at: At; host: string; web: string; nav: Nav; reloadItem: () => void }) {
  const resolve = useMemo(() => hostUrlResolver(web), [web])
  const base = `${repoApi(at)}/${item.pull ? 'pulls' : 'issues'}/${item.number}`
  const issueApi = `${repoApi(at)}/issues/${item.number}`
  const tl = useGet<GitTimeline>(`${base}/timeline`)
  const me = nav.login(at.src)?.toLowerCase() ?? null
  const mine = (p: GitPerson | null) => !!me && p?.login?.toLowerCase() === me
  const write = nav.canWrite(at.src)
  const key = itemKey(at, item.number)
  const what = `${item.pull ? 'pull request' : 'issue'} #${item.number}`

  // What was just sent shows at once, also while the host's own lists catch up.
  const [posted, setPosted] = useState<GitComment[]>([])
  const [changed, setChanged] = useState<Record<number, GitComment>>({})
  const [description, setDescription] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const after = () => {
    forgetLists(repoApi(at))
    tl.reload()
  }
  const addComment = async (body: string) => {
    const c = await send<GitComment>(`${issueApi}/comments`, 'POST', { body })
    setPosted((p) => [...p, c])
    after()
  }
  const saveDescription = async (body: string) => {
    const r = await send<{ body: string }>(issueApi, 'PATCH', { body })
    setDescription(r.body)
    setEditing(null)
    forgetLists(repoApi(at))
    reloadItem()
  }
  const saveComment = async (id: number, body: string) => {
    const c = await send<GitComment>(`${repoApi(at)}/issues/comments/${id}`, 'PATCH', { body })
    setChanged((m) => ({ ...m, [id]: { ...c, edited: true } }))
    setEditing(null)
    after()
  }

  const items = useMemo(() => {
    const list = (tl.data?.items ?? []).map((it) => (it.type === 'comment' && changed[it.id] ? { ...it, ...changed[it.id], type: 'comment' as const } : it))
    const ids = new Set(list.flatMap((it) => (it.type === 'comment' ? [it.id] : [])))
    return [...list, ...posted.filter((c) => !ids.has(c.id)).map((c) => ({ ...(changed[c.id] ?? c), type: 'comment' as const }))]
  }, [tl.data, posted, changed])

  const body = description ?? item.body
  const editButton = (id: string) =>
    write.ok && editing === null ? (
      <button className="git-btn is-small git-edit-btn" onClick={() => setEditing(id)} aria-label="Edit">
        Edit
      </button>
    ) : null

  const commentCard = (c: GitComment) =>
    editing === `c${c.id}` ? (
      <article key={`c${c.id}`} className="git-comment is-editing">
        <MarkdownEditor
          draftKey={`${key}c${c.id}`}
          original={c.body}
          label="Edit your comment"
          submitLabel="Save"
          busyLabel="Saving…"
          autoFocus
          resolve={resolve}
          onSubmit={(t) => saveComment(c.id, t)}
          onCancel={() => setEditing(null)}
        />
      </article>
    ) : (
      <Card key={`c${c.id}`} author={c.author} date={c.createdAt} verb="commented" body={c.body} url={c.url} host={host} resolve={resolve} edited={c.edited} actions={mine(c.author) ? editButton(`c${c.id}`) : null} />
    )

  return (
    <div className="git-thread">
      {editing === 'body' ? (
        <article className="git-comment is-first is-editing">
          <MarkdownEditor
            draftKey={`${key}body`}
            original={body}
            label="Edit the description"
            submitLabel="Save"
            busyLabel="Saving…"
            allowEmpty
            autoFocus
            resolve={resolve}
            onSubmit={saveDescription}
            onCancel={() => setEditing(null)}
          />
        </article>
      ) : (
        <Card first author={item.author} date={item.createdAt} verb="opened this" body={body} url={item.url} host={host} resolve={resolve} actions={mine(item.author) ? editButton('body') : null} />
      )}
      {tl.error && <ErrorBox error={tl.error} onRetry={tl.reload} web={item.url} hostLabel={host} />}
      {!tl.data && !tl.error && <Loading what="the conversation" />}
      {railed(items).map((x) =>
        Array.isArray(x) ? (
          <div key={x[0].type === 'event' || x[0].type === 'commits' ? x[0].id : ''} className="git-tl-rail">
            {x.map((it) =>
              it.type === 'commits' ? (
                <Commits key={it.id} item={it} onOpen={(sha) => nav.go({ v: 'commit', src: at.src, owner: at.owner, repo: at.repo, sha })} />
              ) : it.type === 'event' ? (
                <EventLine key={it.id} e={it} at={at} nav={nav} />
              ) : null,
            )}
          </div>
        ) : x.type === 'comment' ? (
          commentCard(x)
        ) : x.type === 'review' ? (
          <Review key={`r${x.id}`} r={x} host={host} resolve={resolve} />
        ) : null,
      )}
      {tl.data?.truncated && (
        <p className="git-hint">
          Only the first part of this conversation shows here. <ExtLink href={item.url} label={`More on ${host}`} small />
        </p>
      )}
      <section className="git-composer" aria-label="Add a comment">
        <h3 className="git-composer-head">Add a comment</h3>
        <MarkdownEditor
          draftKey={`${key}new`}
          label={`Comment on ${what}`}
          placeholder="Leave a comment"
          submitLabel="Comment"
          busyLabel="Sending…"
          disabled={!write.ok}
          disabledHint={
            write.ok ? null : (
              <>
                {write.hint}{' '}
                <button className="git-linkish" onClick={nav.openSettings}>
                  Settings → Code hosts
                </button>
              </>
            )
          }
          resolve={resolve}
          onSubmit={addComment}
        />
      </section>
      <p className="git-hint">
        {item.pull ? `Reviewing, checks and merging are on ${host}.` : `Closing, labels and reactions are on ${host}.`} <ExtLink href={item.url} label={item.pull ? `Review on ${host}` : `Open on ${host}`} small />
      </p>
    </div>
  )
}
