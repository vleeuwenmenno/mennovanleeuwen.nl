import { useRef } from 'react'
import { LEVEL_UP, MAX_LEVEL, MAX_RESEARCH, MODULE, TECH, UPGRADES, WORKS_NAME, buildable, modulesFor, techsFor, unitOf, worksOf, yardOf, type FactionId, type ModuleId, type UnitType, type Works } from './data'
import { HP_COLOR } from './icons'
import { HpIcon, Icon, TechIcon, fmt, levelBlurb, moduleState, moduleTip, researchName, techState, unitArt, type Hud, type TechStatus } from './Hud'
import { Modal } from './Menus'
import type { Owner, World } from './sim'
import { LongPress, isTouch, useCoarse } from './Touch'

// The tech tree: everything a faction can research, one line for the station (its levels and its
// own upgrades) and one per ship type, with prerequisites drawn as connectors. It opens over the
// battle without pausing it, as research screens do in most RTS games, so everything here is read
// live and the queue can be managed while the fight goes on.

// Tile sizes in px. The connectors are drawn in an SVG over a grid with these exact tracks, so the
// CSS grid and the lines agree without measuring anything.
const NODE_W = 236
const NODE_H = 84
const COL_GAP = 34
const LANE_GAP = 8
const HEAD_W = 132

/** A tile in the tree: a tech, or a station level (all of which research as LEVEL_UP). */
type TreeNode = { key: string; id: string; requires: string[]; level?: number }
type Line = { t: UnitType; nodes: TreeNode[] }

/** `hybrid`: a battle with yards, where the Capital Yard's research (Rushed construction) gets a line. */
function linesFor(faction: FactionId, hybrid: boolean): Line[] {
  const st = unitOf(faction, 'station')
  const levels: TreeNode[] = []
  for (let l = 2; l <= MAX_LEVEL; l++) levels.push({ key: `level-${l}`, id: LEVEL_UP, requires: l > 2 ? [`level-${l - 1}`] : [], level: l })
  const techs = (unitId: string): TreeNode[] => techsFor(unitId).map((t) => ({ key: t.id, id: t.id, requires: t.requires ?? [] }))
  const cyard = yardOf(faction, 'cyard')
  return [{ t: st, nodes: [...levels, ...techs(st.id)] }, ...(hybrid ? [{ t: cyard, nodes: techs(cyard.id) }] : []), ...buildable(faction).map((t) => ({ t, nodes: techs(t.id) }))]
}

/**
 * Place a line's tiles: a tile sits one column right of its furthest prerequisite and stays in its
 * first prerequisite's lane when that spot is free, so chains read left to right on one row.
 */
function layout(nodes: TreeNode[]) {
  const at = new Map<string, { col: number; lane: number }>()
  const taken = new Set<string>()
  let lanes = 0
  for (const n of nodes) {
    const reqs = n.requires.map((r) => at.get(r)).filter((p): p is { col: number; lane: number } => !!p)
    const col = reqs.length ? Math.max(...reqs.map((p) => p.col)) + 1 : 0
    let lane = reqs.length ? reqs[0].lane : lanes
    if (taken.has(`${col}:${lane}`)) lane = lanes
    lanes = Math.max(lanes, lane + 1)
    taken.add(`${col}:${lane}`)
    at.set(n.key, { col, lane })
  }
  return { at, lanes: Math.max(1, lanes), cols: Math.max(1, ...[...at.values()].map((p) => p.col + 1)) }
}

const nodeX = (col: number) => HEAD_W + COL_GAP + col * (NODE_W + COL_GAP)
const laneY = (lane: number) => lane * (NODE_H + LANE_GAP) + NODE_H / 2

type Props = {
  w: World; me: Owner; hud: Hud; onResearch: (id: string) => void; onCancel: (index: number) => void; onClose: () => void
  /** Hybrid bases: order an expansion on building `uid`, or call off the one at `index` in its queue. */
  onExpand?: (uid: number, id: ModuleId) => void
  onCancelExpand?: (uid: number, index: number) => void
}

export function TechTree({ w, me, hud, onResearch, onCancel, onClose, onExpand, onCancelExpand }: Props) {
  const faction = w.players[me].faction
  const lines = linesFor(faction, !!w.hybrid)
  const coarse = useCoarse()
  return (
    <Modal title="Tech tree" onClose={onClose} className="is-tree">
      <ResearchQueue hud={hud} onCancel={onCancel} />
      <p className="ew-muted ew-small ew-tt-hint">
        {coarse ? 'Tap a tile to queue it; long-press it or tap ✕ to cancel and get the credits back.' : 'Click a tile to queue it, right-click or ✕ to cancel and get the credits back.'} Research runs one at a time, in order. The battle carries on while this is open.
      </p>
      <div className="ew-tt-scroll">
        {w.hybrid && onExpand && onCancelExpand && (['station', 'yard', 'cyard'] as Works[]).map((k) => <BaseLine key={k} kind={k} w={w} me={me} hud={hud} faction={faction} onExpand={onExpand} onCancel={onCancelExpand} />)}
        {lines.map((line) => (
          <TreeLine key={line.t.id} line={line} w={w} me={me} hud={hud} faction={faction} onResearch={onResearch} onCancel={onCancel} />
        ))}
      </div>
    </Modal>
  )
}

