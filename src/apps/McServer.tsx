import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { MC_ADDRESS, MC_PORT, mcAdmin, mcAdminInfo, mcNotificationsOn, setMcNotifications, useMcOverview, useMinecraft, worldLine, type McAdminRequest, type McAdminResult, type McOverview, type McPlayerInfo, type McRange } from '../data/minecraft'
import { timeAgo } from '../data/recents'
import { useAccount } from '../os/account'
import { ask } from '../os/Dialogs'
import { useWM, type WinState } from '../os/wm'

// The Minecraft server in full: live status from the shared poller, and the history the site's
// server records (uptime, players over time, who played and for how long). With RCON set up on the
// site's server, also the world's clock and where each player is; and for admins, a console.

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

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

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
  const admin = useAccount().user?.admin === true
  const rconLog = useConsole()
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
        online && status.world && worldLine(status.world),
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
        {online && status.world && <Stat label="World" value={`Day ${status.world.day}`} sub={`${worldLine(status.world).split(' ')[0]} ${status.world.clock} · ${status.world.phase}`} />}
        {online && status.settings && (
          <Stat
            label="Difficulty"
            value={status.settings.difficulty ?? '—'}
            sub={[status.settings.software, status.settings.border && `border ${status.settings.border.toLocaleString()} wide`].filter(Boolean).join(' · ') || undefined}
          />
        )}
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
          <OnNow status={status} data={data} run={admin ? rconLog.run : null} />
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

      {admin && <AdminPanel log={rconLog} />}

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

const DIMENSION: Record<string, string> = { overworld: 'Overworld', nether: 'Nether', end: 'End' }

/** Where a player is: a small coloured chip (green Overworld, red Nether, purple End, grey otherwise). */
function Dimension({ id }: { id: string }) {
  const known = Object.hasOwn(DIMENSION, id)
  return <span className={`mcs-dim is-${known ? id : 'other'}`}>{known ? DIMENSION[id] : id.replace(/_/g, ' ')}</span>
}

/** "Lv 30 · ♥ 10/10": hearts are two health points each. */
function vitals(info: McPlayerInfo | undefined) {
  if (!info) return null
  const parts = [info.level !== undefined && `Lv ${info.level}`, info.health !== undefined && `♥ ${Math.round(info.health) / 2}/10`].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

function OnNow({ status, data, run }: { status: ReturnType<typeof useMinecraft>['status']; data: McOverview | null; run: Console['run'] | null }) {
  const [acting, setActing] = useState<{ name: string; kind: 'tell' | 'kick' } | null>(null)
  const [text, setText] = useState('')
  if (!status?.online) return <p className="mc-empty">{status ? 'The server is offline.' : 'Checking…'}</p>
  const since = new Map(data?.online.map((p) => [p.name, p.since]))
  const names = status.players.list
  if (!names.length)
    return <p className="mc-empty">{status.players.online ? `${status.players.online} on, but the server keeps their names to itself.` : "Nobody's mining right now."}</p>
  const start = (name: string, kind: 'tell' | 'kick') => {
    setActing(acting?.name === name && acting.kind === kind ? null : { name, kind })
    setText('')
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!acting || !run) return
    if (acting.kind === 'tell' && !text.trim()) return
    void run(acting.kind === 'tell' ? { action: 'tell', name: acting.name, text } : { action: 'kick', name: acting.name, reason: text || undefined })
    setActing(null)
  }
  return (
    <ul className="mcs-people">
      {names.map((n) => {
        const info = status.playerInfo?.[n]
        const v = vitals(info)
        return (
          <li key={n} className={run ? 'mcs-person-admin' : undefined}>
            <img src={head(n, 16)} alt="" width={16} height={16} />
            <span>{n}</span>
            {info?.dimension && <Dimension id={info.dimension} />}
            <span className="muted">
              {v && <span className="mcs-vitals">{v}</span>}
              {v && since.has(n) && ' · '}
              {since.has(n) && `for ${duration(Date.now() - since.get(n)!)}`}
            </span>
            {run && (
              <span className="mcs-acts">
                <button className={acting?.name === n && acting.kind === 'tell' ? 'is-active' : ''} onClick={() => start(n, 'tell')} title={`Send ${n} a private message`}>
                  Message
                </button>
                <button className={acting?.name === n && acting.kind === 'kick' ? 'is-active' : ''} onClick={() => start(n, 'kick')} title={`Kick ${n} off the server`}>
                  Kick
                </button>
              </span>
            )}
            {run && acting?.name === n && (
              <form className="mcs-act-form" onSubmit={submit}>
                <input
                  className="mcs-input"
                  autoFocus
                  value={text}
                  maxLength={acting.kind === 'tell' ? 200 : 100}
                  placeholder={acting.kind === 'tell' ? `Message to ${n}` : 'Reason (optional)'}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setActing(null)}
                />
                <button className={`btn btn-small ${acting.kind === 'kick' ? 'btn-danger' : 'btn-primary'}`} type="submit">
                  {acting.kind === 'tell' ? 'Send' : `Kick ${n}`}
                </button>
              </form>
            )}
          </li>
        )
      })}
      {status.players.online > names.length && (
        <li className="muted">
          and {status.players.online - names.length} more who {status.players.online - names.length === 1 ? 'keeps their name' : 'keep their names'} hidden
        </li>
      )}
    </ul>
  )
}

