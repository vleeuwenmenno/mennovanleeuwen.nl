import type { StatusId } from './combat'
import type { SpellId } from './data'
import { drawFighter, rigFor, tipOf, weaponKind, type Kit, type Point } from './render'
import { Puppet, gripOf } from './rig'

// The fight scene: a painted backdrop, a camera that leans in as the fighters close, the two
// puppets, and everything that flies: blood, sparks, dust, spells, damage numbers, taunts.
// World space is 1280x720 with the sand at GROUND.

export const VIEW_W = 1280
export const VIEW_H = 720
export const GROUND = 612
/** Puppets are drawn a little larger than their rig units. */
export const FIG = 1.22

/** Where each painted arena's wall meets the sand, as a fraction of the image height. */
const FLOOR_LINE: Record<string, number> = { 'arena-pits': 0.585, 'arena-city': 0.635, 'arena-colosseum': 0.645, 'training': 0.86 }
const BG_X = -64
const BG_W = VIEW_W + 128

export type Actor = {
  kit: Kit
  puppet: Puppet
  x: number
  facing: 1 | -1
  flash: number
  wounds: number
  aura: string | null
  potion: string | null
  seed: number
  slide: { from: number; to: number; t: number; dur: number } | null
  statuses: StatusId[]
  bubble: { text: string; until: number } | null
  /** Last drawn head, chest and weapon tip in world space, for effects. */
  head: Point
  chest: Point
  tip: Point
}

type Particle = {
  kind: 'blood' | 'spark' | 'dust' | 'fire' | 'frost' | 'heal' | 'magic' | 'petal' | 'star' | 'smoke'
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  size: number
  color: string
  rot: number
  vr: number
  g: number
}
type Decal = { x: number; y: number; rx: number; ry: number; color: string; alpha: number }
type FloatText = { text: string; x: number; y: number; vy: number; life: number; max: number; color: string; size: number }
type Projectile = { spell: SpellId; x: number; y: number; sx: number; sy: number; tx: number; ty: number; t: number; dur: number; onHit: () => void }
type Bolt = { x: number; y: number; life: number; pts: Point[] }

export function makeActor(kit: Kit, x: number, facing: 1 | -1, seed: number): Actor {
  return {
    kit,
    puppet: new Puppet(gripOf(weaponKind(kit))),
    x,
    facing,
    flash: 0,
    wounds: 0,
    aura: null,
    potion: null,
    seed,
    slide: null,
    statuses: [],
    bubble: null,
    head: { x, y: GROUND - 220 },
    chest: { x, y: GROUND - 160 },
    tip: { x, y: GROUND - 160 },
  }
}

const rand = (a: number, b: number) => a + Math.random() * (b - a)

export class ArenaScene {
  bg: HTMLImageElement | null = null
  bgName = ''
  actors: Actor[] = []
  particles: Particle[] = []
  decals: Decal[] = []
  texts: FloatText[] = []
  projectiles: Projectile[] = []
  bolts: Bolt[] = []
  shake = 0
  screenFlash: { color: string; a: number } | null = null
  /** Slow motion: 1 is normal speed. */
  timeScale = 1
  hitstop = 0
  cam = { x: VIEW_W / 2, z: 1 }
  private framed = false
  front = 0
  /** Extra zoom for previews outside the fight. */
  fixedCam: { x: number; z: number } | null = null

  setBackground(name: string) {
    if (this.bgName === name) return
    this.bgName = name
    const img = new Image()
    img.src = `/games/gladiator/${name}.webp`
    img.onload = () => {
      if (this.bgName === name) this.bg = img
    }
  }

  // --- Effects ---------------------------------------------------------------------------------

  blood(x: number, y: number, dir: number, amount: number) {
    for (let i = 0; i < amount; i++) {
      this.particles.push({ kind: 'blood', x, y, vx: dir * rand(60, 360) + rand(-60, 60), vy: rand(-320, -40), life: 0, max: rand(0.6, 1.2), size: rand(2.5, 5.5), color: Math.random() < 0.3 ? '#7a0a10' : '#c0141e', rot: 0, vr: 0, g: 900 })
    }
  }