/** The research queue: what's running, what waits behind it, and the empty slots. */
function ResearchQueue({ hud, onCancel }: { hud: Hud; onCancel: (index: number) => void }) {
  const press = useCancelPress()
  let wait = 0
  return (
    <div className="ew-tt-queue">
      <span className="ew-tt-qlabel">
        Research queue
        <b>
          {hud.research.length}/{MAX_RESEARCH}
        </b>
      </span>
      {Array.from({ length: MAX_RESEARCH }, (_, i) => {
        const r = hud.research[i]
        if (!r)
          return (
            <div key={i} className="ew-tt-slot is-empty">
              Empty slot
            </div>
          )
        // Only the first item runs; the rest start when everything ahead of them is done.
        const starts = wait
        wait += r.left
        return (
          <div
            key={i}
            className={`ew-tt-slot ${i === 0 ? 'is-busy' : ''}`}
            onContextMenu={(e) => {
              e.preventDefault()
              if (!press.touched()) onCancel(i)
            }}
            {...press.handlers(() => onCancel(i))}
          >
            <TechIcon id={r.id} size={34} progress={i === 0 ? 1 - r.left / r.total : 0} status={i === 0 ? 'busy' : 'queued'} />
            <span>
              <strong>{researchName(r.id, hud.level)}</strong>
              <small>{i === 0 ? `${Math.ceil(r.left)}s left` : `Starts in ${Math.ceil(starts)}s`}</small>
            </span>
            <button className="ew-close" onClick={() => onCancel(i)} data-tip="Cancel and refund" aria-label={`Cancel ${researchName(r.id, hud.level)}`}>
              ✕
            </button>
            {i === 0 && <i style={{ width: `${(1 - r.left / r.total) * 100}%` }} />}
          </div>
        )
      })}
      <span className="ew-tt-credits" data-tip="Credits">
        <Icon name="credits" size={16} />
        {fmt(hud.credits)}
      </span>
    </div>
  )
}

/**
 * Hybrid bases: one building's expansions as a line of the tree, the building at its head (with
 * where it stands: built, going up, or what it needs) and a tile per module, with what it does, its
 * price and time and where it stands. Click a tile to order it on the building, again to call it off.
 */
function BaseLine({ kind, w, me, hud, faction, onExpand, onCancel }: { kind: Works; w: World; me: Owner; hud: Hud; faction: FactionId; onExpand: (uid: number, id: ModuleId) => void; onCancel: (uid: number, index: number) => void }) {
  const art = unitArt
  const mods = modulesFor(kind)
  const t = kind === 'station' ? unitOf(faction, 'station') : yardOf(faction, kind)
  const u = kind === 'station' ? w.byId.get(w.players[me].station) : w.units.find((x) => !x.dead && x.owner === me && x.t.id === t.id)
  const head = kind === 'station' ? `Level ${hud.level} of ${MAX_LEVEL}` : !u ? (t.level > hud.level ? `Needs station level ${t.level}` : 'Not built yet: engineers build it') : u.site ? 'Going up' : 'Built'
  const width = nodeX(mods.length) - COL_GAP
  return (
    <section className="ew-tt-line is-base" style={{ gridTemplateColumns: `${HEAD_W}px repeat(${mods.length}, ${NODE_W}px)`, gridTemplateRows: `${NODE_H}px`, columnGap: COL_GAP, width }}>
      <div className={`ew-tt-head ${!u ? 'is-locked' : ''}`}>
        <img src={art(t.sprite)} alt="" />
        <strong>{WORKS_NAME[kind]}</strong>
        <small>{head}</small>
      </div>
      {mods.map((m, i) => {
        const s = moduleState(w, me, u, m.id)
        const status: TechStatus = s.status === 'built' ? 'done' : s.status === 'lost' ? 'poor' : s.status === 'busy' ? 'busy' : s.status === 'queued' ? 'queued' : s.status
        const queued = s.status === 'busy' || s.status === 'queued'
        const label = s.status === 'built' ? '✓ Built' : s.status === 'lost' ? 'Shot off: engineers weld it back' : s.status === 'busy' ? `${Math.ceil(s.left)}s left` : s.status === 'queued' ? `Queued, #${s.slot + 1}` : s.status === 'poor' ? (s.why === 'Not enough credits' ? `Need ${fmt(MODULE[m.id].cost - hud.credits)} more` : s.why ?? '') : 'Build'
        return (
          <div key={m.id} className={`ew-tnode is-${status}`} style={{ gridColumn: i + 2, gridRow: 1 }}>
            <button className="ew-tnode-main" disabled={s.status === 'built'} onClick={() => (queued ? onCancel(u!.id, s.slot) : u && (s.status === 'ready' || s.status === 'poor') ? onExpand(u.id, m.id) : undefined)}
              data-tip={`${moduleTip(m.id)}${s.why && !queued ? `\n\n${s.why}` : queued ? '\n\nClick to call it off (refunded).' : ''}`}>
              <span className="ew-modicon ew-tt-modicon" style={{ ['--c' as string]: HP_COLOR[m.kind] }}><HpIcon kind={m.kind} size={26} /></span>
              <span className="ew-tnode-text">
                <strong>{m.name}</strong>
                <small>{m.blurb}</small>
                <span className="ew-tnode-foot">
                  {s.status === 'locked' ? <em className="is-why">{s.why}</em> : (
                    <>
                      {s.status !== 'built' && (
                        <>
                          <span className="ew-cost"><Icon name="credits" size={12} /> {m.cost}</span>
                          <span className="ew-time"><Icon name="time" size={12} /> {m.time}s</span>
                        </>
                      )}
                      <em>{label}</em>
                    </>
                  )}
                </span>
              </span>
              {s.status === 'busy' && <i className="ew-tnode-bar" style={{ width: `${s.progress * 100}%` }} />}
            </button>
          </div>
        )
      })}
    </section>
  )
}