/**
 * Most players at once per bucket, with the server's availability as a strip underneath. A bucket
 * someone joined in gets a mark on top of its bar: their head where the bar is wide enough, a dot
 * where it isn't. Hovering (or tapping, on a touch screen) shows who was on.
 */
function PlayerChart({ data }: { data: McOverview }) {
  const [hover, setHover] = useState<number | null>(null)
  const chart = useRef<HTMLDivElement>(null)
  const { buckets, range } = data
  // A tap leaves the tip open (a finger has no hover to end): a tap anywhere else closes it.
  useEffect(() => {
    if (hover === null) return
    const away = (e: PointerEvent) => !chart.current?.contains(e.target as Node) && setHover(null)
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [hover])
  const top = Math.max(2, ...buckets.map((b) => b.peak ?? 0))
  if (!data.tracking) return <div className="mcs-chart-empty muted">History starts now: the server is pinged every 30 seconds.</div>
  const h = hover === null ? null : buckets[hover]
  const upLabel = (u: number | null) => (u === null ? 'no data' : u === 1 ? 'up' : u === 0 ? 'down' : `up ${pct(u)}`)
  const upClass = (u: number | null) => (u === null ? 'is-none' : u === 1 ? 'is-up' : u === 0 ? 'is-down' : 'is-partial')
  return (
    <div className="mcs-chart" ref={chart} onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(null)}>
      <div className="mcs-plot">
        <span className="mcs-axis mcs-axis-top">{top}</span>
        <span className="mcs-axis mcs-axis-zero">0</span>
        <div className="mcs-bars">
          {buckets.map((b, i) => {
            const height = b.peak !== null && b.peak > 0 ? (b.peak / top) * 100 : 0
            const joiner = b.players?.find((p) => p.joined !== undefined)
            return (
              <div key={b.from} className={`mcs-col ${hover === i ? 'is-hover' : ''}`} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
                {height > 0 && <span className="mcs-bar" style={{ height: `${height}%` }} />}
                {joiner && (
                  <span className="mcs-mark" style={{ bottom: `calc(${height}% + 3px)` }} aria-hidden>
                    <img src={head(joiner.name, 16)} alt="" width={12} height={12} />
                    <i />
                  </span>
                )}
              </div>
            )
          })}
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
            {h.players && h.players.length > 0 && (
              <ul className="mcs-tip-people">
                {h.players.map((p) => (
                  <li key={p.name}>
                    <img src={head(p.name, 16)} alt="" width={16} height={16} />
                    <span>{p.name}</span>
                    <span className="muted">
                      {p.joined !== undefined && <span className="t-green">→ joined {clock(p.joined)}</span>}
                      {p.joined !== undefined && p.left !== undefined && ' · '}
                      {p.left !== undefined && `← left ${clock(p.left)}`}
                    </span>
                  </li>
                ))}
                {!!h.more && <li className="muted">and {h.more} more</li>}
              </ul>
            )}
          </div>
        )}
      </div>
      <div className="mcs-x muted">
        <span>{bucketTime(buckets[0].from, range)}</span>
        <span className="mcs-legend">
          <i className="is-up" /> up <i className="is-partial" /> partly down <i className="is-down" /> down <i className="is-none" /> no data
          <b className="mcs-legend-join" /> someone joined
        </span>
        <span>now</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// The RCON panel, for admins only: the server refuses everyone else (server/minecraft.ts), and