  sparks(x: number, y: number, dir: number, amount: number, color = '#ffe08a') {
    for (let i = 0; i < amount; i++) {
      const a = rand(-Math.PI, Math.PI)
      const s = rand(200, 620)
      this.particles.push({ kind: 'spark', x, y, vx: Math.cos(a) * s + dir * 120, vy: Math.sin(a) * s - 80, life: 0, max: rand(0.18, 0.4), size: rand(1.5, 2.8), color, rot: 0, vr: 0, g: 600 })
    }
  }

  dust(x: number, amount: number, spread = 30) {
    for (let i = 0; i < amount; i++) {
      this.particles.push({ kind: 'dust', x: x + rand(-spread, spread), y: GROUND - rand(0, 8), vx: rand(-60, 60), vy: rand(-50, -10), life: 0, max: rand(0.5, 1), size: rand(8, 18), color: '#d9b77a', rot: 0, vr: 0, g: -10 })
    }
  }

  burst(kind: Particle['kind'], x: number, y: number, amount: number, color: string, speed = 220, g = 0) {
    for (let i = 0; i < amount; i++) {
      const a = rand(-Math.PI, Math.PI)
      const s = rand(speed * 0.3, speed)
      this.particles.push({ kind, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: rand(0.4, 0.9), size: rand(3, 7), color, rot: rand(0, 6), vr: rand(-6, 6), g })
    }
  }

  petals(amount: number) {
    for (let i = 0; i < amount; i++) {
      this.particles.push({ kind: 'petal', x: rand(-100, VIEW_W + 100), y: rand(-200, -20), vx: rand(-40, 40), vy: rand(60, 140), life: 0, max: rand(3, 5), size: rand(4, 7), color: Math.random() < 0.7 ? '#d81e3a' : '#f4f1e6', rot: rand(0, 6), vr: rand(-4, 4), g: 0 })
    }
  }

  text(text: string, x: number, y: number, color: string, size = 34) {
    this.texts.push({ text, x: x + rand(-14, 14), y, vy: -70, life: 0, max: 1.1, color, size })
  }

  projectile(spell: SpellId, from: Point, to: Point, onHit: () => void) {
    const d = Math.hypot(to.x - from.x, to.y - from.y)
    this.projectiles.push({ spell, x: from.x, y: from.y, sx: from.x, sy: from.y, tx: to.x, ty: to.y, t: 0, dur: Math.max(0.18, d / 900), onHit })
  }

  bolt(x: number, y: number) {
    const pts: Point[] = []
    for (let yy = -40; yy < y; yy += 30) pts.push({ x: x + rand(-26, 26), y: yy })
    pts.push({ x, y })
    this.bolts.push({ x, y, life: 0.35, pts })
    this.screenFlash = { color: '#e8f0ff', a: 0.55 }
  }

  slide(a: Actor, to: number, dur: number) {
    a.slide = { from: a.x, to, t: 0, dur: Math.max(1, dur) }
  }

  // --- Simulation ------------------------------------------------------------------------------

