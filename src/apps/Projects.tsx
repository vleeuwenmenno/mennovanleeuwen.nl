import { useEffect, useState } from 'react'
import { contributions, projects, type Contribution, type Project } from '../data/profile'
import { fetchStars, timeAgo, useRecents } from '../data/recents'
import { useWM, type WinState } from '../os/wm'

type Item = { kind: 'project'; data: Project } | { kind: 'contrib'; data: Contribution }

const all: Item[] = [...projects.map((data) => ({ kind: 'project' as const, data })), ...contributions.map((data) => ({ kind: 'contrib' as const, data }))]

function Stars({ repo }: { repo?: string }) {
  const [n, setN] = useState<number | null>(null)
  useEffect(() => {
    if (repo) fetchStars(repo).then(setN)
  }, [repo])
  if (!repo || n === null) return null
  return <span className="chip chip-star">★ {n}</span>
}

function Detail({ item, onBack }: { item: Item; onBack: () => void }) {
  const wm = useWM()
  const recents = useRecents()
  const d = item.data
  const repoKey = item.kind === 'project' ? d.github ?? (d.slug === 'pepper' ? 'pepper/' : undefined) : d.github
  const activity = repoKey ? recents.items.filter((a) => a.repo.startsWith(repoKey)).slice(0, 5) : []
  const accent = item.data.accent

  return (
    <article className="detail" style={{ ['--p' as string]: accent }}>
      <button className="back" onClick={onBack}>
        ← All
      </button>
      <header className="detail-head">
        <span className="detail-mark">{d.name[0]}</span>
        <div>
          <h2>{d.name}</h2>
          <p className="muted">{item.kind === 'project' ? item.data.tagline : `Contributor · ${item.data.owner}/${item.data.slug}`}</p>
        </div>
      </header>
      <div className="chips">
        {item.kind === 'project' ? (
          <>
            <span className="chip chip-status">{item.data.status}</span>
            {item.data.stack.map((s) => (
              <span key={s} className="chip">
                {s}
              </span>
            ))}
          </>
        ) : (
          <span className="chip chip-status">Contributor</span>
        )}
        <Stars repo={d.github} />
      </div>
      <p>{d.description}</p>
      <h3>{item.kind === 'project' ? 'Highlights' : 'What I worked on'}</h3>
      <ul className="ticks">
        {(item.kind === 'project' ? item.data.highlights : item.data.work).map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
      <div className="actions">
        {d.url && (
          <a className="btn btn-primary" href={d.url} target="_blank" rel="noopener noreferrer">
            Visit site ↗
          </a>
        )}
        {d.repo && (
          <a className="btn" href={d.repo} target="_blank" rel="noopener noreferrer">
            Source ↗
          </a>
        )}
        <button className="btn btn-ghost" onClick={() => wm.open('terminal', { run: `cat ~/${item.kind === 'project' ? 'projects' : 'contributions'}/${d.slug}/README.md` })}>
          Open in terminal
        </button>
      </div>
      {activity.length > 0 && (
        <>
          <h3>Recent activity</h3>
          <ul className="mini-feed">
            {activity.map((a) => (
              <li key={a.id}>
                <a href={a.url} target="_blank" rel="noopener noreferrer">
                  {a.title}
                </a>
                {a.detail && <span className="muted"> · {a.detail}</span>}
                <time className="muted">{timeAgo(a.date)}</time>
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  )
}

export function Projects({ win }: { win: WinState }) {
  const [section, setSection] = useState<'all' | 'project' | 'contrib'>('all')
  const [slug, setSlug] = useState<string | undefined>(win.props.slug)

  useEffect(() => setSlug(win.props.slug), [win.props])

  const selected = all.find((i) => i.data.slug === slug)
  const list = all.filter((i) => section === 'all' || i.kind === section)

  return (
    <div className="files">
      <nav className="files-side">
        <p className="side-label">Places</p>
        {(
          [
            ['all', 'Everything', all.length],
            ['project', 'My projects', projects.length],
            ['contrib', 'Contributions', contributions.length],
          ] as const
        ).map(([key, label, n]) => (
          <button
            key={key}
            className={`side-item ${section === key && !selected ? 'is-active' : ''}`}
            onClick={() => {
              setSection(key)
              setSlug(undefined)
            }}
          >
            {label}
            <span className="muted">{n}</span>
          </button>
        ))}
        <p className="side-label">Open</p>
        {all.map((i) => (
          <button key={i.data.slug} className={`side-item side-sub ${slug === i.data.slug ? 'is-active' : ''}`} onClick={() => setSlug(i.data.slug)}>
            <span className="dot" style={{ background: i.data.accent }} />
            {i.data.name}
          </button>
        ))}
      </nav>
      <div className="files-main">
        {selected ? (
          <Detail item={selected} onBack={() => setSlug(undefined)} />
        ) : (
          <>
            <p className="path muted">~/{section === 'contrib' ? 'contributions' : section === 'project' ? 'projects' : ''}</p>
            <div className="grid">
              {list.map((i) => (
                <button key={i.data.slug} className="card" style={{ ['--p' as string]: i.data.accent }} onClick={() => setSlug(i.data.slug)}>
                  <span className="card-top">
                    <span className="card-mark">{i.data.name[0]}</span>
                    <span className="card-kind">{i.kind === 'project' ? i.data.status : `with ${i.data.owner}`}</span>
                  </span>
                  <strong>{i.data.name}</strong>
                  <span className="muted card-desc">{i.kind === 'project' ? i.data.tagline : i.data.description}</span>
                  {i.kind === 'project' && <span className="card-stack">{i.data.stack.join(' · ')}</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
