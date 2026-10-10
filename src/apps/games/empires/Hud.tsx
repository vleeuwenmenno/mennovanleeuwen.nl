import { useState } from 'react'
import { DIFFICULTY, type Difficulty } from './ai'
import { ABILITIES, FACTIONS, LEVEL_UP, MAX_LEVEL, MAX_QUEUE, MAX_RESEARCH, MINE_INCOME, SURVEY_TIME, TECH, UNIT, buildable, isShip, techsFor, unitOf, type FactionId, type HardpointKind, type UnitType } from './data'
import { HP_COLOR, HP_ICON, HP_NAME } from './icons'
import { spriteUrl } from './render'
import { building, cantBuild, cantResearch, cantSite, other, researchCost, shieldFull, shieldMax, techBonus, type OreNode, type Owner, type ResearchItem, type Unit, type World } from './sim'

// The battle HUD: the top bar, the command card for whatever is selected (the station's shipyard
// lives there, so building is something you do at the station), and the overlays.

export type Hud = {
  credits: number
  income: number
  pop: number
  popCap: number
  level: number
  research: ResearchItem[]
  techs: string[]
  queue: { unit: string; left: number; total: number }[]
  time: number
  sel: number[]
  winner: Owner | -1
  beacons: number
  mines: number
}
export type Mode = 'normal' | 'attack'

export const fmt = (n: number) => Math.floor(n).toLocaleString('en-US')
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function HpIcon({ kind, size = 14 }: { kind: HardpointKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={HP_ICON[kind]} />
    </svg>
  )
}

export function Bar({ value, max, kind }: { value: number; max: number; kind: 'hull' | 'shield' | 'hp' }) {
  const f = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  return (
    <span className={`ew-bar is-${kind} ${kind === 'hull' && f < 0.3 ? 'is-low' : ''}`}>
      <i style={{ width: `${f * 100}%` }} />
    </span>
  )
}

