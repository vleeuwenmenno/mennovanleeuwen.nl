import { FACTIONS } from '../data.ts'
import { drawHull } from '../models/paint.ts'
import type { HullState, Model } from '../models/types.ts'
import { commandAreas, groundDrawSize, groundModel, shownTo, siteProgress, type Placement } from './build.ts'
import { explored, sees } from './fog.ts'
import { GROUND_UNIT, teamOf, typeOf, type GroundUnit, type GroundWorld, type Owner } from './sim.ts'
import { TF, TILE, type GroundMap } from './types.ts'

// What the ground battle screen draws on top of the terrain (GroundRenderer's hooks, in world
// coordinates): units and buildings, building sites, selection rings and health bars, the
// placement ghost, the fog of war and the enemy start spots; and the minimap. Units and buildings
// are their models from models/paint.ts (bitmaps cached by size and light heading, as ships are),
// or a plain marker in their faction's colour while a type has no model yet. Nothing here touches
// the sim: it only reads the world.

// Colours relative to the viewer, as in the space battle (render.ts).
export const OWN = '#7dffa0'
export const ALLY = '#5b9bff'
export const ENEMY = '#ff5a50'
export const relColor = (w: GroundWorld, me: Owner, o: Owner) => (o === me ? OWN : teamOf(w, o) === teamOf(w, me) ? ALLY : ENEMY)

const TAU = Math.PI * 2
const FRESH: HullState = { detached: 0, scorch: 0, variant: 0 }
const SHADOW = { dx: 4, dy: 6, alpha: 0.4 }

/** What the screen looks at the battle as. */
export type Look = {
  me: Owner
  team: number
  selected: Set<number>
  hover: number
  /** Health bars on damaged units (default), always, or only on selected and hovered ones. */
  bars: 'damaged' | 'always' | 'selected'
  /** Dev: the fog lifted, everything shown. */
  reveal: boolean
  /** CSS pixels per world unit, and device pixels per world unit. */
  zoom: number
  zdpr: number
  /** Seconds, real time: for the markers that fade. */
  now: number
}

/** A world rectangle: the view, with a margin. */
export type Box = { x0: number; y0: number; x1: number; y1: number }

const models = new Map<string, Model | null>()
/** The model a type is drawn with, built once (null while it has none). */
export function modelOf(type: string) {
  let m = models.get(type)
  if (m === undefined) {
    m = groundModel(type)
    models.set(type, m)
  }
  return m
}

/** How big a type is drawn, world units on its model's long side. */
export const bodySize = groundDrawSize

export const factionColor = (w: GroundWorld, o: Owner) => FACTIONS[w.players[o]?.faction ?? 'republic'].color

/** Whether unit `u` shows to the viewer now (build.ts shownTo: their side's always, except a
 * teammate's site nobody has started; anyone else's while in sight), or everything with the dev
 * reveal. */
export const seenNow = (w: GroundWorld, look: { me: Owner; reveal: boolean }, u: GroundUnit) => !u.dead && (look.reveal || shownTo(w, look.me, u))

/** The enemy buildings the viewer's side remembers but doesn't see now (as last seen: ghosts under
 * the fog's grey). */
export function* ghosts(w: GroundWorld, look: { me: Owner; team: number; reveal: boolean }) {
  const mem = w.memory[look.team]
  if (!mem) return
  for (const k of mem.values()) {
    const u = w.byId.get(k.id)
    if (u && seenNow(w, look, u)) continue
    yield k
  }
}

// --- Units and buildings ------------------------------------------------------------------------