  update(dtMs: number, now: number) {
    if (this.hitstop > 0) {
      this.hitstop -= dtMs
      return
    }
    const dt = (dtMs / 1000) * this.timeScale
    for (const a of this.actors) {
      a.puppet.update(dtMs * this.timeScale)
      if (a.slide) {
        a.slide.t += dtMs * this.timeScale
        const k = Math.min(1, a.slide.t / a.slide.dur)
        const e = k * k * (3 - 2 * k)
        a.x = a.slide.from + (a.slide.to - a.slide.from) * e
        if (k >= 1) a.slide = null
      }
      a.flash = Math.max(0, a.flash - dt * 6)
      if (a.bubble && now > a.bubble.until) a.bubble = null
      // Ongoing status effects shed particles.
      if (a.statuses.includes('burning') && Math.random() < 0.6) this.particles.push({ kind: 'fire', x: a.chest.x + rand(-16, 16), y: a.chest.y + rand(-20, 60), vx: rand(-20, 20), vy: rand(-140, -60), life: 0, max: rand(0.3, 0.6), size: rand(5, 10), color: '#ff8a2a', rot: 0, vr: 0, g: 0 })
      if (a.statuses.includes('slowed') && Math.random() < 0.15) this.particles.push({ kind: 'frost', x: a.chest.x + rand(-20, 20), y: a.chest.y + rand(-30, 90), vx: 0, vy: rand(10, 40), life: 0, max: 0.8, size: rand(2, 4), color: '#cdf4ff', rot: 0, vr: 2, g: 0 })
      if (a.statuses.includes('weakened') && Math.random() < 0.2) this.particles.push({ kind: 'magic', x: a.chest.x + rand(-24, 24), y: a.chest.y + rand(-20, 90), vx: 0, vy: rand(-40, -10), life: 0, max: 0.9, size: rand(2, 4), color: '#b48cff', rot: 0, vr: 0, g: 0 })
      if (a.statuses.includes('frenzy') && Math.random() < 0.4) this.particles.push({ kind: 'heal', x: a.chest.x + rand(-30, 30), y: a.chest.y + rand(-40, 100), vx: 0, vy: rand(-80, -30), life: 0, max: 0.7, size: rand(2, 4), color: '#ffd84a', rot: 0, vr: 0, g: 0 })
    }

    const keep: Particle[] = []
    for (const p of this.particles) {
      p.life += dt
      p.vy += p.g * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.rot += p.vr * dt
      if (p.kind === 'petal') p.vx += Math.sin(now / 300 + p.rot) * 20 * dt
      if (p.kind === 'blood' && p.y >= GROUND - 4 + p.size && p.vy > 0) {
        // Blood that reaches the sand stays there as a splat.
        this.decals.push({ x: p.x, y: GROUND + rand(-6, 14), rx: p.size * rand(1.4, 2.6), ry: p.size * rand(0.4, 0.7), color: p.color, alpha: 0.85 })
        if (this.decals.length > 90) this.decals.shift()
        continue
      }
      if (p.kind === 'petal' && p.y >= GROUND + rand(-4, 20)) {
        p.vx = p.vy = p.vr = 0
        p.g = 0
      }
      if (p.life < p.max) keep.push(p)
    }
    this.particles = keep

    for (const t of this.texts) {
      t.life += dt
      t.y += t.vy * dt
      t.vy *= 0.97
    }
    this.texts = this.texts.filter((t) => t.life < t.max)

    for (const pr of this.projectiles) {
      pr.t += dt / pr.dur
      const k = Math.min(1, pr.t)
      pr.x = pr.sx + (pr.tx - pr.sx) * k
      pr.y = pr.sy + (pr.ty - pr.sy) * k - Math.sin(k * Math.PI) * 30
      const trail = pr.spell === 'fireball' ? '#ff8a2a' : pr.spell === 'frost' ? '#bdf0ff' : pr.spell === 'weaken' ? '#b48cff' : '#fff6b0'
      for (let i = 0; i < 3; i++) this.particles.push({ kind: pr.spell === 'fireball' ? 'fire' : 'magic', x: pr.x + rand(-6, 6), y: pr.y + rand(-6, 6), vx: rand(-30, 30), vy: rand(-30, 30), life: 0, max: rand(0.2, 0.45), size: rand(4, 9), color: trail, rot: 0, vr: 0, g: 0 })
      if (pr.t >= 1) pr.onHit()
    }
    this.projectiles = this.projectiles.filter((p) => p.t < 1)
    for (const b of this.bolts) b.life -= dt
    this.bolts = this.bolts.filter((b) => b.life > 0)
    this.shake = Math.max(0, this.shake - dt * 40)
    if (this.screenFlash) {
      this.screenFlash.a -= dt * 2.5
      if (this.screenFlash.a <= 0) this.screenFlash = null
    }
  }

