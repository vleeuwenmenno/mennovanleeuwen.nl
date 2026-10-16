import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { GitBranch, GitComment, GitCommit, GitCommitItem, GitFileList, GitIssue, GitIssueItem, GitPull, GitRepo, GitRepoList, GitRepoOverview, RepoHit } from '../../data/gitTypes'
import { MarkdownPreview } from '../../data/markdown/MarkdownPreview'
import { useGet, usePaged } from './data'
import { DiffFiles } from './Diff'
import { hostUrlResolver, htmlToMarkdown, repoUrlResolver } from './markdown'
import { repoApi, type At, type GitView, type PullTab, type RepoTab } from './route'
import { ago, Avatar, copyText, ErrorBox, ExtLink, fullDate, Labels, Loading, MoreButton, StateBadge, Tabs, who } from './ui'

/** What every view needs from the app: moving around, and the host's name and web address. */
export type Nav = {
  go: (v: GitView) => void
  replace: (v: GitView) => void
  hostLabel: (src: string) => string
  /** The repository's page on its host */
  repoWeb: (at: At) => string
}

const enc = encodeURIComponent
const firstLine = (s: string) => s.split('\n')[0]

// ---------------------------------------------------------------------------------------------
// The repository list

export function RepoList({ list, current, onOpen, onReload, onSettings }: { list: ReturnType<typeof useGet<GitRepoList>>; current: At | null; onOpen: (r: RepoHit) => void; onReload: () => void; onSettings: () => void }) {
  const [q, setQ] = useState('')
  const [owner, setOwner] = useState('')
  const [host, setHost] = useState('')
  const data = list.data
  const repos = data?.repos ?? []
  const ownerOf = (r: RepoHit) => r.fullName.split('/')[0]
  const owners = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of repos) counts.set(ownerOf(r), (counts.get(ownerOf(r)) ?? 0) + 1)
    return [...counts].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
  }, [repos])
  const sources = data?.sources ?? []
  const needle = q.trim().toLowerCase()
  const shown = repos.filter((r) => (!owner || ownerOf(r) === owner) && (!host || r.source === host) && (!needle || r.fullName.toLowerCase().includes(needle) || (r.description ?? '').toLowerCase().includes(needle)))
  // Grouped by owner: your own first, then the owner pushed to most recently.
  const groups = useMemo(() => {
    const me = new Set(sources.map((s) => s.login.toLowerCase()))
    const by = new Map<string, RepoHit[]>()
    for (const r of [...shown].sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''))) {
      const k = `${r.source}|${ownerOf(r)}`
      by.set(k, [...(by.get(k) ?? []), r])
    }
    return [...by].sort((a, b) => +me.has(ownerOf(b[1][0]).toLowerCase()) - +me.has(ownerOf(a[1][0]).toLowerCase()) || (b[1][0].pushedAt ?? '').localeCompare(a[1][0].pushedAt ?? ''))
  }, [shown, sources])

  return (
    <div className="git-list">
      <div className="git-list-tools">
        <input className="git-input" type="search" placeholder="Filter repositories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter repositories" />
        <div className="git-list-selects">
          <select className="git-input" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner or organisation">
            <option value="">All owners</option>
            {owners.map(([o, n]) => (
              <option key={o} value={o}>
                {o} ({n})
              </option>
            ))}
          </select>
          {sources.length > 1 && (
            <select className="git-input" value={host} onChange={(e) => setHost(e.target.value)} aria-label="Code host">
              <option value="">All hosts</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
          <button className="git-btn is-icon" onClick={onReload} title="Reload" aria-label="Reload">
            ↻
          </button>
        </div>
      </div>
      {data && !data.privateScope && (
        <p className="git-hint">
          Only public GitHub repositories show.{' '}
          <button className="git-linkish" onClick={onSettings}>
            Allow private ones in Settings → Code hosts
          </button>
        </p>
      )}
      {data?.errors.map((e) => (
        <p key={e} className="git-warn">
          {e}
        </p>
      ))}
      {list.error && <ErrorBox error={list.error} onRetry={onReload} />}
      {!data && !list.error && <Loading what="repositories" />}
      {data && !shown.length && <p className="git-pad muted">{repos.length ? 'No repository matches.' : 'No repositories yet.'}</p>}
      <div className="git-list-scroll">
        {groups.map(([k, rs]) => (
          <section key={k} className="git-group">
            <h3 className="git-group-head">
              {ownerOf(rs[0])}
              {sources.length > 1 && <span className="muted"> · {rs[0].sourceLabel}</span>}
            </h3>
            {rs.map((r) => {
              const [o, name] = r.fullName.split('/')
              const on = !!current && current.src === r.source && current.owner.toLowerCase() === o.toLowerCase() && current.repo.toLowerCase() === name.toLowerCase()
              return (
                <button key={r.fullName} className={`git-repo-row ${on ? 'is-on' : ''}`} onClick={() => onOpen(r)} aria-current={on || undefined}>
                  <span className="git-repo-name">
                    {name}
                    {r.private && <span className="git-badge">private</span>}
                    {r.fork && <span className="git-badge">fork</span>}
                    {r.archived && <span className="git-badge is-warn">archived</span>}
                  </span>
                  {r.description && <span className="git-repo-desc">{r.description}</span>}
                  <span className="git-repo-meta">
                    {r.language && <span>{r.language}</span>}
                    {r.pushedAt && <span>pushed {ago(r.pushedAt)}</span>}
                    {r.stars > 0 && <span>★ {r.stars}</span>}
                  </span>
                </button>
              )
            })}
          </section>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// A repository

export function RepoView({ view, nav }: { view: Extract<GitView, { v: 'repo' }>; nav: Nav }) {
  const overview = useGet<GitRepoOverview>(repoApi(view))
  const repo = overview.data?.repo
  const web = repo?.url ?? nav.repoWeb(view)
  const host = nav.hostLabel(view.src)
  const setTab = (tab: RepoTab) => nav.replace({ ...view, tab, filter: undefined })
  return (
    <div className="git-view">
      <header className="git-head">
        <div className="git-head-main">
          <h2 className="git-title">
            <span className="muted">{view.owner} / </span>
            {view.repo}
            {repo?.private && <span className="git-badge">private</span>}
            {repo?.archived && <span className="git-badge is-warn">archived</span>}
          </h2>
          {repo?.description && <p className="git-sub">{repo.description}</p>}
        </div>
        <div className="git-head-actions">
          <ExtLink href={web} label={`Open on ${host}`} />
        </div>
      </header>
      <Tabs<RepoTab>
        value={view.tab}
        onChange={setTab}
        options={[
          { id: 'overview', label: 'Overview' },
          { id: 'pulls', label: repo?.openPulls ? `Pull requests ${repo.openPulls}` : 'Pull requests' },
          { id: 'issues', label: repo && repo.kind === 'gitea' && repo.openIssues ? `Issues ${repo.openIssues}` : 'Issues' },
          { id: 'commits', label: 'Commits' },
        ]}
      />
      <div className="git-body">
        {view.tab === 'overview' &&
          (overview.error ? <ErrorBox error={overview.error} onRetry={overview.reload} web={web} hostLabel={host} /> : !overview.data ? <Loading what="the repository" /> : <Overview data={overview.data} host={host} />)}
        {view.tab === 'pulls' && <IssueList kind="pulls" view={view} nav={nav} web={web} />}
        {view.tab === 'issues' && <IssueList kind="issues" view={view} nav={nav} web={web} />}
        {view.tab === 'commits' && <CommitList view={view} nav={nav} repo={repo ?? null} web={web} />}
      </div>
    </div>
  )
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <span className="git-copy">
      <code>{value}</code>
      <button
        className="git-btn is-small"
        onClick={() =>
          void copyText(value).then((ok) => {
            setDone(ok)
            if (ok) setTimeout(() => setDone(false), 1500)
          })
        }
        aria-label={`Copy ${label}`}
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}

function Overview({ data, host }: { data: GitRepoOverview; host: string }) {
  const { repo, readme } = data
  const resolve = useMemo(() => repoUrlResolver(repo), [repo])
  const text = useMemo(() => (readme ? htmlToMarkdown(readme.text) : ''), [readme])
  const markdown = readme && /\.(md|markdown|mdown)$/i.test(readme.name)
  return (
    <div className="git-overview">
      <dl className="git-stats">
        <div>
          <dt>Stars</dt>
          <dd>{repo.stars}</dd>
        </div>
        <div>
          <dt>Forks</dt>
          <dd>{repo.forks}</dd>
        </div>
        <div>
          <dt>Watching</dt>
          <dd>{repo.watchers}</dd>
        </div>
        <div>
          <dt>{repo.kind === 'github' ? 'Open issues & PRs' : 'Open issues'}</dt>
          <dd>{repo.openIssues}</dd>
        </div>
        <div>
          <dt>Default branch</dt>
          <dd>
            <code>{repo.defaultBranch}</code>
          </dd>
        </div>
        {repo.language && (
          <div>
            <dt>Language</dt>
            <dd>{repo.language}</dd>
          </div>
        )}
        {repo.license && (
          <div>
            <dt>License</dt>
            <dd>{repo.license}</dd>
          </div>
        )}
        {repo.pushedAt && (
          <div>
            <dt>Last push</dt>
            <dd title={fullDate(repo.pushedAt)}>{ago(repo.pushedAt)}</dd>
          </div>
        )}
      </dl>
      {repo.topics.length > 0 && (
        <p className="git-topics">
          {repo.topics.map((t) => (
            <span key={t} className="git-topic">
              {t}
            </span>
          ))}
        </p>
      )}
      <div className="git-clone">
        <CopyField value={repo.cloneUrl} label="HTTPS clone address" />
        {repo.sshUrl && <CopyField value={repo.sshUrl} label="SSH clone address" />}
      </div>
      {repo.homepage && (
        <p>
          <ExtLink href={repo.homepage} label={repo.homepage.replace(/^https?:\/\//, '').replace(/\/$/, '')} small />
        </p>
      )}
      <section className="git-card">
        <header className="git-card-head">
          <span>{readme?.name ?? 'README'}</span>
          {readme?.url && <ExtLink href={readme.url} label={`On ${host}`} small />}
        </header>
        <article className="git-md selectable">
          {!readme ? <p className="muted">This repository has no README.</p> : markdown ? <MarkdownPreview text={text} resolveUrl={resolve} /> : <pre className="git-pre">{readme.text}</pre>}
          {readme?.truncated && <p className="muted">The rest of this README is on {host}.</p>}
        </article>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Pull request and issue lists

function IssueRow({ i, onOpen }: { i: GitIssueItem; onOpen: () => void }) {
  return (
    <button className="git-item" onClick={onOpen}>
      <span className="git-item-top">
        <StateBadge state={i.state} draft={i.draft} />
        <span className="git-item-title">{i.title}</span>
      </span>
      <span className="git-item-meta">
        #{i.number} · {who(i.author)} · updated {ago(i.updatedAt)}
        {i.comments ? ` · 💬 ${i.comments}` : ''}
        <Labels labels={i.labels} />
      </span>
    </button>
  )
}

function IssueList({ kind, view, nav, web }: { kind: 'pulls' | 'issues'; view: Extract<GitView, { v: 'repo' }>; nav: Nav; web: string }) {
  const states = kind === 'pulls' ? (['open', 'merged', 'closed', 'all'] as const) : (['open', 'closed', 'all'] as const)
  const state = (states as readonly string[]).includes(view.filter ?? '') ? view.filter! : 'open'
  const list = usePaged<GitIssueItem>(`${repoApi(view)}/${kind}?state=${state}`)
  const host = nav.hostLabel(view.src)
  const label = kind === 'pulls' ? 'pull requests' : 'issues'
  return (
    <div>
      <div className="git-toolbar">
        <Tabs small value={state} onChange={(f) => nav.replace({ ...view, filter: f })} options={states.map((s) => ({ id: s, label: s[0].toUpperCase() + s.slice(1) }))} />
        <span className="git-toolbar-end">
          <button className="git-btn is-icon" onClick={list.reload} title="Reload" aria-label="Reload">
            ↻
          </button>
          <ExtLink href={kind === 'pulls' ? `${web}/compare` : `${web}/issues/new`} label={kind === 'pulls' ? 'New pull request' : 'New issue'} small title={`Opens ${host} to write it`} />
        </span>
      </div>
      {list.items.map((i) => (
        <IssueRow key={i.number} i={i} onOpen={() => nav.go(i.pull ? { v: 'pull', src: view.src, owner: view.owner, repo: view.repo, number: i.number, tab: 'conversation' } : { v: 'issue', src: view.src, owner: view.owner, repo: view.repo, number: i.number })} />
      ))}
      {!list.loading && !list.error && !list.items.length && list.next === null && <p className="git-pad muted">No {state === 'all' ? '' : `${state} `}{label}.</p>}
      {list.loading && !list.items.length ? <Loading what={label} /> : <MoreButton next={list.next} loading={list.loading} error={list.error} onMore={list.more} />}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Commits

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Unknown date')

function CommitRows({ items, onOpen }: { items: GitCommitItem[]; onOpen: (sha: string) => void }) {
  const groups: [string, GitCommitItem[]][] = []
  for (const c of items) {
    const d = day(c.date)
    const last = groups[groups.length - 1]
    if (last && last[0] === d) last[1].push(c)
    else groups.push([d, [c]])
  }
  return (
    <>
      {groups.map(([d, cs]) => (
        <section key={d} className="git-group">
          <h3 className="git-group-head">Commits on {d}</h3>
          {cs.map((c) => (
            <button key={c.sha} className="git-item git-commit-row" onClick={() => onOpen(c.sha)}>
              <span className="git-item-top">
                <span className="git-item-title">{firstLine(c.message)}</span>
                <code className="git-sha">{c.sha.slice(0, 7)}</code>
              </span>
              <span className="git-item-meta">
                <Avatar p={c.author} size={16} /> {who(c.author)} · {ago(c.date)}
              </span>
            </button>
          ))}
        </section>
      ))}
    </>
  )
}

function CommitList({ view, nav, repo, web }: { view: Extract<GitView, { v: 'repo' }>; nav: Nav; repo: GitRepo | null; web: string }) {
  const branches = useGet<GitBranch[]>(`${repoApi(view)}/branches`)
  const ref = view.ref ?? repo?.defaultBranch ?? null
  const list = usePaged<GitCommitItem>(ref || repo ? `${repoApi(view)}/commits${ref ? `?ref=${enc(ref)}` : ''}` : null)
  const names = branches.data?.map((b) => b.name) ?? []
  if (ref && !names.includes(ref)) names.unshift(ref)
  const host = nav.hostLabel(view.src)
  const webCommits = ref ? (view.src === 'github' ? `${web}/commits/${enc(ref)}` : `${web}/commits/branch/${enc(ref)}`) : web
  return (
    <div>
      <div className="git-toolbar">
        <label className="git-branch">
          <span className="muted">Branch</span>
          <select className="git-input" value={ref ?? ''} onChange={(e) => nav.replace({ ...view, ref: e.target.value })} disabled={!names.length}>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="git-toolbar-end">
          <button className="git-btn is-icon" onClick={list.reload} title="Reload" aria-label="Reload">
            ↻
          </button>
          <ExtLink href={webCommits} label={`History on ${host}`} small />
        </span>
      </div>
      <CommitRows items={list.items} onOpen={(sha) => nav.go({ v: 'commit', src: view.src, owner: view.owner, repo: view.repo, sha })} />
      {!list.loading && !list.error && !list.items.length && list.next === null && <p className="git-pad muted">No commits.</p>}
      {list.loading && !list.items.length ? <Loading what="commits" /> : <MoreButton next={list.next} loading={list.loading} error={list.error} onMore={list.more} />}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// One pull request, issue or commit

function Comment({ author, date, body, url, host, resolve, first = false }: { author: GitComment['author']; date: string; body: string; url: string | null; host: string; resolve: (u: string) => string; first?: boolean }) {
  const text = useMemo(() => htmlToMarkdown(body), [body])
  return (
    <article className={`git-comment ${first ? 'is-first' : ''}`}>
      <header className="git-comment-head">
        <Avatar p={author} size={20} />
        <strong>{who(author)}</strong>
        <span className="muted" title={fullDate(date)}>
          {first ? 'opened' : 'commented'} {ago(date)}
        </span>
        {url && (
          <a className="git-comment-link muted" href={url} target="_blank" rel="noopener noreferrer" title={`This comment on ${host}`} aria-label={`This comment on ${host}`}>
            ↗
          </a>
        )}
      </header>
      <div className="git-md selectable">{body.trim() ? <MarkdownPreview text={text} resolveUrl={resolve} /> : <p className="muted">No description provided.</p>}</div>
    </article>
  )
}

function Conversation({ item, host, web }: { item: GitIssue; host: string; web: string }) {
  const resolve = useMemo(() => hostUrlResolver(web), [web])
  return (
    <div className="git-thread">
      <Comment first author={item.author} date={item.createdAt} body={item.body} url={item.url} host={host} resolve={resolve} />
      {item.commentList.map((c) => (
        <Comment key={c.id} author={c.author} date={c.createdAt} body={c.body} url={c.url} host={host} resolve={resolve} />
      ))}
      {item.moreComments && (
        <p className="git-hint">
          More comments than shown here. <ExtLink href={item.url} label={`Read them on ${host}`} small />
        </p>
      )}
      <p className="git-hint">
        {item.pull ? 'Reviews, review comments and checks are on the web.' : 'To reply, react or change it, go to the web.'} <ExtLink href={item.url} label={item.pull ? `Review on ${host}` : `Comment on ${host}`} small />
      </p>
    </div>
  )
}

function ItemHead({ item, host, extra, children }: { item: GitIssue; host: string; extra?: ReactNode; children?: ReactNode }) {
  return (
    <header className="git-head">
      <div className="git-head-main">
        <h2 className="git-title">
          {item.title} <span className="muted">#{item.number}</span>
        </h2>
        <p className="git-sub git-item-meta">
          <StateBadge state={item.state} draft={item.draft} /> {children}
        </p>
        {(item.labels.length > 0 || item.assignees.length > 0 || item.milestone) && (
          <p className="git-sub git-item-meta">
            <Labels labels={item.labels} />
            {item.assignees.length > 0 && <span>Assigned to {item.assignees.map(who).join(', ')}</span>}
            {item.milestone && <span>· Milestone {item.milestone}</span>}
          </p>
        )}
        {extra}
      </div>
      <div className="git-head-actions">
        <ExtLink href={item.url} label={`Open on ${host}`} />
      </div>
    </header>
  )
}

export function PullView({ view, nav }: { view: Extract<GitView, { v: 'pull' }>; nav: Nav }) {
  const base = `${repoApi(view)}/pulls/${view.number}`
  const pull = useGet<GitPull>(base)
  const host = nav.hostLabel(view.src)
  const repoWeb = nav.repoWeb(view)
  const web = pull.data?.url ?? `${repoWeb}/pulls/${view.number}`
  if (pull.error) return <ErrorBox error={pull.error} onRetry={pull.reload} web={web} hostLabel={host} />
  if (!pull.data) return <Loading what={`pull request #${view.number}`} />
  const p = pull.data
  const commits = p.commitCount ?? null
  return (
    <div className="git-view">
      <ItemHead item={p} host={host}>
        <span>
          <strong>{who(p.author)}</strong> {p.merged ? 'merged' : p.state === 'open' ? 'wants to merge' : 'proposed'} {commits !== null ? `${commits} ${commits === 1 ? 'commit' : 'commits'} ` : ''}into <code className="git-ref">{p.base.ref}</code> from <code className="git-ref">{p.head.label || p.head.ref}</code>
          {p.merged && p.mergedAt ? ` ${ago(p.mergedAt)}` : ` · opened ${ago(p.createdAt)}`}
        </span>
      </ItemHead>
      <Tabs<PullTab>
        value={view.tab}
        onChange={(tab) => nav.replace({ ...view, tab })}
        options={[
          { id: 'conversation', label: `Conversation${p.comments ? ` ${p.comments}` : ''}` },
          { id: 'commits', label: `Commits${commits !== null ? ` ${commits}` : ''}` },
          {
            id: 'files',
            label: (
              <>
                Files changed{p.changedFiles !== null ? ` ${p.changedFiles}` : ''}
                {p.additions !== null && <span className="git-add"> +{p.additions}</span>}
                {p.deletions !== null && <span className="git-del"> −{p.deletions}</span>}
              </>
            ),
          },
        ]}
      />
      <div className="git-body">
        {view.tab === 'conversation' && <Conversation item={p} host={host} web={new URL(repoWeb).origin} />}
        {view.tab === 'commits' && <PullCommits base={base} onOpen={(sha) => nav.go({ v: 'commit', src: view.src, owner: view.owner, repo: view.repo, sha })} />}
        {view.tab === 'files' && <PullFiles base={base} web={`${web}/files`} host={host} />}
      </div>
    </div>
  )
}

function PullCommits({ base, onOpen }: { base: string; onOpen: (sha: string) => void }) {
  const list = usePaged<GitCommitItem>(`${base}/commits`)
  return (
    <div>
      <CommitRows items={list.items} onOpen={onOpen} />
      {list.loading && !list.items.length ? <Loading what="commits" /> : <MoreButton next={list.next} loading={list.loading} error={list.error} onMore={list.more} />}
    </div>
  )
}

function PullFiles({ base, web, host }: { base: string; web: string; host: string }) {
  const files = useGet<GitFileList>(`${base}/files`)
  if (files.error) return <ErrorBox error={files.error} onRetry={files.reload} web={web} hostLabel={host} />
  if (!files.data) return <Loading what="changes" />
  return <DiffFiles files={files.data.files} truncated={files.data.truncated} web={web} hostLabel={host} />
}

export function IssueView({ view, nav }: { view: Extract<GitView, { v: 'issue' }>; nav: Nav }) {
  const issue = useGet<GitIssue>(`${repoApi(view)}/issues/${view.number}`)
  const host = nav.hostLabel(view.src)
  const repoWeb = nav.repoWeb(view)
  const web = issue.data?.url ?? `${repoWeb}/issues/${view.number}`
  // The issues API answers for pull requests too (GitHub numbers them together): show it as one.
  const isPull = !!issue.data?.pull
  useEffect(() => {
    if (isPull) nav.replace({ v: 'pull', src: view.src, owner: view.owner, repo: view.repo, number: view.number, tab: 'conversation' })
  }, [isPull, nav, view.src, view.owner, view.repo, view.number])
  if (issue.error) return <ErrorBox error={issue.error} onRetry={issue.reload} web={web} hostLabel={host} />
  if (!issue.data || isPull) return <Loading what={`issue #${view.number}`} />
  const i = issue.data
  return (
    <div className="git-view">
      <ItemHead item={i} host={host}>
        <span>
          <strong>{who(i.author)}</strong> opened this {ago(i.createdAt)}
          {i.comments !== null ? ` · ${i.comments} ${i.comments === 1 ? 'comment' : 'comments'}` : ''}
          {i.closedAt && i.state === 'closed' ? ` · closed ${ago(i.closedAt)}` : ''}
        </span>
      </ItemHead>
      <div className="git-body">
        <Conversation item={i} host={host} web={new URL(repoWeb).origin} />
      </div>
    </div>
  )
}

export function CommitView({ view, nav }: { view: Extract<GitView, { v: 'commit' }>; nav: Nav }) {
  const commit = useGet<GitCommit>(`${repoApi(view)}/commits/${view.sha}`)
  const host = nav.hostLabel(view.src)
  const web = commit.data?.url ?? `${nav.repoWeb(view)}/commit/${view.sha}`
  if (commit.error) return <ErrorBox error={commit.error} onRetry={commit.reload} web={web} hostLabel={host} />
  if (!commit.data) return <Loading what={`commit ${view.sha.slice(0, 7)}`} />
  const c = commit.data
  const [title, ...rest] = c.message.split('\n')
  const body = rest.join('\n').trim()
  return (
    <div className="git-view">
      <header className="git-head">
        <div className="git-head-main">
          <h2 className="git-title">{title}</h2>
          {body && <pre className="git-pre git-commit-body selectable">{body}</pre>}
          <p className="git-sub git-item-meta">
            <Avatar p={c.author} size={18} /> <strong>{who(c.author)}</strong> committed <span title={fullDate(c.date)}>{ago(c.date)}</span>
            {c.committer?.name && c.committer.name !== c.author.name ? <span> · committed by {c.committer.name}</span> : null}
          </p>
          <p className="git-sub git-item-meta">
            <CopyField value={c.sha} label="commit hash" />
            {c.parents.length > 0 && (
              <span className="git-parents">
                {c.parents.length > 1 ? 'Parents' : 'Parent'}{' '}
                {c.parents.map((sha) => (
                  <button key={sha} className="git-linkish" onClick={() => nav.go({ v: 'commit', src: view.src, owner: view.owner, repo: view.repo, sha })}>
                    <code>{sha.slice(0, 7)}</code>
                  </button>
                ))}
              </span>
            )}
          </p>
        </div>
        <div className="git-head-actions">
          <ExtLink href={web} label={`Open on ${host}`} />
        </div>
      </header>
      <div className="git-body">
        <DiffFiles files={c.files} truncated={c.filesTruncated} web={web} hostLabel={host} />
      </div>
    </div>
  )
}