function marker(ctx: CanvasRenderingContext2D, w: GroundWorld, type: string, owner: Owner, x: number, y: number, heading: number, tc: number, tr: number, px: number) {
  const t = GROUND_UNIT[type]
  const col = factionColor(w, owner)
  if (t?.foot) {
    const x0 = tc * TILE + 4, y0 = tr * TILE + 4
    const ww = t.foot[0] * TILE - 8, hh = t.foot[1] * TILE - 8
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'
    ctx.fillRect(x0 + 6, y0 + 8, ww, hh)
    ctx.fillStyle = col
    ctx.fillRect(x0, y0, ww, hh)
    ctx.fillStyle = 'rgba(10, 14, 22, 0.45)'
    ctx.fillRect(x0 + ww * 0.3, y0 + hh * 0.3, ww * 0.4, hh * 0.4)
    ctx.lineWidth = Math.max(2 * px, 3)
    ctx.strokeStyle = 'rgba(10, 14, 22, 0.85)'
    ctx.strokeRect(x0, y0, ww, hh)
    return
  }
  const r = (t?.radius ?? 12) * 0.95
  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'
  ctx.beginPath()
  ctx.arc(3, 5, r, 0, TAU)
  ctx.fill()
  ctx.rotate(heading)
  ctx.fillStyle = col
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, TAU)
  ctx.fill()
  ctx.lineWidth = Math.max(1.5 * px, r * 0.12)
  ctx.strokeStyle = 'rgba(10, 14, 22, 0.85)'
  ctx.stroke()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
  ctx.beginPath()
  ctx.moveTo(r * 0.1, -r * 0.45)
  ctx.lineTo(r * 1.05, 0)
  ctx.lineTo(r * 0.1, r * 0.45)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** A unit or building's body: its model, or the marker while it has none. Buildings face south and
 * don't turn; vehicles turn with their heading (models are drawn nose up). */
function body(ctx: CanvasRenderingContext2D, w: GroundWorld, type: string, owner: Owner, x: number, y: number, heading: number, tc: number, tr: number, look: Look, alpha: number) {
  const m = modelOf(type)
  const px = 1 / look.zoom
  const a = ctx.globalAlpha
  if (alpha < 1) ctx.globalAlpha = a * alpha
  if (m) {
    const building = !!GROUND_UNIT[type]?.foot
    drawHull(ctx, m, x, y, building ? 0 : heading + Math.PI / 2, bodySize(type), look.zdpr, FRESH, { shadow: SHADOW })
  } else marker(ctx, w, type, owner, x, y, heading, tc, tr, px)
  ctx.globalAlpha = a
}

/** A building site: the outline of its footprint, the building fading in as it goes up. */
function site(ctx: CanvasRenderingContext2D, w: GroundWorld, type: string, owner: Owner, x: number, y: number, tc: number, tr: number, p: number, col: string, look: Look) {
  const f = GROUND_UNIT[type]?.foot ?? [1, 1]
  const px = 1 / look.zoom
  ctx.setLineDash([6 * px, 5 * px])
  ctx.lineWidth = 1.5 * px
  ctx.strokeStyle = col
  ctx.strokeRect(tc * TILE + 2, tr * TILE + 2, f[0] * TILE - 4, f[1] * TILE - 4)
  ctx.setLineDash([])
  ctx.fillStyle = 'rgba(10, 14, 22, 0.35)'
  ctx.fillRect(tc * TILE + 2, tr * TILE + 2, f[0] * TILE - 4, f[1] * TILE - 4)
  body(ctx, w, type, owner, x, y, Math.PI / 2, tc, tr, look, 0.25 + 0.6 * p)
}

/** A bar under or over something: `f` of it filled, `col` for the fill. In screen-sized pixels. */
function bar(ctx: CanvasRenderingContext2D, cx: number, y: number, wide: number, f: number, col: string, px: number) {
  const h = 4 * px
  const x0 = cx - wide / 2
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)'
  ctx.fillRect(x0 - px, y - px, wide + 2 * px, h + 2 * px)
  ctx.fillStyle = col
  ctx.fillRect(x0, y, wide * Math.max(0, Math.min(1, f)), h)
}

const hullCol = (f: number) => (f > 0.6 ? '#7dffa0' : f > 0.3 ? '#f2c14a' : '#ff6a5e')