  // --- Drawing ---------------------------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, width: number, height: number, now: number) {
    const [a, b] = this.actors
    // Scale by height, so a tall phone canvas shows less width rather than a thin strip.
    // Fill the whole canvas: scale to its height, or to the backdrop's width when the window is
    // wider than the painting, cropping a little sky rather than showing bars.
    const k = Math.max(height / VIEW_H, width / BG_W)
    const visible = width / k
    let target = { x: VIEW_W / 2, z: 1 }
    if (this.fixedCam) target = this.fixedCam
    else if (a && b) {
      const d = Math.abs(a.x - b.x)
      const lean = 1.32 - (d - 170) / 1100
      // Never so close that either fighter leaves the frame.
      const fit = visible / (d + 340)
      target = { x: (a.x + b.x) / 2, z: Math.max(0.55, Math.min(1.32, Math.max(1, lean), fit)) }
    }
    if (!this.framed) {
      // The first frame starts already framed; after that the camera eases.
      this.cam = { ...target }
      this.framed = true
    }
    this.cam.z += (target.z - this.cam.z) * 0.06
    this.cam.x += (target.x - this.cam.x) * 0.08
    const z = this.cam.z
    const half = visible / 2 / z
    const cx = Math.max(BG_X + half, Math.min(BG_X + BG_W - half, this.cam.x))
    const sx = this.shake ? rand(-this.shake, this.shake) : 0
    const sy = this.shake ? rand(-this.shake, this.shake) : 0
    // The sand sits at the same share of the canvas height however it's shaped.
    // On a tall (phone) canvas the sand sits a bit higher, keeping the fighters off the bottom edge.
    const tall = height > width * 1.1
    const groundPx = height * (tall ? 0.78 : GROUND / VIEW_H) + (z - 1) * 50 * k
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#2a1a0e'
    ctx.fillRect(0, 0, width, height)
    ctx.setTransform(k * z, 0, 0, k * z, width / 2 + k * (sx - cx * z), groundPx + k * (sy - GROUND * z))