/** The ship's sprite with its hardpoints marked where they sit, each showing its health. */
export function Schematic({ u, size = 116 }: { u: Unit; size?: number }) {
  const t = u.t
  const w = t.aspect >= 1 ? size : size * t.aspect
  const h = t.aspect >= 1 ? size / t.aspect : size
  return (
    <div className="ew-schem-box" style={{ width: size, height: size }}>
      <div className="ew-schem" style={{ width: w, height: h }}>
        <img src={spriteUrl(t.sprite)} alt="" />
        {t.hardpoints.map((p, i) => {
          const s = u.hps[i]
          const f = s.hp / s.max
          return (
            <span
              key={i}
              className={`ew-schem-hp ${s.hp <= 0 ? 'is-dead' : ''}`}
              style={{ left: `${p.x * 10}%`, top: `${p.y * 10}%`, ['--c' as string]: HP_COLOR[p.kind], ['--f' as string]: `${f * 360}deg` }}
              title={`${HP_NAME[p.kind]}: ${s.hp <= 0 ? 'destroyed' : `${fmt(s.hp)} / ${fmt(s.max)}`}`}
            >
              <HpIcon kind={p.kind} size={9} />
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** Hardpoints counted by kind: "Turbolasers 5/6". */
function HpSummary({ u }: { u: Unit }) {
  const kinds = [...new Set(u.t.hardpoints.map((h) => h.kind))]
  return (
    <div className="ew-hpsum">
      {kinds.map((k) => {
        const all = u.t.hardpoints.map((h, i) => (h.kind === k ? i : -1)).filter((i) => i >= 0)
        const up = all.filter((i) => u.hps[i].hp > 0).length
        return (
          <span key={k} className={`ew-hpchip ${up === 0 ? 'is-dead' : up < all.length ? 'is-hurt' : ''}`} style={{ ['--c' as string]: HP_COLOR[k] }} title={`${HP_NAME[k]}: ${up} of ${all.length} working`}>
            <HpIcon kind={k} size={13} />
            {up}/{all.length}
          </span>
        )
      })}
    </div>
  )
}

function Vitals({ u, squad = [u] }: { u: Unit; squad?: Unit[] }) {
  const t = u.t
  const hull = squad.reduce((s, x) => s + x.hull, 0)
  const max = squad.reduce((s, x) => s + x.hullMax, 0)
  return (
    <div className="ew-bars">
      <span>Hull</span>
      <Bar value={hull} max={max} kind="hull" />
      <small>{fmt(hull)}</small>
      {t.shield > 0 && (
        <>
          <span>Shield</span>
          <Bar value={u.shield} max={shieldFull(u)} kind="shield" />
          <small title={shieldMax(u) < shieldFull(u) ? 'Shield generators damaged: the shields cannot fully recharge' : undefined}>
            {fmt(u.shield)}
            {shieldMax(u) < shieldFull(u) ? ' ⚠' : ''}
          </small>
        </>
      )}
    </div>
  )
}

// --- Top bar ----------------------------------------------------------------------------------------

export function TopBar({ hud, faction, ui, onPause, onSpeed, onMenu, onMute, onHelp, onShipyard }: {
  hud: Hud
  faction: FactionId
  ui: { paused: boolean; speed: number; muted: boolean }
  onPause: () => void
  onSpeed: (s: number) => void
  onMenu: () => void
  onMute: () => void
  onHelp: () => void
  onShipyard: () => void
}) {
  const q = hud.queue[0]
  return (
    <div className="ew-top">
      <span className="ew-badge">{FACTIONS[faction].name}</span>
      <span className="ew-stat" title="Credits (income per minute)">
        <b>{fmt(hud.credits)}</b> <small>cr · +{fmt(hud.income * 60)}/min</small>
      </span>
      <span className={`ew-stat ${hud.pop >= hud.popCap ? 'is-full' : ''}`} title="Fleet size / capacity. Capture beacons and upgrade the station for more.">
        Fleet <b>{hud.pop}</b>/{hud.popCap}
      </span>
      <span className="ew-stat ew-hide-narrow" title="Mining platforms and beacons held">
        Ore <b>{hud.mines}</b> · Beacons <b>{hud.beacons}</b>/3
      </span>
      <button className={`ew-yardchip ${q ? 'is-busy' : ''}`} onClick={onShipyard} title="Select the station to build (H)">
        {q ? (
          <>
            <img src={spriteUrl(UNIT[q.unit].sprite)} alt="" />
            <span>{Math.ceil(q.left)}s</span>
            {hud.queue.length > 1 && <small>+{hud.queue.length - 1}</small>}
            <i style={{ width: `${(1 - q.left / q.total) * 100}%` }} />
          </>
        ) : (
          <span>Shipyard idle</span>
        )}
      </button>
      <span className="ew-top-right">
        <span className="ew-stat ew-hide-narrow ew-clock">{clock(hud.time)}</span>
        <span className="ew-speed" role="group" aria-label="Game speed">
          {[1, 2, 3].map((s) => (
            <button key={s} className={ui.speed === s ? 'is-on' : ''} onClick={() => onSpeed(s)}>
              {s}×
            </button>
          ))}
        </span>
        <button onClick={onPause} title="Pause (P)">{ui.paused ? '▶' : '❚❚'}</button>
        <button onClick={onMute} title="Sound">{ui.muted ? '🔇' : '🔊'}</button>
        <button onClick={onHelp} title="Controls">?</button>
        <button onClick={onMenu} title="Menu">☰</button>
      </span>
    </div>
  )
}

// --- Command card -----------------------------------------------------------------------------------

type CardProps = {
  w: World
  me: Owner
  sel: Unit[]
  hud: Hud
  faction: FactionId
  mode: Mode
  onAbility: () => void
  onStop: () => void
  onAttackMode: () => void
  onOnly: (typeId: string, drop: boolean) => void
  onBuild: (id: string, times: number) => void
  onUnqueue: (id: string) => void
  onCancel: (index: number) => void
  onResearch: (id: string) => void
  onCancelResearch: (index: number) => void
  onSite: (node: number, tier: 'mine' | 'defense') => void
  onStation: () => void
  /** The ore asteroid clicked on, if no ships are selected. */
  node: OreNode | null
}

export function CommandCard(p: CardProps) {
  const { sel, me } = p
  if (!sel.length && p.node) return <OreCard {...p} n={p.node} />
  if (!sel.length)
    return (
      <div className="ew-panel ew-cmd is-empty">
        <p>
          Drag across your ships to command them. Select your <button className="ew-link" onClick={p.onStation}>station</button> (H) to build, or click surveyed ore to build on it.
        </p>
      </div>
    )
  const first = sel[0]
  if (sel.length === 1 && first.owner === me && first.t.tier === 'station') return <StationCard {...p} st={first} />
  const sameSquad = sel.every((u) => u.t.id === first.t.id && u.squad && u.squad === first.squad)
  if (sel.length === 1 || sameSquad) return <UnitCard {...p} u={first} squad={sel} />
  return <GroupCard {...p} />
}

function Pips({ level }: { level: number }) {
  return (
    <span className="ew-pips" title={`Station level ${level} of ${MAX_LEVEL}`}>
      {Array.from({ length: MAX_LEVEL }, (_, i) => (
        <i key={i} className={i < level ? 'is-on' : ''} />
      ))}
    </span>
  )
}

function Slots({ label, size, items, onCancel }: { label: string; size: number; items: { icon: React.ReactNode; name: string; left: number; total: number }[]; onCancel: (i: number) => void }) {
  return (
    <div className="ew-slots" aria-label={label}>
      <span className="ew-slots-label">{label}</span>
      {Array.from({ length: size }, (_, i) => {
        const q = items[i]
        if (!q) return <span key={i} className="ew-slot is-empty" />
        return (
          <button key={i} className="ew-slot" onClick={() => onCancel(i)} title={`${q.name}${i === 0 ? `: ${Math.ceil(q.left)} s left` : ''}. Click to cancel and refund.`}>
            {q.icon}
            {i === 0 && (
              <>
                <i style={{ height: `${(1 - q.left / q.total) * 100}%` }} />
                <em>{Math.ceil(q.left)}</em>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}

const researchName = (id: string, level: number) => (id === LEVEL_UP ? `Station level ${level + 1}` : TECH[id].name)

/** One piece of research: done, under way, locked, or ready to buy. */
function TechTile({ id, w, me, hud, onResearch }: { id: string; w: World; me: Owner; hud: Hud; onResearch: (id: string) => void }) {
  const level = id === LEVEL_UP
  const t = level ? null : TECH[id]
  const done = !level && hud.techs.includes(id)
  const maxed = level && hud.level >= MAX_LEVEL
  const busy = hud.research.find((r) => r.id === id)
  const why = cantResearch(w, me, id)
  const locked = !!t && t.level > hud.level
  const cost = researchCost(w.players[me], id)
  const unlocks = level ? buildable(w.players[me].faction).filter((u) => u.level === hud.level + 1) : []
  const blurb = level
    ? `More hull and firepower for the station, +4 fleet capacity${unlocks.length ? `, unlocks the ${unlocks.map((u) => u.name).join(', ')}` : ''}.`
    : t!.blurb
  return (
    <button
      className={`ew-tech ${done || maxed ? 'is-done' : busy ? 'is-busy' : locked ? 'is-locked' : why ? 'is-off' : ''}`}
      onClick={() => onResearch(id)}
      disabled={done || maxed}
      title={`${researchName(id, hud.level)}\n${blurb}${!done && why && !busy ? `\n\n${why}` : ''}`}
    >
      <strong>{maxed ? 'Station maxed' : researchName(id, hud.level)}</strong>
      <span>{done ? '✓ Researched' : maxed ? '✓' : busy ? `${Math.ceil(busy.left)}s…` : locked ? `Station Lv${t!.level}` : cost ? `${cost.cost} · ${cost.time}s` : ''}</span>
    </button>
  )
}

function StationCard(p: CardProps & { st: Unit }) {
  const { w, me, st, hud, faction } = p
  const [tab, setTab] = useState<'yard' | 'research'>('yard')
  const ships = buildable(faction)
  const queued = (id: string) => hud.queue.filter((q) => q.unit === id).length
  const groups = [st.t, ...ships]
  return (
    <div className="ew-panel ew-cmd is-station">
      <div className="ew-cmd-side">
        <Schematic u={st} size={112} />
        <div className="ew-side-info">
          <strong>{st.t.name}</strong>
          <Pips level={hud.level} />
          <Vitals u={st} />
          <HpSummary u={st} />
        </div>
      </div>
      <div className="ew-cmd-main">
        <header className="ew-yardhead">
          <div className="ew-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'yard'} className={tab === 'yard' ? 'is-on' : ''} onClick={() => setTab('yard')}>Shipyard</button>
            <button role="tab" aria-selected={tab === 'research'} className={tab === 'research' ? 'is-on' : ''} onClick={() => setTab('research')}>
              Research{hud.research.length ? ` (${hud.research.length})` : ''}
            </button>
          </div>
          <div className="ew-queues">
          <Slots label="Ships" size={MAX_QUEUE} onCancel={p.onCancel}
            items={hud.queue.map((q) => ({ icon: <img src={spriteUrl(UNIT[q.unit].sprite)} alt="" />, name: UNIT[q.unit].name, left: q.left, total: q.total }))}
          />
          <Slots label="Research" size={MAX_RESEARCH} onCancel={p.onCancelResearch}
            items={hud.research.map((r) => ({
              icon: r.id === LEVEL_UP ? <b className="ew-slot-lvl">Lv{hud.level + 1}</b> : <img src={spriteUrl(UNIT[TECH[r.id].for].sprite)} alt="" />,
              name: researchName(r.id, hud.level), left: r.left, total: r.total,
            }))}
          />
          </div>
        </header>
        {tab === 'yard' ? (
          <div className="ew-yard">
            {ships.map((t) => (
              <ShipCard key={t.id} t={t} why={cantBuild(w, me, t.id)} level={hud.level} queued={queued(t.id)} onBuild={p.onBuild} onUnqueue={p.onUnqueue} />
            ))}
          </div>
        ) : (
          <div className="ew-research">
            {groups.map((t) => (
              <div key={t.id} className={`ew-techgroup ${t.tier === 'station' ? 'is-station' : ''}`}>
                <span className="ew-techhead" title={t.name}>
                  <img src={spriteUrl(t.sprite)} alt="" />
                  {t.tier === 'station' ? 'Station' : t.name.split(' ')[0]}
                </span>
                {t.tier === 'station' && <TechTile id={LEVEL_UP} w={w} me={me} hud={hud} onResearch={p.onResearch} />}
                {techsFor(t.id).map((x) => (
                  <TechTile key={x.id} id={x.id} w={w} me={me} hud={hud} onResearch={p.onResearch} />
                ))}
              </div>
            ))}
          </div>
        )}
        <p className="ew-muted ew-small ew-yardhint">
          {tab === 'yard' ? 'Click to build, Shift-click for five, right-click to remove one. Right-click the map to set the rally point. Mining and defense platforms are built on surveyed ore.' : 'Research upgrades every ship of that type, the ones already flying too.'}
        </p>
      </div>
    </div>
  )
}

/** An ore asteroid: who has surveyed it, and what we can build on it. */
function OreCard(p: CardProps & { n: OreNode }) {
  const { w, me, n, faction } = p
  const mine = unitOf(faction, 'mine')
  const defense = unitOf(faction, 'defense')
  const site = n.site ? w.byId.get(n.site) : undefined
  const ours = n.owner === me
  const theirs = n.owner !== -1 && n.owner !== me
  const toward = n.progress === 0 ? -1 : n.progress < 0 ? 0 : 1
  const pct = Math.round(Math.abs(n.progress) * 100)
  const ore = MINE_INCOME * (1 + (techBonus(w.players[me], unitOf(faction, 'station').id).mines ?? 0))
  const status = site
    ? `${site.owner === me ? 'Our' : 'Enemy'} ${site.t.name.toLowerCase()}${building(site) ? ' (under construction)' : ''}`
    : ours
      ? 'Surveyed by us: ready to build on.'
      : theirs
        ? `Surveyed by the enemy. Keep ships here to take it over${toward === me ? ` (${100 - pct}% to neutral)` : ''}.`
        : pct > 0
          ? `Survey under way: ${pct}%${toward === me ? '' : ' (enemy)'}.`
          : `Unsurveyed. Keep ships within the ring for ${SURVEY_TIME} s, with no enemies there, to claim it.`
  const option = (t: UnitType, tier: 'mine' | 'defense', text: string) => {
    const why = cantSite(w, me, n.id, tier)
    return (
      <button className={`ew-shipcard ew-sitecard ${why ? 'is-off' : ''}`} onClick={() => p.onSite(n.id, tier)} title={`${t.name}\n${t.blurb}${why ? `\n\n${why}` : ''}`}>
        <img src={spriteUrl(t.sprite)} alt="" />
        <strong>{t.name}</strong>
        <span className="ew-cost">{t.cost}<small> · {t.build}s</small></span>
        <span className="ew-muted ew-small">{text}</span>
      </button>
    )
  }
  return (
    <div className="ew-panel ew-cmd is-ore">
      <div className="ew-cmd-side">
        <img className="ew-portrait" src="/games/empires/world/asteroid-ore.webp" alt="" />
      </div>
      <div className="ew-cmd-main">
        <header className="ew-unithead">
          <strong>Ore asteroid</strong>
          <span className={`ew-tag ${theirs ? 'is-enemy' : ''}`}>{ours ? 'ours' : theirs ? 'enemy' : 'unclaimed'}</span>
        </header>
        <span className="ew-muted ew-small">{status}</span>
        {!site && pct > 0 && pct < 100 && <Bar value={pct} max={100} kind="shield" />}
        {!site && (
          <div className="ew-siteopts">
            {option(mine, 'mine', `+${fmt(ore * 60)} credits a minute`)}
            {option(defense, 'defense', 'Guards this spot and the space around it')}
          </div>
        )}
      </div>
    </div>
  )
}

function ShipCard({ t, why, level, queued, onBuild, onUnqueue }: {
  t: UnitType; why: string | null; level: number; queued: number; onBuild: (id: string, times: number) => void; onUnqueue: (id: string) => void
}) {
  const locked = t.level > level
  return (
    <button
      className={`ew-shipcard ${locked ? 'is-locked' : why ? 'is-off' : ''}`}
      onClick={(e) => onBuild(t.id, e.shiftKey ? 5 : 1)}
      onContextMenu={(e) => {
        e.preventDefault()
        onUnqueue(t.id)
      }}
      title={`${t.name}${t.squad > 1 ? ` (squadron of ${t.squad})` : ''}\n${t.blurb}${why ? `\n\n${why}` : ''}`}
    >
      <img src={spriteUrl(t.sprite)} alt="" />
      <strong>{t.name}</strong>
      <span className="ew-cost">
        {t.cost}
        <small> · {t.build}s · ⬢{t.pop}</small>
      </span>
      {locked && <span className="ew-lock">Station Lv{t.level}</span>}
      {queued > 0 && <span className="ew-qbadge">{queued}</span>}
    </button>
  )
}

function orderText(w: World, u: Unit) {
  if (building(u)) return `Under construction: ${Math.ceil(u.building)} s`
  const o = u.order
  if (o.k === 'move') return o.attack ? 'Attack-moving' : 'Moving'
  if (o.k === 'attack') {
    const t = w.byId.get(o.id)
    return t ? `Attacking ${t.t.name}${o.hp >= 0 ? `: ${HP_NAME[t.t.hardpoints[o.hp].kind].toLowerCase()}` : ''}` : 'Attacking'
  }
  const t = u.target ? w.byId.get(u.target) : undefined
  return t ? `Engaging ${t.t.name}` : 'Holding position'
}

function UnitCard(p: CardProps & { u: Unit; squad: Unit[] }) {
  const { u, squad, me, w } = p
  const t = u.t
  const mine = u.owner === me
  const ab = t.ability ? ABILITIES[t.ability] : null
  return (
    <div className={`ew-panel ew-cmd is-unit ${mine ? '' : 'is-enemy'}`}>
      <div className="ew-cmd-side">
        {u.hps.length ? <Schematic u={u} size={104} /> : <img className="ew-portrait" src={spriteUrl(t.sprite)} alt="" />}
      </div>
      <div className="ew-cmd-main">
        <header className="ew-unithead">
          <strong>
            {t.name}
            {squad.length > 1 ? ` ×${squad.length}` : ''}
          </strong>
          <span className={`ew-tag ${mine ? '' : 'is-enemy'}`}>{mine ? t.tier : `enemy ${t.tier}`}</span>
        </header>
        <span className="ew-muted ew-small">{t.blurb}</span>
        <Vitals u={u} squad={squad} />
        {u.hps.length > 0 && <HpSummary u={u} />}
        {mine && techsFor(t.id).length > 0 && (
          <div className="ew-unittech">
            <span className="ew-muted ew-small">Upgrades</span>
            {techsFor(t.id).map((x) => (
              <TechTile key={x.id} id={x.id} w={w} me={me} hud={p.hud} onResearch={p.onResearch} />
            ))}
          </div>
        )}
        {mine && isShip(t) ? (
          <div className="ew-actions">
            <span className="ew-muted ew-small">{orderText(w, u)}</span>
            <button onClick={p.onAttackMode} title="Attack-move (R)">Attack-move</button>
            <button onClick={p.onStop} title="Stop (X)">Stop</button>
            {ab && (
              <button className="ew-ability" disabled={u.abilityCd > 0} onClick={p.onAbility} title={`${ab.blurb} (Q)`}>
                {ab.name}
                {u.abilityCd > 0 ? ` · ${Math.ceil(u.abilityCd)}s` : ''}
              </button>
            )}
            {u.kills > 0 && <span className="ew-muted ew-small">{u.kills} kills</span>}
          </div>
        ) : mine ? (
          <span className="ew-muted ew-small">{orderText(w, u)}</span>
        ) : (
          u.hps.length > 0 && <span className="ew-muted ew-small">Select your ships, hover this one and right-click a marker to target that hardpoint.</span>
        )}
      </div>
    </div>
  )
}

function GroupCard(p: CardProps) {
  const { sel } = p
  const types = new Map<string, Unit[]>()
  for (const u of sel) types.set(u.t.id, [...(types.get(u.t.id) ?? []), u])
  const ready = sel.filter((u) => u.t.ability && u.abilityCd <= 0).length
  const withAb = sel.filter((u) => u.t.ability).length
  return (
    <div className="ew-panel ew-cmd is-group">
      <div className="ew-cmd-main">
        <header className="ew-unithead">
          <strong>{sel.length} ships</strong>
          <span className="ew-muted ew-small">Click a type to keep only those, Shift-click to drop them.</span>
        </header>
        <div className="ew-group">
          {[...types.values()].map((us) => {
            const t = us[0].t
            const hull = us.reduce((s, u) => s + u.hull, 0) / us.reduce((s, u) => s + u.hullMax, 0)
            return (
              <button key={t.id} className="ew-group-item" onClick={(e) => p.onOnly(t.id, e.shiftKey)} title={t.name}>
                <img src={spriteUrl(t.sprite)} alt="" />
                <b>×{us.length}</b>
                <Bar value={hull} max={1} kind="hull" />
              </button>
            )
          })}
        </div>
        <div className="ew-actions">
          <button onClick={p.onAttackMode} title="Attack-move (R)">Attack-move</button>
          <button onClick={p.onStop} title="Stop (X)">Stop</button>
          {withAb > 0 && (
            <button className="ew-ability" disabled={!ready} onClick={p.onAbility} title="Every selected ship that can fires its ability (Q)">
              Abilities ({ready}/{withAb})
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// --- Overlays ---------------------------------------------------------------------------------------

export function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="ew-overlay" onClick={onClose}>
      <div className="ew-card ew-help" onClick={(e) => e.stopPropagation()}>
        <h2>Controls</h2>
        <dl>
          <dt>WASD · arrows</dt><dd>Move the camera (also middle-drag; wheel zooms)</dd>
          <dt>Left-drag</dt><dd>Select ships</dd>
          <dt>Click / Shift-click</dt><dd>Select / add; double-click selects that type on screen</dd>
          <dt>Right-click</dt><dd>Move, or attack what's under the cursor. On a hardpoint marker: target it</dd>
          <dt>R, then click</dt><dd>Attack-move</dd>
          <dt>X · Q</dt><dd>Stop · use ability</dd>
          <dt>H</dt><dd>Select the station (its shipyard builds ships)</dd>
          <dt>Ctrl+1–9 · 1–9</dt><dd>Set group · select group (twice to jump to it)</dd>
          <dt>Space · F</dt><dd>Jump to the last alert · to the selection</dd>
          <dt>P</dt><dd>Pause</dd>
          <dt>Ore</dt><dd>Keep ships at an ore asteroid to survey it; click it to build a mining or defense platform</dd>
          <dt>Touch</dt><dd>Drag to pan, pinch to zoom, tap a ship then tap where it should go</dd>
        </dl>
        <h3>Tips</h3>
        <ul>
          <li>Flak shreds fighters; turbolasers can't track them. Fighter torpedoes wreck cruisers and flagships.</li>
          <li>Missiles and torpedoes slip through shields. Destroyed shield generators cap the shields.</li>
          <li>Engines down: the ship crawls. Hangars down: no more fighters, and the shipyard slows.</li>
        </ul>
        <button className="ew-go" onClick={onClose}>Got it</button>
      </div>
    </div>
  )
}

export function Result({ w, me, won, difficulty, onAgain, onExit }: { w: World; me: Owner; won: boolean; difficulty: Difficulty; onAgain: () => void; onExit: () => void }) {
  const p = w.players[me]
  const e = w.players[other(me)]
  return (
    <div className="ew-overlay">
      <div className={`ew-card ew-result ${won ? 'is-won' : 'is-lost'}`}>
        <h2>{won ? 'Victory' : 'Defeat'}</h2>
        <p className="ew-muted">
          {won ? `The ${FACTIONS[e.faction].name} station is destroyed.` : `Our station has fallen.`} {clock(w.time)} against the {DIFFICULTY[difficulty].name.toLowerCase()}.
        </p>
        <table>
          <tbody>
            <tr><th /><th>Us</th><th>Them</th></tr>
            <tr><td>Ships built</td><td>{p.stats.built}</td><td>{e.stats.built}</td></tr>
            <tr><td>Kills</td><td>{p.stats.killed}</td><td>{e.stats.killed}</td></tr>
            <tr><td>Losses</td><td>{p.stats.lost}</td><td>{e.stats.lost}</td></tr>
            <tr><td>Credits earned</td><td>{fmt(p.stats.earned)}</td><td>{fmt(e.stats.earned)}</td></tr>
          </tbody>
        </table>
        <button className="ew-go" onClick={onAgain}>Fight again</button>
        <button onClick={onExit}>Back to title</button>
      </div>
    </div>
  )
}