/** Units and buildings in view: enemy ones only where this team sees them (its buildings as last
 * seen elsewhere, under the fog's grey), then health bars and site progress. */
export function drawUnits(ctx: CanvasRenderingContext2D, w: GroundWorld, look: Look, box: Box) {
  const px = 1 / look.zoom
  const inBox = (x: number, y: number, r: number) => x + r >= box.x0 && x - r <= box.x1 && y + r >= box.y0 && y - r <= box.y1
  // Remembered enemy buildings not in sight now.
  for (const k of ghosts(w, look)) {
    const f = GROUND_UNIT[k.type]?.foot ?? [1, 1]
    const x = (k.tc + f[0] / 2) * TILE, y = (k.tr + f[1] / 2) * TILE
    if (inBox(x, y, bodySize(k.type))) body(ctx, w, k.type, k.owner, x, y, Math.PI / 2, k.tc, k.tr, look, 0.85)
  }
  // Buildings, then vehicles over them.
  for (let pass = 0; pass < 2; pass++)
    for (const u of w.units) {
      if (u.dead) continue
      const t = typeOf(u)
      if (!!t.foot !== (pass === 0)) continue
      if (!inBox(u.x, u.y, bodySize(u.type)) || !seenNow(w, look, u)) continue
      const p = siteProgress(u)
      if (p !== null) site(ctx, w, u.type, u.owner, u.x, u.y, u.tc, u.tr, p, relColor(w, look.me, u.owner), look)
      else body(ctx, w, u.type, u.owner, u.x, u.y, u.heading, u.tc, u.tr, look, 1)
    }
  // Engineers at work: a flickering welding spark at the nose.
  for (const u of w.units) {
    if (!u.busy || u.dead || !inBox(u.x, u.y, 40) || !seenNow(w, look, u)) continue
    const flick = Math.sin(look.now * 37 + u.id * 3.1) * 0.5 + 0.5
    const weld = FACTIONS[w.players[u.owner]?.faction ?? 'republic'].weld
    const r = typeOf(u).radius
    const x = u.x + Math.cos(u.heading) * r, y = u.y + Math.sin(u.heading) * r
    ctx.globalAlpha = 0.35 + 0.5 * flick
    ctx.fillStyle = weld.glow
    ctx.beginPath()
    ctx.arc(x, y, r * (0.45 + 0.25 * flick), 0, TAU)
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.fillStyle = weld.core
    ctx.beginPath()
    ctx.arc(x, y, r * 0.16, 0, TAU)
    ctx.fill()
  }
  // Bars: hull where it shows, a site's progress always.
  for (const u of w.units) {
    if (u.dead) continue
    const size = bodySize(u.type)
    if (!inBox(u.x, u.y, size) || !seenNow(w, look, u)) continue
    const t = typeOf(u)
    const p = siteProgress(u)
    const wide = Math.max(28 * px, size * 0.7)
    const top = t.foot ? u.tr * TILE - 9 * px : u.y - size * 0.55 - 8 * px
    const picked = look.selected.has(u.id) || look.hover === u.id
    const f = t.hull > 0 ? u.hull / t.hull : 1
    if (p !== null) bar(ctx, u.x, t.foot ? (u.tr + t.foot[1]) * TILE + 4 * px : top, wide, p, '#59c8ff', px)
    // A site's hull grows with it: shown only when picked.
    if (look.bars === 'always' || picked || (look.bars === 'damaged' && f < 0.999 && p === null)) bar(ctx, u.x, top, wide, f, hullCol(f), px)
  }
}

