import { CYARD_SOCKETS, MODULE, STATION_SOCKETS, YARD_SOCKETS, FACTIONS, REBUILD, SURVEY_RADIUS, UNIT, dims, isEngineer, isShip, moduleSprite, type HardpointKind, type Tier, type UnitType, type WeaponKind } from './data'
import { HP_COLOR, HP_ICON, hpName } from './icons'
import { rng, type MapDef, type Nebula, type Patch, type Pt, type Rect } from './maps'
import { RETREAT_TIME, atHome, building, foes, hpPos, radius, SALVAGE_RANGE, sensorOf, shieldFull, shieldMax, shipPoint, type Owner, type SimEvent, type Unit, type World } from './sim'
import { BREAK_WEIGHTS, breakPieces, hullState, modelFor, unitForSprite, wreckState, type HullState, type Model } from './models/index.ts'
import { YARD_BERTHS } from './models/base.ts'
import { bigType, sizedType } from './models/sizes.ts'
import { ModelFx } from './models/fx.ts'
import { PALETTES, hash, rng as seeded } from './models/kit.ts'
import { drawHull, drawMounts, drawPiece, liveEngines, outlineOf } from './models/paint.ts'
import { averageRings, moduleRing } from './ranges.ts'

// Drawing the battle on a 2D canvas: the painted backdrop and two star layers in parallax, nebulas
// and asteroid fields, ore, rocks and beacons, the ships (procedural cel-shaded models where a unit
// has one, see models/, otherwise generated sprites rotated in code; with engine glow, shield
// shimmer and hardpoint markers), laser bolts, explosions and smoke, then fog of war on top. The
// minimap is drawn here too.

const BASE = '/games/empires/'
export const spriteUrl = (name: string) =>
  name.startsWith('mod-') ? `${BASE}modules/${name.slice(4)}.webp` : `${BASE}${/^(mine|defense)-/.test(name) ? 'world' : 'ships'}/${name}.webp`
/** The order icons on map tags, the same shapes as the order cursors (32 px boxes). Made on first
 * use: Path2D only exists in a browser. */
const TAG_PATHS = {
  patrol: 'M6 13a10 10 0 0 1 17-5M26 19a10 10 0 0 1-17 5M23 3.5v4.8h-4.8M9 28.5v-4.8h4.8',
  guard: 'M16 4l9 3.5v7c0 6-4 10-9 12.5-5-2.5-9-6.5-9-12.5v-7z',
}
const tagIcons = new Map<string, Path2D>()
const tagIcon = (k: keyof typeof TAG_PATHS) => {
  let p = tagIcons.get(k)
  if (!p) tagIcons.set(k, (p = new Path2D(TAG_PATHS[k])))
  return p
}
const WORLD_SPRITES = ['asteroid-1', 'asteroid-2', 'asteroid-ore', 'beacon', 'backdrop']

export type Camera = { x: number; y: number; zoom: number }

// Colours relative to the viewer: us, our allies, everyone else.
export const OWN = '#7dffa0'
export const ALLY = '#5b9bff'
export const ENEMY = '#ff5a50'
/** A player's colour as the viewer sees it. */
export const relColor = (w: World, me: Owner, o: Owner) => (o === me ? OWN : w.players[o].team === w.players[me].team ? ALLY : ENEMY)
/** A team's colour as the viewer sees it (beacons and ore belong to teams). */
const teamColor = (w: World, me: Owner, team: number) => (team === w.players[me].team ? OWN : ENEMY)

export type View = {
  me: Owner
  /** Health bars: on damaged ships (the default), always, or only on selected and hovered ones. */
  bars: 'damaged' | 'always' | 'selected'
  /** A faint ring under every ship in its relative colour, to tell allies from enemies. */
  rings: boolean
  /** The fog grid overlay (F2): where our sight ends, cell by cell. */
  fogGrid?: boolean
  /** Dev cheat: no fog of war. */
  reveal?: boolean
  /** A structure's gun picked by clicking it, ringed. */
  turretPick?: { unit: number; hp: number } | null
  selected: Set<number>
  hover: number
  hoverHp: number
  /** Screen-space drag rectangle. */
  box: { x0: number; y0: number; x1: number; y1: number } | null
  /** The ore asteroid clicked on, or -1. */
  node: number
  hoverNode: number
  /** The wreck under the pointer, or 0. */
  hoverWreck: number
  /** A move line being drawn with the right button, and where each ship (or squadron) would go. */
  /** A right-drag being made: the drawn line (or, for one ship or squadron, where it goes and an
   * arrow the way it will face), and one spot per ship. */
  line?: {
    path: { x: number; y: number }[]
    spots: { x: number; y: number }[]
    attack: boolean
    ring: boolean
    face?: number | null
    /** A Shift-drag: the circle to attack in, and the enemies inside it now. */
    area?: { x: number; y: number; r: number; targets: { x: number; y: number; r: number }[] } | null
  } | null
  /** Before the battle starts: every player's start area, and where our station would go. */
  areas?: { r: Rect; color: string; label: string; mine: boolean }[]
  ghost?: { x: number; y: number; ok: boolean } | null
  /** A ship being dragged out of the reserve: where it would drop out, and whether it can. */
  warpGhost?: { sprite: string; x: number; y: number; a: number; size: number; ok: boolean; why: string | null; field: boolean } | null
  /** A player whose ships aren't drawn yet: ours, until we've picked where to start. */
  hideOwner?: number
  showRally: boolean
  /** Weapon range rings: round the ship or structure under the pointer, round the selected ones
   * (touch, which has no hover), or none (the setting is off). */
  ranges?: 'hover' | 'selected' | 'off'
  /** Draw units that have a procedural model with it (the default), or every unit as its sprite. */
  models?: boolean
  /** Hybrid bases: a yard being placed, its ghost where it would go (green where it can, red with
   * why where it can't) and the Command Station's build radius round it. */
  place?: { t: UnitType; x: number; y: number; a: number; ok: boolean; why: string | null; cost: number; rebuild: boolean; ring: { x: number; y: number; r: number } } | null
  /** The build radius, faintly, while the station or engineers are selected. */
  buildRing?: { x: number; y: number; r: number } | null
}

type Particle = {
  kind: 'spark' | 'fire' | 'smoke' | 'ring' | 'flash' | 'debris' | 'muzzle'
  x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; grow: number; color: string; rot: number; vr: number
}
type Pending = { at: number; x: number; y: number; size: number; final: boolean }
/** One small rock in an asteroid field, circling slowly round its spot as it tumbles. */
type FieldRock = { x: number; y: number; size: number; rot: number; spin: number; kind: number; orbit: number; phase: number; speed: number }
/** One layer of a nebula: a pre-painted cloud, turned slowly so the gas seems to churn. */
type CloudLayer = { img: HTMLCanvasElement; x: number; y: number; r: number; spin: number; add: boolean; phase: number }
type TerrainArt = { map: MapDef; clouds: CloudLayer[]; rocks: FieldRock[]; fields: Patch[] }

const TAU = Math.PI * 2
/** A bolt's length and width in world units, by kind. Under Big ship sizes they are slimmer and
 * longer, so they read as thin streaks of light next to the big hulls rather than fat dashes. */
const BOLTS = { turbo: [46, 5], flak: [10, 2.2], laser: [22, 2.6] } as const
const BOLTS_BIG = { turbo: [72, 3], flak: [15, 1.5], laser: [30, 1.7] } as const
/** An undamaged hull. */
const FRESH: HullState = { detached: 0, scorch: 0, variant: 0 }

/**
 * A nebula patch painted once into a small canvas (a quarter of world size; it's soft anyway):
 * dozens of overlapping coloured puffs, a few bright wisps, a few darker gaps, then faded out
 * towards the patch's edge, where its effect on ships ends.
 */
function cloudCanvas(n: Nebula, seed: number, bright: boolean) {
  const k = 0.25
  const R = n.r * 1.08
  const size = Math.max(8, Math.ceil(R * 2 * k))
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const r = rng(seed)
  const mid = size / 2
  const puff = (d: number, rad: number, color: (hue: number) => [string, string]) => {
    const a = r() * TAU
    const dd = Math.sqrt(r()) * d
    const x = mid + Math.cos(a) * dd
    const y = mid + Math.sin(a) * dd
    const pr = rad * (0.6 + r() * 0.8)
    const [c0, c1] = color(n.hue + (r() - 0.5) * 44)
    const grd = g.createRadialGradient(x, y, 0, x, y, pr)
    grd.addColorStop(0, c0)
    grd.addColorStop(1, c1)
    g.fillStyle = grd
    g.fillRect(x - pr, y - pr, pr * 2, pr * 2)
  }
  const nr = n.r * k
  for (let i = 0; i < (bright ? 14 : 30); i++)
    puff(nr * 0.75, nr * (bright ? 0.22 : 0.4), (h) => [`hsla(${h},78%,${48 + r() * 18}%,${(bright ? 0.1 : 0.17) + r() * 0.12})`, `hsla(${h},78%,40%,0)`])
  g.globalCompositeOperation = 'lighter'
  for (let i = 0; i < (bright ? 8 : 4); i++) puff(nr * 0.6, nr * 0.15, (h) => [`hsla(${h},95%,75%,${0.06 + r() * 0.08})`, `hsla(${h},95%,70%,0)`])
  g.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 5; i++) puff(nr * 0.8, nr * 0.18, () => [`rgba(0,0,0,${0.2 + r() * 0.2})`, 'rgba(0,0,0,0)'])
  g.globalCompositeOperation = 'destination-in'
  const edge = g.createRadialGradient(mid, mid, nr * 0.5, mid, mid, R * k)
  edge.addColorStop(0, 'rgba(0,0,0,1)')
  edge.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = edge
  g.fillRect(0, 0, size, size)
  return c
}

function terrainArt(map: MapDef): TerrainArt {
  const clouds: CloudLayer[] = []
  map.nebulas.forEach((n, i) => {
    const seed = map.seed * 31 + i * 977
    clouds.push({ img: cloudCanvas(n, seed, false), x: n.x, y: n.y, r: n.r * 1.08, spin: 0.006 + (i % 3) * 0.002, add: false, phase: i })
    clouds.push({ img: cloudCanvas(n, seed + 1, true), x: n.x, y: n.y, r: n.r * 1.08, spin: -0.011, add: true, phase: i + 2 })
  })
  const rocks: FieldRock[] = []
  map.fields.forEach((f, i) => {
    const r = rng(map.seed * 17 + i * 613)
    const count = Math.round(Math.min(180, Math.max(20, (f.r * f.r) / 1700)))
    for (let k = 0; k < count; k++) {
      const a = r() * TAU
      const d = Math.sqrt(r()) * (f.r - 12)
      rocks.push({
        x: f.x + Math.cos(a) * d, y: f.y + Math.sin(a) * d, size: 10 + r() ** 2 * 40, rot: r() * TAU, spin: (r() - 0.5) * 0.8, kind: r() < 0.5 ? 0 : 1,
        orbit: 6 + r() * 26, phase: r() * TAU, speed: (0.04 + r() * 0.1) * (r() < 0.5 ? -1 : 1),
      })
    }
  })
  return { map, clouds, rocks, fields: map.fields }
}

/** Nebulas and asteroid fields from above, for the minimap and the lobby's map previews: tinted
 * clouds, and dusty patches speckled with rocks. */
export function drawTerrainOverview(g: CanvasRenderingContext2D, map: MapDef, ox: number, oy: number, s: number) {
  for (const n of map.nebulas) {
    const x = ox + n.x * s
    const y = oy + n.y * s
    const r = n.r * s
    const grd = g.createRadialGradient(x, y, 0, x, y, r)
    grd.addColorStop(0, `hsla(${n.hue},70%,58%,0.34)`)
    grd.addColorStop(0.7, `hsla(${n.hue},70%,52%,0.22)`)
    grd.addColorStop(1, `hsla(${n.hue},70%,50%,0)`)
    g.fillStyle = grd
    g.beginPath()
    g.arc(x, y, r, 0, TAU)
    g.fill()
  }
  map.fields.forEach((f, i) => {
    const x = ox + f.x * s
    const y = oy + f.y * s
    const r = f.r * s
    g.fillStyle = 'rgba(175,150,115,0.2)'
    g.beginPath()
    g.arc(x, y, r, 0, TAU)
    g.fill()
    const rr = rng(i * 131 + 7)
    g.fillStyle = 'rgba(205,185,150,0.75)'
    const dots = Math.round(Math.min(26, Math.max(3, r * 0.9)))
    for (let k = 0; k < dots; k++) {
      const a = rr() * TAU
      const d = Math.sqrt(rr()) * r * 0.92
      const z = rr() < 0.25 ? 1.3 : 0.8
      g.fillRect(x + Math.cos(a) * d - z / 2, y + Math.sin(a) * d - z / 2, z, z)
    }
  })
}
type Ping = { x: number; y: number; t: number; color: string }
/** A ship jumping in, on the renderer's clock: charging from `start`, dropping out at `at`. */
type Warp = { x: number; y: number; a: number; size: number; sprite: string; unit: string; glow: string; start: number; at: number }
/** Seconds of the streak in before a ship drops out, and of the glow it leaves after. */
const STREAK = 0.32
const AFTER = 1.1

/** How each kind of gun's range ring looks: its colour (as r,g,b), dash pattern in screen pixels
 * (solid for lasers), and its name on the label. */
const RANGE_STYLE: Record<WeaponKind, { rgb: string; dash: number[]; name: string }> = {
  laser: { rgb: '255,128,112', dash: [], name: 'Lasers' },
  flak: { rgb: '255,196,92', dash: [9, 6], name: 'Flak' },
  turbo: { rgb: '122,190,255', dash: [22, 9], name: 'Turbolasers' },
  missile: { rgb: '255,140,222', dash: [3, 6], name: 'Missiles' },
  ion: { rgb: '176,146,255', dash: [14, 5, 3, 5], name: 'Ion cannon' },
}
const TIER_ORDER: Record<Tier, number> = { station: 0, yard: 0.5, mine: 1, defense: 1, capital: 2, cruiser: 3, frigate: 4, gunship: 5, fighter: 6 }
const ICON_PATH = new Map<HardpointKind, Path2D>()
const iconPath = (k: HardpointKind) => {
  let p = ICON_PATH.get(k)
  if (!p) ICON_PATH.set(k, (p = new Path2D(HP_ICON[k])))
  return p
}

function load(src: string) {
  const img = new Image()
  img.decoding = 'async'
  img.src = src
  return img
}

/** A soft white disc, for punching sight holes in the fog. */
function softDisc() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.7, 'rgba(255,255,255,0.95)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 128, 128)
  return c
}

/** A tile of stars: `n` dots, a few of them bright and tinted. */
function starTile(size: number, n: number, seed: number, bright: number) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  let s = seed
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < n; i++) {
    const x = r() * size
    const y = r() * size
    const big = r() < 0.08
    const a = 0.25 + r() * bright
    const hue = r() < 0.3 ? `rgba(170,200,255,${a})` : r() < 0.15 ? `rgba(255,220,190,${a})` : `rgba(255,255,255,${a})`
    g.fillStyle = hue
    g.beginPath()
    g.arc(x, y, big ? 1.3 : 0.7, 0, Math.PI * 2)
    g.fill()
  }
  return c
}

export class Renderer {
  private imgs = new Map<string, HTMLImageElement>()
  private cache = new Map<string, HTMLCanvasElement>()
  private parts: Particle[] = []
  private pending: Pending[] = []
  private pings: Ping[] = []
  private fog = document.createElement('canvas')
  private disc = softDisc()
  private stars = [starTile(512, 160, 7, 0.5), starTile(700, 90, 99, 0.75)]
  private patterns: (CanvasPattern | null)[] = []
  private clock = 0
  private smokeT = 0
  private terrain: TerrainArt | null = null
  /** Where each turret points, eased towards its target: by unit id * 64 + hardpoint. */
  private aims = new Map<number, number>()
  private warps: Warp[] = []
  /** Ships jumping out, on the renderer's clock from when they went. */
  private departs: Omit<Warp, 'at'>[] = []
  private dark = new Map<string, HTMLCanvasElement>()
  /** Procedural models' debris and broken hulls (all on screen only, see models/fx.ts). */
  private fx = new ModelFx()
  /** Every modelled unit seen last frame, with what had come off it then, so a part that comes
   * off (or a unit that dies) shows the moment it happens. */
  private tracked = new Map<number, { u: Unit; m: Model; det: number; st: HullState; dead: boolean[]; vis: boolean }>()
  /** Modelled warships that just died where we could see, until their wreck shows up: what had
   * already come off them carries over to the hulk. */
  private deaths: { x: number; y: number; det: number; at: number }[] = []
  /** Whether units are drawn with their models this frame (the setting). */
  private modelsOn = true
  /** The battle's ship sizes (sizes.ts), as of the last frame. */
  private sizes: World['sizes'] = undefined
  /** A unit type by id, at this battle's ship sizes. */
  private typeOf(id: string) {
    return sizedType(id, this.sizes)
  }

