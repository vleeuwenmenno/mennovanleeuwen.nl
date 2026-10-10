import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ask } from '../../../os/Dialogs'
import { rules, type Save } from './career'
import {
  BUILDINGS, live, building, bYieldAt, bSpeedAt, bSlotsAt, CATEGORIES, collectJobs, collectRents, crews, dailyStock, demolish, describe, effectDiff, partDiff, jobBlock, jobPreview, JOBS, jobsAt,
  marketPrice, maxSiteLevel, ownSlots, pendingRents, plan, PLOTS, plotDef, prettyHours, rankOf, resource, RESOURCES, SITE_BRANCH_AT, SITE_BRANCHES, siteEffectOf, SITES, slotsAt, speedAt, startJob, startWork,
  stockLeft, TERRAIN_NAMES, today, trade, yieldAt, bonuses,
  type Bag, type Branch, type BuildingDef, type BuildingId, type Estate, type JobDef, type Plan, type ResId, type SiteId, type Work,
} from './estate'
import { BagView, CardIcon, Gold, PageHead, PlaceIcon, Storehouse, useNow } from './ui'
import './estate.css'

// The estate, drawn as a map of the grounds: the four work sites and the workshop where they lie,
// and the plots around them to clear and build on. Tapping anything opens its panel (a drawer
// beside the map, or a sheet from the bottom on a narrow screen) with its jobs, its upgrades and
// the road ahead. And the market: materials for gold, prices moving day to day.

type Update = (fn: (s: Save) => Save) => void
type Sfx = { coins: () => void; ui: () => void; fanfare: () => void }
/** What the panel shows: a site, or a plot (empty, overgrown or built on). */
type Sel = { kind: 'site'; id: SiteId } | { kind: 'plot'; id: string } | null

const range = ([lo, hi]: [number, number]) => (lo === hi ? `${lo}` : `${lo}–${hi}`)
const iconOf = (b: BuildingId) => `bld-${b}`
/** A step up reads as a gain: "3 coins an hour" becomes "+3 coins an hour". */
const plus = (l: string) => (/^\d/.test(l) ? `+${l}` : l)

/** The estate as it stands now: older saves brought up to date, finished construction applied. */