/** Selection and hover rings, on the ground under units. */
export function drawRings(ctx: CanvasRenderingContext2D, w: GroundWorld, look: Look) {
  const px = 1 / look.zoom
  const ring = (u: GroundUnit, col: string, alpha: number) => {
    const t = typeOf(u)
    ctx.globalAlpha = alpha
    ctx.strokeStyle = col
    ctx.lineWidth = 2 * px
    if (t.foot) {
      // Corner brackets round the footprint.
      const x0 = u.tc * TILE, y0 = u.tr * TILE, x1 = x0 + t.foot[0] * TILE, y1 = y0 + t.foot[1] * TILE
      const k = Math.min(TILE, (x1 - x0) / 4)
      ctx.beginPath()
      for (const [x, y, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
        ctx.moveTo(x + sx * k, y)
        ctx.lineTo(x, y)
        ctx.lineTo(x, y + sy * k)
      }
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.ellipse(u.x, u.y + t.radius * 0.1, t.radius * 1.3, t.radius * 1.15, 0, 0, TAU)
      ctx.stroke()
    }
  }
  for (const id of look.selected) {
    const u = w.byId.get(id)
    if (u && !u.dead && seenNow(w, look, u)) ring(u, relColor(w, look.me, u.owner), 0.95)
  }
  const h = look.hover && !look.selected.has(look.hover) ? w.byId.get(look.hover) : undefined
  if (h && !h.dead && seenNow(w, look, h)) ring(h, relColor(w, look.me, h.owner), 0.45)
  ctx.globalAlpha = 1
}

/** The order lines' colour, as the space battle's move lines (render.ts). */
const ROUTE = 'rgba(125,255,160,0.3)'

/**
 * Where our selected units are going: the current move (or the drive to a building site) along the
 * waypoints its path really takes, from where the unit is now, as a smooth curve (each waypoint
 * pulls the line towards it, the line passing halfway between them), as the space battle draws its
 * move lines. A walled-in move ends where the unit will stop. Queued orders follow as straight legs
 * from one destination to the next, and each destination gets a small dot.
 */
export function drawRoutes(ctx: CanvasRenderingContext2D, w: GroundWorld, look: Look) {
  const px = 1 / look.zoom
  ctx.strokeStyle = ROUTE
  ctx.fillStyle = ROUTE
  ctx.lineWidth = 1.5 * px
  for (const id of look.selected) {
    const u = w.byId.get(id)
    if (!u || u.dead || u.owner !== look.me || !u.orders.length) continue
    const o = u.orders[0]
    // The path is the current order's (it is found again at the next tick after a new order).
    const path = u.pv >= 0 ? u.path : []
    const end = u.short && path.length ? path[path.length - 1] : { x: o.x, y: o.y }
    const pts: { x: number; y: number }[] = [u]
    for (const p of path) if (p.x !== end.x || p.y !== end.y) pts.push(p)
    pts.push(end)
    ctx.beginPath()
    ctx.moveTo(u.x, u.y)
    for (let i = 1; i < pts.length - 1; i++) ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2)
    ctx.lineTo(end.x, end.y)
    // Queued orders: on from each destination to the next.
    for (let i = 1; i < u.orders.length; i++) ctx.lineTo(u.orders[i].x, u.orders[i].y)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(end.x, end.y, 3.5 * px, 0, TAU)
    for (let i = 1; i < u.orders.length; i++) {
      const q = u.orders[i]
      ctx.moveTo(q.x + 3.5 * px, q.y)
      ctx.arc(q.x, q.y, 3.5 * px, 0, TAU)
    }
    ctx.fill()
  }
}