type LineProps = { line: Line; w: World; me: Owner; hud: Hud; faction: FactionId; onResearch: (id: string) => void; onCancel: (index: number) => void }

function TreeLine({ line, w, me, hud, faction, onResearch, onCancel }: LineProps) {
  const { t, nodes } = line
  const art = unitArt
  const station = t.tier === 'station'
  const { at, lanes, cols } = layout(nodes)
  const states = new Map(nodes.map((n) => [n.key, nodeState(w, me, hud, n)]))
  const width = nodeX(cols) - COL_GAP
  const height = lanes * (NODE_H + LANE_GAP) - LANE_GAP
  const locked = !station && t.level > hud.level
  // Connector style follows the tile it leads to: green once researched, bright while it can be
  // had, dim and dashed while it's still locked.
  const tone = (s: TechStatus) => (s === 'done' ? 'is-done' : s === 'locked' ? 'is-locked' : 'is-open')
  return (
    <section
      className={`ew-tt-line ${station ? 'is-station' : ''}`}
      style={{
        gridTemplateColumns: `${HEAD_W}px repeat(${cols}, ${NODE_W}px)`,
        gridTemplateRows: `repeat(${lanes}, ${NODE_H}px)`,
        columnGap: COL_GAP,
        rowGap: LANE_GAP,
        width,
      }}
    >
      <svg className="ew-tt-wires" width={width} height={height} aria-hidden="true">
        {nodes.map((n) => {
          const p = at.get(n.key)!
          const x = nodeX(p.col)
          const y = laneY(p.lane)
          const c = tone(states.get(n.key)!.status)
          // Roots hang off the line's header; everything else off its prerequisites.
          if (!n.requires.length) return <path key={n.key} className={c} d={`M${HEAD_W} ${height / 2}H${x - COL_GAP / 2}V${y}H${x}`} />
          return n.requires.map((r) => {
            const q = at.get(r)
            if (!q) return null
            return <path key={`${r}-${n.key}`} className={c} d={`M${nodeX(q.col) + NODE_W} ${laneY(q.lane)}H${x - COL_GAP / 2}V${y}H${x}`} />
          })
        })}
      </svg>
      <div className={`ew-tt-head ${locked ? 'is-locked' : ''}`} style={{ gridRow: `1 / span ${lanes}` }}>
        <img src={art(t.sprite)} alt="" />
        <strong>{station ? 'Station' : t.tier === 'yard' ? WORKS_NAME[worksOf(t) ?? 'cyard'] : t.name}</strong>
        <small>{station ? `Level ${hud.level} of ${MAX_LEVEL}` : locked ? `Needs station level ${t.level}` : t.tier === 'yard' ? (w.units.some((u) => !u.dead && u.owner === me && u.t.id === t.id && !u.site) ? 'Standing' : 'Not built yet') : t.squad > 1 ? `Squadron of ${t.squad}` : `${t.tier[0].toUpperCase()}${t.tier.slice(1)}`}</small>
      </div>
      {nodes.map((n) => {
        const p = at.get(n.key)!
        return (
          <Tile key={n.key} n={n} s={states.get(n.key)!} hud={hud} faction={faction} col={p.col} lane={p.lane} onResearch={onResearch} onCancel={onCancel} />
        )
      })}
    </section>
  )
}

