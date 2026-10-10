import { FACTIONS, SURVEY_RADIUS, dims, isShip, type HardpointKind, type Tier } from './data'
import { HP_COLOR, HP_ICON, HP_NAME } from './icons'
import { rng, type MapDef, type Nebula, type Patch } from './maps'
import { building, foes, hpPos, radius, sensorOf, shieldFull, shieldMax, shipPoint, type Owner, type SimEvent, type Unit, type World } from './sim'

// Drawing the battle on a 2D canvas: the painted backdrop and two star layers in parallax, nebulas
// and asteroid fields, ore, rocks and beacons, the ships (generated sprites rotated in code, with engine glow, shield
// shimmer and hardpoint markers), laser bolts, explosions and smoke, then fog of war on top. The
// minimap is drawn here too.

const BASE = '/games/empires/'
export const spriteUrl = (name: string) => `${BASE}${/^(mine|defense)-/.test(name) ? 'world' : 'ships'}/${name}.webp`
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
  selected: Set<number>
  hover: number
  hoverHp: number
  /** Screen-space drag rectangle. */
  box: { x0: number; y0: number; x1: number; y1: number } | null
  /** The ore asteroid clicked on, or -1. */
  node: number
  hoverNode: number
  showRally: boolean
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
    const count = Math.round(Math.min(130, Math.max(14, (f.r * f.r) / 2600)))
    for (let k = 0; k < count; k++) {
      const a = r() * TAU
      const d = Math.sqrt(r()) * (f.r - 12)
      rocks.push({
        x: f.x + Math.cos(a) * d, y: f.y + Math.sin(a) * d, size: 8 + r() ** 2.2 * 34, rot: r() * TAU, spin: (r() - 0.5) * 0.8, kind: r() < 0.5 ? 0 : 1,
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

const TIER_ORDER: Record<Tier, number> = { station: 0, mine: 1, defense: 1, capital: 2, cruiser: 3, frigate: 4, gunship: 5, fighter: 6 }
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
        if (e.tier === 'fighter' || e.tier === 'gunship') {
          this.blast(e.x, e.y, e.size * 1.2)
          this.debris(e.x, e.y, e.size * 2, color)
        } else {
          // Big ships come apart in a chain of blasts before the final one.
          const n = Math.round(3 + e.size / 40)
          for (let i = 0; i < n; i++) {
            const a = Math.random() * 6.28
            const r = Math.random() * e.size * 0.4
            this.pending.push({ at: this.clock + i * (0.12 + Math.random() * 0.1), x: e.x + Math.cos(a) * r, y: e.y + Math.sin(a) * r, size: e.size * (0.25 + Math.random() * 0.2), final: false })
          }
          this.pending.push({ at: this.clock + n * 0.17, x: e.x, y: e.y, size: e.size, final: true })
          this.debris(e.x, e.y, e.size, color)
        }
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
      for (const u of w.units) {
        if (!isShip(u.t) && u.t.tier !== 'station') continue
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
    this.step(dt, w)
    const z = cam.zoom
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

    // The world.
    ctx.translate(vw / 2, vh / 2)
    ctx.scale(z, z)
    ctx.translate(-cam.x, -cam.y)
    const left = cam.x - vw / 2 / z - 300
    const right = cam.x + vw / 2 / z + 300
    const top = cam.y - vh / 2 / z - 300
    const bottom = cam.y + vh / 2 / z + 300
    const onScreen = (x: number, y: number, r = 0) => x + r > left && x - r < right && y + r > top && y - r < bottom

    ctx.strokeStyle = 'rgba(140,170,220,0.18)'
    ctx.lineWidth = 2 / z
    ctx.setLineDash([24 / z, 18 / z])
    ctx.strokeRect(0, 0, w.w, w.h)
    ctx.setLineDash([])

    this.drawTerrain(ctx, w, z, onScreen)

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
    ctx.lineWidth = 1.5 / z
    for (const id of view.selected) {
      const u = w.byId.get(id)
      if (!u || u.owner !== view.me) continue
      const o = u.order
      if (o.k === 'patrol') {
        ctx.strokeStyle = 'rgba(143,208,255,0.35)'
        ctx.setLineDash([10 / z, 8 / z])
        ctx.beginPath()
        ctx.moveTo(o.bx, o.by)
        ctx.lineTo(o.x, o.y)
        ctx.stroke()
        ctx.setLineDash([])
      } else if (o.k === 'move') {
        ctx.strokeStyle = o.attack ? 'rgba(255,170,90,0.35)' : 'rgba(125,255,160,0.3)'
        ctx.beginPath()
        ctx.moveTo(u.x, u.y)
        ctx.lineTo(o.x, o.y)
        ctx.stroke()
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
    }

    // Ships and stations, big ones first so fighters fly over them.
    const myTeam = w.players[view.me].team
    const shown = w.units.filter((u) => u.seen[myTeam] && onScreen(u.x, u.y, u.t.size))
    shown.sort((a, b) => TIER_ORDER[a.t.tier] - TIER_ORDER[b.t.tier])
    for (const u of shown) this.drawUnit(ctx, u, w, z, view)

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
      const len = s.kind === 'turbo' ? 46 : s.kind === 'flak' ? 10 : 22
      const width = s.kind === 'turbo' ? 5 : s.kind === 'flak' ? 2.2 : 2.6
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
    f.fillStyle = 'rgba(2,4,12,0.55)'
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
      const kind = hp >= 0 ? hu.t.hardpoints[hp].kind : null
      const st = hp >= 0 ? hu.hps[hp] : null
      const rel = relColor(w, view.me, hu.owner)
      const title = kind ? HP_NAME[kind] : `${rel === OWN ? '' : rel === ALLY ? 'Allied ' : 'Enemy '}${hu.t.name}`
      const sub = st ? (st.hp > 0 ? `${Math.ceil(st.hp)} / ${st.max}` : 'Destroyed') : `Hull ${Math.round((hu.hull / hu.hullMax) * 100)}%${hu.t.shield ? ` · Shield ${Math.round((hu.shield / shieldFull(hu)) * 100)}%` : ''}`
      ctx.font = '600 12px system-ui, sans-serif'
      const tw = Math.max(ctx.measureText(title).width, (ctx.font = '11px system-ui, sans-serif', ctx.measureText(sub).width)) + 20
      const th = st ? 40 : 34
      const bx = Math.min(vw - tw - 6, Math.max(6, sx - tw / 2))
      const by = Math.max(46, sy - th)
      ctx.fillStyle = 'rgba(6,10,22,0.9)'
      ctx.strokeStyle = kind ? HP_COLOR[kind] : rel
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
        ctx.fillStyle = HP_COLOR[kind!]
        ctx.fillRect(bx + 10, by + th - 7, (tw - 20) * (st.hp / st.max), 3)
      }
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
      grd.addColorStop(0, 'rgba(160,140,112,0.16)')
      grd.addColorStop(0.8, 'rgba(150,130,105,0.1)')
      grd.addColorStop(1, 'rgba(140,120,100,0)')
      ctx.fillStyle = grd
      ctx.beginPath()
      ctx.arc(f.x, f.y, f.r, 0, TAU)
      ctx.fill()
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

    // Engine glow, stronger at speed.
    if (t.engines.length && isShip(t)) {
      ctx.globalCompositeOperation = 'lighter'
      const thrust = 0.35 + 0.65 * Math.min(1, u.v / Math.max(1, t.speed))
      const flick = 0.85 + Math.random() * 0.15
      for (const [gx, gy] of t.engines) {
        const p = shipPoint(u, gx, gy)
        const ex = u.x + (p.x - u.x) * k
        const ey = u.y + (p.y - u.y) * k
        const r = Math.max(4 / z, size * (t.tier === 'fighter' ? 0.35 : 0.07)) * thrust * flick
        const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, r)
        g.addColorStop(0, '#ffffff')
        g.addColorStop(0.3, fac.glow)
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

    this.drawSprite(ctx, t.sprite, u.x, u.y, u.a + Math.PI / 2, size, z, building(u) ? 0.55 : 1)

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
    // disc with the part's icon, ringed in its colour as far round as its health goes.
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

  /** The minimap: the backdrop behind, what our ships can see, nebulas and asteroid fields, ore, beacons, ships, stations, the
   * last alert, and the camera's view as a bracketed box. */
  minimap(
    ctx: CanvasRenderingContext2D, w: World, me: Owner, cam: Camera, vw: number, vh: number, mw: number, mh: number, alarm: { x: number; y: number; t: number } | null,
    filter: 'all' | 'ships' | 'stations' | 'enemies' = 'all',
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
      if (!u.seen[w.players[me].team]) continue
      // The filter tabs under the map.
      if (filter === 'ships' && !isShip(u.t)) continue
      if (filter === 'stations' && isShip(u.t)) continue
      if (filter === 'enemies' && !foes(w, u.owner, me)) continue
      const col = relColor(w, me, u.owner)
      const x = X(u.x)
      const y = Y(u.y)
      if (u.t.tier === 'station' || u.t.tier === 'mine' || u.t.tier === 'defense') {
        const r = u.t.tier === 'station' ? 6 : u.t.tier === 'defense' ? 4 : 3.5
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