/** Order markers: a ring that shrinks where a move or rally went, for a moment. */
export type Ping = { x: number; y: number; at: number; col: string }
const PING_S = 0.6
export function drawPings(ctx: CanvasRenderingContext2D, pings: Ping[], look: Look) {
  const px = 1 / look.zoom
  for (let i = pings.length - 1; i >= 0; i--) {
    const p = pings[i]
    const f = (look.now - p.at) / PING_S
    if (f >= 1 || f < 0) {
      pings.splice(i, 1)
      continue
    }
    ctx.globalAlpha = 1 - f
    ctx.strokeStyle = p.col
    ctx.lineWidth = 2 * px
    ctx.beginPath()
    ctx.arc(p.x, p.y, (16 - 10 * f) * px, 0, TAU)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/** A structure's rally point: a dashed line out to a small flag. */
export function drawRally(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, look: Look) {
  const px = 1 / look.zoom
  ctx.strokeStyle = OWN
  ctx.globalAlpha = 0.8
  ctx.lineWidth = 1.5 * px
  ctx.setLineDash([5 * px, 5 * px])
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x, to.y - 18 * px)
  ctx.stroke()
  ctx.fillStyle = OWN
  ctx.beginPath()
  ctx.moveTo(to.x, to.y - 18 * px)
  ctx.lineTo(to.x + 11 * px, to.y - 14 * px)
  ctx.lineTo(to.x, to.y - 10 * px)
  ctx.fill()
  ctx.globalAlpha = 1
}

/** The placement ghost: each tile of the footprint green or red, and the building over it. With no
 * tiles (building isn't in the game yet) a red box of the footprint's size round (x, y). */
export function drawGhost(ctx: CanvasRenderingContext2D, w: GroundWorld, type: string, p: Placement, x: number, y: number, look: Look) {
  const px = 1 / look.zoom
  const f = GROUND_UNIT[type]?.foot ?? [6, 6]
  if (!p.tiles.length) {
    const tc = Math.round(x / TILE - f[0] / 2), tr = Math.round(y / TILE - f[1] / 2)
    ctx.fillStyle = 'rgba(255, 80, 70, 0.4)'
    ctx.fillRect(tc * TILE, tr * TILE, f[0] * TILE, f[1] * TILE)
    ctx.strokeStyle = ENEMY
    ctx.lineWidth = 2 * px
    ctx.strokeRect(tc * TILE, tr * TILE, f[0] * TILE, f[1] * TILE)
    return
  }
  // Our command range, where a building may go (a standalone one, such as a Command Center, may go
  // anywhere explored away from the enemy instead).
  if (!GROUND_UNIT[type]?.standalone) {
    ctx.strokeStyle = OWN
    ctx.globalAlpha = 0.45
    ctx.lineWidth = 1.5 * px
    ctx.setLineDash([8 * px, 6 * px])
    for (const a of commandAreas(w, look.me)) {
      ctx.beginPath()
      ctx.arc(a.x, a.y, a.r, 0, TAU)
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }
  for (const t of p.tiles) {
    ctx.fillStyle = t.ok ? 'rgba(90, 255, 130, 0.32)' : 'rgba(255, 70, 60, 0.5)'
    ctx.fillRect(t.tc * TILE + 1, t.tr * TILE + 1, TILE - 2, TILE - 2)
  }
  // The row in front of its door, which must stay free: outlined only.
  ctx.lineWidth = 1.5 * px
  for (const t of p.door ?? []) {
    ctx.strokeStyle = t.ok ? 'rgba(90, 255, 130, 0.7)' : 'rgba(255, 70, 60, 0.85)'
    ctx.strokeRect(t.tc * TILE + 3, t.tr * TILE + 3, TILE - 6, TILE - 6)
  }
  const cx = (p.tc + f[0] / 2) * TILE, cy = (p.tr + f[1] / 2) * TILE
  if (GROUND_UNIT[type]) body(ctx, w, type, look.me, cx, cy, Math.PI / 2, p.tc, p.tr, look, 0.55)
  ctx.strokeStyle = p.why ? ENEMY : OWN
  ctx.lineWidth = 2 * px
  ctx.strokeRect(p.tc * TILE, p.tr * TILE, f[0] * TILE, f[1] * TILE)
}

/** The enemy start spots, marked from the first second (over the fog), as stations always show on
 * the space map. */
export function drawStarts(ctx: CanvasRenderingContext2D, w: GroundWorld, look: Look) {
  const px = 1 / look.zoom
  w.players.forEach((p, i) => {
    if (p.team === look.team) return
    const s = w.map.spawns[i]
    if (!s) return
    const r = 3.5 * TILE
    ctx.strokeStyle = ENEMY
    ctx.globalAlpha = 0.85
    ctx.lineWidth = 2.5 * px
    ctx.setLineDash([10 * px, 7 * px])
    ctx.beginPath()
    ctx.arc(s.x, s.y, r, 0, TAU)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(s.x + dx * (r - 10 * px), s.y + dy * (r - 10 * px))
      ctx.lineTo(s.x + dx * (r + 10 * px), s.y + dy * (r + 10 * px))
    }
    ctx.stroke()
    ctx.fillStyle = ENEMY
    ctx.beginPath()
    ctx.moveTo(s.x, s.y - 9 * px)
    ctx.lineTo(s.x + 9 * px, s.y)
    ctx.lineTo(s.x, s.y + 9 * px)
    ctx.lineTo(s.x - 9 * px, s.y)
    ctx.fill()
  })
  ctx.globalAlpha = 1
}

/** A box being dragged out to select, in world units. */
export function drawBox(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, look: Look) {
  const px = 1 / look.zoom
  ctx.fillStyle = 'rgba(125, 255, 160, 0.08)'
  ctx.strokeStyle = OWN
  ctx.lineWidth = 1.5 * px
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), ww = Math.abs(a.x - b.x), hh = Math.abs(a.y - b.y)
  ctx.fillRect(x, y, ww, hh)
  ctx.strokeRect(x, y, ww, hh)
}

