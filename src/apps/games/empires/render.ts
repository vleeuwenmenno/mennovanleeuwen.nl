import { FACTIONS, dims, isShip, type HardpointKind, type Tier } from './data'
import { building, hpPos, radius, shieldMax, shipPoint, type Owner, type SimEvent, type Unit, type World } from './sim'

// Drawing the battle on a 2D canvas: the painted backdrop and two star layers in parallax, ore,
// rocks and beacons, the ships (generated sprites rotated in code, with engine glow, shield
// shimmer and hardpoint markers), laser bolts, explosions and smoke, then fog of war on top. The
// minimap is drawn here too.

const BASE = '/games/empires/'
export const spriteUrl = (name: string) => `${BASE}${name.startsWith('mine-') ? 'world' : 'ships'}/${name}.webp`
const WORLD_SPRITES = ['asteroid-1', 'asteroid-2', 'asteroid-ore', 'beacon', 'backdrop']

export type Camera = { x: number; y: number; zoom: number }
export type View = {
  me: Owner
  selected: Set<number>
  hover: number
  hoverHp: number
  /** Screen-space drag rectangle. */
  box: { x0: number; y0: number; x1: number; y1: number } | null
  placingMine: boolean
  hoverNode: number
  showRally: boolean
}

type Particle = {
  kind: 'spark' | 'fire' | 'smoke' | 'ring' | 'flash' | 'debris' | 'muzzle'
  x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; grow: number; color: string; rot: number; vr: number
}
type Pending = { at: number; x: number; y: number; size: number; final: boolean }
type Ping = { x: number; y: number; t: number; color: string }