// the panel isn't shown to them. Quick actions and the console share one scrollback.

type Line = { id: number; kind: 'in' | 'out' | 'err'; text: string }
type Console = { log: Line[]; busy: boolean; run: (req: McAdminRequest) => Promise<McAdminResult | null>; clear: () => void }

let lineId = 0
function useConsole(): Console {
  const [log, setLog] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const run = useCallback(async (req: McAdminRequest) => {
    const add = (kind: Line['kind'], text: string) => setLog((l) => [...l.slice(-199), { id: ++lineId, kind, text }])
    setBusy(true)
    try {
      const res = await mcAdmin(req)
      add('in', res.command)
      if (res.output) add('out', res.output)
      return res
    } catch (e) {
      add('err', (e as Error).message)
      return null
    } finally {
      setBusy(false)
    }
  }, [])
  return { log, busy, run, clear: () => setLog([]) }
}

/** Commands that are hard to take back: asked about in a dialog before they are sent. */
const RISKY: { test: RegExp; why: string }[] = [
  { test: /^(stop|restart)\b/, why: 'This shuts the server down for everyone.' },
  { test: /^(ban|ban-ip)\b/, why: 'This bans a player (or an address) until pardoned.' },
  { test: /^(op|deop)\b/, why: 'This changes who has operator rights.' },
  { test: /^whitelist\s+off\b/, why: 'This lets anyone join the server.' },
  { test: /^kill\s+@[ae]\b/, why: 'This kills every player (or every entity) in the world.' },
  { test: /^kick\s+@a\b/, why: 'This kicks everyone off the server.' },
]

