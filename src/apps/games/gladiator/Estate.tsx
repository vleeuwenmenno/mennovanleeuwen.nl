import { rules, type Save } from './career'
import {
  collectJobs, JOBS, jobsAt, MAX_SITE_LEVEL, marketPrice, prettyHours, resource, RESOURCES, SITES, slotsAt, speedAt, startJob, stockLeft, today, trade, upgradeCost, upgradeSite, yieldAt,
  type Estate, type ResId, type SiteId,
} from './estate'
import { BagView, CardIcon, Gold, PageHead, PlaceIcon, Storehouse, useNow } from './ui'

// The estate (work sites running jobs on real time, levelled with gold and materials) and the
// market (materials for gold, prices moving day to day, rare ones in short supply).

type Update = (fn: (s: Save) => Save) => void
type Sfx = { coins: () => void; ui: () => void; fanfare: () => void }

const range = ([lo, hi]: [number, number], level: number) => {
  const a = Math.round(lo * yieldAt(level))
  const b = Math.round(hi * yieldAt(level))
  return a === b ? `${a}` : `${a}–${b}`
}

export function EstateScreen({ save, update, onBack, sound }: { save: Save; update: Update; onBack: () => void; sound: Sfx }) {
  const now = useNow(1000)
  const e = save.estate
  const ready = e.jobs.filter((j) => j.end <= now)
  const setEstate = (fn: (e: Estate) => Estate) => update((s) => ({ ...s, estate: fn(s.estate) }))
  const collect = () => {
    sound.coins()
    setEstate((x) => collectJobs(x, Date.now()).estate)
  }
  return (
    <div className="gl-page gl-shop">
      <PageHead title="Estate" onBack={onBack}>
        {ready.length > 0 && (
          <button className="gl-btn is-primary" onClick={collect}>
            Collect {ready.length} finished {ready.length === 1 ? 'job' : 'jobs'}
          </button>
        )}
        <span className="gl-coin-badge">
          <Gold n={save.gold} />
        </span>
      </PageHead>
      <Storehouse estate={e} />
      <p className="gl-blurb">Jobs run while you're away, even with the game closed. Start them, go fight (or sleep), and collect when you're back.</p>
      <section className="gl-cards gl-sites">
        {SITES.map((st) => {
          const level = e.levels[st.id]
          const running = jobsAt(e, st.id)
          const free = slotsAt(level) - running.length
          const next = level < MAX_SITE_LEVEL ? upgradeCost(level) : null
          const { coins: upCoins, ...upBag } = next ?? { coins: 0 }
          const canUp = !!next && save.gold >= upCoins && (Object.keys(upBag) as ResId[]).every((k) => (e.res[k] ?? 0) >= (upBag[k as ResId] ?? 0))
          const jobs = JOBS.filter((j) => j.site === st.id)
          return (
            <div key={st.id} className="gl-card gl-site">
              <span className="gl-card-ribbon">
                Level {level}
                {level >= MAX_SITE_LEVEL ? ' · max' : ''}
              </span>
              <CardIcon id={`site-${st.id}`} glyph={st.glyph} colour="#e8b35a" />
              <div className="gl-card-body">
                <strong>{st.name}</strong>
                <span className="gl-muted">{st.text}</span>
                <div className="gl-chips">
                  <span className="gl-chip">
                    {slotsAt(level)} {st.id === 'workshop' ? (slotsAt(level) === 1 ? 'bench' : 'benches') : slotsAt(level) === 1 ? 'crew' : 'crews'}
                  </span>
                  {st.id !== 'workshop' && level > 1 && <span className="gl-chip is-up">+{Math.round((yieldAt(level) - 1) * 100)}% yield</span>}
                  {level > 1 && <span className="gl-chip is-up">{Math.round((1 - speedAt(level)) * 100)}% faster</span>}
                </div>
                {running.map((j) => {
                  const d = JOBS.find((x) => x.id === j.job)!
                  const done = j.end <= now
                  const pct = Math.min(100, ((now - j.start) / (j.end - j.start)) * 100)
                  return (
                    <div key={j.id} className={`gl-job is-running ${done ? 'is-done' : ''}`}>
                      <div className="gl-job-head">
                        <strong>{d.name}</strong>
                        <span>{done ? 'Done!' : prettyHours(j.end - now)}</span>
                      </div>
                      <div className="gl-statbar">
                        <span style={{ width: `${pct}%` }} />
                      </div>
                      <BagView bag={j.gives} />
                    </div>
                  )
                })}
                {st.id === 'workshop' ? (
                  <span className="gl-muted gl-fine">Forge gear at the Forge and the Armoury; this sets how many pieces at once and how fast.</span>
                ) : (
                  <div className="gl-joblist">
                    {jobs.map((d) => {
                      const locked = level < d.level
                      const affordable = !d.costs || (Object.keys(d.costs) as ResId[]).every((k) => (e.res[k] ?? 0) >= (d.costs![k] ?? 0))
                      return (
                        <button
                          key={d.id}
                          className="gl-job"
                          disabled={locked || free <= 0 || !affordable}
                          title={locked ? `Needs ${st.name} level ${d.level}` : free <= 0 ? 'Every crew is busy' : !affordable ? 'Not enough materials' : undefined}
                          onClick={() => {
                            sound.ui()
                            setEstate((x) => startJob(x, d.id, Date.now()))
                          }}
                        >
                          <div className="gl-job-head">
                            <strong>{d.name}</strong>
                            <span>{locked ? `🔒 level ${d.level}` : prettyHours(d.hours * 3600_000 * speedAt(level))}</span>
                          </div>
                          <span className="gl-bag">
                            {(Object.entries(d.gives) as [ResId, [number, number]][]).map(([k, r]) => (
                              <span key={k} className="gl-res">
                                <PlaceIcon id={`res-${k}`} glyph={resource(k).glyph} />
                                <b>{range(r, level)}</b>
                              </span>
                            ))}
                            {d.costs && (
                              <span className="gl-muted">
                                {' '}
                                uses <BagView bag={d.costs} />
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
              <div className="gl-card-foot gl-site-foot">
                {next ? (
                  <>
                    <span className="gl-upcost">
                      <Gold n={upCoins} /> <BagView bag={upBag} have={e.res} />
                    </span>
                    <button
                      className="gl-btn is-primary"
                      disabled={!canUp}
                      onClick={() => {
                        const r = upgradeSite(save.estate, st.id as SiteId, save.gold)
                        if (!r) return
                        sound.fanfare()
                        update((s) => ({ ...s, gold: r.coins, estate: r.estate }))
                      }}
                    >
                      Level {level + 1}
                    </button>
                  </>
                ) : (
                  <span className="gl-owned">Fully built</span>
                )}
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}

export function MarketScreen({ save, update, onBack, sound }: { save: Save; update: Update; onBack: () => void; sound: Sfx }) {
  const e = save.estate
  const mult = rules(save).prices
  const deal = (id: ResId, n: number) => {
    const r = trade(save.estate, id, n, save.gold, mult, Date.now())
    if (!r) return
    sound.coins()
    update((s) => ({ ...s, gold: r.coins, estate: r.estate }))
  }
  return (
    <div className="gl-page gl-shop">
      <PageHead title="Market" onBack={onBack}>
        <span className="gl-coin-badge">
          <Gold n={save.gold} />
        </span>
      </PageHead>
      <p className="gl-blurb">
        Prices for {today()} · they change every day, and rare materials come in small lots. Selling fetches half the going rate.
        {mult !== 1 ? ` ${rules(save).name} prices (×${mult}).` : ''}
      </p>
      <section className="gl-cards gl-wares">
        {RESOURCES.map((r) => {
          const p = marketPrice(r.id, mult)
          const left = stockLeft(e, r.id)
          const held = e.res[r.id] ?? 0
          return (
            <div key={r.id} className="gl-card gl-ware gl-trade">
              <span className="gl-card-ribbon">{left ? `${left} for sale today` : 'Sold out today'}</span>
              <CardIcon id={`res-${r.id}`} glyph={r.glyph} colour="#e8b35a" />
              <div className="gl-card-body">
                <strong>{r.name}</strong>
                <span className="gl-muted">{r.text}</span>
                <div className="gl-chips">
                  <span className="gl-chip">You have {held}</span>
                  <span className={`gl-chip ${p.trend > 0.05 ? 'is-hard' : p.trend < -0.05 ? 'is-up' : ''}`}>
                    {p.trend > 0.05 ? '▲ dearer' : p.trend < -0.05 ? '▼ cheaper' : '≈ steady'}
                  </span>
                </div>
              </div>
              <div className="gl-trade-rows">
                <div>
                  <span>
                    Buy <Gold n={p.buy} />
                  </span>
                  <button className="gl-btn is-small is-primary" disabled={!left || save.gold < p.buy} onClick={() => deal(r.id, 1)}>
                    1
                  </button>
                  <button className="gl-btn is-small is-primary" disabled={left < 5 || save.gold < p.buy * 5} onClick={() => deal(r.id, 5)}>
                    5
                  </button>
                </div>
                <div>
                  <span>
                    Sell <Gold n={p.sell} />
                  </span>
                  <button className="gl-btn is-small" disabled={held < 1} onClick={() => deal(r.id, -1)}>
                    1
                  </button>
                  <button className="gl-btn is-small" disabled={held < 5} onClick={() => deal(r.id, -5)}>
                    5
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}
