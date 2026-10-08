import { useMemo, useState } from 'react'
import { timeAgo, useRecents, type Activity } from '../data/recents'
import { ContributionGraph } from './ContributionGraph'

const KIND_LABEL: Record<Activity['kind'], string> = {
  push: 'Push',
  pr: 'Pull request',
  merge: 'Merged',
  issue: 'Issue',
  release: 'Release',
  create: 'Created',
  star: 'Starred',
  comment: 'Comment',
  fork: 'Fork',
}

function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(Date.now() - 864e5)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}

export function Recents() {
  const { items, status, live, snapshotAt } = useRecents()
  const [repo, setRepo] = useState<string>('all')
  const [kind, setKind] = useState<'all' | 'release' | 'code' | 'issues'>('all')

  const repos = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of items) {
      const key = i.repo.startsWith('pepper/') ? 'pepper/*' : i.repo
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [items])

  const filtered = items.filter((i) => {
    if (repo !== 'all' && (repo === 'pepper/*' ? !i.repo.startsWith('pepper/') : i.repo !== repo)) return false
    if (kind === 'release') return i.kind === 'release'
    if (kind === 'code') return ['push', 'pr', 'merge', 'create'].includes(i.kind)
    if (kind === 'issues') return ['issue', 'comment'].includes(i.kind)
    return true
  })

  const groups: [string, Activity[]][] = []
  for (const i of filtered.slice(0, 80)) {
    const label = dayLabel(i.date)
    if (groups.length && groups[groups.length - 1][0] === label) groups[groups.length - 1][1].push(i)
    else groups.push([label, [i]])
  }

  return (
    <div className="recents">
      <header className="recents-head">
        <div>
          <h2>Activity</h2>
          <p className="muted">
            <span className={`live-dot ${live ? 'is-live' : ''}`} />
            {live ? 'Live from GitHub' : status === 'loading' ? 'Connecting…' : 'Snapshot'}
            {snapshotAt && <> · git.mvl.sh synced {timeAgo(snapshotAt)}</>}
          </p>
        </div>
        <div className="seg">
          {(['all', 'code', 'release', 'issues'] as const).map((k) => (
            <button key={k} className={kind === k ? 'is-active' : ''} onClick={() => setKind(k)}>
              {k === 'all' ? 'All' : k === 'code' ? 'Code' : k === 'release' ? 'Releases' : 'Issues'}
            </button>
          ))}
        </div>
      </header>
      <ContributionGraph />
      <div className="repo-filter">
        <button className={`chip ${repo === 'all' ? 'is-active' : ''}`} onClick={() => setRepo('all')}>
          everything
        </button>
        {repos.map(([r, n]) => (
          <button key={r} className={`chip ${repo === r ? 'is-active' : ''}`} onClick={() => setRepo(r)}>
            {r.split('/')[1] === '*' ? 'pepper' : repos.filter(([x]) => x.split('/')[1] === r.split('/')[1]).length > 1 ? r : r.split('/')[1]} <span className="muted">{n}</span>
          </button>
        ))}
      </div>
      <div className="timeline">
        {status === 'loading' && !items.length && <p className="muted pad">Fetching activity…</p>}
        {status === 'error' && !items.length && <p className="muted pad">GitHub is not answering right now (rate limit?). Try again in a bit.</p>}
        {groups.map(([label, list]) => (
          <section key={label}>
            <h3 className="day">{label}</h3>
            <ul>
              {list.map((i) => (
                <li key={i.id} className={`ev ev-${i.kind}`}>
                  <span className="ev-dot" />
                  <div className="ev-body">
                    <a href={i.url} target="_blank" rel="noopener noreferrer" className="ev-title">
                      {i.title}
                    </a>
                    {i.detail && <p className="ev-detail">{i.detail}</p>}
                    <p className="ev-meta">
                      <span className="tag">{KIND_LABEL[i.kind]}</span>
                      <span>{i.repo}</span>
                      <span className="src">{i.source === 'forgejo' ? 'git.mvl.sh' : 'GitHub'}</span>
                      <time dateTime={i.date} title={new Date(i.date).toLocaleString()}>
                        {timeAgo(i.date)}
                      </time>
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