export function EstateScreen({ save, update, onBack, sound }: { save: Save; update: Update; onBack: () => void; sound: Sfx }) {
  const now = useNow(1000)
  const e = live(save.estate, now)
  const [sel, setSel] = useState<Sel>(null)
  const ready = e.jobs.filter((j) => j.end <= now)
  const rents = pendingRents(e, now)
  const rank = rankOf(e)
  const b = bonuses(e)
  const crew = crews(e)
  const setEstate = (fn: (e: Estate) => Estate) => update((s) => ({ ...s, estate: fn(live(s.estate)) }))

  // A fanfare when construction finishes while you watch. Nothing is written for it: every screen
  // reads the estate through live(), so only your own actions change the save (and its timestamp).
  const opened = useRef(Date.now())
  const finished = save.estate.works?.filter((w) => w.end <= now && w.end > opened.current).length ?? 0
  useEffect(() => {
    if (finished) sound.fanfare()
  }, [finished])

  const collect = () => {
    sound.coins()
    update((s) => {
      const r = collectJobs(live(s.estate), Date.now())
      return { ...s, gold: s.gold + r.coins, estate: r.estate }
    })
  }
  const takeRents = () => {
    sound.coins()
    update((s) => {
      const r = collectRents(live(s.estate), Date.now())
      return { ...s, gold: s.gold + r.coins, estate: r.estate }
    })
  }
  const build = (p: Plan) => {
    const r = startWork(live(save.estate), p, save.gold, Date.now())
    if (!r) return
    sound.coins()
    update((s) => ({ ...s, gold: r.coins, estate: r.estate }))
  }

  return (
    <div className="gl-page es-page">
      <PageHead title="Estate" onBack={onBack}>
        <span className="es-rankchip" title={`${rank.points} levels built`}>
          <PlaceIcon id="es-rank" glyph="🏅" />
          <span>
            <b>Rank {rank.rank}</b> {rank.name}
          </span>
        </span>
        <span className="gl-coin-badge">
          <Gold n={save.gold} />
        </span>
      </PageHead>
      <div className="es-top">
      <div className="es-bar">
        {ready.length > 0 && (
          <button className="gl-btn is-primary" onClick={collect}>
            Collect {ready.length} finished {ready.length === 1 ? 'job' : 'jobs'}
          </button>
        )}
        <button className="gl-btn es-rents" disabled={rents.coins < 1} onClick={takeRents} title={`${rents.rate} coins an hour, piling up for at most ${rents.cap} hours`}>
          <PlaceIcon id="es-rents" glyph="💰" />
          <span>
            Rents <Gold n={rents.coins} />
            <small>
              {rents.rate}/h{rents.full ? ' · strongbox full' : ''}
            </small>
          </span>
        </button>
        <span className="es-stat">
          <PlaceIcon id="es-works" glyph="🏗️" />
          <span>
            Builders <b>{e.works.length}/{1 + b.builders}</b>
          </span>
        </span>
        <span className="es-stat">
          <PlaceIcon id="es-crews" glyph="👷" />
          <span>
            Spare crews <b>{crew.free}/{crew.spare}</b>
          </span>
        </span>
        <span className="es-stat es-rankbar">
          <span>
            {rank.next ? (
              <>
                {rank.points}/{rank.next} to <b>{rank.nextName}</b>
              </>
            ) : (
              <>{rank.points} levels: the highest rank</>
            )}
          </span>
          <span className="gl-statbar">
            <span style={{ width: `${rank.next ? Math.min(100, ((rank.points - rank.from) / (rank.next - rank.from)) * 100) : 100}%` }} />
          </span>
        </span>
      </div>
      <Storehouse estate={e} />
      </div>
      <div className={`es-body ${sel ? 'has-panel' : ''}`}>
        <EstateMap e={e} now={now} sel={sel} onSel={(s) => (sound.ui(), setSel(s))} />
        {sel && (
          <aside className="es-panel gl-panel" aria-label="Details">
            <button className="es-close" onClick={() => setSel(null)} aria-label="Close">
              ×
            </button>
            {sel.kind === 'site' ? (
              <SitePanel key={sel.id} id={sel.id} e={e} save={save} now={now} setEstate={setEstate} build={build} sound={sound} />
            ) : (
              <PlotPanel key={sel.id} id={sel.id} e={e} save={save} now={now} setEstate={setEstate} build={build} sound={sound} onDemolished={() => setSel({ kind: 'plot', id: sel.id })} />
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

// --- The map -------------------------------------------------------------------------------------

const ZOOMS = [1, 1.4, 1.9]

function EstateMap({ e, now, sel, onSel }: { e: Estate; now: number; sel: Sel; onSel: (s: Sel) => void }) {
  const view = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(0)
  const keep = useRef<{ x: number; y: number } | null>(null)
  const drag = useRef<{ x: number; y: number; sx: number; sy: number; moved: boolean } | null>(null)
  const { rank } = rankOf(e)

  // Zooming keeps the middle of the view where it was.
  const zoomTo = (z: number) => {
    const v = view.current
    if (v) keep.current = { x: (v.scrollLeft + v.clientWidth / 2) / v.scrollWidth, y: (v.scrollTop + v.clientHeight / 2) / v.scrollHeight }
    setZoom(Math.max(0, Math.min(ZOOMS.length - 1, z)))
  }
  useLayoutEffect(() => {
    const v = view.current
    const k = keep.current
    if (!v || !k) return
    v.scrollLeft = k.x * v.scrollWidth - v.clientWidth / 2
    v.scrollTop = k.y * v.scrollHeight - v.clientHeight / 2
    keep.current = null
  }, [zoom])
  // On a phone the map is wider than the screen: start looking at its middle.
  useLayoutEffect(() => {
    const v = view.current
    if (v) v.scrollLeft = (v.scrollWidth - v.clientWidth) / 2
  }, [])

  // Bring the picked marker into view: centred beside a drawer, or near the top above a sheet.
  const selKey = sel ? `${sel.kind}:${sel.id}` : ''
  useEffect(() => {
    const v = view.current
    const m = v?.querySelector<HTMLElement>('.es-marker.is-sel')
    if (!v || !m) return
    const sheet = !!v.closest('.es-body')?.querySelector('.es-panel') && v.closest('.es-page')!.clientWidth <= 760
    const vr = v.getBoundingClientRect()
    const mr = m.getBoundingClientRect()
    const x = v.scrollLeft + (mr.left + mr.width / 2 - vr.left) - v.clientWidth / 2
    const y = v.scrollTop + (mr.top + mr.height / 2 - vr.top) - (sheet ? v.clientHeight * 0.14 : v.clientHeight / 2)
    v.scrollTo({ left: x, top: y })
  }, [selKey])

  // A mouse can drag the map around (fingers scroll it natively). A drag isn't a click.
  const down = (ev: React.PointerEvent) => {
    if (ev.pointerType !== 'mouse' || ev.button !== 0) return
    const v = view.current!
    drag.current = { x: ev.clientX, y: ev.clientY, sx: v.scrollLeft, sy: v.scrollTop, moved: false }
  }
  const move = (ev: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = ev.clientX - d.x
    const dy = ev.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 6) return
    d.moved = true
    view.current!.scrollLeft = d.sx - dx
    view.current!.scrollTop = d.sy - dy
  }
  const up = () => {
    const d = drag.current
    drag.current = null
    if (d?.moved) {
      // Swallow the click that ends a drag.
      const stop = (ev: Event) => (ev.stopPropagation(), ev.preventDefault())
      window.addEventListener('click', stop, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0)
    }
  }

  return (
    <div className="es-mapbox">
      <div ref={view} className="es-view" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={() => (drag.current = null)}>
        <div className="es-map" style={{ ['--zoom' as string]: ZOOMS[zoom] }} onClick={(ev) => ev.target === ev.currentTarget && onSel(null)}>
          <img className="es-map-img" src="/games/gladiator/estate-map.webp" alt="" draggable={false} />
          {SITES.map((s) => {
            const busy = jobsAt(e, s.id)
            const done = busy.filter((j) => j.end <= now).length
            const work = e.works.find((w) => w.target === s.id)
            const slots = s.id === 'workshop' ? slotsAt(e.levels.workshop) : ownSlots(e, s.id)
            const using = s.id === 'workshop' ? e.crafting.length : busy.length
            return (
              <Marker
                key={s.id}
                x={s.x}
                y={s.y}
                icon={`site-${s.id}`}
                glyph={s.glyph}
                name={s.name}
                level={e.levels[s.id]}
                sel={sel?.kind === 'site' && sel.id === s.id}
                kind="site"
                badge={done}
                status={work ? <WorkTimer w={work} now={now} /> : using ? `${using}/${slots} busy` : 'idle'}
                idle={!work && !using}
                onClick={() => onSel({ kind: 'site', id: s.id })}
              />
            )
          })}
          {PLOTS.map((p) => {
            const st = e.plots[p.id] ?? { cleared: false, level: 0 }
            const work = e.works.find((w) => w.target === p.id)
            const d = st.building ? building(st.building) : null
            const busy = jobsAt(e, p.id)
            const done = busy.filter((j) => j.end <= now).length
            const isSel = sel?.kind === 'plot' && sel.id === p.id
            const open = () => onSel({ kind: 'plot', id: p.id })
            if (work && work.kind === 'build') {
              const nd = building(work.building!)
              return <Marker key={p.id} x={p.x} y={p.y} icon={iconOf(nd.id)} glyph={nd.glyph} name={nd.name} sel={isSel} kind="works" status={<WorkTimer w={work} now={now} />} onClick={open} />
            }
            if (d) return <Marker key={p.id} x={p.x} y={p.y} icon={iconOf(d.id)} glyph={d.glyph} name={d.name} level={st.level} sel={isSel} kind={d.id === 'villa' ? 'site' : 'building'} badge={done} status={work ? <WorkTimer w={work} now={now} /> : busy.length ? `${busy.length} at work` : undefined} onClick={open} />
            if (!st.cleared)
              return <Marker key={p.id} x={p.x} y={p.y} icon="es-rubble" glyph="🪨" name={work ? 'Clearing' : rank >= p.rank ? 'Clear' : `Rank ${p.rank}`} label={`${p.name}: overgrown plot`} sel={isSel} kind={rank >= p.rank ? 'rubble' : 'locked'} status={work ? <WorkTimer w={work} now={now} /> : undefined} onClick={open} />
            return <Marker key={p.id} x={p.x} y={p.y} icon="es-plot" glyph="➕" name="Build" label={`${p.name}: empty plot`} sel={isSel} kind="empty" onClick={open} />
          })}
        </div>
      </div>
      <div className="es-zoom">
        <button className="gl-btn is-quiet" onClick={() => zoomTo(zoom + 1)} disabled={zoom >= ZOOMS.length - 1} aria-label="Zoom in">
          +
        </button>
        <button className="gl-btn is-quiet" onClick={() => zoomTo(zoom - 1)} disabled={zoom <= 0} aria-label="Zoom out">
          −
        </button>
      </div>
    </div>
  )
}

function Marker({ x, y, icon, glyph, name, label, level, sel, kind, badge, status, idle, onClick }: { x: number; y: number; icon: string; glyph: string; name: string; label?: string; level?: number; sel: boolean; kind: 'site' | 'building' | 'empty' | 'rubble' | 'locked' | 'works'; badge?: number; status?: ReactNode; idle?: boolean; onClick: () => void }) {
  return (
    <button className={`es-marker is-${kind} ${sel ? 'is-sel' : ''} ${badge ? 'is-ready' : ''}`} style={{ left: `${x}%`, top: `${y}%` }} onClick={onClick} aria-label={label ?? `${name}${level ? `, level ${level}` : ''}`}>
      <span className="es-pin">
        <PlaceIcon id={icon} glyph={glyph} />
        {level !== undefined && level > 0 && <em className="es-lvl">{level}</em>}
        {!!badge && <b className="gl-badge">{badge}</b>}
      </span>
      <span className="es-label">
        <strong>{name}</strong>
        {status && <small className={idle ? 'is-idle' : ''}>{status}</small>}
      </span>
    </button>
  )
}

function WorkTimer({ w, now }: { w: Work; now: number }) {
  return <>🏗 {w.end <= now ? 'done' : prettyHours(w.end - now)}</>
}

// --- Panels --------------------------------------------------------------------------------------

type PanelProps = { e: Estate; save: Save; now: number; setEstate: (fn: (e: Estate) => Estate) => void; build: (p: Plan) => void; sound: Sfx }

function PanelHead({ icon, glyph, title, sub, children }: { icon: string; glyph: string; title: string; sub: ReactNode; children?: ReactNode }) {
  return (
    <div className="es-head">
      <CardIcon id={icon} glyph={glyph} colour="#e8b35a" />
      <div>
        <h3>{title}</h3>
        <span className="gl-muted">{sub}</span>
        {children}
      </div>
    </div>
  )
}

function SitePanel({ id, e, save, now, setEstate, build, sound }: PanelProps & { id: SiteId }) {
  const s = SITES.find((x) => x.id === id)!
  const level = e.levels[id]
  const max = maxSiteLevel(id)
  const branch = e.branches[id]
  const work = e.works.find((w) => w.target === id)
  const fork = SITE_BRANCHES[id].find((f) => f.id === (branch ?? work?.branch))
  const jobs = JOBS.filter((j) => j.at === id)
  const effectNow = describe(siteEffectOf(id, level, branch))
  return (
    <>
      <PanelHead icon={`site-${id}`} glyph={s.glyph} title={s.name} sub={`Level ${level} of ${max}${fork ? ` · ${fork.name}` : ''}`}>
        <div className="gl-chips">
          <span className="gl-chip">
            {slotsAt(level)} {id === 'workshop' ? (slotsAt(level) === 1 ? 'bench' : 'benches') : slotsAt(level) === 1 ? 'crew' : 'crews'}
          </span>
          {id !== 'workshop' && level > 1 && <span className="gl-chip is-up">+{Math.round((yieldAt(level) - 1) * 100)}% yield</span>}
          {level > 1 && <span className="gl-chip is-up">{Math.round((1 - speedAt(level)) * 100)}% faster</span>}
        </div>
      </PanelHead>
      <p className="es-text">{s.text}</p>
      {effectNow.length > 0 && <Lines title={fork?.name ?? 'Specialisation'} lines={effectNow} />}
      {work && <Construction w={work} now={now} what={`Raising to level ${work.to}`} />}
      {id === 'workshop' ? (
        <section className="es-sec">
          <h4>Benches</h4>
          {e.crafting.length ? (
            e.crafting.map((c) => (
              <div key={c.id} className={`gl-job is-running ${c.end <= now ? 'is-done' : ''}`}>
                <div className="gl-job-head">
                  <strong>{c.item.replace(/-\d+$/, '').replace(/-/g, ' ')}</strong>
                  <span>{c.end <= now ? 'Ready at the forge' : prettyHours(c.end - now)}</span>
                </div>
                <div className="gl-statbar">
                  <span style={{ width: `${Math.min(100, ((now - c.start) / Math.max(1, c.end - c.start)) * 100)}%` }} />
                </div>
              </div>
            ))
          ) : (
            <p className="gl-muted gl-fine">Every bench is free. Forge gear at the Forge and the Armoury; the workshop sets how many pieces at once and how fast.</p>
          )}
        </section>
      ) : (
        <JobList e={e} jobs={jobs} place={id} now={now} setEstate={setEstate} sound={sound} />
      )}
      <Path
        level={level}
        max={max}
        branchAt={SITE_BRANCH_AT}
        branch={fork}
        next={
          level < max && !work
            ? (choice) => {
                const p = plan(e, id, 'upgrade', save.gold, { branch: choice })
                const to = level + 1
                const lines = [
                  slotsAt(to) > slotsAt(level) ? `${slotsAt(to)} ${id === 'workshop' ? 'benches' : 'crews'}` : null,
                  id !== 'workshop' ? `+${Math.round((yieldAt(to) - 1) * 100)}% yield` : null,
                  `${Math.round((1 - speedAt(to)) * 100)}% faster`,
                  ...JOBS.filter((j) => j.at === id && j.level === to).map((j) => `New job: ${j.name}`),
                  ...describe(partDiff(siteEffectOf(id, level, branch), siteEffectOf(id, to, choice ?? branch))).map(plus),
                ].filter((x): x is string => !!x)
                return { plan: p, lines }
              }
            : null
        }
        forks={SITE_BRANCHES[id]}
        gold={save.gold}
        e={e}
        onBuild={build}
      />
    </>
  )
}

function PlotPanel({ id, e, save, now, setEstate, build, sound, onDemolished }: PanelProps & { id: string; onDemolished: () => void }) {
  const p = plotDef(id)!
  const st = e.plots[id] ?? { cleared: false, level: 0 }
  const work = e.works.find((w) => w.target === id)
  const { rank } = rankOf(e)
  const fits = BUILDINGS.filter((d) => d.terrain.includes(p.terrain))

  if (work && work.kind !== 'upgrade') {
    const d = work.building ? building(work.building) : null
    return (
      <>
        <PanelHead icon={d ? iconOf(d.id) : 'es-works'} glyph="🏗️" title={d ? d.name : p.name} sub={`${p.name} · ${TERRAIN_NAMES[p.terrain]}`} />
        <Construction w={work} now={now} what={d ? `Building ${d.name}` : 'Clearing the plot'} />
      </>
    )
  }

  if (!st.cleared) {
    const pl = plan(e, id, 'clear', save.gold)
    return (
      <>
        <PanelHead icon="es-rubble" glyph="🪨" title={p.name} sub={`${TERRAIN_NAMES[p.terrain]} · overgrown`} />
        <p className="es-text">Rocks, scrub and old stumps. Clear it, and it takes any of these:</p>
        <div className="es-fits">
          {fits.map((d) => (
            <span key={d.id} className="es-fit">
              <PlaceIcon id={iconOf(d.id)} glyph={d.glyph} />
              {d.name}
            </span>
          ))}
        </div>
        <section className="es-sec es-next">
          <h4>Clear the plot</h4>
          {rank < p.rank && <p className="gl-req">Needs estate rank {p.rank} (you are rank {rank}).</p>}
          <CostLine plan={pl} e={e} gold={save.gold} />
          <Act plan={pl} label="Clear it" onBuild={build} />
        </section>
      </>
    )
  }

  if (!st.building) {
    return (
      <>
        <PanelHead icon="es-plot" glyph="➕" title={p.name} sub={`${TERRAIN_NAMES[p.terrain]} · cleared and ready`} />
        <p className="es-text">Pick what to build here. Each building stands once on the estate; choose where with care, the good plots are few.</p>
        <div className="es-catalogue">
          {fits.map((d) => (
            <BuildCard key={d.id} d={d} e={e} gold={save.gold} plot={id} onBuild={build} />
          ))}
        </div>
      </>
    )
  }

  const d = building(st.building)
  // A fork being built counts as chosen.
  const fork = d.branches?.find((f) => f.id === (st.branch ?? work?.branch))
  const jobs = JOBS.filter((j) => j.at === d.id)
  const busy = jobsAt(e, id).length
  const knock = async () => {
    const ok = await ask({ title: `Demolish the ${d.name.toLowerCase()}?`, body: `All ${st.level} ${st.level === 1 ? 'level' : 'levels'} are lost and nothing comes back. The plot is left empty to build on again.`, confirm: 'Demolish', danger: true })
    if (!ok) return
    sound.ui()
    setEstate((x) => demolish(x, id) ?? x)
    onDemolished()
  }
  return (
    <>
      <PanelHead icon={iconOf(d.id)} glyph={d.glyph} title={d.name} sub={`Level ${st.level} of ${d.max}${fork ? ` · ${fork.name}` : ''} · ${CATEGORIES[d.cat]}`}>
        {jobs.length > 0 && (
          <div className="gl-chips">
            <span className="gl-chip">
              {bSlotsAt(st.level)} {bSlotsAt(st.level) === 1 ? 'crew' : 'crews'}
            </span>
            {st.level > 1 && <span className="gl-chip is-up">+{Math.round((bYieldAt(st.level) - 1) * 100)}% output</span>}
            {st.level > 1 && <span className="gl-chip is-up">{Math.round((1 - bSpeedAt(st.level)) * 100)}% faster</span>}
          </div>
        )}
      </PanelHead>
      <p className="es-text">{d.text}</p>
      <Lines title="What it does now" lines={describe(d.effect(st.level, st.branch))} empty={jobs.length ? 'Its jobs, below.' : 'Nothing yet.'} />
      {work && <Construction w={work} now={now} what={`Raising to level ${work.to}`} />}
      {jobs.length > 0 && <JobList e={e} jobs={jobs} place={id} now={now} setEstate={setEstate} sound={sound} />}
      <Path
        level={st.level}
        max={d.max}
        branchAt={d.branchAt}
        branch={fork}
        forks={d.branches}
        gold={save.gold}
        e={e}
        onBuild={build}
        next={
          st.level < d.max && !work
            ? (choice) => {
                const to = st.level + 1
                const pl = plan(e, id, 'upgrade', save.gold, { branch: choice })
                const lines = [
                  ...(jobs.length ? [bSlotsAt(to) > bSlotsAt(st.level) ? `${bSlotsAt(to)} crews` : null, `+${Math.round((bYieldAt(to) - 1) * 100)}% output, ${Math.round((1 - bSpeedAt(to)) * 100)}% faster`] : []),
                  ...describe(effectDiff(d, st.level, to, st.branch, choice)).map(plus),
                  ...jobs.filter((j) => j.level === to && (!j.branch || j.branch === (choice ?? st.branch))).map((j) => `New job: ${j.name}`),
                ].filter((x): x is string => !!x)
                return { plan: pl, lines }
              }
            : null
        }
      />
      {d.id !== 'villa' && (
        <section className="es-sec es-demolish">
          <button className="gl-btn is-small is-quiet" disabled={!!work || busy > 0} onClick={knock}>
            Demolish
          </button>
          {(work || busy > 0) && <span className="gl-muted gl-fine">Not while it's {work ? 'being built' : 'working'}.</span>}
        </section>
      )}
    </>
  )
}

function BuildCard({ d, e, gold, plot, onBuild }: { d: BuildingDef; e: Estate; gold: number; plot: string; onBuild: (p: Plan) => void }) {
  const where = Object.keys(e.plots).find((k) => e.plots[k].building === d.id) ?? e.works.find((w) => w.kind === 'build' && w.building === d.id)?.target
  const pl = plan(e, plot, 'build', gold, { building: d.id })
  const forks = d.branches?.map((f) => f.name).join(' or ')
  return (
    <div className={`es-build ${where ? 'is-taken' : ''}`}>
      <div className="es-build-head">
        <PlaceIcon id={iconOf(d.id)} glyph={d.glyph} />
        <div>
          <strong>{d.name}</strong>
          <span className="gl-muted">
            {CATEGORIES[d.cat]} · {d.max} levels{d.branchAt ? `, forks at ${d.branchAt}` : ''}
          </span>
        </div>
      </div>
      <p>{d.text}</p>
      {forks && (
        <p className="gl-muted es-forks">
          Becomes: <b>{forks}</b>
        </p>
      )}
      {where ? (
        <p className="gl-muted gl-fine">Already built, at {plotDef(where)?.name}.</p>
      ) : (
        <>
          <CostLine plan={pl} e={e} gold={gold} />
          <Act plan={pl} label={`Build the ${d.name.toLowerCase()}`} onBuild={onBuild} />
        </>
      )}
    </div>
  )
}

// --- Pieces of a panel ---------------------------------------------------------------------------

function Lines({ title, lines, empty }: { title: string; lines: string[]; empty?: string }) {
  if (!lines.length && !empty) return null
  return (
    <section className="es-sec">
      <h4>{title}</h4>
      {lines.length ? (
        <ul className="es-lines">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="gl-muted gl-fine">{empty}</p>
      )}
    </section>
  )
}

function Construction({ w, now, what }: { w: Work; now: number; what: string }) {
  const pct = Math.min(100, ((now - w.start) / Math.max(1, w.end - w.start)) * 100)
  return (
    <section className="es-sec es-works">
      <div className="gl-job is-running">
        <div className="gl-job-head">
          <strong>🏗 {what}</strong>
          <span>{w.end <= now ? 'Done!' : prettyHours(w.end - now)}</span>
        </div>
        <div className="gl-statbar">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
    </section>
  )
}

function CostLine({ plan: p, e, gold }: { plan: Plan; e: Estate; gold: number }) {
  const { coins, ...bag } = p.cost
  return (
    <div className="es-cost">
      <span className={`gl-coin-badge ${gold < coins ? 'is-short' : ''}`}>
        <Gold n={coins} />
      </span>
      <BagView bag={bag as Bag} have={e.res} />
      <span className="gl-chip">⏱ {prettyHours(p.ms)}</span>
      {p.rank > 1 && <span className={`gl-chip ${rankOf(e).rank < p.rank ? 'is-hard' : ''}`}>Rank {p.rank}</span>}
    </div>
  )
}

function Act({ plan: p, label, onBuild }: { plan: Plan; label: string; onBuild: (p: Plan) => void }) {
  return (
    <div className="es-act">
      <button className="gl-btn is-primary" disabled={!!p.why} onClick={() => onBuild(p)}>
        {label}
      </button>
      {p.why && <span className="gl-req">{p.why}</span>}
    </div>
  )
}

/** The road ahead: every level as a pip, the fork marked, and the next step with what it brings. */
function Path({ level, max, branchAt, branch, forks, next, gold, e, onBuild }: { level: number; max: number; branchAt?: number; branch?: Branch; forks?: Branch[]; next: ((choice?: string) => { plan: Plan; lines: string[] }) | null; gold: number; e: Estate; onBuild: (p: Plan) => void }) {
  const atFork = !!branchAt && level + 1 === branchAt
  const [choice, setChoice] = useState<string | undefined>(undefined)
  const step = next ? next(atFork ? choice : undefined) : null
  return (
    <section className="es-sec es-next">
      <h4>
        The road ahead <span className="gl-muted">{level < max ? `level ${level} of ${max}` : 'complete'}</span>
      </h4>
      <ol className="es-path" aria-label={`Level ${level} of ${max}`}>
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
          <li key={n} className={`${n <= level ? 'is-done' : ''} ${n === level + 1 ? 'is-next' : ''} ${n === branchAt ? 'is-fork' : ''}`}>
            {n === branchAt ? '⑂' : n}
          </li>
        ))}
      </ol>
      {branchAt && (
        <p className="gl-muted gl-fine">
          {branch ? (
            <>
              Specialised at level {branchAt}: <b>{branch.name}</b>. {branch.text}
            </>
          ) : (
            <>
              At level {branchAt} the path forks: {forks?.map((f) => f.name).join(', or ')}.
            </>
          )}
        </p>
      )}
      {atFork && forks && next && (
        <div className="es-forkpick" role="radiogroup" aria-label="Choose a specialisation">
          {forks.map((f) => (
            <button key={f.id} role="radio" aria-checked={choice === f.id} className={`es-fork ${choice === f.id ? 'is-on' : ''}`} onClick={() => setChoice(f.id)}>
              <strong>{f.name}</strong>
              <span>{f.text}</span>
            </button>
          ))}
          <p className="gl-muted gl-fine">The choice is for good: the rest of the path follows it.</p>
        </div>
      )}
      {step && (
        <>
          <Lines title={`Level ${level + 1}`} lines={step.lines} />
          <CostLine plan={step.plan} e={e} gold={gold} />
          <Act plan={step.plan} label={`Build level ${level + 1}`} onBuild={onBuild} />
        </>
      )}
    </section>
  )
}

function JobList({ e, jobs, place, now, setEstate, sound }: { e: Estate; jobs: JobDef[]; place: string; now: number; setEstate: (fn: (e: Estate) => Estate) => void; sound: Sfx }) {
  const running = jobsAt(e, place)
  const level = e.plots[place]?.level ?? e.levels[place as SiteId]
  const branch = e.plots[place]?.branch ?? e.branches[place as SiteId]
  // Jobs of a specialisation not taken are left out; the rest show, locked ones with what they need.
  const shown = jobs.filter((d) => !d.branch || !branch || d.branch === branch).sort((a, b) => a.level - b.level)
  const b = bonuses(e)
  return (
    <>
      {running.length > 0 && (
        <section className="es-sec">
          <h4>At work</h4>
          {running.map((j) => {
            const d = JOBS.find((x) => x.id === j.job)
            const done = j.end <= now
            const pct = Math.min(100, ((now - j.start) / Math.max(1, j.end - j.start)) * 100)
            return (
              <div key={j.id} className={`gl-job is-running ${done ? 'is-done' : ''}`}>
                <div className="gl-job-head">
                  <strong>{d?.name ?? j.job}</strong>
                  <span>{done ? 'Done!' : prettyHours(j.end - now)}</span>
                </div>
                <div className="gl-statbar">
                  <span style={{ width: `${pct}%` }} />
                </div>
                <span className="gl-bag">
                  <BagView bag={j.gives} />
                  {!!j.coins && <Gold n={j.coins} />}
                </span>
              </div>
            )
          })}
        </section>
      )}
      <section className="es-sec">
        <h4>Jobs</h4>
        <div className="es-jobs">
          {shown.map((d) => {
            const why = jobBlock(e, d)
            const locked = level < d.level || (!!d.branch && d.branch !== branch)
            const p = jobPreview(e, d, b)
            return (
              <div key={d.id} className={`es-job ${locked ? 'is-locked' : ''}`}>
                <div className="es-job-main">
                  <strong>{d.name}</strong>
                  <span className="gl-bag">
                    {(Object.entries(p.gives) as [ResId, [number, number]][]).map(([k, r]) => (
                      <span key={k} className="gl-res" title={resource(k).name}>
                        <PlaceIcon id={`res-${k}`} glyph={resource(k).glyph} />
                        <b>{range(r)}</b>
                      </span>
                    ))}
                    {!!p.coins && <Gold n={p.coins} />}
                    {d.costs && (
                      <span className="es-uses">
                        uses <BagView bag={d.costs} have={e.res} />
                      </span>
                    )}
                  </span>
                </div>
                <div className="es-job-side">
                  <span className="es-time">{locked ? (d.branch && d.branch !== branch ? `🔒 ${branchName(d)}` : `🔒 level ${d.level}`) : prettyHours(p.ms)}</span>
                  {!locked && (
                    <button
                      className="gl-btn is-small is-primary"
                      disabled={!!why}
                      onClick={() => {
                        sound.ui()
                        setEstate((x) => startJob(x, d.id, Date.now()))
                      }}
                    >
                      Start
                    </button>
                  )}
                  {!locked && why && <span className="gl-req">{why}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </>
  )
}

// --- The market ----------------------------------------------------------------------------------

/** The name of the specialisation a job belongs to. */
function branchName(d: JobDef) {
  const forks = (SITES.some((s) => s.id === d.at) ? SITE_BRANCHES[d.at as SiteId] : building(d.at as BuildingId).branches) ?? []
  return forks.find((f) => f.id === d.branch)?.name ?? d.branch
}

const KIND_NAMES = { gear: 'For gear', build: 'For building', goods: 'Trade goods' }

export function MarketScreen({ save, update, onBack, sound }: { save: Save; update: Update; onBack: () => void; sound: Sfx }) {
  const e = live(save.estate)
  const mult = rules(save).prices
  const b = bonuses(e)
  const deal = (id: ResId, n: number) => {
    const r = trade(live(save.estate), id, n, save.gold, mult, Date.now())
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
        Prices for {today()} · they change every day, and rare materials come in small lots. Selling fetches {Math.round((0.5 + b.sell) * 100)}% of the going rate
        {b.sell > 0 ? ' (your trading post sees to that)' : ''}.{b.buy > 0 ? ` You buy ${Math.round(b.buy * 100)}% under it.` : ''}
        {mult !== 1 ? ` ${rules(save).name} prices (×${mult}).` : ''}
      </p>
      {(['gear', 'build', 'goods'] as const).map((kind) => (
        <section key={kind} className="es-market-group">
          <h3 className="es-market-head">{KIND_NAMES[kind]}</h3>
          <div className="gl-cards gl-wares">
            {RESOURCES.filter((r) => r.kind === kind).map((r) => {
              const p = marketPrice(r.id, mult, Date.now(), e)
              const left = stockLeft(e, r.id)
              const held = e.res[r.id] ?? 0
              return (
                <div key={r.id} className="gl-card gl-ware gl-trade">
                  <span className="gl-card-ribbon">{left ? `${left} of ${dailyStock(e, r.id)} for sale today` : 'Sold out today'}</span>
                  <CardIcon id={`res-${r.id}`} glyph={r.glyph} colour="#e8b35a" />
                  <div className="gl-card-body">
                    <strong>{r.name}</strong>
                    <span className="gl-muted">{r.text}</span>
                    <div className="gl-chips">
                      <span className="gl-chip">You have {held}</span>
                      <span className={`gl-chip ${p.trend > 0.05 ? 'is-hard' : p.trend < -0.05 ? 'is-up' : ''}`}>{p.trend > 0.05 ? '▲ dearer' : p.trend < -0.05 ? '▼ cheaper' : '≈ steady'}</span>
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
          </div>
        </section>
      ))}
    </div>
  )
}

