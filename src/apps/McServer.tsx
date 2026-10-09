import { useEffect, useRef, useState } from 'react'
import { MC_ADDRESS, MC_PORT, mcNotificationsOn, setMcNotifications, useMcOverview, useMinecraft, type McOverview, type McRange } from '../data/minecraft'
import { timeAgo } from '../data/recents'
import { useWM, type WinState } from '../os/wm'

// The Minecraft server in full: live status from the shared poller, and the history the site's
// server records (uptime, players over time, who played and for how long).

const head = (name: string, size: number) => `https://mc-heads.net/avatar/${encodeURIComponent(name)}/${size}`
const ago = (ms: number) => timeAgo(new Date(ms).toISOString())
const pct = (u: number | null) => (u === null ? '—' : `${u === 1 ? 100 : Math.min(99.9, Math.floor(u * 1000) / 10)}%`)

function duration(ms: number) {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'under a minute'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const RANGE_LABEL: Record<McRange, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' }

function bucketTime(ms: number, range: McRange) {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (range === '24h') return time
  if (range === '7d') return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function McServer({ win }: { win: WinState }) {
  const wm = useWM()
  const ref = useRef<HTMLDivElement>(null)
  // Brought to the front (from Spotlight, the top bar): take the keyboard, so arrows and Page Down
  // scroll it. Not while something else is being typed in.
  useEffect(() => {
    if (wm.focusedPid !== win.pid) return
    const active = document.activeElement
    if (active && active !== document.body && !active.closest('.window')) return
    ref.current?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid, win.props.t])
  const live = useMinecraft()
  const [range, setRange] = useState<McRange>('24h')
  const { data, missing } = useMcOverview(range)
  const [copied, setCopied] = useState(false)
  // Whichever answer is newer: the shared poller's or the overview's.
  const status = live.status && (!data || live.status.checkedAt >= data.status.checkedAt) ? live.status : (data?.status ?? null)
  const online = !!status?.online
  const latency = status?.latency ?? data?.latency ?? null

  const copy = () =>
    navigator.clipboard
      ?.writeText(MC_ADDRESS)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})

  const line = !status
    ? live.error
      ? `Could not check (${live.error})`
      : 'Checking…'
    : [
        online ? 'Online' : 'Offline',
        online && status.version && `Java ${status.version}`,
        online && latency !== null && `${latency} ms`,
        data?.stateSince && `${online ? 'up' : 'down'} for ${duration(Date.now() - data.stateSince)}`,
      ]
        .filter(Boolean)
        .join(' · ')

  return (
    <div className="mcs" ref={ref} tabIndex={-1}>
      <header className="mcs-head">
        {status?.icon ? <img src={status.icon} alt="" className="mc-icon" /> : <span className="mc-icon mc-icon-blank">⛏</span>}
        <div className="mcs-title">
          <h2>{status?.motd || 'Minecraft server'}</h2>
          <p className="muted">
            <span className={`live-dot ${online ? 'is-live' : status ? 'is-down' : ''}`} />
            {line}
          </p>
        </div>
        <div className="mc-addr mcs-addr">
          <code>{MC_ADDRESS}</code>
          <button className="btn btn-small" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy address'}
          </button>
        </div>
      </header>

      <div className="mcs-stats">
        <Stat label="Players" value={status ? (online ? `${status.players.online}/${status.players.max}` : '—') : '…'} />
        <Stat label="Uptime, 24 hours" value={pct(data?.uptime.day ?? null)} />
        <Stat label="Uptime, 7 days" value={pct(data?.uptime.week ?? null)} />
        <Stat label="Peak, 30 days" value={data?.peak ? String(data.peak.players) : '—'} sub={data?.peak ? bucketTime(data.peak.at, '30d') : undefined} />
      </div>

      {missing ? (
        <p className="mcs-note muted">History needs the site's own server, which pings the Minecraft server every 30 seconds. This copy of the site runs without it, so only the live status shows.</p>
      ) : (
        <section className="mcs-card">
          <div className="mcs-card-head">
            <h3>Players, last {RANGE_LABEL[range]}</h3>
            <div className="seg seg-small" role="tablist">
              {(Object.keys(RANGE_LABEL) as McRange[]).map((r) => (
                <button key={r} role="tab" aria-selected={r === range} className={r === range ? 'is-active' : ''} onClick={() => setRange(r)}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          {data && data.range === range ? <PlayerChart data={data} /> : <div className="mcs-chart-empty muted">Loading…</div>}
        </section>
      )}

      <div className="mcs-cols">
        <section>
          <h3>On now</h3>
          <OnNow status={status} data={data} />
          {data && data.recent.length > 0 && (
            <>
              <h3>Recently</h3>
              <ul className="mcs-people">
                {data.recent.map((s) => (
                  <li key={`${s.name}-${s.joinedAt}`}>
                    <img src={head(s.name, 16)} alt="" width={16} height={16} />
                    <span>{s.name}</span>
                    <span className="muted">
                      played {duration(s.leftAt! - s.joinedAt)} · {ago(s.leftAt!)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        {data && (
          <section>
            <h3>Most played, 30 days</h3>
            {data.top.length ? (
              <ol className="mcs-people mcs-top">
                {data.top.map((p) => (
                  <li key={p.name}>
                    <img src={head(p.name, 16)} alt="" width={16} height={16} />
                    <span>{p.name}</span>
                    <span className="muted">
                      {p.lastSeen === null && <span className="t-green">on now · </span>}
                      {duration(p.ms)} · {p.visits} {p.visits === 1 ? 'visit' : 'visits'}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mc-empty">Nobody has played since tracking began.</p>
            )}
          </section>
        )}
      </div>

      <footer className="mc-foot muted mcs-foot">
        <label className="mc-notify">
          <input type="checkbox" checked={mcNotificationsOn()} onChange={(e) => setMcNotifications(e.target.checked)} />
          Notify me when players join or leave
        </label>
        <span>
          Port {MC_PORT}
          {data?.trackedSince ? ` · history since ${new Date(data.trackedSince).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}
          {status ? ` · checked ${ago(status.checkedAt)}` : ''}
        </span>
      </footer>
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="mcs-stat">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
      {sub && <span className="muted">{sub}</span>}
    </div>
  )
}

function OnNow({ status, data }: { status: ReturnType<typeof useMinecraft>['status']; data: McOverview | null }) {
  if (!status?.online) return <p className="mc-empty">{status ? 'The server is offline.' : 'Checking…'}</p>
  const since = new Map(data?.online.map((p) => [p.name, p.since]))
  const names = status.players.list
  if (!names.length)
    return <p className="mc-empty">{status.players.online ? `${status.players.online} on, but the server keeps their names to itself.` : "Nobody's mining right now."}</p>
  return (
    <ul className="mcs-people">
      {names.map((n) => (
        <li key={n}>
          <img src={head(n, 16)} alt="" width={16} height={16} />
          <span>{n}</span>
          {since.has(n) && <span className="muted">for {duration(Date.now() - since.get(n)!)}</span>}
        </li>
      ))}
    </ul>
  )
}

/** Most players at once per bucket, with the server's availability as a strip underneath. */
function PlayerChart({ data }: { data: McOverview }) {
  const [hover, setHover] = useState<number | null>(null)
  const { buckets, range } = data
  const top = Math.max(2, ...buckets.map((b) => b.peak ?? 0))
  if (!data.tracking) return <div className="mcs-chart-empty muted">History starts now: the server is pinged every 30 seconds.</div>
  const h = hover === null ? null : buckets[hover]
  const upLabel = (u: number | null) => (u === null ? 'no data' : u === 1 ? 'up' : u === 0 ? 'down' : `up ${pct(u)}`)
  const upClass = (u: number | null) => (u === null ? 'is-none' : u === 1 ? 'is-up' : u === 0 ? 'is-down' : 'is-partial')
  return (
    <div className="mcs-chart" onPointerLeave={() => setHover(null)}>
      <div className="mcs-plot">
        <span className="mcs-axis mcs-axis-top">{top}</span>
        <span className="mcs-axis mcs-axis-zero">0</span>
        <div className="mcs-bars">
          {buckets.map((b, i) => (
            <div key={b.from} className={`mcs-col ${hover === i ? 'is-hover' : ''}`} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
              {b.peak !== null && b.peak > 0 && <span className="mcs-bar" style={{ height: `${(b.peak / top) * 100}%` }} />}
            </div>
          ))}
        </div>
        <div className="mcs-strip" aria-hidden>
          {buckets.map((b, i) => (
            <span key={b.from} className={`${upClass(b.uptime)} ${hover === i ? 'is-hover' : ''}`} onPointerEnter={() => setHover(i)} />
          ))}
        </div>
        {h && hover !== null && (
          <div className="mcs-tip" style={{ left: `${((hover + 0.5) / buckets.length) * 100}%` }} data-side={hover > buckets.length / 2 ? 'left' : 'right'}>
            <strong>
              {bucketTime(h.from, range)} – {bucketTime(h.to, range)}
            </strong>
            <span>{h.peak === null ? 'Not recorded' : `${h.peak} at most · ${h.avg} on average`}</span>
            <span className="muted">Server {upLabel(h.uptime)}</span>
          </div>
        )}
      </div>
      <div className="mcs-x muted">
        <span>{bucketTime(buckets[0].from, range)}</span>
        <span className="mcs-legend">
          <i className="is-up" /> up <i className="is-partial" /> partly down <i className="is-down" /> down <i className="is-none" /> no data
        </span>
        <span>now</span>
      </div>
    </div>
  )
}