type NodeState = ReturnType<typeof techState>

/** Station levels past the next one aren't something the queue knows about yet: they're locked. */
function nodeState(w: World, me: Owner, hud: Hud, n: TreeNode): NodeState {
  if (n.level === undefined || n.level === hud.level + 1) return techState(w, me, hud, n.id)
  if (n.level <= hud.level) return { status: 'done', why: null, slot: -1, progress: 0, left: 0 }
  return { status: 'locked', why: `Needs station level ${n.level - 1}`, slot: -1, progress: 0, left: 0 }
}

function Tile({ n, s, hud, faction, col, lane, onResearch, onCancel }: {
  n: TreeNode; s: NodeState; hud: Hud; faction: FactionId; col: number; lane: number; onResearch: (id: string) => void; onCancel: (index: number) => void
}) {
  const t = n.level ? null : TECH[n.id]
  const name = t ? t.name : `Station level ${n.level}`
  const price = t ? { cost: t.cost, time: t.time } : UPGRADES[n.level!]!
  const blurb = t ? t.blurb : levelBlurb(faction, n.level!)
  const queued = s.slot >= 0
  const press = useCancelPress()
  const label =
    s.status === 'done' ? '✓ Researched'
      : s.status === 'busy' ? `${Math.ceil(s.left)}s left`
        : s.status === 'queued' ? `Queued, #${s.slot + 1}`
          : s.status === 'poor' ? (s.why === 'Not enough credits' ? `Need ${fmt(price.cost - hud.credits)} more` : 'Queue full')
            : 'Research'
  return (
    <div className={`ew-tnode is-${s.status} ${n.level ? 'is-level' : ''}`} style={{ gridColumn: col + 2, gridRow: lane + 1 }}>
      <button
        className="ew-tnode-main"
        disabled={s.status === 'done'}
        onClick={() => {
          // Later station levels all research as LEVEL_UP, so only the next one may queue it.
          if (!queued && (n.level === undefined || n.level === hud.level + 1)) onResearch(n.id)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          if (queued && !press.touched()) onCancel(s.slot)
        }}
        {...press.handlers(queued ? () => onCancel(s.slot) : null)}
        data-tip={`${name}\n${blurb}${s.why && s.status !== 'done' && !queued ? `\n\n${s.why}` : ''}`}
      >
        <TechIcon id={n.id} size={52} progress={s.progress} status={s.status} />
        <span className="ew-tnode-text">
          <strong>{name}</strong>
          <small>{blurb}</small>
          <span className="ew-tnode-foot">
            {s.status === 'locked' ? (
              <em className="is-why">{s.why}</em>
            ) : (
              <>
                {s.status !== 'done' && (
                  <>
                    <span className="ew-cost"><Icon name="credits" size={12} /> {price.cost}</span>
                    <span className="ew-time"><Icon name="time" size={12} /> {price.time}s</span>
                  </>
                )}
                <em>{label}</em>
              </>
            )}
          </span>
        </span>
        {s.status === 'busy' && <i className="ew-tnode-bar" style={{ width: `${s.progress * 100}%` }} />}
      </button>
      {queued && (
        <button className="ew-tnode-x" onClick={() => onCancel(s.slot)} data-tip="Cancel and refund" aria-label={`Cancel ${name}`}>
          ✕
        </button>
      )}
    </div>
  )
}

/**
 * A finger's way to cancel research: a long press (with `cancel`; without one the handlers only
 * watch). The click that follows it is swallowed, so a cancelled tile isn't queued again at once,
 * and `touched` tells the context menu, which some phones open on a long press too, to leave it be.
 * The data-longpress mark keeps the long-press tooltip from showing as well.
 */
function useCancelPress() {
  const lp = useRef(new LongPress())
  const touch = useRef(false)
  return {
    touched: () => touch.current,
    handlers: (cancel: (() => void) | null) => ({
      ...(cancel ? { 'data-longpress': '' } : {}),
      onPointerDown: (e: React.PointerEvent) => {
        touch.current = isTouch(e)
        lp.current.fired = false
        if (cancel && isTouch(e)) lp.current.start(e, cancel)
      },
      onPointerMove: (e: React.PointerEvent) => void (isTouch(e) && lp.current.move(e)),
      onPointerUp: () => lp.current.cancel(),
      onPointerCancel: () => lp.current.cancel(),
      onClickCapture: (e: React.MouseEvent) => {
        if (lp.current.fired) {
          lp.current.fired = false
          e.preventDefault()
          e.stopPropagation()
        }
      },
    }),
  }
}