    // Backdrop.
    if (this.bg) {
      const h = (BG_W * this.bg.height) / this.bg.width
      const top = 470 - (FLOOR_LINE[this.bgName] ?? 0.62) * h
      ctx.drawImage(this.bg, BG_X, top, BG_W, h)
      // Zoomed out on a tall screen the view can reach past the painting: continue it with mirrored
      // copies above (more sky) and below (more sand), so the edges never show.
      for (const edge of [top, top + h]) {
        ctx.save()
        ctx.translate(0, 2 * edge)
        ctx.scale(1, -1)
        ctx.drawImage(this.bg, BG_X, top, BG_W, h)
        ctx.restore()
      }
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, VIEW_H)
      g.addColorStop(0, '#7ab4e0')
      g.addColorStop(0.62, '#e8d2a0')
      g.addColorStop(0.63, '#d4a860')
      g.addColorStop(1, '#b88a48')
      ctx.fillStyle = g
      ctx.fillRect(BG_X, -200, BG_W, VIEW_H + 400)
    }

    for (const d of this.decals) {
      ctx.globalAlpha = d.alpha
      ctx.fillStyle = d.color
      ctx.beginPath()
      ctx.ellipse(d.x, d.y, d.rx, d.ry, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    // Shadows, then the fighters, the one who acted last in front.
    for (const ac of this.actors) {
      ctx.fillStyle = 'rgba(40,24,8,0.28)'
      ctx.beginPath()
      ctx.ellipse(ac.x, GROUND + 4, 66, 13, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    const order = this.actors.map((_, i) => i).sort((i, j) => (i === this.front ? 1 : 0) - (j === this.front ? 1 : 0))
    for (const i of order) this.drawActor(ctx, this.actors[i], now)

    for (const p of this.particles) this.drawParticle(ctx, p)
    for (const pr of this.projectiles) {
      const c = pr.spell === 'fireball' ? '#ffb24a' : pr.spell === 'frost' ? '#dff8ff' : pr.spell === 'weaken' ? '#c9a8ff' : '#ffffff'
      ctx.save()
      ctx.shadowColor = c
      ctx.shadowBlur = 24
      ctx.fillStyle = c
      ctx.beginPath()
      ctx.arc(pr.x, pr.y, pr.spell === 'frost' ? 11 : 18, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    for (const bo of this.bolts) {
      ctx.save()
      ctx.strokeStyle = '#ffffff'
      ctx.shadowColor = '#9ec8ff'
      ctx.shadowBlur = 24
      ctx.lineWidth = 5
      ctx.globalAlpha = Math.min(1, bo.life * 4)
      ctx.beginPath()
      // Jitter every frame so the bolt crackles.
      bo.pts.forEach((p, i) => (i ? ctx.lineTo(p.x + rand(-5, 5), p.y) : ctx.moveTo(p.x, p.y)))
      ctx.stroke()
      ctx.restore()
    }

    for (const t of this.texts) {
      const f = 1 - t.life / t.max
      ctx.globalAlpha = Math.min(1, f * 2.5)
      const s = t.size * (t.life < 0.12 ? 0.6 + (t.life / 0.12) * 0.6 : 1.2 - Math.min(0.2, t.life))
      ctx.font = `900 ${s}px Impact, 'Arial Black', sans-serif`
      ctx.textAlign = 'center'
      ctx.lineWidth = 6
      ctx.strokeStyle = '#1a0d06'
      ctx.strokeText(t.text, t.x, t.y)
      ctx.fillStyle = t.color
      ctx.fillText(t.text, t.x, t.y)
    }
    ctx.globalAlpha = 1
    for (const ac of this.actors) if (ac.bubble) this.drawBubble(ctx, ac)

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (this.screenFlash) {
      ctx.globalAlpha = Math.max(0, this.screenFlash.a)
      ctx.fillStyle = this.screenFlash.color
      ctx.fillRect(0, 0, width, height)
      ctx.globalAlpha = 1
    }
    // Vignette.
    const v = ctx.createRadialGradient(width / 2, height * 0.55, height * 0.45, width / 2, height * 0.55, width * 0.75)
    v.addColorStop(0, 'rgba(0,0,0,0)')
    v.addColorStop(1, 'rgba(20,8,0,0.45)')
    ctx.fillStyle = v
    ctx.fillRect(0, 0, width, height)
  }

  private drawActor(ctx: CanvasRenderingContext2D, ac: Actor, now: number) {
    const pose = ac.puppet.pose(now)
    const toWorld = (p: Point): Point => ({ x: ac.x + p.x * ac.facing * FIG, y: GROUND + p.y * FIG })
    const r = rigFor(pose, weaponKind(ac.kit))
    ac.head = toWorld(r.head)
    ac.chest = toWorld({ x: (r.hip.x + r.neck.x) / 2, y: (r.hip.y + r.neck.y) / 2 })
    ac.tip = toWorld(tipOf(ac.kit, pose))
    ctx.save()
    ctx.translate(ac.x, GROUND)
    ctx.scale(ac.facing * FIG, FIG)
    if (ac.flash > 0) ctx.filter = `brightness(${1 + ac.flash * 1.4}) saturate(${1 - ac.flash * 0.5})`
    drawFighter(ctx, ac.kit, pose, { time: now, wounds: ac.wounds, aura: ac.aura ?? (ac.statuses.includes('frenzy') ? '#ffd84a' : null), potion: ac.potion, seed: ac.seed })
    ctx.restore()
    // Stars circle a stunned head; a dark cloud hangs over a blinded one.
    if (ac.statuses.includes('stunned')) {
      for (let i = 0; i < 3; i++) {
        const a = now / 260 + (i * Math.PI * 2) / 3
        this.drawStar(ctx, ac.head.x + Math.cos(a) * 26, ac.head.y - 30 + Math.sin(a) * 7, 6, '#ffe04a')
      }
    }
    if (ac.statuses.includes('blinded')) {
      ctx.fillStyle = 'rgba(40,30,50,0.55)'
      for (let i = 0; i < 4; i++) {
        ctx.beginPath()
        ctx.arc(ac.head.x + Math.sin(now / 300 + i) * 10 + (i - 1.5) * 8, ac.head.y - 4 + Math.cos(now / 250 + i) * 3, 9, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  private drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string) {
    ctx.beginPath()
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2
      const k = i % 2 ? r * 0.45 : r
      ctx.lineTo(x + Math.cos(a) * k, y + Math.sin(a) * k)
    }
    ctx.closePath()
    ctx.fillStyle = c
    ctx.fill()
    ctx.strokeStyle = '#5a3a00'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  private drawParticle(ctx: CanvasRenderingContext2D, p: Particle) {
    const f = 1 - p.life / p.max
    switch (p.kind) {
      case 'blood':
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.ellipse(p.x, p.y, p.size, p.size * 0.8, Math.atan2(p.vy, p.vx), 0, Math.PI * 2)
        ctx.fill()
        break
      case 'spark':
        ctx.strokeStyle = p.color
        ctx.globalAlpha = f
        ctx.lineWidth = p.size
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03)
        ctx.stroke()
        ctx.globalAlpha = 1
        break
      case 'dust':
      case 'smoke':
        ctx.fillStyle = p.color
        ctx.globalAlpha = f * 0.45
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size * (1.6 - f * 0.6), 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
        break
      case 'fire':
        ctx.fillStyle = f > 0.5 ? '#ffd27a' : p.color
        ctx.globalAlpha = f
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size * f, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
        break
      case 'petal':
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.globalAlpha = Math.min(1, f * 3)
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
        break
      case 'star':
        ctx.globalAlpha = f
        this.drawStar(ctx, p.x, p.y, p.size, p.color)
        ctx.globalAlpha = 1
        break
      default:
        ctx.fillStyle = p.color
        ctx.globalAlpha = f
        ctx.beginPath()
        if (p.kind === 'frost') {
          ctx.save()
          ctx.translate(p.x, p.y)
          ctx.rotate(p.rot)
          ctx.rect(-p.size / 2, -p.size * 1.5, p.size, p.size * 3)
          ctx.restore()
        } else ctx.arc(p.x, p.y, p.size * (0.5 + f * 0.5), 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
    }
  }

  private drawBubble(ctx: CanvasRenderingContext2D, ac: Actor) {
    const text = ac.bubble!.text
    ctx.font = "600 17px 'Trebuchet MS', sans-serif"
    // Wrap to about 220 units wide.
    const words = text.split(' ')
    const lines: string[] = []
    let line = ''
    for (const w of words) {
      const t = line ? `${line} ${w}` : w
      if (ctx.measureText(t).width > 220 && line) {
        lines.push(line)
        line = w
      } else line = t
    }
    if (line) lines.push(line)
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 24
    const h = lines.length * 21 + 14
    const x = Math.max(BG_X + w / 2 + 10, Math.min(BG_X + BG_W - w / 2 - 10, ac.head.x + ac.facing * 40))
    const y = ac.head.y - 60 - h
    ctx.fillStyle = '#fffaf0'
    ctx.strokeStyle = '#22140c'
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.roundRect(x - w / 2, y, w, h, 12)
    ctx.moveTo(ac.head.x + ac.facing * 10, y + h + 22)
    ctx.lineTo(ac.head.x + ac.facing * 24, y + h - 1)
    ctx.lineTo(ac.head.x + ac.facing * 40, y + h - 1)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#22140c'
    ctx.textAlign = 'center'
    lines.forEach((l, i) => ctx.fillText(l, x, y + 25 + i * 21))
  }
}