function AdminPanel({ log }: { log: Console }) {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [say, setSay] = useState('')
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [back, setBack] = useState(-1)
  const [whitelist, setWhitelist] = useState<string[] | null>(null)
  const [add, setAdd] = useState('')
  const scroll = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    mcAdminInfo().then(
      (r) => setConfigured(r.configured),
      (e: Error) => setError(e.message),
    )
  }, [])
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight })
  }, [log.log])

  const listWhitelist = async () => {
    const r = await log.run({ action: 'whitelist', op: 'list' })
    if (r?.whitelist) setWhitelist(r.whitelist)
  }
  const changeWhitelist = async (op: 'add' | 'remove', name: string) => {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return setError(`“${name}” isn't a Minecraft name (3 to 16 letters, digits or _)`)
    setError(null)
    if (await log.run({ action: 'whitelist', op, name })) {
      if (op === 'add') setAdd('')
      await listWhitelist()
    }
  }
  const submitSay = async (e: FormEvent) => {
    e.preventDefault()
    if (!say.trim()) return
    if (await log.run({ action: 'say', text: say })) setSay('')
  }
  const submitCommand = async (e: FormEvent) => {
    e.preventDefault()
    const cmd = command.trim().replace(/^\//, '')
    if (!cmd) return
    const risky = RISKY.find((r) => r.test.test(cmd.toLowerCase()))
    if (risky && !(await ask({ title: `Run “${cmd}”?`, body: risky.why, confirm: 'Run it', danger: true }))) return
    setHistory((h) => [...h.filter((c) => c !== cmd), cmd].slice(-50))
    setBack(-1)
    setCommand('')
    await log.run({ action: 'command', command: cmd })
    input.current?.focus()
  }
  // ↑ and ↓ walk back through this session's commands, like a shell.
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    if (!history.length) return
    const next = e.key === 'ArrowUp' ? (back < 0 ? history.length - 1 : Math.max(0, back - 1)) : back < 0 ? -1 : back + 1
    if (next < 0 || next >= history.length) {
      setBack(-1)
      setCommand('')
    } else {
      setBack(next)
      setCommand(history[next])
    }
  }

  return (
    <section className="mcs-card mcs-admin">
      <div className="mcs-card-head">
        <h3>Server console</h3>
        <span className="muted">admins only · over RCON</span>
      </div>
      {configured === false ? (
        <p className="mcs-note muted">RCON isn't set up on the site's server: set MC_RCON (host:port) and MC_RCON_PASSWORD to use the console.</p>
      ) : (
        <>
          <form className="mcs-row" onSubmit={submitSay}>
            <input className="mcs-input" value={say} maxLength={200} placeholder="Say something to everyone on the server" onChange={(e) => setSay(e.target.value)} aria-label="Chat message" />
            <button className="btn btn-small" type="submit" disabled={log.busy || !say.trim()}>
              Say
            </button>
          </form>
          <div className="mcs-row mcs-wl">
            <button className="btn btn-small" onClick={listWhitelist} disabled={log.busy}>
              {whitelist ? 'Refresh whitelist' : 'Show whitelist'}
            </button>
            {whitelist &&
              (whitelist.length ? (
                whitelist.map((n) => (
                  <span key={n} className="chip mcs-wl-name">
                    <img src={head(n, 16)} alt="" width={12} height={12} />
                    {n}
                    <button title={`Take ${n} off the whitelist`} aria-label={`Take ${n} off the whitelist`} onClick={() => changeWhitelist('remove', n)} disabled={log.busy}>
                      ×
                    </button>
                  </span>
                ))
              ) : (
                <span className="muted">Nobody on the whitelist.</span>
              ))}
            {whitelist && (
              <form
                className="mcs-wl-add"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (add.trim()) void changeWhitelist('add', add.trim())
                }}
              >
                <input className="mcs-input" value={add} maxLength={16} placeholder="Add a player" onChange={(e) => setAdd(e.target.value)} aria-label="Player to add to the whitelist" />
                <button className="btn btn-small" type="submit" disabled={log.busy || !add.trim()}>
                  Add
                </button>
              </form>
            )}
          </div>
          {error && <p className="mcs-err">{error}</p>}
          <div className="mcs-console" ref={scroll} onClick={() => input.current?.focus()}>
            {log.log.length === 0 && <div className="muted">Commands typed here go straight to the server, as if typed in its console. ↑ goes back through them.</div>}
            {log.log.map((l) => (
              <div key={l.id} className={`mcs-line is-${l.kind}`}>
                {l.kind === 'in' ? `> ${l.text}` : l.text}
              </div>
            ))}
          </div>
          <form className="mcs-console-input" onSubmit={submitCommand}>
            <span aria-hidden>&gt;</span>
            <input ref={input} value={command} maxLength={256} spellCheck={false} autoComplete="off" placeholder="time query day" onChange={(e) => setCommand(e.target.value)} onKeyDown={keys} aria-label="Server command" />
            {log.log.length > 0 && (
              <button type="button" className="mc-refresh" onClick={log.clear}>
                Clear
              </button>
            )}
          </form>
        </>
      )}
    </section>
  )
}