// --- Fog ----------------------------------------------------------------------------------------

/**
 * The fog of war as one pixel per tile, scaled up over the map with smoothing so its edges come out
 * soft for one drawImage a frame: black where the team has never looked, grey over explored ground
 * (with the buildings last seen there under it), clear in sight. Filled again after each fog refresh,
 * with a small blur first (a binomial kernel, five tiles wide) so a sight disc's stepped edge reads
 * as a round, soft one once scaled up.
 */
export class FogShade {
  readonly canvas: HTMLCanvasElement
  private g: CanvasRenderingContext2D
  private img: ImageData
  private a: Float32Array
  private b: Float32Array
  private cols: number
  private rows: number
  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    this.canvas = document.createElement('canvas')
    this.canvas.width = cols
    this.canvas.height = rows
    this.g = this.canvas.getContext('2d')!
    this.img = this.g.createImageData(cols, rows)
    // One colour throughout, near black; only the alpha changes.
    for (let i = 0; i < cols * rows; i++) {
      this.img.data[i * 4] = 3
      this.img.data[i * 4 + 1] = 5
      this.img.data[i * 4 + 2] = 8
    }
    this.a = new Float32Array(cols * rows)
    this.b = new Float32Array(cols * rows)
  }
  update(w: GroundWorld, team: number, reveal: boolean) {
    const { cols, rows, a, b } = this
    const n = cols * rows
    for (let i = 0; i < n; i++) a[i] = reveal || sees(w.fog, team, i) ? 0 : explored(w.fog, team, i) ? 125 : 255
    // Blur [1 4 6 4 1] / 16 across, then down (edges clamped).
    const cl = (k: number, hi: number) => (k < 0 ? 0 : k > hi ? hi : k)
    for (let r = 0; r < rows; r++) {
      const o = r * cols
      for (let c = 0; c < cols; c++)
        b[o + c] = (a[o + cl(c - 2, cols - 1)] + 4 * a[o + cl(c - 1, cols - 1)] + 6 * a[o + c] + 4 * a[o + cl(c + 1, cols - 1)] + a[o + cl(c + 2, cols - 1)]) / 16
    }
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        a[r * cols + c] = (b[cl(r - 2, rows - 1) * cols + c] + 4 * b[cl(r - 1, rows - 1) * cols + c] + 6 * b[r * cols + c] + 4 * b[cl(r + 1, rows - 1) * cols + c] + b[cl(r + 2, rows - 1) * cols + c]) / 16
    const d = this.img.data
    for (let i = 0; i < n; i++) d[i * 4 + 3] = a[i]
    this.g.putImageData(this.img, 0, 0)
  }
  draw(ctx: CanvasRenderingContext2D, w: GroundWorld) {
    const smooth = ctx.imageSmoothingEnabled
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(this.canvas, 0, 0, w.w, w.h)
    ctx.imageSmoothingEnabled = smooth
  }
}