  constructor(sprites: string[]) {
    for (const s of sprites) this.imgs.set(s, load(spriteUrl(s)))
    for (const s of WORLD_SPRITES) this.imgs.set(s, load(`${BASE}world/${s}.webp`))
  }

  /** Resolves once every sprite has loaded (or failed), for a loading screen. */
  ready() {
    return Promise.all([...this.imgs.values()].map((i) => (i.complete ? Promise.resolve() : new Promise<void>((r) => ((i.onload = () => r()), (i.onerror = () => r()))))))
  }

  /** A sprite pre-shrunk to roughly the size it's drawn at: big downscales each frame alias and cost. */
  private sprite(name: string, px: number) {
    const img = this.imgs.get(name)
    if (!img || !img.complete || !img.naturalWidth) return null
    const nat = Math.max(img.naturalWidth, img.naturalHeight)
    let bucket = 32
    while (bucket < px * 1.5 && bucket < nat) bucket *= 2
    if (bucket >= nat) return img
    const k = `${name}@${bucket}`
    let c = this.cache.get(k)
    if (!c) {
      // Halve in steps for a clean result.
      let src: HTMLImageElement | HTMLCanvasElement = img
      let w = img.naturalWidth
      let h = img.naturalHeight
      const scale = bucket / nat
      while (w * 0.5 > img.naturalWidth * scale) {
        const t = document.createElement('canvas')
        t.width = Math.max(1, Math.round(w * 0.5))
        t.height = Math.max(1, Math.round(h * 0.5))
        t.getContext('2d')!.drawImage(src, 0, 0, t.width, t.height)
        src = t
        w = t.width
        h = t.height
      }
      c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.naturalWidth * scale))
      c.height = Math.max(1, Math.round(img.naturalHeight * scale))
      const g = c.getContext('2d')!
      g.imageSmoothingQuality = 'high'
      g.drawImage(src, 0, 0, c.width, c.height)
      this.cache.set(k, c)
    }
    return c
  }

  ping(x: number, y: number, color: string) {
    this.pings.push({ x, y, t: this.clock, color })
  }

  private add(p: Partial<Particle> & { x: number; y: number }) {
    if (this.parts.length > 2500) return
    this.parts.push({ kind: 'spark', vx: 0, vy: 0, life: 0.5, size: 3, grow: 0, color: '#fff', rot: Math.random() * 6.28, vr: 0, ...p, max: p.life ?? 0.5 })
  }

  private blast(x: number, y: number, size: number) {
    const n = Math.min(26, 5 + size / 8)
    this.add({ kind: 'flash', x, y, life: 0.25, size: size * 1.4, color: '#fff3d0' })
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28
      const v = (0.4 + Math.random()) * (60 + size * 1.6)
      this.add({ kind: 'fire', x: x + Math.cos(a) * size * 0.1, y: y + Math.sin(a) * size * 0.1, vx: Math.cos(a) * v * 0.35, vy: Math.sin(a) * v * 0.35, life: 0.5 + Math.random() * 0.6, size: size * (0.18 + Math.random() * 0.22), grow: size * 0.5, color: Math.random() < 0.5 ? '#ffb347' : '#ff6a2a' })
      this.add({ kind: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.4 + Math.random() * 0.5, size: 1.5 + Math.random() * 1.5, color: '#ffe9b0' })
    }
    for (let i = 0; i < n / 2; i++) {
      const a = Math.random() * 6.28
      const v = (0.2 + Math.random()) * (20 + size * 0.6)
      this.add({ kind: 'smoke', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1.2 + Math.random() * 1.4, size: size * 0.25, grow: size * 0.6, color: 'rgba(60,60,70,1)' })
    }
    if (size > 40) this.add({ kind: 'ring', x, y, life: 0.6, size: size * 0.3, grow: size * 3, color: '#ffd9a0' })
  }

  private debris(x: number, y: number, size: number, color: string) {
    for (let i = 0; i < Math.min(18, size / 10); i++) {
      const a = Math.random() * 6.28
      const v = 20 + Math.random() * 90
      this.add({ kind: 'debris', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 2 + Math.random() * 2, size: 2 + Math.random() * size * 0.05, color, vr: (Math.random() - 0.5) * 6 })
    }
  }

  /** Turns the sim's events into effects. Only what the viewer can see makes sparks. */
  consume(events: SimEvent[], w: World, me: Owner) {
    this.sizes = w.sizes
    const seen = (x: number, y: number) => {
      const team = w.players[me].team
      for (const u of w.units) if (w.players[u.owner].team === team && (u.x - x) ** 2 + (u.y - y) ** 2 < sensorOf(u) ** 2) return true
      return false
    }
    for (const e of events) {
      if (e.k === 'fire') {
        if (e.kind === 'turbo') this.add({ kind: 'muzzle', x: e.x, y: e.y, life: 0.12, size: 10, color: FACTIONS[w.players[e.owner].faction].bolt })
      } else if (e.k === 'hit') {
        if (e.shield) {
          this.add({ kind: 'ring', x: e.x, y: e.y, life: 0.25, size: 3, grow: 30, color: FACTIONS[w.players[e.owner].faction].glow })
        } else {
          for (let i = 0; i < (e.kind === 'turbo' || e.kind === 'missile' ? 7 : 3); i++) {
            const a = Math.random() * 6.28
            const v = 40 + Math.random() * 140
            this.add({ kind: 'spark', x: e.x, y: e.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.25 + Math.random() * 0.3, size: 1.2 + Math.random(), color: '#ffcf80' })
          }
          if (e.kind === 'turbo' || e.kind === 'missile') this.add({ kind: 'fire', x: e.x, y: e.y, life: 0.35, size: 6, grow: 22, color: '#ff8a3a' })
        }
      } else if (e.k === 'boom') {
        if (!seen(e.x, e.y)) continue
        const color = e.owner === undefined ? '#888' : w.players[e.owner].faction === 'republic' ? '#d8d2c8' : '#c8b48c'
        // A unit drawn with its model breaks into its own fragments (see trackModels): the old
        // flecks of debris are only for sprites. The battle's event doesn't say which unit it was,
        // so it is the one we were following that died on that spot.
        const modelled = this.modelsOn && [...this.tracked.values()].some((tr) => tr.u.dead && Math.abs(tr.u.x - e.x) < 1 && Math.abs(tr.u.y - e.y) < 1)
        if (e.tier === 'fighter' || e.tier === 'gunship') {
          this.blast(e.x, e.y, e.size * 1.2)
          if (!modelled) this.debris(e.x, e.y, e.size * 2, color)
        } else {
          // Big ships come apart in a chain of blasts before the final one.
          const n = Math.round(3 + e.size / 40)
          for (let i = 0; i < n; i++) {
            const a = Math.random() * 6.28
            const r = Math.random() * e.size * 0.4
            this.pending.push({ at: this.clock + i * (0.12 + Math.random() * 0.1), x: e.x + Math.cos(a) * r, y: e.y + Math.sin(a) * r, size: e.size * (0.25 + Math.random() * 0.2), final: false })
          }
          this.pending.push({ at: this.clock + n * 0.17, x: e.x, y: e.y, size: e.size, final: true })
          if (!modelled) this.debris(e.x, e.y, e.size, color)
        }
      } else if (e.k === 'warp') {
        if (e.owner !== me && !seen(e.x, e.y)) continue
        const t = this.typeOf(e.unit)
        this.warps.push({ x: e.x, y: e.y, a: e.a, size: t.size, sprite: t.sprite, unit: t.id, glow: FACTIONS[t.faction].glow, start: this.clock, at: this.clock + e.delay })
      } else if (e.k === 'retreated') {
        if (e.owner !== me && !seen(e.x, e.y)) continue
        const t = this.typeOf(e.unit)
        const glow = FACTIONS[t.faction].glow
        this.departs.push({ x: e.x, y: e.y, a: e.a, size: t.size, sprite: t.sprite, unit: t.id, glow, start: this.clock })
        this.add({ kind: 'flash', x: e.x, y: e.y, life: 0.3, size: t.size * 0.7, grow: t.size * 0.4, color: glow })
        this.add({ kind: 'ring', x: e.x, y: e.y, life: 0.6, size: t.size * 0.3, grow: t.size * 1.8, color: '#e8f6ff' })
      } else if (e.k === 'arrived') {
        if (e.owner !== me && !seen(e.x, e.y)) continue
        this.arrival(e.x, e.y, e.a, this.typeOf(e.unit).size, FACTIONS[UNIT[e.unit].faction].glow, e.field)
      } else if (e.k === 'rankUp') {
        this.add({ kind: 'ring', x: e.x, y: e.y, life: 0.8, size: 20, grow: 90, color: '#f2c14a' })
      } else if (e.k === 'hpdown') {
        this.blast(e.x, e.y, 34)
      } else if (e.k === 'built' || e.k === 'launch') {
        this.add({ kind: 'ring', x: e.x, y: e.y, life: 0.5, size: 10, grow: 60, color: '#9fe8ff' })
      } else if (e.k === 'ability') {
        this.add({ kind: 'ring', x: e.x, y: e.y, life: 0.9, size: 40, grow: e.id === 'tractor' ? 1300 : 300, color: e.id === 'tractor' ? '#7ff0ff' : '#fff0a0' })
      }
    }
  }

  private step(dt: number, w: World) {
    this.clock += dt
    this.fx.step(dt)
    for (const p of this.pending) {
      if (p.at > this.clock) continue
      this.blast(p.x, p.y, p.size)
      if (p.final) this.add({ kind: 'ring', x: p.x, y: p.y, life: 1, size: p.size * 0.4, grow: p.size * 4, color: '#ffe6b0' })
    }
    this.pending = this.pending.filter((p) => p.at > this.clock)
    // Burning ships and wrecked hardpoints trail smoke.
    this.smokeT -= dt
    if (this.smokeT <= 0) {
      this.smokeT = 0.12
      // Crews cutting into a hulk throw sparks.
      for (const h of w.wrecks) {
        if (h.team === -1 || Math.random() > 0.55) continue
        const a = Math.random() * Math.PI * 2
        const d = Math.random() * h.size * 0.3
        const x = h.x + Math.cos(a) * d
        const y = h.y + Math.sin(a) * d
        for (let i = 0; i < 3; i++) {
          const b = Math.random() * Math.PI * 2
          const v = 30 + Math.random() * 90
          this.add({ kind: 'spark', x, y, vx: Math.cos(b) * v, vy: Math.sin(b) * v, life: 0.3 + Math.random() * 0.3, size: 1.2, color: '#ffd27a' })
        }
      }
      for (const u of w.units) {
        u.hps.forEach((h, i) => {
          if (h.hp > 0 || Math.random() > 0.5) return
          const p = hpPos(u, i)
          this.add({ kind: 'smoke', x: p.x, y: p.y, vx: (Math.random() - 0.5) * 20, vy: (Math.random() - 0.5) * 20, life: 1.4, size: 5, grow: 26, color: 'rgba(50,50,58,1)' })
          if (Math.random() < 0.4) this.add({ kind: 'fire', x: p.x, y: p.y, life: 0.3, size: 4, grow: 6, color: '#ff8a3a' })
        })
        if (u.hull < u.hullMax * 0.4 && u.t.tier !== 'fighter' && Math.random() < 0.5) {
          const p = shipPoint(u, 2 + Math.random() * 6, 2 + Math.random() * 6)
          this.add({ kind: 'smoke', x: p.x, y: p.y, vx: 0, vy: 0, life: 1.2, size: 4, grow: radius(u.t) * 0.3, color: 'rgba(55,55,62,1)' })
        }
      }
    }
    for (const p of this.parts) {
      p.life -= dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      const drag = p.kind === 'smoke' ? 0.97 : p.kind === 'debris' ? 0.995 : 0.94
      p.vx *= drag
      p.vy *= drag
      p.rot += p.vr * dt
    }
    this.parts = this.parts.filter((p) => p.life > 0)
  }

  draw(ctx: CanvasRenderingContext2D, w: World, cam: Camera, vw: number, vh: number, view: View, dt: number) {
    this.sizes = w.sizes
    this.step(dt, w)
    // Switched back on: start tracking afresh, so nothing that happened meanwhile bursts now.
    if (view.models !== false && !this.modelsOn) this.tracked.clear()
    this.modelsOn = view.models !== false
    if (this.modelsOn) this.trackModels(w, view)
    const z = cam.zoom
    const zdpr = z * (window.devicePixelRatio || 1)
    ctx.save()
    ctx.fillStyle = '#04060d'
    ctx.fillRect(0, 0, vw, vh)

    // Backdrop and stars, sliding slower than the battle for depth.
    const bg = this.imgs.get('backdrop')
    if (bg?.complete && bg.naturalWidth) {
      const s = Math.max(vw / bg.naturalWidth, vh / bg.naturalHeight) * 1.25
      const bw = bg.naturalWidth * s
      const bh = bg.naturalHeight * s
      const fx = (cam.x / w.w - 0.5) * (bw - vw)
      const fy = (cam.y / w.h - 0.5) * (bh - vh)
      ctx.globalAlpha = 0.9
      ctx.drawImage(bg, (vw - bw) / 2 - fx, (vh - bh) / 2 - fy, bw, bh)
      ctx.globalAlpha = 1
    }
    this.stars.forEach((tile, i) => {
      this.patterns[i] ??= ctx.createPattern(tile, 'repeat')
      const pat = this.patterns[i]
      if (!pat) return
      const par = i === 0 ? 0.12 : 0.3
      const sc = 0.6 + z * (i === 0 ? 0.25 : 0.5)
      ctx.save()
      ctx.translate(vw / 2, vh / 2)
      ctx.scale(sc, sc)
      ctx.translate(-cam.x * par, -cam.y * par)
      ctx.fillStyle = pat
      const ext = Math.max(vw, vh) / sc
      ctx.fillRect(cam.x * par - ext, cam.y * par - ext, ext * 2, ext * 2)
      ctx.restore()
    })

    // A fleet battle's planet: huge and far off, sliding slower than the battle.
    const pl = w.map.planet
    if (pl) {
      const key = `planet-${pl.kind}`
      if (!this.imgs.has(key)) this.imgs.set(key, load(`${BASE}planets/${pl.kind}.webp`))
      const img = this.imgs.get(key)!
      if (img.complete && img.naturalWidth) {
        const par = 0.3
        const sc = 0.5 + z * 0.3
        const x = vw / 2 + (pl.x - cam.x) * par * sc
        const y = vh / 2 + (pl.y - cam.y) * par * sc
        const rad = pl.r * sc
        // Dimmed, so the ships in front of it stay easy to read.
        ctx.globalAlpha = 0.62
        ctx.drawImage(img, x - rad, y - rad, rad * 2, rad * 2)
        // Its night side fades into space.
        const shade = ctx.createRadialGradient(x - rad * 0.35, y - rad * 0.35, rad * 0.2, x, y, rad * 1.05)
        shade.addColorStop(0, 'rgba(4,6,13,0.2)')
        shade.addColorStop(0.75, 'rgba(4,6,13,0.4)')
        shade.addColorStop(1, 'rgba(4,6,13,0.75)')
        ctx.fillStyle = shade
        ctx.beginPath()
        ctx.arc(x, y, rad, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
      }
    }

    // The world.
    ctx.translate(vw / 2, vh / 2)
    ctx.scale(z, z)
    ctx.translate(-cam.x, -cam.y)
    const left = cam.x - vw / 2 / z - 300
    const right = cam.x + vw / 2 / z + 300
    const top = cam.y - vh / 2 / z - 300
    const bottom = cam.y + vh / 2 / z + 300
    const onScreen = (x: number, y: number, r = 0) => x + r > left && x - r < right && y + r > top && y - r < bottom

    // Past the map's edge (the camera may run out there): dim, so the edge reads at a glance.
    if (left < 0 || top < 0 || right > w.w || bottom > w.h) {
      ctx.fillStyle = 'rgba(2,4,10,0.5)'
      ctx.beginPath()
      ctx.rect(left, top, right - left, bottom - top)
      ctx.rect(0, 0, w.w, w.h)
      ctx.fill('evenodd')
    }
    ctx.strokeStyle = 'rgba(140,170,220,0.3)'
    ctx.lineWidth = 2 / z
    ctx.setLineDash([24 / z, 18 / z])
    ctx.strokeRect(0, 0, w.w, w.h)
    ctx.setLineDash([])

    this.drawTerrain(ctx, w, z, onScreen)

    // Picking start positions: each player's area, ours brighter, and the station's footprint
    // under the pointer (red where it can't go).
    if (view.areas) {
      for (const a of view.areas) {
        ctx.fillStyle = a.color
        ctx.globalAlpha = a.mine ? 0.1 : 0.05
        ctx.fillRect(a.r.x, a.r.y, a.r.w, a.r.h)
        ctx.globalAlpha = a.mine ? 0.9 : 0.5
        ctx.strokeStyle = a.color
        ctx.lineWidth = (a.mine ? 3 : 2) / z
        ctx.setLineDash(a.mine ? [] : [16 / z, 12 / z])
        ctx.strokeRect(a.r.x, a.r.y, a.r.w, a.r.h)
        ctx.setLineDash([])
        ctx.fillStyle = a.color
        ctx.font = `700 ${13 / z}px system-ui, sans-serif`
        ctx.textBaseline = 'top'
        ctx.fillText(a.label, a.r.x + 10 / z, a.r.y + 8 / z)
        ctx.textBaseline = 'alphabetic'
      }
      ctx.globalAlpha = 1
      const g = view.ghost
      if (g) {
        ctx.strokeStyle = g.ok ? '#7dffa0' : '#ff5a50'
        ctx.fillStyle = g.ok ? 'rgba(125,255,160,0.12)' : 'rgba(255,90,80,0.12)'
        ctx.lineWidth = 2 / z
        ctx.beginPath()
        ctx.arc(g.x, g.y, 260, 0, TAU)
        ctx.fill()
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(g.x - 60, g.y)
        ctx.lineTo(g.x + 60, g.y)
        ctx.moveTo(g.x, g.y - 60)
        ctx.lineTo(g.x, g.y + 60)
        ctx.stroke()
      }
    }

    // Beacons, with their capture ring.
    for (const b of w.beacons) {
      if (!onScreen(b.x, b.y, 400)) continue
      const col = b.owner === -1 ? 'rgba(200,210,230,0.5)' : teamColor(w, view.me, b.owner)
      ctx.strokeStyle = col
      ctx.globalAlpha = 0.35
      ctx.lineWidth = 2 / z
      ctx.setLineDash([10 / z, 10 / z])
      ctx.beginPath()
      ctx.arc(b.x, b.y, 320, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
      // A pulsing glow in the holder's colour, so beacons stand out when zoomed out.
      const glow = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, 150)
      glow.addColorStop(0, b.owner === -1 ? '#c8d4ee' : col)
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = 0.28 + Math.sin(this.clock * 2 + b.id) * 0.08
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(b.x, b.y, 150, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      this.drawSprite(ctx, 'beacon', b.x, b.y, this.clock * 0.15 + b.id, 170, z)
      if (b.progress > 0 && b.claim >= 0) {
        ctx.strokeStyle = teamColor(w, view.me, b.claim)
        ctx.lineWidth = 7 / Math.max(z, 0.4)
        ctx.beginPath()
        ctx.arc(b.x, b.y, 95, -Math.PI / 2, -Math.PI / 2 + b.progress * Math.PI * 2)
        ctx.stroke()
      }
    }

    // Wrecks: dimmed hulks turning slowly, ringed by what's left to salvage.
    const myTeamW = w.players[view.me].team
    for (const h of w.wrecks) {
      if (!onScreen(h.x, h.y, h.size)) continue
      const fade = Math.min(1, h.decay / 20)
      // A modelled warship's hull lies here as it broke; anything else is its sprite, burnt dark.
      this.fx.setAlpha(h.id, fade)
      if (!this.modelsOn || !this.fx.drawHulk(ctx, h.id, zdpr)) {
        ctx.filter = 'brightness(0.42) saturate(0.35) sepia(0.25)'
        this.drawSprite(ctx, h.sprite, h.x, h.y, h.rot + this.clock * 0.012 * (h.id % 2 ? 1 : -1), h.size, z, 0.95 * fade)
        ctx.filter = 'none'
      }
      const rr = h.size * 0.55 + 20
      ctx.globalAlpha = fade
      ctx.strokeStyle = h.team === myTeamW ? '#f2c14a' : 'rgba(242,193,74,0.4)'
      ctx.lineWidth = (h.team === -1 ? 1.5 : 3) / z
      ctx.setLineDash(h.team === -1 ? [6 / z, 8 / z] : [])
      ctx.beginPath()
      ctx.arc(h.x, h.y, rr, -Math.PI / 2, -Math.PI / 2 + (h.left / h.value) * Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      // Hovered: show how close ships have to come to strip it.
      if (view.hoverWreck === h.id) {
        ctx.strokeStyle = 'rgba(242,193,74,0.3)'
        ctx.lineWidth = 1.5 / z
        ctx.setLineDash([10 / z, 10 / z])
        ctx.beginPath()
        ctx.arc(h.x, h.y, SALVAGE_RANGE + h.size * 0.25, 0, TAU)
        ctx.stroke()
        ctx.setLineDash([])
      }
      if (z > 0.3 && view.hoverWreck !== h.id) {
        ctx.fillStyle = '#f2c14a'
        ctx.font = `600 ${12 / z}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText(`${Math.ceil(h.left)} cr`, h.x, h.y - rr - 6 / z)
        ctx.textAlign = 'start'
      }
      ctx.globalAlpha = 1
    }
    // Hulks whose wreck was just salvaged or drifted off, fading out.
    if (this.modelsOn) this.fx.drawFading(ctx, zdpr)
    this.drawRuins(ctx, w, view, z, zdpr, onScreen)

    // Ore, with its survey ring: dashed while unclaimed, in the holder's colour once surveyed, and
    // an arc for a survey under way.
    for (const n of w.nodes) {
      if (!onScreen(n.x, n.y, SURVEY_RADIUS + 40)) continue
      const mine = n.owner === w.players[view.me].team
      const mineCol = n.owner === -1 ? 'rgba(170,230,255,0.35)' : mine ? 'rgba(125,255,160,0.55)' : 'rgba(255,90,80,0.55)'
      if (!n.site) {
        ctx.strokeStyle = mineCol
        ctx.lineWidth = 1.5 / z
        ctx.setLineDash(n.owner === -1 ? [10 / z, 12 / z] : [])
        ctx.beginPath()
        ctx.arc(n.x, n.y, SURVEY_RADIUS, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
        if (n.progress > 0 && n.progress < 1 && n.claim >= 0) {
          ctx.strokeStyle = teamColor(w, view.me, n.claim)
          ctx.lineWidth = 6 / Math.max(z, 0.4)
          ctx.beginPath()
          ctx.arc(n.x, n.y, 112, -Math.PI / 2, -Math.PI / 2 + n.progress * Math.PI * 2)
          ctx.stroke()
        }
      }
      if (view.node === n.id || view.hoverNode === n.id) {
        ctx.strokeStyle = view.node === n.id ? '#7dffa0' : 'rgba(125,255,160,0.5)'
        ctx.lineWidth = (view.node === n.id ? 3 : 2) / z
        ctx.beginPath()
        ctx.arc(n.x, n.y, 128 + Math.sin(this.clock * 4) * 5, 0, Math.PI * 2)
        ctx.stroke()
      }
      this.drawSprite(ctx, 'asteroid-ore', n.x, n.y, n.rot, 170, z)
    }
    for (const r of w.rocks) {
      if (!onScreen(r.x, r.y, r.r * 1.6)) continue
      this.drawSprite(ctx, r.kind ? 'asteroid-2' : 'asteroid-1', r.x, r.y, r.rot, r.r * 2.3, z)
    }

    // A move line being drawn: the stroke, and a marker where each ship will end up.
    // Green to move, orange to attack-move; a closed loop shows closed, as the ring it'll make.
    if (view.line?.area) {
      // The circle being drawn, filled faintly, each enemy inside it marked.
      const a = view.line.area
      ctx.strokeStyle = '#ff5a50'
      ctx.fillStyle = 'rgba(255,90,80,0.07)'
      ctx.lineWidth = 2.5 / z
      ctx.setLineDash([14 / z, 9 / z])
      ctx.lineDashOffset = -this.clock * 40 / z
      ctx.beginPath()
      ctx.arc(a.x, a.y, a.r, 0, TAU)
      ctx.fill()
      ctx.stroke()
      ctx.setLineDash([])
      ctx.lineWidth = 1.5 / z
      ctx.beginPath()
      ctx.moveTo(a.x - 10 / z, a.y)
      ctx.lineTo(a.x + 10 / z, a.y)
      ctx.moveTo(a.x, a.y - 10 / z)
      ctx.lineTo(a.x, a.y + 10 / z)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(255,120,100,0.9)'
      for (const t of a.targets) {
        ctx.beginPath()
        ctx.arc(t.x, t.y, Math.max(8 / z, t.r), 0, TAU)
        ctx.stroke()
      }
    } else if (view.line) {
      const col = view.line.attack ? '#ffaa5a' : '#7dffa0'
      ctx.strokeStyle = col
      ctx.globalAlpha = 0.75
      ctx.lineWidth = 2.5 / z
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      const face = view.line.face
      if (face != null) {
        // The facing arrow: from where it goes, as long as the drag, with a head.
        const a = view.line.path[0]
        const b = view.line.path[view.line.path.length - 1]
        const len = Math.max(40 / z, Math.hypot(b.x - a.x, b.y - a.y))
        const tx = a.x + Math.cos(face) * len
        const ty = a.y + Math.sin(face) * len
        const head = Math.min(len * 0.4, 18 / z)
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(tx, ty)
        ctx.moveTo(tx - Math.cos(face - 0.5) * head, ty - Math.sin(face - 0.5) * head)
        ctx.lineTo(tx, ty)
        ctx.lineTo(tx - Math.cos(face + 0.5) * head, ty - Math.sin(face + 0.5) * head)
      } else view.line.path.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)))
      if (view.line.ring) ctx.closePath()
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillStyle = col
      // One dot per ship: a squadron shows each fighter's place.
      for (const q of view.line.spots) {
        ctx.beginPath()
        ctx.arc(q.x, q.y, 4.5 / z, 0, TAU)
        ctx.fill()
      }
    }

    // Rally point and order lines for the selection.
    const p = w.players[view.me]
    if (view.showRally) {
      ctx.strokeStyle = 'rgba(125,255,160,0.5)'
      ctx.lineWidth = 1.5 / z
      ctx.setLineDash([8 / z, 8 / z])
      const st = w.byId.get(p.station)
      if (st) {
        ctx.beginPath()
        ctx.moveTo(st.x, st.y)
        ctx.lineTo(p.rally.x, p.rally.y)
        ctx.stroke()
      }
      ctx.setLineDash([])
      ctx.fillStyle = '#7dffa0'
      ctx.beginPath()
      ctx.moveTo(p.rally.x, p.rally.y)
      ctx.lineTo(p.rally.x, p.rally.y - 46)
      ctx.lineTo(p.rally.x + 28, p.rally.y - 38)
      ctx.lineTo(p.rally.x, p.rally.y - 30)
      ctx.fill()
      ctx.fillRect(p.rally.x - 1.5, p.rally.y - 46, 3, 46)
    }
    // Selected yards' own rally points, in the yard colour.
    for (const id of view.selected) {
      const y = w.byId.get(id)
      if (!y || y.owner !== view.me || y.t.tier !== 'yard' || !y.yr) continue
      ctx.strokeStyle = 'rgba(255,200,110,0.55)'
      ctx.lineWidth = 1.5 / z
      ctx.setLineDash([8 / z, 8 / z])
      ctx.beginPath()
      ctx.moveTo(y.x, y.y)
      ctx.lineTo(y.yr.x, y.yr.y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#ffc86e'
      ctx.beginPath()
      ctx.moveTo(y.yr.x, y.yr.y)
      ctx.lineTo(y.yr.x, y.yr.y - 46)
      ctx.lineTo(y.yr.x + 28, y.yr.y - 38)
      ctx.lineTo(y.yr.x, y.yr.y - 30)
      ctx.fill()
      ctx.fillRect(y.yr.x - 1.5, y.yr.y - 46, 3, 46)
    }
    // The build radius round the Command Station: faint while the station or engineers are
    // selected, bright while a yard is being placed.
    const ring = view.place?.ring ?? view.buildRing
    if (ring) {
      const on = !!view.place
      ctx.save()
      ctx.fillStyle = on ? 'rgba(125,255,160,0.05)' : 'rgba(125,255,160,0.025)'
      ctx.strokeStyle = on ? 'rgba(125,255,160,0.65)' : 'rgba(125,255,160,0.28)'
      ctx.lineWidth = (on ? 2.5 : 1.5) / z
      ctx.setLineDash([18 / z, 12 / z])
      ctx.lineDashOffset = (-this.clock * 24) / z
      ctx.beginPath()
      ctx.arc(ring.x, ring.y, ring.r, 0, TAU)
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
    ctx.lineWidth = 1.5 / z
    /** Selected ships' patrols: where they start and end, labelled once for the lot. */
    const patrolEnds: { s: Pt; e: Pt }[] = []
    for (const id of view.selected) {
      const u = w.byId.get(id)
      if (!u || u.owner !== view.me) continue
      // A structure's focus fire: a line from it to its focus, and from each gun with its own.
      if (!isShip(u.t)) {
        ctx.setLineDash([5 / z, 5 / z])
        ctx.strokeStyle = 'rgba(255,90,80,0.45)'
        const f = u.focus ? w.byId.get(u.focus) : undefined
        if (f && !f.dead) {
          ctx.beginPath()
          ctx.moveTo(u.x, u.y)
          ctx.lineTo(f.x, f.y)
          ctx.stroke()
        }
        for (const g of u.guns) {
          const e = g.focus ? w.byId.get(g.focus) : undefined
          if (!e || e.dead || g.hp < 0) continue
          const p = hpPos(u, g.hp)
          ctx.beginPath()
          ctx.moveTo(p.x, p.y)
          ctx.lineTo(e.x, e.y)
          ctx.stroke()
        }
        ctx.setLineDash([])
      }
      const o = u.order
      if (o.k === 'patrol') {
        const start = { x: o.sx ?? o.bx, y: o.sy ?? o.by }
        const end = { x: o.ex ?? o.x, y: o.ey ?? o.y }
        patrolEnds.push({ s: start, e: end })
        // The beat, dashes flowing the way the ship is heading now.
        ctx.strokeStyle = 'rgba(143,208,255,0.5)'
        ctx.lineWidth = 2 / z
        ctx.setLineDash([10 / z, 8 / z])
        ctx.lineDashOffset = (-this.clock * 30) / z
        ctx.beginPath()
        ctx.moveTo(o.bx, o.by)
        ctx.lineTo(o.x, o.y)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.lineDashOffset = 0
        ctx.lineWidth = 1.5 / z
        // Start: a hollow ring; end: a filled ring. The end it's heading for now pulses.
        const pulse = 1 + 0.25 * Math.sin(this.clock * 5)
        for (const [p, isEnd] of [[start, false], [end, true]] as const) {
          const heading = Math.abs(p.x - o.x) < 1 && Math.abs(p.y - o.y) < 1
          ctx.strokeStyle = 'rgba(143,208,255,0.9)'
          ctx.fillStyle = isEnd ? 'rgba(143,208,255,0.85)' : 'rgba(6,10,22,0.7)'
          ctx.beginPath()
          ctx.arc(p.x, p.y, 6 / z, 0, TAU)
          ctx.fill()
          ctx.stroke()
          if (heading) {
            ctx.strokeStyle = 'rgba(143,208,255,0.55)'
            ctx.beginPath()
            ctx.arc(p.x, p.y, (12 * pulse) / z, 0, TAU)
            ctx.stroke()
          }
        }
        // An arrowhead halfway, pointing where it's going.
        const mx = (o.bx + o.x) / 2
        const my = (o.by + o.y) / 2
        const a = Math.atan2(o.y - o.by, o.x - o.bx)
        ctx.fillStyle = 'rgba(143,208,255,0.85)'
        ctx.beginPath()
        ctx.moveTo(mx + (Math.cos(a) * 9) / z, my + (Math.sin(a) * 9) / z)
        ctx.lineTo(mx + (Math.cos(a + 2.5) * 8) / z, my + (Math.sin(a + 2.5) * 8) / z)
        ctx.lineTo(mx + (Math.cos(a - 2.5) * 8) / z, my + (Math.sin(a - 2.5) * 8) / z)
        ctx.fill()
      } else if (o.k === 'move') {
        ctx.strokeStyle = o.attack ? 'rgba(255,170,90,0.35)' : 'rgba(125,255,160,0.3)'
        ctx.lineWidth = 1.5 / z
        ctx.beginPath()
        // Follow the way round the rocks (and fields and nebulas) when there is one, as a smooth
        // curve rather than corners: each waypoint pulls the line towards it, the line passing
        // halfway between them.
        const route = u.route && u.route.x === o.x && u.route.y === o.y ? u.route.pts : []
        const pts = [{ x: u.x, y: u.y }, ...route.filter((pt) => pt.x !== o.x || pt.y !== o.y), { x: o.x, y: o.y }]
        ctx.moveTo(pts[0].x, pts[0].y)
        for (let i = 1; i < pts.length - 1; i++) ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2)
        ctx.lineTo(o.x, o.y)
        ctx.stroke()
        // Its own spot, and a tick the way it will face there.
        ctx.fillStyle = ctx.strokeStyle
        ctx.beginPath()
        ctx.arc(o.x, o.y, 3.5 / z, 0, TAU)
        ctx.fill()
        if (o.face !== undefined) {
          ctx.beginPath()
          ctx.moveTo(o.x, o.y)
          ctx.lineTo(o.x + (Math.cos(o.face) * 16) / z, o.y + (Math.sin(o.face) * 16) / z)
          ctx.stroke()
        }
      } else if (o.k === 'guard') {
        const g = w.byId.get(o.id)
        if (g && !g.dead) {
          ctx.strokeStyle = 'rgba(125,255,160,0.35)'
          ctx.setLineDash([6 / z, 6 / z])
          ctx.beginPath()
          ctx.moveTo(u.x, u.y)
          ctx.lineTo(g.x, g.y)
          ctx.stroke()
          ctx.setLineDash([])
        }
      } else if (o.k === 'area') {
        ctx.strokeStyle = 'rgba(255,90,80,0.28)'
        ctx.setLineDash([12 / z, 9 / z])
        ctx.beginPath()
        ctx.arc(o.x, o.y, o.r, 0, TAU)
        ctx.stroke()
        ctx.setLineDash([])
        const t = u.target ? w.byId.get(u.target) : undefined
        if (t && !t.dead) {
          ctx.strokeStyle = 'rgba(255,90,80,0.4)'
          ctx.beginPath()
          ctx.moveTo(u.x, u.y)
          ctx.lineTo(t.x, t.y)
          ctx.stroke()
        }
      } else if (o.k === 'attack') {
        const t = w.byId.get(o.id)
        if (t) {
          const at = o.hp >= 0 ? hpPos(t, o.hp) : t
          ctx.strokeStyle = 'rgba(255,90,80,0.4)'
          ctx.beginPath()
          ctx.moveTo(u.x, u.y)
          ctx.lineTo(at.x, at.y)
          ctx.stroke()
        }
      }
      // Shift-queued orders: dashed legs on from the current one, a dot at each stop.
      if (u.queue.length) {
        const spot = (q: typeof o) => {
          if (q.k === 'move' || q.k === 'patrol' || q.k === 'area') return { x: q.x, y: q.y }
          if (q.k === 'attack') return w.byId.get(q.id) ?? null
          return null
        }
        let from = spot(o) ?? u
        ctx.setLineDash([8 / z, 8 / z])
        for (const q of u.queue) {
          const to = spot(q)
          if (!to) continue
          const col = q.k === 'attack' || q.k === 'area' ? '255,90,80' : q.k === 'patrol' ? '143,208,255' : q.k === 'move' && q.attack ? '255,170,90' : '125,255,160'
          ctx.strokeStyle = `rgba(${col},0.3)`
          ctx.beginPath()
          ctx.moveTo(from.x, from.y)
          ctx.lineTo(to.x, to.y)
          ctx.stroke()
          ctx.fillStyle = `rgba(${col},0.7)`
          ctx.beginPath()
          ctx.arc(to.x, to.y, 5 / z, 0, TAU)
          ctx.fill()
          from = to
        }
        ctx.setLineDash([])
      }
    }

    // Tags (drawn last, over the ships and structures, so a station can't hide one; under a hull's
    // furthest corner, however it's turned): "Patrol" at both ends of the selection's patrols (at the middle of its starts, and of
    // its ends), "Guarding" under a ship our selection guards, and "Guarded by" under a selected
    // ship others are guarding.
    const tags: Parameters<Renderer['tag']>[] = []
    if (patrolEnds.length) {
      const mid = (ps: Pt[]) => ({ x: ps.reduce((v, p) => v + p.x, 0) / ps.length, y: ps.reduce((v, p) => v + p.y, 0) / ps.length })
      tags.push([ctx, mid(patrolEnds.map((p) => p.s)), 12, 'Patrol', 'patrol', '143,208,255', z])
      tags.push([ctx, mid(patrolEnds.map((p) => p.e)), 12, 'Patrol', 'patrol', '143,208,255', z])
    }
    const guarded = new Map<number, number>()
    for (const id of view.selected) {
      const u = w.byId.get(id)
      if (u && u.owner === view.me && u.order.k === 'guard') guarded.set(u.order.id, (guarded.get(u.order.id) ?? 0) + 1)
    }
    for (const [id] of guarded) {
      const g = w.byId.get(id)
      if (g && !g.dead) tags.push([ctx, g, Math.hypot(...dims(g.t)) * 0.5 * z + 10, 'Guarding', 'guard', '95,230,208', z])
    }
    for (const id of view.selected) {
      const u = w.byId.get(id)
      if (!u || u.owner !== view.me || guarded.has(id)) continue
      const by = w.units.filter((m) => !m.dead && m.owner === view.me && m.order.k === 'guard' && m.order.id === id && !m.parent).length
      if (by) tags.push([ctx, u, Math.hypot(...dims(u.t)) * 0.5 * z + 10, `Guarded by ${by}`, 'guard', '95,230,208', z])
    }

    // Support ships' repair beams: a faint green tether to each ship being patched, pulsing.
    const myTeamB = w.players[view.me].team
    ctx.lineWidth = 2 / z
    for (const u of w.units) {
      if (!u.mending.length || !u.seen[myTeamB]) continue
      for (const id of u.mending) {
        const o = w.byId.get(id)
        if (!o || !onScreen((u.x + o.x) / 2, (u.y + o.y) / 2, 600)) continue
        ctx.strokeStyle = `rgba(125,255,160,${0.25 + 0.15 * Math.sin(this.clock * 6 + id)})`
        ctx.setLineDash([6 / z, 10 / z])
        ctx.lineDashOffset = -this.clock * 40 / z
        ctx.beginPath()
        ctx.moveTo(u.x, u.y)
        ctx.lineTo(o.x, o.y)
        ctx.stroke()
      }
    }
    ctx.setLineDash([])
    ctx.lineDashOffset = 0

    // Weapon ranges, under the ships.
    // Pointing at a gun (or, by touch, having picked one) rings just that gun.
    if (view.ranges === 'hover' && view.hover && !view.box) this.drawRanges(ctx, w, view, z, view.hover, true, view.hoverHp)
    else if (view.ranges === 'selected') {
      // A big selection would bury the field in rings: the first few only.
      let n = 0
      for (const id of view.selected) if (n++ < 6) this.drawRanges(ctx, w, view, z, id, view.selected.size === 1, view.turretPick?.unit === id ? view.turretPick.hp : -1)
    }

    // Ships and stations, big ones first so fighters fly over them.
    const myTeam = w.players[view.me].team
    const shown = w.units.filter((u) => u.seen[myTeam] && u.owner !== view.hideOwner && onScreen(u.x, u.y, u.t.size))
    shown.sort((a, b) => TIER_ORDER[a.t.tier] - TIER_ORDER[b.t.tier])
    for (const u of shown) this.drawUnit(ctx, u, w, z, view)
    // Parts blown off and fragments of small craft, over the ships.
    if (this.modelsOn) this.fx.draw(ctx, zdpr, onScreen)
    this.drawWarps(ctx, z)
    this.drawDeparts(ctx, z)
    for (const t of tags) this.tag(...t)
    if (view.warpGhost) this.drawWarpGhost(ctx, view.warpGhost, z)
    if (view.place) this.drawPlace(ctx, view.place, z)
    // The gun picked on one of our structures: a pulsing ring round it.
    const tp = view.turretPick ? w.byId.get(view.turretPick.unit) : undefined
    if (tp && !tp.dead && view.turretPick) {
      const h = tp.t.hardpoints[view.turretPick.hp]
      const p = hpPos(tp, view.turretPick.hp)
      const r = Math.max(10 / z, (h.s ?? 0.05) * tp.t.size * 0.6) * (1 + 0.08 * Math.sin(this.clock * 6))
      ctx.strokeStyle = '#ff8a70'
      ctx.lineWidth = 2 / z
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, TAU)
      ctx.stroke()
    }

    // Bolts.
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    for (const s of w.shots) {
      if (!onScreen(s.x, s.y)) continue
      const col = FACTIONS[w.players[s.owner].faction].bolt
      const sp = Math.hypot(s.vx, s.vy) || 1
      const dx = s.vx / sp
      const dy = s.vy / sp
      if (s.kind === 'missile') {
        ctx.strokeStyle = 'rgba(255,200,140,0.35)'
        ctx.lineWidth = 3 / Math.max(z, 0.5)
        ctx.beginPath()
        ctx.moveTo(s.x, s.y)
        ctx.lineTo(s.x - dx * 40, s.y - dy * 40)
        ctx.stroke()
        ctx.fillStyle = '#fff4d0'
        ctx.beginPath()
        ctx.arc(s.x, s.y, 3, 0, Math.PI * 2)
        ctx.fill()
        continue
      }
      // Ion: a fat, pale-blue ball of crackling charge with a short fading tail.
      if (s.kind === 'ion') {
        const r = Math.max(2 / z, 9)
        ctx.strokeStyle = 'rgba(150,225,255,0.35)'
        ctx.lineWidth = r * 1.4
        ctx.beginPath()
        ctx.moveTo(s.x, s.y)
        ctx.lineTo(s.x - dx * 34, s.y - dy * 34)
        ctx.stroke()
        const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 1.6)
        g.addColorStop(0, '#ffffff')
        g.addColorStop(0.35, 'rgba(170,235,255,0.95)')
        g.addColorStop(1, 'rgba(90,180,255,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(s.x, s.y, r * 1.6, 0, Math.PI * 2)
        ctx.fill()
        continue
      }
      const [len, width] = (w.sizes === 'big' ? BOLTS_BIG : BOLTS)[s.kind === 'turbo' ? 'turbo' : s.kind === 'flak' ? 'flak' : 'laser']
      const min = 1.2 / z
      ctx.strokeStyle = s.kind === 'flak' ? '#ffcf70' : col
      ctx.globalAlpha = 0.45
      ctx.lineWidth = Math.max(min * 2.4, width * 2.4)
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(s.x - dx * len, s.y - dy * len)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = Math.max(min, width * 0.45)
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(s.x - dx * len * 0.8, s.y - dy * len * 0.8)
      ctx.stroke()
    }
    ctx.lineCap = 'butt'

    // Effects.
    for (const q of this.parts) {
      if (!onScreen(q.x, q.y, q.size + q.grow)) continue
      const t = 1 - q.life / q.max
      const size = q.size + q.grow * t
      if (q.kind === 'smoke' || q.kind === 'debris') continue
      ctx.globalAlpha = Math.max(0, q.life / q.max) * (q.kind === 'fire' ? 0.8 : 1)
      if (q.kind === 'ring') {
        ctx.strokeStyle = q.color
        ctx.lineWidth = Math.max(1.5 / z, size * 0.06)
        ctx.beginPath()
        ctx.arc(q.x, q.y, size, 0, Math.PI * 2)
        ctx.stroke()
      } else if (q.kind === 'spark') {
        ctx.strokeStyle = q.color
        ctx.lineWidth = Math.max(1 / z, q.size)
        ctx.beginPath()
        ctx.moveTo(q.x, q.y)
        ctx.lineTo(q.x - q.vx * 0.04, q.y - q.vy * 0.04)
        ctx.stroke()
      } else {
        const g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, size)
        g.addColorStop(0, q.kind === 'flash' || q.kind === 'muzzle' ? '#ffffff' : '#fff2c0')
        g.addColorStop(0.35, q.color)
        g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(q.x, q.y, size, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalCompositeOperation = 'source-over'
    for (const q of this.parts) {
      if (q.kind !== 'smoke' && q.kind !== 'debris') continue
      if (!onScreen(q.x, q.y, q.size + q.grow)) continue
      const t = 1 - q.life / q.max
      const size = q.size + q.grow * t
      if (q.kind === 'smoke') {
        ctx.globalAlpha = 0.28 * (q.life / q.max)
        ctx.fillStyle = q.color
        ctx.beginPath()
        ctx.arc(q.x, q.y, size, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.globalAlpha = Math.min(1, q.life)
        ctx.fillStyle = q.color
        ctx.save()
        ctx.translate(q.x, q.y)
        ctx.rotate(q.rot)
        ctx.fillRect(-q.size, -q.size * 0.6, q.size * 2, q.size * 1.2)
        ctx.restore()
      }
    }
    ctx.globalAlpha = 1

    // Move markers.
    this.pings = this.pings.filter((g) => this.clock - g.t < 0.6)
    for (const g of this.pings) {
      const t = (this.clock - g.t) / 0.6
      ctx.strokeStyle = g.color
      ctx.globalAlpha = 1 - t
      ctx.lineWidth = 2 / z
      ctx.beginPath()
      ctx.arc(g.x, g.y, (10 + t * 30) / Math.min(1, z), 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.restore()

    // Fog of war: dark everywhere except around our ships and structures.
    const fs = 4
    const fw = Math.ceil(vw / fs)
    const fh = Math.ceil(vh / fs)
    if (!fw || !fh) return
    if (this.fog.width !== fw || this.fog.height !== fh) {
      this.fog.width = fw
      this.fog.height = fh
    }
    const f = this.fog.getContext('2d')!
    f.globalCompositeOperation = 'source-over'
    f.clearRect(0, 0, fw, fh)
    f.fillStyle = view.reveal ? 'rgba(2,4,12,0)' : 'rgba(2,4,12,0.55)'
    f.fillRect(0, 0, fw, fh)
    f.globalCompositeOperation = 'destination-out'
    for (const u of w.units) {
      if (w.players[u.owner].team !== w.players[view.me].team) continue
      const r = (sensorOf(u) * z) / fs
      const sx = ((u.x - cam.x) * z + vw / 2) / fs
      const sy = ((u.y - cam.y) * z + vh / 2) / fs
      if (sx + r < 0 || sy + r < 0 || sx - r > fw || sy - r > fh) continue
      f.drawImage(this.disc, sx - r, sy - r, r * 2, r * 2)
    }
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(this.fog, 0, 0, fw * fs, fh * fs)
    if (view.fogGrid) this.drawFogGrid(ctx, w, cam, vw, vh, view.me)

    // Drag box.
    if (view.box) {
      const { x0, y0, x1, y1 } = view.box
      ctx.strokeStyle = '#7dffa0'
      ctx.fillStyle = 'rgba(125,255,160,0.08)'
      ctx.lineWidth = 1
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0))
    }

    // Hover label: a hardpoint's name and health, or the ship's name.
    const hu = view.hover ? w.byId.get(view.hover) : undefined
    if (hu && hu.seen[w.players[view.me].team] && !view.box) {
      const hp = view.hoverHp >= 0 && hu.t.size * z > 90 ? view.hoverHp : -1
      const at = hp >= 0 ? hpPos(hu, hp) : { x: hu.x, y: hu.y - Math.max(...dims(hu.t)) * 0.5 }
      const sx = (at.x - cam.x) * z + vw / 2
      const sy = (at.y - cam.y) * z + vh / 2 - (hp >= 0 ? 18 : 22)
      const part = hp >= 0 ? hu.t.hardpoints[hp] : null
      const st = hp >= 0 ? hu.hps[hp] : null
      const rel = relColor(w, view.me, hu.owner)
      const title = part ? hpName(part) : `${rel === OWN ? '' : rel === ALLY ? 'Allied ' : 'Enemy '}${hu.t.name}`
      const sub = st ? (st.hp > 0 ? `${Math.ceil(st.hp)} / ${st.max}` : 'Destroyed') : `Hull ${Math.round((hu.hull / hu.hullMax) * 100)}%${hu.t.shield ? ` · Shield ${Math.round((hu.shield / shieldFull(hu)) * 100)}%` : ''}`
      ctx.font = '600 12px system-ui, sans-serif'
      const tw = Math.max(ctx.measureText(title).width, (ctx.font = '11px system-ui, sans-serif', ctx.measureText(sub).width)) + 20
      const th = st ? 40 : 34
      const bx = Math.min(vw - tw - 6, Math.max(6, sx - tw / 2))
      const by = Math.max(46, sy - th)
      ctx.fillStyle = 'rgba(6,10,22,0.9)'
      ctx.strokeStyle = part ? HP_COLOR[part.kind] : rel
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(bx, by, tw, th, 6)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#e8eef8'
      ctx.font = '600 12px system-ui, sans-serif'
      ctx.textBaseline = 'top'
      ctx.fillText(title, bx + 10, by + 6)
      ctx.fillStyle = '#9fb0c8'
      ctx.font = '11px system-ui, sans-serif'
      ctx.fillText(sub, bx + 10, by + 21)
      if (st && st.hp > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.12)'
        ctx.fillRect(bx + 10, by + th - 7, tw - 20, 3)
        ctx.fillStyle = HP_COLOR[part!.kind]
        ctx.fillRect(bx + 10, by + th - 7, (tw - 20) * (st.hp / st.max), 3)
      }
      ctx.textBaseline = 'alphabetic'
    }

    // Hover label for a wreck: what's left on it and who's stripping it.
    const hw = !hu && view.hoverWreck && !view.box ? w.wrecks.find((h) => h.id === view.hoverWreck) : undefined
    if (hw) {
      const myTeam = w.players[view.me].team
      const title = hw.decay === Infinity ? 'Derelict hulk' : 'Battle wreck'
      const who = hw.team === -1 ? 'Park warships beside it to salvage' : hw.team === myTeam ? 'Your crews are salvaging' : 'Enemy crews are salvaging'
      const sub = `${Math.ceil(hw.left)} of ${hw.value} cr · ${who}`
      const sx = (hw.x - cam.x) * z + vw / 2
      const sy = (hw.y - hw.size * 0.55 - 20 - cam.y) * z + vh / 2 - 22
      ctx.font = '600 12px system-ui, sans-serif'
      const tw = Math.max(ctx.measureText(title).width, (ctx.font = '11px system-ui, sans-serif', ctx.measureText(sub).width)) + 20
      const th = 34
      const bx = Math.min(vw - tw - 6, Math.max(6, sx - tw / 2))
      const by = Math.max(46, sy - th)
      ctx.fillStyle = 'rgba(6,10,22,0.9)'
      ctx.strokeStyle = '#f2c14a'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(bx, by, tw, th, 6)
      ctx.fill()
      ctx.stroke()
      ctx.textBaseline = 'top'
      ctx.fillStyle = '#e8eef8'
      ctx.font = '600 12px system-ui, sans-serif'
      ctx.fillText(title, bx + 10, by + 6)
      ctx.fillStyle = '#9fb0c8'
      ctx.font = '11px system-ui, sans-serif'
      ctx.fillText(sub, bx + 10, by + 21)
      ctx.textBaseline = 'alphabetic'
    }
  }

  /** Nebulas, then asteroid fields: under everything else, so ore, beacons and ships sit on top. */
  private drawTerrain(ctx: CanvasRenderingContext2D, w: World, z: number, onScreen: (x: number, y: number, r?: number) => boolean) {
    if (this.terrain?.map !== w.map) this.terrain = terrainArt(w.map)
    const art = this.terrain
    for (const c of art.clouds) {
      if (!onScreen(c.x, c.y, c.r)) continue
      ctx.save()
      ctx.translate(c.x, c.y)
      ctx.rotate(this.clock * c.spin + c.phase)
      ctx.globalCompositeOperation = c.add ? 'lighter' : 'source-over'
      ctx.globalAlpha = (c.add ? 0.55 : 0.9) + Math.sin(this.clock * 0.35 + c.phase) * 0.08
      ctx.drawImage(c.img, -c.r, -c.r, c.r * 2, c.r * 2)
      ctx.restore()
    }
    // Dust first, then the rocks drifting through it.
    for (const f of art.fields) {
      if (!onScreen(f.x, f.y, f.r)) continue
      const grd = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r)
      grd.addColorStop(0, 'rgba(170,148,116,0.26)')
      grd.addColorStop(0.75, 'rgba(160,138,108,0.18)')
      grd.addColorStop(1, 'rgba(150,128,100,0.04)')
      ctx.fillStyle = grd
      ctx.beginPath()
      ctx.arc(f.x, f.y, f.r, 0, TAU)
      ctx.fill()
      // A dashed hazard ring marks where the rocks start to scrape big hulls.
      ctx.strokeStyle = 'rgba(232,180,96,0.4)'
      ctx.lineWidth = 2 / z
      ctx.setLineDash([14 / z, 10 / z])
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (!art.rocks.length) return
    const dpr = window.devicePixelRatio || 1
    const imgs = [this.sprite('asteroid-1', 40 * z * dpr), this.sprite('asteroid-2', 40 * z * dpr)]
    // Zoomed far out, the smallest rocks would be specks: skip them and let the dust carry it.
    const minSize = 3 / z
    for (const k of art.rocks) {
      if (k.size < minSize) continue
      const a = k.phase + this.clock * k.speed
      const x = k.x + Math.cos(a) * k.orbit
      const y = k.y + Math.sin(a) * k.orbit
      if (!onScreen(x, y, k.size)) continue
      const img = imgs[k.kind]
      if (!img) continue
      const nw = img instanceof HTMLImageElement ? img.naturalWidth : img.width
      const nh = img instanceof HTMLImageElement ? img.naturalHeight : img.height
      const s = k.size / Math.max(nw, nh)
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(k.rot + this.clock * k.spin)
      ctx.globalAlpha = 0.92
      ctx.drawImage(img, (-nw * s) / 2, (-nh * s) / 2, nw * s, nh * s)
      ctx.restore()
    }
    ctx.globalAlpha = 1
  }

  private drawSprite(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, rot: number, size: number, z: number, alpha = 1) {
    const img = this.sprite(name, size * z * (window.devicePixelRatio || 1))
    if (!img) return
    const nw = img instanceof HTMLImageElement ? img.naturalWidth : img.width
    const nh = img instanceof HTMLImageElement ? img.naturalHeight : img.height
    const s = size / Math.max(nw, nh)
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    ctx.globalAlpha = alpha
    ctx.drawImage(img, (-nw * s) / 2, (-nh * s) / 2, nw * s, nh * s)
    ctx.restore()
  }

  /** A ship type drawn whole and undamaged (its model where it has one and models are on, else its
   * sprite), optionally stretched along its length: for jumps into and out of hyperspace. */
  private drawShip(ctx: CanvasRenderingContext2D, unit: string, sprite: string, x: number, y: number, rot: number, size: number, z: number, alpha: number, stretch?: [number, number]) {
    const t = UNIT[unit] ? this.typeOf(unit) : undefined
    const m = this.modelsOn && t ? modelFor(t) : null
    const zdpr = z * (window.devicePixelRatio || 1)
    if (!stretch) {
      if (m) drawHull(ctx, m, x, y, rot, size, zdpr, FRESH, { alpha })
      else this.drawSprite(ctx, sprite, x, y, rot, size, z, alpha)
      return
    }
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    ctx.scale(stretch[0], stretch[1])
    if (m) drawHull(ctx, m, 0, 0, 0, size, zdpr, FRESH, { alpha, lightRot: rot })
    else {
      const img = this.sprite(sprite, size * zdpr)
      if (img) {
        const nw = img instanceof HTMLImageElement ? img.naturalWidth : img.width
        const nh = img instanceof HTMLImageElement ? img.naturalHeight : img.height
        const sc = size / Math.max(nw, nh)
        ctx.globalAlpha = alpha
        ctx.drawImage(img, (-nw * sc) / 2, (-nh * sc) / 2, nw * sc, nh * sc)
      }
    }
    ctx.restore()
  }

  /**
   * Keeps up with the modelled units: when a part comes off one we can see (a wing tip below its
   * hull share, a flak turret shot out), it flies off; when one dies, small craft and structures
   * burst into fragments, and a warship's hull is laid where the battle leaves its wreck, broken
   * the way the wreck's id says. Hulks whose wreck is gone (salvaged, drifted off) fade out.
   */
  private trackModels(w: World, view: View) {
    const team = w.players[view.me].team
    for (const u of w.units) {
      if (u.dead) continue
      const m = modelFor(u.t)
      if (!m) continue
      const st = hullState(m, u, u.t.tier)
      const dead = u.hps.map((h) => h.hp <= 0)
      const vis = !!u.seen[team] && u.owner !== view.hideOwner
      const tr = this.tracked.get(u.id)
      if (tr && tr.m === m && vis) {
        const rot = u.a + Math.PI / 2
        const vx = Math.cos(u.a) * u.v
        const vy = Math.sin(u.a) * u.v
        m.detachable.forEach((pi, i) => {
          if (st.detached & (1 << i) && !(tr.det & (1 << i))) this.fx.flyPart(m, pi, u.x, u.y, rot, u.t.size, vx, vy, u.id * 977 + i)
        })
        m.mounts.forEach((mt, i) => {
          // A mount follows its hardpoint (a turret for show follows the one it stands for).
          if (mt.detach && dead[mt.hp] && !tr.dead[mt.hp]) this.fx.flyMount(m, i, u.x, u.y, rot, this.aims.get(u.id * 64 + mt.hp) ?? rot, u.t.size, vx, vy, u.id * 613 + i)
        })
      }
      if (tr) Object.assign(tr, { u, m, det: st.detached, st, dead, vis })
      else this.tracked.set(u.id, { u, m, det: st.detached, st, dead, vis })
    }
    for (const [id, tr] of this.tracked) {
      if (w.byId.get(id) === tr.u && !tr.u.dead) continue
      this.tracked.delete(id)
      const u = tr.u
      if (!u.dead || !tr.vis) continue
      if (BREAK_WEIGHTS[u.t.tier]) this.deaths.push({ x: u.x, y: u.y, det: tr.det, at: this.clock })
      else this.fx.shatter(tr.m, u.t.tier, u.x, u.y, u.a + Math.PI / 2, u.t.size, Math.cos(u.a) * u.v, Math.sin(u.a) * u.v, u.id, hullState(tr.m, u, u.t.tier))
    }
    const listed = new Set<number>()
    for (const h of w.wrecks) {
      listed.add(h.id)
      if (this.fx.has(h.id)) continue
      const plain = unitForSprite(h.sprite)
      if (!plain) continue
      const t = h.big ? bigType(plain) : plain
      const d = this.deaths.find((q) => Math.abs(q.x - h.x) < 1 && Math.abs(q.y - h.y) < 1)
      this.fx.anchor(h.id, modelFor(t)!, t.tier, h.x, h.y, h.rot, h.size, w.map.seed, d?.det)
    }
    for (const id of this.fx.anchored()) if (!listed.has(id)) this.fx.release(id)
    if (this.deaths.length) this.deaths = this.deaths.filter((q) => this.clock - q.at < 1)
  }

  /** The flash of a ship dropping out of hyperspace: a white burst, a shockwave, a spray of sparks
   * thrown forward, and in an asteroid field shattered rock and fire. */
  private arrival(x: number, y: number, a: number, size: number, glow: string, field: boolean) {
    this.add({ kind: 'flash', x, y, life: 0.35, size: size * 0.9, grow: size * 0.6, color: glow })
    this.add({ kind: 'ring', x, y, life: 0.7, size: size * 0.35, grow: size * 2.4, color: '#e8f6ff' })
    this.add({ kind: 'ring', x, y, life: 1.1, size: size * 0.2, grow: size * 1.4, color: glow })
    const n = Math.round(14 + size / 12)
    for (let i = 0; i < n; i++) {
      // Most of the energy carries on the way the ship was going.
      const b = a + (Math.random() - 0.5) * (Math.random() < 0.7 ? 0.9 : Math.PI * 2)
      const v = 120 + Math.random() * (260 + size)
      this.add({ kind: 'spark', x, y, vx: Math.cos(b) * v, vy: Math.sin(b) * v, life: 0.3 + Math.random() * 0.5, size: 1.4 + Math.random() * 1.6, color: Math.random() < 0.5 ? '#ffffff' : glow })
    }
    if (field) {
      for (let i = 0; i < 4; i++) this.pending.push({ at: this.clock + i * 0.08, x: x + (Math.random() - 0.5) * size * 0.6, y: y + (Math.random() - 0.5) * size * 0.6, size: size * 0.35, final: false })
      this.debris(x, y, size * 1.4, '#7a6a5a')
    }
  }

  /**
   * The rings round one ship or structure (ours, or anyone's we can see). Pointing at one of its
   * guns (`hp`): that gun's ring alone, centred on the gun where it sits, at its range, since that
   * is where the battle fires it from (see ranges.ts). Otherwise one ring per kind of gun, centred on
   * the unit at the average reach of that kind's standing guns, in that gun's colour and dash,
   * labelled lightly with its name and reach at the ring's top, fanned out so close rings don't
   * print over each other; and its sensor range, fainter. `labels` off for a crowd of selected ships.
   */
  private drawRanges(ctx: CanvasRenderingContext2D, w: World, view: View, z: number, id: number, labels: boolean, hp = -1) {
    const u = w.byId.get(id)
    if (!u || u.dead || !u.seen[w.players[view.me].team] || u.owner === view.hideOwner) return
    ctx.lineWidth = 1.5 / z
    ctx.font = `${11 / z}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    const ring = (x: number, y: number, r: number, rgb: string, dash: number[], alpha: number, label: string, i: number) => {
      ctx.strokeStyle = `rgba(${rgb},${alpha})`
      ctx.setLineDash(dash.length ? dash.map((d) => d / z) : [])
      ctx.beginPath()
      ctx.arc(x, y, r, 0, TAU)
      ctx.stroke()
      if (!labels) return
      // Fanned along the top so rings close together keep their labels apart.
      const a = -Math.PI / 2 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.min(0.5, 70 / z / r)
      ctx.fillStyle = `rgba(${rgb},${Math.min(1, alpha + 0.3)})`
      ctx.fillText(label, x + Math.cos(a) * r, y + Math.sin(a) * r - 3 / z)
    }
    const one = hp >= 0 ? moduleRing(u.t, hp, u.mods.range) : null
    if (one) {
      const at = hpPos(u, hp)
      const st = RANGE_STYLE[one.kind]
      // A gun that was shot out reaches nothing: its ring is drawn faint.
      ring(at.x, at.y, one.range, st.rgb, st.dash, u.hps[hp].hp > 0 ? 0.75 : 0.25, `${hpName(u.t.hardpoints[hp])} #${hp + 1} · ${Math.round(one.range)}`, 0)
    } else {
      const rings = averageRings(u.t, (i) => u.hps[i].hp > 0, u.mods.range)
      ring(u.x, u.y, sensorOf(u), '200,215,240', [4, 8], 0.22, `Sensors ${Math.round(sensorOf(u))}`, rings.length)
      rings.forEach((g, i) => {
        const st = RANGE_STYLE[g.kind]
        ring(u.x, u.y, g.reach, st.rgb, st.dash, 0.55, `${st.name} ${g.n > 1 ? '· avg ' : ''}${Math.round(g.reach)}`, i)
      })
    }
    ctx.setLineDash([])
    ctx.textAlign = 'start'
    ctx.textBaseline = 'alphabetic'
  }

  /**
   * Ships on their way in from hyperspace. While the jump charges, light gathers where the ship will
   * be: a swirling glow, its outline flickering in, and streaks reaching out behind it along the way
   * it comes. Then it streaks in, stretched long, and snaps to a stop; a fading trail stays behind.
   */
  private drawWarps(ctx: CanvasRenderingContext2D, z: number) {
    const now = this.clock
    this.warps = this.warps.filter((v) => now < v.at + AFTER)
    if (!this.warps.length) return
    ctx.save()
    for (const v of this.warps) {
      const dx = Math.cos(v.a)
      const dy = Math.sin(v.a)
      const charge = Math.min(1, Math.max(0, (now - v.start) / Math.max(0.01, v.at - STREAK - v.start)))
      ctx.globalCompositeOperation = 'lighter'
      if (now < v.at) {
        // The gathering glow, pulsing faster as it builds.
        const pulse = 0.85 + 0.15 * Math.sin(now * (8 + charge * 22))
        const r = v.size * (0.25 + charge * 0.45) * pulse
        const g = ctx.createRadialGradient(v.x, v.y, 0, v.x, v.y, r)
        g.addColorStop(0, `rgba(255,255,255,${0.35 + charge * 0.5})`)
        g.addColorStop(0.3, v.glow)
        g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.globalAlpha = 0.35 + charge * 0.5
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(v.x, v.y, r, 0, TAU)
        ctx.fill()
        // Two broken rings turning against each other, closing in.
        ctx.strokeStyle = v.glow
        ctx.lineWidth = Math.max(1.2 / z, v.size * 0.012)
        for (const dir of [1, -1]) {
          const rr = v.size * (0.75 - charge * 0.25) * (dir > 0 ? 1 : 0.82)
          ctx.globalAlpha = charge * 0.7
          ctx.setLineDash([rr * 0.5, rr * 0.35])
          ctx.lineDashOffset = now * rr * 1.5 * dir
          ctx.beginPath()
          ctx.arc(v.x, v.y, rr, 0, TAU)
          ctx.stroke()
        }
        ctx.setLineDash([])
        // Its outline flickering into being.
        this.drawShip(ctx, v.unit, v.sprite, v.x, v.y, v.a + Math.PI / 2, v.size, z, (0.08 + charge * 0.22) * (0.6 + 0.4 * Math.random()))
        // Streaks of light reaching back along the way it comes.
        const len = v.size * (2 + charge * 7)
        for (let i = 0; i < 9; i++) {
          const side = ((i * 37) % 9) / 8 - 0.5
          const off = side * v.size * 0.8
          const ox = -dy * off
          const oy = dx * off
          const l = len * (0.4 + ((i * 53) % 7) / 10)
          const lg = ctx.createLinearGradient(v.x + ox, v.y + oy, v.x + ox - dx * l, v.y + oy - dy * l)
          lg.addColorStop(0, `rgba(230,245,255,${0.5 * charge})`)
          lg.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.strokeStyle = lg
          ctx.globalAlpha = 1
          ctx.lineWidth = Math.max(1 / z, v.size * 0.01)
          ctx.beginPath()
          ctx.moveTo(v.x + ox, v.y + oy)
          ctx.lineTo(v.x + ox - dx * l, v.y + oy - dy * l)
          ctx.stroke()
        }
        // The streak in: the ship rushing in from far back, stretched long, slowing to a stop.
        const p = (now - (v.at - STREAK)) / STREAK
        if (p > 0) {
          const k = (1 - p) ** 2
          const cx = v.x - dx * v.size * 9 * k
          const cy = v.y - dy * v.size * 9 * k
          const stretch = 1 + 7 * k
          this.drawShip(ctx, v.unit, v.sprite, cx, cy, v.a + Math.PI / 2, v.size, z, 0.9, [1 - 0.35 * k, stretch])
          // The bright wake it pulls behind it.
          const wl = ctx.createLinearGradient(cx, cy, cx - dx * v.size * 12, cy - dy * v.size * 12)
          wl.addColorStop(0, 'rgba(255,255,255,0.95)')
          wl.addColorStop(0.15, v.glow)
          wl.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.strokeStyle = wl
          ctx.lineWidth = Math.max(2 / z, v.size * 0.07)
          ctx.globalAlpha = 1
          ctx.beginPath()
          ctx.moveTo(cx, cy)
          ctx.lineTo(cx - dx * v.size * 12, cy - dy * v.size * 12)
          ctx.stroke()
        }
      } else {
        // After: the wake fading behind it, and a glare across the spot.
        const q = (now - v.at) / AFTER
        const fade = (1 - q) ** 2
        const wl = ctx.createLinearGradient(v.x, v.y, v.x - dx * v.size * 10, v.y - dy * v.size * 10)
        wl.addColorStop(0, `rgba(255,255,255,${0.6 * fade})`)
        wl.addColorStop(0.2, v.glow)
        wl.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.strokeStyle = wl
        ctx.globalAlpha = fade
        ctx.lineWidth = Math.max(1.5 / z, v.size * 0.05 * (1 - q * 0.5))
        ctx.beginPath()
        ctx.moveTo(v.x - dx * v.size * 0.3, v.y - dy * v.size * 0.3)
        ctx.lineTo(v.x - dx * v.size * 10, v.y - dy * v.size * 10)
        ctx.stroke()
        const glare = v.size * (1.6 + q * 1.4)
        const gg = ctx.createLinearGradient(v.x + dy * glare, v.y - dx * glare, v.x - dy * glare, v.y + dx * glare)
        gg.addColorStop(0, 'rgba(0,0,0,0)')
        gg.addColorStop(0.5, `rgba(235,248,255,${0.8 * fade})`)
        gg.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.strokeStyle = gg
        ctx.lineWidth = Math.max(1 / z, v.size * 0.02)
        ctx.beginPath()
        ctx.moveTo(v.x + dy * glare, v.y - dx * glare)
        ctx.lineTo(v.x - dy * glare, v.y + dx * glare)
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  /**
   * A warship charging its drive to retreat: light gathering round it, rings tightening, and an arc
   * filling as the drive charges.
   */
  private drawCharge(ctx: CanvasRenderingContext2D, u: Unit, z: number) {
    const total = RETREAT_TIME[u.t.tier] ?? 10
    const k = Math.min(1, Math.max(0, 1 - u.retreat / total))
    const glow = FACTIONS[u.t.faction].glow
    const size = u.t.size
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const pulse = 0.85 + 0.15 * Math.sin(this.clock * (6 + k * 20))
    const g = ctx.createRadialGradient(u.x, u.y, size * 0.2, u.x, u.y, size * 0.75)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(0.6, glow)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalAlpha = (0.1 + k * 0.35) * pulse
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(u.x, u.y, size * 0.75, 0, TAU)
    ctx.fill()
    ctx.strokeStyle = glow
    ctx.lineWidth = Math.max(1.2 / z, size * 0.01)
    for (const dir of [1, -1]) {
      const rr = size * (0.8 - k * 0.2) * (dir > 0 ? 1 : 0.88)
      ctx.globalAlpha = 0.3 + k * 0.5
      ctx.setLineDash([rr * 0.45, rr * 0.3])
      ctx.lineDashOffset = this.clock * rr * (1 + k * 2) * dir
      ctx.beginPath()
      ctx.arc(u.x, u.y, rr, 0, TAU)
      ctx.stroke()
    }
    ctx.setLineDash([])
    // How far along the charge is.
    ctx.globalAlpha = 0.9
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = Math.max(2 / z, size * 0.012)
    ctx.beginPath()
    ctx.arc(u.x, u.y, size * 0.9, -Math.PI / 2, -Math.PI / 2 + k * TAU)
    ctx.stroke()
    ctx.restore()
  }

  /** Ships jumping out: stretched long and gone ahead in a streak, a wake fading behind them. */
  private drawDeparts(ctx: CanvasRenderingContext2D, z: number) {
    const now = this.clock
    this.departs = this.departs.filter((v) => now < v.start + AFTER)
    if (!this.departs.length) return
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (const v of this.departs) {
      const dx = Math.cos(v.a)
      const dy = Math.sin(v.a)
      const q = (now - v.start) / AFTER
      const p = Math.min(1, (now - v.start) / STREAK)
      const cx = v.x + dx * v.size * 10 * p * p
      const cy = v.y + dy * v.size * 10 * p * p
      if (p < 1) this.drawShip(ctx, v.unit, v.sprite, cx, cy, v.a + Math.PI / 2, v.size, z, 1 - p * 0.6, [1 - 0.35 * p, 1 + 7 * p])
      // The wake from where it was to where it went, fading.
      const fade = (1 - q) ** 2
      const wl = ctx.createLinearGradient(v.x, v.y, cx, cy)
      wl.addColorStop(0, 'rgba(0,0,0,0)')
      wl.addColorStop(0.7, v.glow)
      wl.addColorStop(1, `rgba(255,255,255,${0.9 * fade})`)
      ctx.strokeStyle = wl
      ctx.globalAlpha = fade
      ctx.lineWidth = Math.max(1.5 / z, v.size * 0.06 * (1 - q * 0.5))
      ctx.beginPath()
      ctx.moveTo(v.x, v.y)
      ctx.lineTo(cx, cy)
      ctx.stroke()
    }
    ctx.restore()
  }

  /**
   * The fog grid (F2): the map cut into cells, each shaded by whether our team can see its middle,
   * the cells out of sight hatched, and a bright stepped line along the edge between the two, so
   * it's plain where sight ends. Cells grow as the camera pulls back.
   */
  private drawFogGrid(ctx: CanvasRenderingContext2D, w: World, cam: Camera, vw: number, vh: number, me: Owner) {
    const z = cam.zoom
    const cell = [100, 200, 400, 800].find((c) => c * z >= 26) ?? 800
    const x0 = Math.max(0, Math.floor((cam.x - vw / 2 / z) / cell))
    const y0 = Math.max(0, Math.floor((cam.y - vh / 2 / z) / cell))
    const x1 = Math.min(Math.ceil(w.w / cell), Math.ceil((cam.x + vw / 2 / z) / cell))
    const y1 = Math.min(Math.ceil(w.h / cell), Math.ceil((cam.y + vh / 2 / z) / cell))
    const cols = x1 - x0
    const rows = y1 - y0
    if (cols <= 0 || rows <= 0 || cols * rows > 20000) return
    const team = w.players[me].team
    const eyes = w.units.filter((u) => !u.dead && w.players[u.owner].team === team).map((u) => ({ x: u.x, y: u.y, r2: sensorOf(u) ** 2 }))
    const seen = new Uint8Array(cols * rows)
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const cx = (x0 + i + 0.5) * cell
        const cy = (y0 + j + 0.5) * cell
        seen[j * cols + i] = eyes.some((e) => (e.x - cx) ** 2 + (e.y - cy) ** 2 < e.r2) ? 1 : 0
      }
    const sx = (x: number) => (x - cam.x) * z + vw / 2
    const sy = (y: number) => (y - cam.y) * z + vh / 2
    const px = cell * z
    ctx.save()
    // Out of sight: darker, with a faint hatch.
    ctx.fillStyle = 'rgba(255,80,60,0.07)'
    ctx.strokeStyle = 'rgba(255,110,90,0.12)'
    ctx.lineWidth = 1
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        if (seen[j * cols + i]) continue
        const x = sx((x0 + i) * cell)
        const y = sy((y0 + j) * cell)
        ctx.fillRect(x, y, px, px)
        ctx.beginPath()
        for (let d = 8; d < px * 2; d += 12) {
          ctx.moveTo(x + Math.max(0, d - px), y + Math.min(px, d))
          ctx.lineTo(x + Math.min(px, d), y + Math.max(0, d - px))
        }
        ctx.stroke()
      }
    // The grid itself, faint.
    ctx.strokeStyle = 'rgba(160,200,255,0.12)'
    ctx.beginPath()
    for (let i = 0; i <= cols; i++) {
      ctx.moveTo(Math.round(sx((x0 + i) * cell)) + 0.5, sy(y0 * cell))
      ctx.lineTo(Math.round(sx((x0 + i) * cell)) + 0.5, sy(y1 * cell))
    }
    for (let j = 0; j <= rows; j++) {
      ctx.moveTo(sx(x0 * cell), Math.round(sy((y0 + j) * cell)) + 0.5)
      ctx.lineTo(sx(x1 * cell), Math.round(sy((y0 + j) * cell)) + 0.5)
    }
    ctx.stroke()
    // Where sight ends: every cell edge between a seen cell and an unseen one.
    ctx.strokeStyle = 'rgba(125,240,255,0.85)'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const v = seen[j * cols + i]
        if (i + 1 < cols && seen[j * cols + i + 1] !== v) {
          const x = sx((x0 + i + 1) * cell)
          ctx.moveTo(x, sy((y0 + j) * cell))
          ctx.lineTo(x, sy((y0 + j + 1) * cell))
        }
        if (j + 1 < rows && seen[(j + 1) * cols + i] !== v) {
          const y = sy((y0 + j + 1) * cell)
          ctx.moveTo(sx((x0 + i) * cell), y)
          ctx.lineTo(sx((x0 + i + 1) * cell), y)
        }
      }
    ctx.stroke()
    ctx.restore()
  }

  /** A ship being dragged from the reserve: its ghost where it would arrive, ringed green where it
   * can, red where it can't (with why), amber over an asteroid field. */
  private drawWarpGhost(ctx: CanvasRenderingContext2D, g: NonNullable<View['warpGhost']>, z: number) {
    const col = !g.ok ? '#ff5a50' : g.field ? '#ffaa5a' : '#7dffa0'
    const r = g.size * 0.6
    ctx.save()
    ctx.fillStyle = !g.ok ? 'rgba(255,90,80,0.08)' : g.field ? 'rgba(255,170,90,0.1)' : 'rgba(125,255,160,0.08)'
    ctx.strokeStyle = col
    ctx.lineWidth = 2 / z
    ctx.setLineDash([10 / z, 7 / z])
    ctx.lineDashOffset = -this.clock * 30 / z
    ctx.beginPath()
    ctx.arc(g.x, g.y, r, 0, TAU)
    ctx.fill()
    ctx.stroke()
    ctx.setLineDash([])
    // Which way it will face.
    ctx.beginPath()
    ctx.moveTo(g.x + Math.cos(g.a) * r, g.y + Math.sin(g.a) * r)
    ctx.lineTo(g.x + Math.cos(g.a) * (r + 22 / z), g.y + Math.sin(g.a) * (r + 22 / z))
    ctx.stroke()
    ctx.restore()
    // Its model where it has one (the ghost only knows the sprite), else the sprite.
    const t = unitForSprite(g.sprite)
    if (t) this.drawShip(ctx, t.id, g.sprite, g.x, g.y, g.a + Math.PI / 2, g.size, z, g.ok ? 0.55 : 0.3)
    else this.drawSprite(ctx, g.sprite, g.x, g.y, g.a + Math.PI / 2, g.size, z, g.ok ? 0.55 : 0.3)
    const label = !g.ok ? g.why : g.field ? `Asteroid field: arrives badly damaged` : null
    if (label) {
      ctx.save()
      ctx.font = `600 ${12 / z}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(6,10,22,0.85)'
      const tw = ctx.measureText(label).width + 14 / z
      ctx.fillRect(g.x - tw / 2, g.y + r + 8 / z, tw, 20 / z)
      ctx.fillStyle = col
      ctx.textBaseline = 'middle'
      ctx.fillText(label, g.x, g.y + r + 18 / z)
      ctx.restore()
    }
  }

  /**
   * A yard going up. Until engineers start on it, a blueprint: the whole structure faint, its
   * outline dashed. Then its frame fills in from the stern: the part that's built drawn solid, and
   * over what's still to come the structure's own frame (every plate's outline) with scaffolding,
   * uprights, girders and braces, clipped to its shape, and a welding line along the front of the
   * work that throws sparks while engineers are at it.
   */
  private drawSite(ctx: CanvasRenderingContext2D, u: Unit, w: World, m: Model | null, size: number, z: number) {
    const t = u.t
    const zdpr = z * (window.devicePixelRatio || 1)
    const rot = u.a + Math.PI / 2
    const [sw, sh] = dims(t)
    const planned = !u.site!.started
    const progress = Math.max(0, Math.min(1, 1 - u.building / t.build))
    const rgb = t.faction === 'republic' ? '130,205,255' : '255,186,120'
    if (m) drawHull(ctx, m, u.x, u.y, rot, size, zdpr, FRESH, { alpha: planned ? 0.3 : 0.12 })
    else this.drawSprite(ctx, t.sprite, u.x, u.y, rot, size, z, planned ? 0.3 : 0.18)
    ctx.save()
    ctx.translate(u.x, u.y)
    ctx.rotate(rot)
    ctx.strokeStyle = `rgba(${rgb},${planned ? 0.8 : 0.35})`
    ctx.lineWidth = 1.5 / z
    ctx.setLineDash([9 / z, 6 / z])
    ctx.lineDashOffset = (-this.clock * 20) / z
    ctx.strokeRect(-sw / 2, -sh / 2, sw, sh)
    ctx.setLineDash([])
    if (!planned) {
      const cut = sh / 2 - progress * sh
      ctx.save()
      ctx.beginPath()
      ctx.rect(-sw, cut, sw * 2, sh * 1.5)
      ctx.clip()
      if (m) drawHull(ctx, m, 0, 0, 0, size, zdpr, hullState(m, u, t.tier), { lightRot: rot })
      else this.drawSprite(ctx, t.sprite, 0, 0, 0, size, z)
      ctx.restore()
      // What's still to come: the structure's frame, and scaffolding over it, both clipped to its
      // shape (the model's own silhouette) and to the part not built yet.
      ctx.save()
      ctx.beginPath()
      ctx.rect(-sw, -sh, sw * 2, cut + sh)
      ctx.clip()
      if (m) {
        const k = size / m.long
        const o = outlineOf(m)
        ctx.scale(k, k)
        ctx.clip(o.solid)
        ctx.strokeStyle = `rgba(${rgb},0.55)`
        ctx.lineWidth = 1.1 / z / k
        ctx.stroke(o.frame)
        ctx.scale(1 / k, 1 / k)
      }
      const cols = 6
      const rows = 10
      ctx.beginPath()
      for (let i = 0; i <= cols; i++) {
        const x = -sw / 2 + (sw * i) / cols
        ctx.moveTo(x, -sh / 2)
        ctx.lineTo(x, cut)
      }
      for (let j = 0; j < rows; j++) {
        const y0 = -sh / 2 + (sh * j) / rows
        if (y0 >= cut) break
        const y1 = Math.min(cut, y0 + sh / rows)
        ctx.moveTo(-sw / 2, y0)
        ctx.lineTo(sw / 2, y0)
        for (let i = 0; i < cols; i++) {
          const x0 = -sw / 2 + (sw * i) / cols
          const x1 = x0 + sw / cols
          if ((i + j) % 2) {
            ctx.moveTo(x0, y0)
            ctx.lineTo(x1, y1)
          } else {
            ctx.moveTo(x1, y0)
            ctx.lineTo(x0, y1)
          }
        }
      }
      ctx.strokeStyle = `rgba(${rgb},${m ? 0.3 : 0.5})`
      ctx.lineWidth = 1 / z
      ctx.stroke()
      ctx.restore()
      // The welding front.
      const welding = w.units.some((e) => !e.dead && isEngineer(e.t) && e.mending.includes(u.id))
      const flick = welding ? 0.65 + 0.35 * Math.sin(this.clock * 23 + u.id) : 0.35
      ctx.strokeStyle = `rgba(255,224,150,${flick})`
      ctx.lineWidth = 3 / z
      ctx.beginPath()
      ctx.moveTo(-sw / 2, cut)
      ctx.lineTo(sw / 2, cut)
      ctx.stroke()
      ctx.restore()
      if (welding && Math.random() < 0.5) {
        const f = Math.random() - 0.5
        const c = Math.cos(rot)
        const s = Math.sin(rot)
        const px = u.x + c * f * sw - s * cut
        const py = u.y + s * f * sw + c * cut
        for (let i = 0; i < 3; i++) {
          const b = Math.random() * TAU
          const v = 40 + Math.random() * 110
          this.add({ kind: 'spark', x: px, y: py, vx: Math.cos(b) * v, vy: Math.sin(b) * v, life: 0.25 + Math.random() * 0.3, size: 1.4, color: '#ffd27a' })
        }
      }
    } else ctx.restore()
    if (planned && z > 0.12) {
      ctx.save()
      ctx.font = `600 ${12 / z}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.fillStyle = `rgba(${rgb},0.9)`
      ctx.fillText('Awaiting engineers', u.x, u.y + Math.max(sw, sh) * 0.55 + 16 / z)
      ctx.restore()
    }
  }

  /**
   * The ship a yard is building, taking shape in its berth: its frame (every plate's outline) in the
   * yard's working light, filled in solid from the stern as the work goes on. Drawn over the yard's
   * hull and under its crane, nose to the yard's mouth, shrunk to fit if the berth is short for it.
   */
  private drawBerth(ctx: CanvasRenderingContext2D, u: Unit, ym: Model, z: number, alpha: number) {
    const q = u.yq?.[0]
    const b = YARD_BERTHS[u.t.id]
    if (!q || !b || building(u)) return
    const st = this.typeOf(q.unit)
    const m = modelFor(st)
    if (!m) return
    const ky = u.t.size / ym.long
    const [w0, h0] = dims(st)
    const fit = Math.min(1, ((b.y1 - b.y0) * ky * 0.9) / h0, (b.hw * 2 * ky * 1.15) / w0)
    const size = st.size * fit
    const k = size / m.long
    const rot = u.a + Math.PI / 2
    const cy = ((b.y0 + b.y1) / 2) * ky
    const x = u.x - Math.sin(rot) * cy
    const y = u.y + Math.cos(rot) * cy
    const progress = Math.max(0, Math.min(1, 1 - q.left / Math.max(0.001, q.total)))
    const zdpr = z * (window.devicePixelRatio || 1)
    const rgb = u.t.faction === 'republic' ? '130,205,255' : '255,186,120'
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    ctx.globalAlpha *= alpha
    const half = (m.h / 2) * k
    ctx.save()
    ctx.beginPath()
    ctx.rect(-size, half - progress * half * 2, size * 2, size * 2)
    ctx.clip()
    drawHull(ctx, m, 0, 0, 0, size, zdpr, FRESH, { alpha: 0.85, lightRot: rot })
    ctx.restore()
    ctx.scale(k, k)
    ctx.strokeStyle = `rgba(${rgb},0.5)`
    ctx.lineWidth = 1 / z / k
    ctx.stroke(outlineOf(m).frame)
    ctx.restore()
  }

  /** A yard being placed: its ghost where it would go, the slipway's mouth marked, green where it can
   * go and red (with why) where it can't, and what it costs. */
  private drawPlace(ctx: CanvasRenderingContext2D, g: NonNullable<View['place']>, z: number) {
    const zdpr = z * (window.devicePixelRatio || 1)
    const col = g.ok ? '#7dffa0' : '#ff5a50'
    const rot = g.a + Math.PI / 2
    const [sw, sh] = dims(g.t)
    const m = this.modelsOn ? modelFor(g.t) : null
    if (m) drawHull(ctx, m, g.x, g.y, rot, g.t.size, zdpr, FRESH, { alpha: g.ok ? 0.6 : 0.3 })
    else this.drawSprite(ctx, g.t.sprite, g.x, g.y, rot, g.t.size, z, g.ok ? 0.6 : 0.3)
    ctx.save()
    ctx.translate(g.x, g.y)
    ctx.rotate(rot)
    ctx.fillStyle = g.ok ? 'rgba(125,255,160,0.1)' : 'rgba(255,90,80,0.12)'
    ctx.strokeStyle = col
    ctx.lineWidth = 2 / z
    ctx.fillRect(-sw / 2, -sh / 2, sw, sh)
    ctx.strokeRect(-sw / 2, -sh / 2, sw, sh)
    // The slipway's mouth: where its ships come out.
    ctx.beginPath()
    ctx.moveTo(-14 / z, -sh / 2 - 6 / z)
    ctx.lineTo(0, -sh / 2 - 22 / z)
    ctx.lineTo(14 / z, -sh / 2 - 6 / z)
    ctx.stroke()
    ctx.restore()
    const label = g.ok ? `${g.rebuild ? 'Rebuild' : g.t.name}: ${g.cost} credits` : (g.why ?? '')
    ctx.save()
    ctx.font = `600 ${12 / z}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    const tw = ctx.measureText(label).width + 14 / z
    const ly = g.y + Math.max(sw, sh) * 0.55 + 10 / z
    ctx.fillStyle = 'rgba(6,10,22,0.85)'
    ctx.fillRect(g.x - tw / 2, ly, tw, 20 / z)
    ctx.fillStyle = col
    ctx.textBaseline = 'middle'
    ctx.fillText(label, g.x, ly + 10 / z)
    ctx.restore()
  }

  /** Ruined yards: the burnt-out hull where each one fell, broken across in three and sagged apart,
   * for its owner to rebuild (labelled with the price for them). Everyone else sees one once their
   * ships have it in sight. */
  private drawRuins(ctx: CanvasRenderingContext2D, w: World, view: View, z: number, zdpr: number, onScreen: (x: number, y: number, r?: number) => boolean) {
    const team = w.players[view.me].team
    for (const r of w.ruins ?? []) {
      const t = UNIT[r.unit]
      if (!t || !onScreen(r.x, r.y, t.size)) continue
      const ours = w.players[r.owner].team === team
      if (!ours && !w.units.some((u) => !u.dead && w.players[u.owner].team === team && (u.x - r.x) ** 2 + (u.y - r.y) ** 2 < sensorOf(u) ** 2)) continue
      const m = this.modelsOn ? modelFor(t) : null
      const rot = r.a + Math.PI / 2
      if (m) {
        const st = wreckState(m, r.id)
        const k = t.size / m.long
        const c = Math.cos(rot)
        const s = Math.sin(rot)
        breakPieces(m, 'pieces', hash(r.id, 0x5e1d) % 1000).forEach((p, i) => {
          // Each piece pushed a little out from the middle and turned a touch, as it settled.
          const rr = seeded(hash(r.id, i, 0x2a7))
          const l = Math.hypot(p.cx, p.cy) || 1
          const push = m.long * (0.025 + rr() * 0.025)
          const lx = (p.cx + (p.cx / l) * push) * k
          const ly = (p.cy + (p.cy / l) * push) * k
          drawPiece(ctx, m, p, `ruin${r.id}.${i}`, st, r.x + lx * c - ly * s, r.y + lx * s + ly * c, rot + (rr() - 0.5) * 0.1, t.size, zdpr, 0.92)
        })
      } else {
        ctx.filter = 'brightness(0.5) saturate(0.45)'
        this.drawSprite(ctx, t.sprite, r.x, r.y, rot, t.size, z, 0.8)
        ctx.filter = 'none'
      }
      if (r.owner === view.me && z > 0.15) {
        ctx.save()
        ctx.font = `600 ${12 / z}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.fillStyle = 'rgba(255,200,110,0.85)'
        ctx.fillText(`Ruined yard: engineers rebuild it for ${Math.round(t.cost * REBUILD)}`, r.x, r.y + t.size * 0.6 + 14 / z)
        ctx.restore()
      }
    }
  }

  /** A sprite with its colour knocked out to a burnt dark, for a module that was shot off. */
  private burnt(name: string) {
    let c = this.dark.get(name)
    if (c) return c
    const img = this.imgs.get(name)
    if (!img || !img.complete || !img.naturalWidth) return null
    c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    g.globalCompositeOperation = 'source-atop'
    g.fillStyle = 'rgba(22,16,14,0.72)'
    g.fillRect(0, 0, c.width, c.height)
    this.dark.set(name, c)
    return c
  }

  /**
   * Where a gun points: at what it shoots, eased round towards it; with nothing to shoot, the crew
   * scans, slowly sweeping to and fro, each gun on its own rhythm (a station's or platform's guns
   * look all round, a ship's keep roughly ahead). A wrecked gun stays where it last pointed. Called
   * once per gun per frame.
   */
  private aim(u: Unit, i: number, w: World) {
    const t = u.t
    const ahead = u.a + Math.PI / 2
    const p = hpPos(u, i)
    const dead = u.hps[i].hp <= 0
    const key = u.id * 64 + i
    const g = dead ? undefined : u.guns.find((x) => x.hp === i)
    const e = g?.target ? w.byId.get(g.target) : undefined
    const fixed = !isShip(t)
    const seed = (u.id * 13 + i * 7) % 17
    const sweep = this.clock * (0.18 + (seed % 5) * 0.03) + seed
    const scan = fixed ? ahead + Math.sin(sweep) * Math.PI + Math.sin(sweep * 0.37) * 0.8 : ahead + Math.sin(sweep) * 0.9
    const want = e && !e.dead && Math.hypot(e.x - p.x, e.y - p.y) < g!.w.range * 1.3 ? Math.atan2(e.y - p.y, e.x - p.x) + Math.PI / 2 : scan
    const cur = this.aims.get(key) ?? want
    const d = ((want - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI
    const rot = dead ? cur : cur + d * 0.12
    this.aims.set(key, rot)
    return rot
  }

  /**
   * Every module on a hull: guns, shield generators, hangars and station parts, each its own sprite
   * on its socket. Guns turn towards what they shoot at and ease back along the hull; a module that
   * was shot off shows as a burnt wreck.
   */
  private drawModules(ctx: CanvasRenderingContext2D, u: Unit, w: World, z: number) {
    const t = u.t
    const ahead = u.a + Math.PI / 2
    // Faded with the hull while it's still being built.
    const fade = building(u) ? 0.55 : 1
    for (let i = 0; i < t.hardpoints.length; i++) {
      const h = t.hardpoints[i]
      if (!h.art) continue
      const size = (h.s ?? 0.05) * t.size
      if (size * z < 2) continue
      const p = hpPos(u, i)
      const dead = u.hps[i].hp <= 0
      const rot = h.weapon ? this.aim(u, i, w) : ahead
      if (!dead) {
        this.drawSprite(ctx, moduleSprite(t.faction, h.art), p.x, p.y, rot, size, z, fade)
        continue
      }
      // The Republic's turrets have a wreck of their own; everything else is burnt where it stands.
      if (h.weapon && t.faction === 'republic') {
        this.drawSprite(ctx, moduleSprite('republic', 'wreck'), p.x, p.y, rot, size, z)
        continue
      }
      const img = this.burnt(moduleSprite(t.faction, h.art))
      if (!img) continue
      const k = size / Math.max(img.width, img.height)
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(rot)
      ctx.drawImage(img, (-img.width * k) / 2, (-img.height * k) / 2, img.width * k, img.height * k)
      ctx.restore()
    }
  }

  private drawUnit(ctx: CanvasRenderingContext2D, u: Unit, w: World, z: number, view: View) {
    const t = u.t
    const fac = FACTIONS[t.faction]
    // Small craft keep a minimum size on screen when zoomed far out, so fleets stay readable.
    const minPx = t.tier === 'fighter' ? 9 : t.tier === 'gunship' ? 14 : 0
    const size = Math.max(t.size, minPx / z)
    const k = size / t.size
    const [sw, sh] = dims(t)
    const sel = view.selected.has(u.id)
    const hov = view.hover === u.id
    const rel = relColor(w, view.me, u.owner)
    const m = this.modelsOn ? modelFor(t) : null
    // Worked out this frame already while keeping up with the models (see trackModels).
    const tr = m ? this.tracked.get(u.id) : undefined
    const st: HullState | null = m ? (tr && tr.u === u && tr.m === m ? tr.st : hullState(m, u, t.tier)) : null
    const lit = m && st ? liveEngines(m, st) : null

    // Engine glow, stronger at speed.
    if (t.engines.length && isShip(t)) {
      ctx.globalCompositeOperation = 'lighter'
      const thrust = 0.35 + 0.65 * Math.min(1, u.v / Math.max(1, t.speed))
      const flick = 0.85 + Math.random() * 0.15
      const engines = t.hardpoints.flatMap((h, i) => (h.kind === 'engine' ? [i] : []))
      for (const [ei, [gx, gy]] of t.engines.entries()) {
        // An engine pod blown off the model takes its glow with it.
        if (lit && !lit[ei]) continue
        // A glow belongs to the nearest engine hardpoint and goes dark with it.
        const near = engines.reduce((a, b) => (Math.hypot(t.hardpoints[b].x - gx, t.hardpoints[b].y - gy) < Math.hypot(t.hardpoints[a].x - gx, t.hardpoints[a].y - gy) ? b : a), engines[0] ?? -1)
        if (near >= 0 && u.hps[near].hp <= 0) continue
        const p = shipPoint(u, gx, gy)
        const ex = u.x + (p.x - u.x) * k
        const ey = u.y + (p.y - u.y) * k
        const r = Math.max(4 / z, size * (t.tier === 'fighter' ? 0.35 : 0.07)) * thrust * flick
        const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, r)
        g.addColorStop(0, '#ffffff')
        // A model's engines burn in its own palette's colour (the droid navy's blue-white).
        g.addColorStop(0.3, m ? PALETTES[m.faction].engine : fac.glow)
        g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(ex, ey, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    // Team ring: a faint ellipse in the relative colour, so allies and enemies of the same faction
    // can be told apart.
    if (view.rings && !sel && !hov) {
      ctx.strokeStyle = rel
      ctx.globalAlpha = t.tier === 'fighter' ? 0.35 : 0.28
      ctx.lineWidth = Math.max(1 / z, 1.2)
      ctx.beginPath()
      const rr = Math.max(sw, sh) * 0.5 * k + 2 / z
      ctx.ellipse(u.x, u.y, rr, rr * 0.92, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // Selection ring underneath.
    if (sel || hov) {
      ctx.strokeStyle = rel
      ctx.globalAlpha = sel ? 0.9 : 0.5
      ctx.lineWidth = 1.6 / z
      ctx.beginPath()
      ctx.ellipse(u.x, u.y, Math.max(sw, sh) * 0.55 * k + 4 / z, Math.max(sw, sh) * 0.55 * k + 4 / z, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // A defense wing craft far from its station fights at a fraction of its strength: drawn faded.
    const alpha = building(u) ? 0.55 : t.kind === 'wing' && !atHome(w, u) ? 0.45 : 1
    if (u.site) this.drawSite(ctx, u, w, m, size, z)
    else if (m && st) {
      const zdpr = z * (window.devicePixelRatio || 1)
      drawHull(ctx, m, u.x, u.y, u.a + Math.PI / 2, size, zdpr, st, { alpha })
      if (t.tier === 'yard') this.drawBerth(ctx, u, m, z, alpha)
      if (m.mounts.length) drawMounts(ctx, m, u.x, u.y, u.a + Math.PI / 2, size, zdpr, u.hps, (i) => this.aim(u, i, w), alpha)
    } else {
      this.drawSprite(ctx, t.sprite, u.x, u.y, u.a + Math.PI / 2, size, z, alpha)
      if (t.hardpoints.some((h) => h.art)) this.drawModules(ctx, u, w, z)
    }
    if (u.retreat > 0) this.drawCharge(ctx, u, z)
    // An expansion going up on its socket: a scaffold ring turning round it, filling as it's built.
    const job = u.xq?.[0]
    if (job && (u.owner === view.me || u.seen[w.players[view.me].team])) {
      const x = MODULE[job.id]
      const g = x.on === 'station' ? STATION_SOCKETS[x.socket] : (x.on === 'cyard' ? CYARD_SOCKETS : YARD_SOCKETS)[t.faction][x.socket]
      const p = shipPoint(u, g[0], g[1])
      const r = x.s * t.size * 0.62
      const done = 1 - job.left / job.total
      ctx.save()
      ctx.strokeStyle = 'rgba(255,200,110,0.7)'
      ctx.lineWidth = 1.5 / z
      ctx.setLineDash([6 / z, 5 / z])
      ctx.lineDashOffset = (-this.clock * 18) / z
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, TAU)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.strokeStyle = '#ffc86e'
      ctx.lineWidth = 3 / z
      ctx.beginPath()
      ctx.arc(p.x, p.y, r + 4 / z, -Math.PI / 2, -Math.PI / 2 + done * TAU)
      ctx.stroke()
      ctx.restore()
    }

    // Shield shimmer on the side that was hit.
    const since = w.time - u.shieldHit
    if (since < 0.4 && u.shield > 0) {
      ctx.globalCompositeOperation = 'lighter'
      const rx = Math.max(sw, sh) * 0.62 * k
      ctx.strokeStyle = fac.glow
      ctx.globalAlpha = (1 - since / 0.4) * 0.7
      ctx.lineWidth = Math.max(2 / z, rx * 0.06)
      ctx.beginPath()
      ctx.arc(u.x, u.y, rx, u.hitAngle - 0.9, u.hitAngle + 0.9)
      ctx.stroke()
      ctx.globalAlpha = (1 - since / 0.4) * 0.12
      ctx.fillStyle = fac.glow
      ctx.beginPath()
      ctx.arc(u.x, u.y, rx, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }

    // Construction ring.
    if (building(u)) {
      ctx.strokeStyle = '#7dffa0'
      ctx.lineWidth = 4 / z
      ctx.beginPath()
      ctx.arc(u.x, u.y, t.size * 0.62, -Math.PI / 2, -Math.PI / 2 + (1 - u.building / t.build) * Math.PI * 2)
      ctx.stroke()
    }

    // Hardpoint markers on selected or hovered warships, once they're big enough to read: a dark
    // disc with the part's icon, ringed in its colour as far round as its health goes, centred on
    // the part.
    if ((sel || hov) && u.hps.length && t.size * z > 90) {
      t.hardpoints.forEach((h, i) => {
        const p = hpPos(u, i)
        const st = u.hps[i]
        const hi = hov && view.hoverHp === i
        const r = Math.max(9 / z, t.size * 0.032) * (hi ? 1.25 : 1)
        ctx.fillStyle = st.hp <= 0 ? 'rgba(60,8,8,0.8)' : 'rgba(6,10,22,0.78)'
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.fill()
        // The icon: drawn on its 24-unit grid, scaled to fit inside the disc.
        ctx.save()
        ctx.translate(p.x, p.y)
        const k2 = (r * 1.25) / 24
        ctx.scale(k2, k2)
        ctx.translate(-12, -12)
        ctx.strokeStyle = st.hp <= 0 ? 'rgba(255,120,110,0.7)' : 'rgba(235,242,255,0.92)'
        ctx.lineWidth = 2.2
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.stroke(iconPath(h.kind))
        ctx.restore()
        ctx.lineWidth = (hi ? 2.6 : 1.8) / z
        if (st.hp <= 0) {
          ctx.strokeStyle = 'rgba(255,80,70,0.9)'
          ctx.beginPath()
          ctx.moveTo(p.x - r * 0.75, p.y - r * 0.75)
          ctx.lineTo(p.x + r * 0.75, p.y + r * 0.75)
          ctx.stroke()
          return
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.15)'
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.stroke()
        ctx.strokeStyle = HP_COLOR[h.kind]
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + (st.hp / st.max) * Math.PI * 2)
        ctx.stroke()
      })
    }

    // Health and shield bars: selected and hovered ships, plus recently hit ones (or every one).
    const barsOn = sel || hov || (view.bars === 'always' ? isShip(t) || u.hull < u.hullMax : view.bars === 'damaged' && w.time - u.lastHit < 3)
    if (barsOn && !(t.tier === 'fighter' && !sel && !hov && z < 0.6)) {
      const bw = Math.max(26 / z, Math.min(sw, sh) * 0.8 * k)
      const bh = 3.2 / z
      const by = u.y - Math.max(sw, sh) * 0.55 * k - 10 / z
      const bx = u.x - bw / 2
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(bx - 1 / z, by - 1 / z, bw + 2 / z, bh * (t.shield ? 2 : 1) + 3 / z)
      // Veterancy: a gold chevron per rank, just left of the bar.
      if (u.rank > 0) {
        ctx.strokeStyle = '#f2c14a'
        ctx.lineWidth = 1.6 / z
        const cw = 5 / z
        for (let i = 0; i < u.rank; i++) {
          const cx = bx - 5 / z - cw / 2
          const cy = by + bh * (t.shield ? 1 : 0.5) - (i - (u.rank - 1) / 2) * 3.4 / z
          ctx.beginPath()
          ctx.moveTo(cx - cw / 2, cy + cw * 0.35)
          ctx.lineTo(cx, cy - cw * 0.15)
          ctx.lineTo(cx + cw / 2, cy + cw * 0.35)
          ctx.stroke()
        }
      }
      const hf = u.hull / u.hullMax
      ctx.fillStyle = hf > 0.6 ? '#6fe08a' : hf > 0.3 ? '#f2c14a' : '#ff5a50'
      ctx.fillRect(bx, by, bw * hf, bh)
      if (t.shield) {
        ctx.fillStyle = '#59c8ff'
        ctx.fillRect(bx, by + bh + 1 / z, (bw * u.shield) / Math.max(1, shieldFull(u)), bh)
        const cap = shieldMax(u) / shieldFull(u)
        if (cap < 1) {
          ctx.fillStyle = 'rgba(255,80,70,0.5)'
          ctx.fillRect(bx + bw * cap, by + bh + 1 / z, bw * (1 - cap), bh)
        }
      }
    }
  }

  /** A small tag under a spot on the map: an order's icon and a word or two, at a fixed size on
   * screen, `below` pixels under it. */
  tag(ctx: CanvasRenderingContext2D, at: Pt, below: number, text: string, icon: 'patrol' | 'guard', rgb: string, z: number) {
    ctx.save()
    ctx.translate(at.x, at.y)
    ctx.scale(1 / z, 1 / z)
    ctx.font = '600 11px system-ui, sans-serif'
    const tw = ctx.measureText(text).width + 30
    const y = below
    ctx.fillStyle = 'rgba(6,10,22,0.86)'
    ctx.strokeStyle = `rgba(${rgb},0.75)`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(-tw / 2, y, tw, 20, 5)
    ctx.fill()
    ctx.stroke()
    // The order's icon, as on its cursor, drawn into a 13 px square.
    ctx.save()
    ctx.translate(-tw / 2 + 5, y + 3.5)
    ctx.scale(13 / 32, 13 / 32)
    ctx.strokeStyle = `rgb(${rgb})`
    ctx.lineWidth = 3.4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke(tagIcon(icon))
    ctx.restore()
    ctx.fillStyle = '#dbeaff'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, -tw / 2 + 23, y + 10.5)
    ctx.restore()
  }

  /** The minimap: the backdrop behind, what our ships can see, nebulas and asteroid fields, ore, beacons, ships, stations, the
   * last alert, and the camera's view as a bracketed box. */
  minimap(
    ctx: CanvasRenderingContext2D, w: World, me: Owner, cam: Camera, vw: number, vh: number, mw: number, mh: number, alarm: { x: number; y: number; t: number } | null,
    filter: 'all' | 'ships' | 'stations' | 'enemies' = 'all',
    /** A player whose ships aren't shown yet (ours, before we've picked where to start). */
    hide = -1,
  ) {
    const s = Math.min(mw / w.w, mh / w.h)
    const ox = (mw - w.w * s) / 2
    const oy = (mh - w.h * s) / 2
    const X = (x: number) => ox + x * s
    const Y = (y: number) => oy + y * s
    ctx.clearRect(0, 0, mw, mh)
    ctx.fillStyle = '#03050c'
    ctx.fillRect(0, 0, mw, mh)
    const bg = this.imgs.get('backdrop')
    if (bg?.complete && bg.naturalWidth) {
      ctx.globalAlpha = 0.55
      ctx.drawImage(bg, ox, oy, w.w * s, w.h * s)
      ctx.globalAlpha = 1
    }
    // What we can see, lit up; the rest stays dim.
    ctx.fillStyle = 'rgba(2,4,12,0.45)'
    ctx.fillRect(ox, oy, w.w * s, w.h * s)
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = 'rgba(70,110,170,0.09)'
    for (const u of w.units) {
      if (u.owner === hide) continue
      if (w.players[u.owner].team !== w.players[me].team) continue
      ctx.beginPath()
      ctx.arc(X(u.x), Y(u.y), sensorOf(u) * s, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
    // A faint grid.
    ctx.strokeStyle = 'rgba(140,180,240,0.07)'
    ctx.lineWidth = 1
    for (let gx = 700; gx < w.w; gx += 700) {
      ctx.beginPath()
      ctx.moveTo(X(gx), oy)
      ctx.lineTo(X(gx), oy + w.h * s)
      ctx.stroke()
    }
    for (let gy = 680; gy < w.h; gy += 680) {
      ctx.beginPath()
      ctx.moveTo(ox, Y(gy))
      ctx.lineTo(ox + w.w * s, Y(gy))
      ctx.stroke()
    }
    drawTerrainOverview(ctx, w.map, ox, oy, s)
    ctx.fillStyle = 'rgba(150,150,165,0.4)'
    for (const r of w.rocks) {
      ctx.beginPath()
      ctx.arc(X(r.x), Y(r.y), Math.max(1, r.r * s * 0.8), 0, Math.PI * 2)
      ctx.fill()
    }
    // Wrecks: small amber squares.
    ctx.fillStyle = '#f2c14a'
    for (const h of w.wrecks) ctx.fillRect(X(h.x) - 2, Y(h.y) - 2, 4, 4)
    // Ore: small crystals.
    for (const n of w.nodes) {
      const x = X(n.x)
      const y = Y(n.y)
      ctx.fillStyle = n.owner === -1 ? '#4fe3d8' : teamColor(w, me, n.owner)
      ctx.beginPath()
      ctx.moveTo(x, y - 4)
      ctx.lineTo(x + 3, y)
      ctx.lineTo(x, y + 4)
      ctx.lineTo(x - 3, y)
      ctx.closePath()
      ctx.fill()
    }
    // Beacons: a ring, filled when held, with capture progress.
    for (const b of w.beacons) {
      const x = X(b.x)
      const y = Y(b.y)
      const col = b.owner === -1 ? '#c8d0e0' : teamColor(w, me, b.owner)
      ctx.strokeStyle = col
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.stroke()
      if (b.owner !== -1) {
        ctx.fillStyle = col
        ctx.globalAlpha = 0.35
        ctx.fill()
        ctx.globalAlpha = 1
      }
      if (b.progress > 0 && b.progress < 1 && b.claim >= 0) {
        ctx.strokeStyle = teamColor(w, me, b.claim)
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(x, y, 8, -Math.PI / 2, -Math.PI / 2 + b.progress * Math.PI * 2)
        ctx.stroke()
      }
    }
    // Ships as dots sized by class; mines and stations as framed squares.
    for (const u of w.units) {
      if (u.owner === hide) continue
      if (!u.seen[w.players[me].team]) continue
      // The filter tabs under the map.
      if (filter === 'ships' && !isShip(u.t)) continue
      if (filter === 'stations' && isShip(u.t)) continue
      if (filter === 'enemies' && !foes(w, u.owner, me)) continue
      const col = relColor(w, me, u.owner)
      const x = X(u.x)
      const y = Y(u.y)
      if (u.t.tier === 'station' || u.t.tier === 'mine' || u.t.tier === 'defense' || u.t.tier === 'yard') {
        const r = u.t.tier === 'station' ? 6 : u.t.tier === 'yard' ? 5 : u.t.tier === 'defense' ? 4 : 3.5
        ctx.fillStyle = 'rgba(0,0,0,0.6)'
        ctx.fillRect(x - r - 1, y - r - 1, r * 2 + 2, r * 2 + 2)
        ctx.strokeStyle = col
        ctx.lineWidth = 1.5
        ctx.strokeRect(x - r, y - r, r * 2, r * 2)
        if (u.t.tier === 'station') {
          ctx.fillStyle = FACTIONS[u.t.faction].color
          ctx.fillRect(x - 2.5, y - 2.5, 5, 5)
        }
        continue
      }
      const big = u.t.tier === 'capital' ? 3.5 : u.t.tier === 'cruiser' ? 2.8 : u.t.tier === 'frigate' ? 2.3 : u.t.tier === 'gunship' ? 1.8 : 1.1
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.arc(x, y, big, 0, Math.PI * 2)
      ctx.fill()
    }
    // The last alert pulses for a few seconds.
    if (alarm && w.time - alarm.t < 6) {
      const k = ((w.time - alarm.t) % 1.2) / 1.2
      ctx.strokeStyle = `rgba(255,90,80,${1 - k})`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(X(alarm.x), Y(alarm.y), 4 + k * 14, 0, Math.PI * 2)
      ctx.stroke()
    }
    // The camera's view, with corner brackets.
    const ww = (vw / cam.zoom) * s
    const wh = (vh / cam.zoom) * s
    const x0 = X(cam.x) - ww / 2
    const y0 = Y(cam.y) - wh / 2
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth = 1
    ctx.strokeRect(x0, y0, ww, wh)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    const c = Math.min(8, ww / 3, wh / 3)
    for (const [cx, cy, dx, dy] of [
      [x0, y0, 1, 1],
      [x0 + ww, y0, -1, 1],
      [x0, y0 + wh, 1, -1],
      [x0 + ww, y0 + wh, -1, -1],
    ]) {
      ctx.beginPath()
      ctx.moveTo(cx + dx * c, cy)
      ctx.lineTo(cx, cy)
      ctx.lineTo(cx, cy + dy * c)
      ctx.stroke()
    }
    return { s, ox, oy }
  }
}
