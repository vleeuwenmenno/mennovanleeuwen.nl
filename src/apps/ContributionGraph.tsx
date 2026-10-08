import { useEffect, useMemo, useRef, useState } from 'react'
import { countFor, levels, useContributions, type ContributionDay, type Source } from '../data/contributions'
import { timeAgo } from '../data/recents'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmt = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

export function ContributionGraph() {
  const data = useContributions()
  const [source, setSource] = useState<Source>('all')
  const [hover, setHover] = useState<{ day: ContributionDay; x: number; y: number } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLElement>(null)

  const weeks = useMemo(() => {
    const out: ContributionDay[][] = []
    for (const d of data?.days ?? []) {
      if (!out.length || new Date(`${d.date}T12:00:00`).getDay() === 0) out.push([])
      out[out.length - 1].push(d)
    }
    return out
  }, [data])

  const level = useMemo(() => levels(data?.days ?? [], source), [data, source])
  const total = (data?.days ?? []).reduce((a, d) => a + countFor(d, source), 0)
  const activeDays = (data?.days ?? []).filter((d) => countFor(d, source) > 0).length

  // Start scrolled to the most recent weeks on narrow windows.
  useEffect(() => {
    scroller.current?.scrollTo({ left: scroller.current.scrollWidth })
  }, [weeks.length])

  if (data === undefined) return <div className="contrib contrib-empty muted">Loading contributions…</div>
  if (data === null || !data.days.length) return null

  return (
    <section className="contrib" ref={root}>
      <header className="contrib-head">
        <p>
          <strong>{total.toLocaleString('en-GB')}</strong> contributions in the last year
          <span className="muted"> · {activeDays} active days</span>
        </p>
        <div className="seg seg-small">
          {(
            [
              ['all', 'Combined'],
              ['github', 'GitHub'],
              ['forgejo', 'git.mvl.sh'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={source === k ? 'is-active' : ''} onClick={() => setSource(k)}>
              {label}
            </button>
          ))}
        </div>
      </header>
      <div className="contrib-scroll" ref={scroller}>
        <div className="contrib-grid" onPointerLeave={() => setHover(null)}>
          <div className="contrib-months">
            {weeks.map((w, i) => {
              const first = w.find((d) => d.date.endsWith('-01') || (i === 0 && d === w[0]))
              const m = first ? new Date(`${first.date}T12:00:00`).getMonth() : -1
              return (
                <span key={i} className="contrib-month">
                  {m >= 0 && i < weeks.length - 2 ? MONTHS[m] : ''}
                </span>
              )
            })}
          </div>
          <div className="contrib-cols">
            {weeks.map((w, i) => (
              <div key={i} className="contrib-week" style={i === 0 ? { justifyContent: 'flex-end' } : undefined}>
                {w.map((d) => (
                  <span
                    key={d.date}
                    className={`contrib-day l${level(countFor(d, source))}`}
                    onPointerEnter={(e) => {
                      // Positioned inside the section: windows use backdrop-filter, which breaks position: fixed.
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      const o = root.current!.getBoundingClientRect()
                      setHover({ day: d, x: r.left + r.width / 2 - o.left, y: r.top - o.top })
                    }}
                    aria-label={`${fmt(d.date)}: ${countFor(d, source)} contributions`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <footer className="contrib-foot muted">
        <span>Updated {timeAgo(data.generatedAt)}</span>
        <span className="contrib-legend">
          Less
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className={`contrib-day l${l}`} />
          ))}
          More
        </span>
      </footer>
      {hover && (
        <div className="contrib-tip" style={{ left: hover.x, top: hover.y }}>
          <strong>{countFor(hover.day, source) || 'No'} contributions</strong> on {fmt(hover.day.date)}
          {source === 'all' && hover.day.github + hover.day.forgejo > 0 && (
            <span className="muted">
              {' '}
              · GitHub {hover.day.github}, git.mvl.sh {hover.day.forgejo}
            </span>
          )}
        </div>
      )}
    </section>
  )
}