const TIER_ORDER: Record<Tier, number> = { station: 0, mine: 1, capital: 2, cruiser: 3, frigate: 4, gunship: 5, fighter: 6 }
const HP_COLOR: Record<HardpointKind, string> = { turret: '#ffb347', shield: '#59c8ff', engine: '#ffe066', hangar: '#7dffa0' }

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
      for (const u of w.units) if (u.owner === me && (u.x - x) ** 2 + (u.y - y) ** 2 < u.t.sensor ** 2) return true
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
        if (!seen(e.x, e.y) && e.owner !== me) continue
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

    // Beacons, with their capture ring.
    for (const b of w.beacons) {
      if (!onScreen(b.x, b.y, 400)) continue
      const col = b.owner === -1 ? 'rgba(200,210,230,0.5)' : FACTIONS[w.players[b.owner].faction].color
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
      if (b.progress !== 0) {
        const o: Owner = b.progress < 0 ? 0 : 1
        ctx.strokeStyle = FACTIONS[w.players[o].faction].color
        ctx.lineWidth = 7 / Math.max(z, 0.4)
        ctx.beginPath()
        ctx.arc(b.x, b.y, 95, -Math.PI / 2, -Math.PI / 2 + Math.abs(b.progress) * Math.PI * 2)
        ctx.stroke()
      }
    }

    // Ore, and the rocks around it.
    for (const n of w.nodes) {
      if (!onScreen(n.x, n.y, 200)) continue
      if (view.placingMine && !n.mine) {
        ctx.strokeStyle = view.hoverNode === n.id ? '#7dffa0' : 'rgba(125,255,160,0.5)'
        ctx.lineWidth = (view.hoverNode === n.id ? 4 : 2) / z
        ctx.beginPath()
        ctx.arc(n.x, n.y, 120 + Math.sin(this.clock * 4) * 6, 0, Math.PI * 2)
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
      if (o.k === 'move') {
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
    const shown = w.units.filter((u) => (u.owner === view.me || u.seen[view.me]) && onScreen(u.x, u.y, u.t.size))
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
      if (u.owner !== view.me) continue
      const r = (u.t.sensor * (building(u) ? 0.5 : 1) * z) / fs
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
    const enemy = u.owner !== view.me

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

    // Selection ring underneath.
    if (sel || hov) {
      ctx.strokeStyle = enemy ? '#ff5a50' : '#7dffa0'
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

    // Hardpoint markers on selected or hovered warships, once they're big enough to read.
    if ((sel || hov) && u.hps.length && t.size * z > 90) {
      t.hardpoints.forEach((h, i) => {
        const p = hpPos(u, i)
        const st = u.hps[i]
        const r = Math.max(5 / z, t.size * 0.028)
        const hi = hov && view.hoverHp === i
        ctx.lineWidth = (hi ? 3 : 1.8) / z
        if (st.hp <= 0) {
          ctx.strokeStyle = 'rgba(255,80,70,0.8)'
          ctx.beginPath()
          ctx.moveTo(p.x - r, p.y - r)
          ctx.lineTo(p.x + r, p.y + r)
          ctx.moveTo(p.x + r, p.y - r)
          ctx.lineTo(p.x - r, p.y + r)
          ctx.stroke()
          return
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 2 / z, 0, Math.PI * 2)
        ctx.stroke()
        ctx.strokeStyle = HP_COLOR[h.kind]
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + (st.hp / st.max) * Math.PI * 2)
        ctx.stroke()
        if (hi) {
          ctx.fillStyle = HP_COLOR[h.kind]
          ctx.globalAlpha = 0.3
          ctx.beginPath()
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
        }
      })
    }

    // Health and shield bars: selected, hovered, or recently hit.
    if ((sel || hov || w.time - u.lastHit < 3) && !(t.tier === 'fighter' && !sel && !hov && z < 0.6)) {
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
        ctx.fillRect(bx, by + bh + 1 / z, (bw * u.shield) / Math.max(1, t.shield), bh)
        const cap = shieldMax(u) / t.shield
        if (cap < 1) {
          ctx.fillStyle = 'rgba(255,80,70,0.5)'
          ctx.fillRect(bx + bw * cap, by + bh + 1 / z, bw * (1 - cap), bh)
        }
      }
    }
  }

  /** The minimap: ore, beacons, ships as dots, and the camera's view as a box. */
  minimap(ctx: CanvasRenderingContext2D, w: World, me: Owner, cam: Camera, vw: number, vh: number, mw: number, mh: number) {
    const s = Math.min(mw / w.w, mh / w.h)
    const ox = (mw - w.w * s) / 2
    const oy = (mh - w.h * s) / 2
    ctx.clearRect(0, 0, mw, mh)
    ctx.fillStyle = 'rgba(6,10,22,0.92)'
    ctx.fillRect(0, 0, mw, mh)
    ctx.fillStyle = 'rgba(120,130,150,0.35)'
    for (const r of w.rocks) {
      ctx.beginPath()
      ctx.arc(ox + r.x * s, oy + r.y * s, Math.max(1, r.r * s), 0, Math.PI * 2)
      ctx.fill()
    }
    for (const n of w.nodes) {
      ctx.fillStyle = '#4fe3d8'
      ctx.fillRect(ox + n.x * s - 2, oy + n.y * s - 2, 4, 4)
    }
    for (const b of w.beacons) {
      ctx.strokeStyle = b.owner === -1 ? '#c8d0e0' : FACTIONS[w.players[b.owner].faction].color
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(ox + b.x * s, oy + b.y * s, 4, 0, Math.PI * 2)
      ctx.stroke()
    }
    for (const u of w.units) {
      if (u.owner !== me && !u.seen[me]) continue
      ctx.fillStyle = u.owner === me ? '#7dffa0' : '#ff5a50'
      const big = u.t.tier === 'station' ? 6 : u.t.tier === 'capital' || u.t.tier === 'mine' ? 4 : u.t.tier === 'fighter' ? 1.5 : 2.5
      ctx.fillRect(ox + u.x * s - big / 2, oy + u.y * s - big / 2, big, big)
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'
    ctx.lineWidth = 1
    const ww = vw / cam.zoom
    const wh = vh / cam.zoom
    ctx.strokeRect(ox + (cam.x - ww / 2) * s, oy + (cam.y - wh / 2) * s, ww * s, wh * s)
    return { s, ox, oy }
  }
}