// --- Minimap ------------------------------------------------------------------------------------

const TERRAIN_RGB: [number, number, number][] = [
  [122, 98, 72], // dirt
  [93, 112, 64], // grass
  [138, 133, 126], // rocky
]

/** The minimap: the terrain painted once at a pixel a tile, then each draw the fog, buildings and
 * units as dots, the enemy start spots and the view's frame. */
export class MiniMap {
  readonly base: HTMLCanvasElement
  constructor(map: GroundMap) {
    const g = map.grid
    this.base = document.createElement('canvas')
    this.base.width = g.cols
    this.base.height = g.rows
    const x = this.base.getContext('2d')!
    const img = x.createImageData(g.cols, g.rows)
    for (let i = 0; i < g.cols * g.rows; i++) {
      let [r, gg, b] = TERRAIN_RGB[g.terrain[i]] ?? TERRAIN_RGB[0]
      let k = 0.78 + 0.14 * g.height[i]
      if (g.flags[i] & TF.water) [r, gg, b, k] = [53, 90, 122, 1]
      else if (g.flags[i] & TF.blocked) k *= 0.55
      img.data[i * 4] = Math.min(255, r * k)
      img.data[i * 4 + 1] = Math.min(255, gg * k)
      img.data[i * 4 + 2] = Math.min(255, b * k)
      img.data[i * 4 + 3] = 255
    }
    x.putImageData(img, 0, 0)
  }
  draw(g: CanvasRenderingContext2D, cw: number, ch: number, w: GroundWorld, look: Look, fog: FogShade, view: { x: number; y: number; w: number; h: number; zoom: number }) {
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.imageSmoothingEnabled = true
    g.drawImage(this.base, 0, 0, cw, ch)
    g.drawImage(fog.canvas, 0, 0, cw, ch)
    const sx = cw / w.w, sy = ch / w.h
    const dpr = cw / Math.max(1, g.canvas.clientWidth || cw)
    const dot = 3 * dpr
    for (const s of ghosts(w, look)) {
      const f = GROUND_UNIT[s.type]?.foot ?? [1, 1]
      g.fillStyle = ENEMY
      g.globalAlpha = 0.6
      g.fillRect(s.tc * TILE * sx, s.tr * TILE * sy, Math.max(dot, f[0] * TILE * sx), Math.max(dot, f[1] * TILE * sy))
    }
    g.globalAlpha = 1
    for (const u of w.units) {
      if (!seenNow(w, look, u)) continue
      const t = typeOf(u)
      g.fillStyle = look.selected.has(u.id) ? '#ffffff' : relColor(w, look.me, u.owner)
      if (t.foot) g.fillRect(u.tc * TILE * sx, u.tr * TILE * sy, Math.max(dot, t.foot[0] * TILE * sx), Math.max(dot, t.foot[1] * TILE * sy))
      else g.fillRect(u.x * sx - dot / 2, u.y * sy - dot / 2, dot, dot)
    }
    // Enemy start spots.
    g.strokeStyle = ENEMY
    g.lineWidth = 1.5 * dpr
    w.players.forEach((p, i) => {
      const s = w.map.spawns[i]
      if (!s || p.team === look.team) return
      g.beginPath()
      g.arc(s.x * sx, s.y * sy, 5 * dpr, 0, TAU)
      g.stroke()
    })
    // The view.
    const hw = view.w / 2 / view.zoom, hh = view.h / 2 / view.zoom
    g.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    g.lineWidth = 1 * dpr
    g.strokeRect((view.x - hw) * sx, (view.y - hh) * sy, hw * 2 * sx, hh * 2 * sy)
  }
}
