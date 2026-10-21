import { FACTIONS } from '../data.ts'
import type { Owner, World } from '../sim.ts'
import { CONE, muzzle } from './combat.ts'
import { sees } from './fog.ts'
import { TILE } from './types.ts'

// How the ground weapons look (the battle screen draws these through groundKit, over the units and
// under the fog): pulse bolts in the side's bolt colour, a beam that holds on its target and swells
// as it burns, rockets with smoke trails, heavy shells, artillery lobbed in an arc with its shadow on
// the ground, swarm rocket salvos, and spray cones (Republic flame, droid gas, Swarm acid) with what
// they set burning. In world coordinates; only what our team sees.

/** A spray's colours by faction: its core and its edge. */
const SPRAY: Record<string, [string, string]> = {
  republic: ['255,196,96', '255,110,40'],
  droid: ['214,240,120', '150,190,60'],
  swarm: ['190,255,120', '120,200,70'],
}

const TAU = Math.PI * 2

export function drawEffects(ctx: CanvasRenderingContext2D, w: World, me: Owner, zoom: number, clock: number) {
  const g = w.ground
  if (!g) return
  const team = w.players[me].team
  const px = 1 / zoom
  const seen = (x: number, y: number) => {
    const c = Math.floor(x / TILE)
    const r = Math.floor(y / TILE)
    return c >= 0 && r >= 0 && c < g.nav.cols && r < g.nav.rows && sees(g.fog, team, r * g.nav.cols + c)
  }
  ctx.save()
  ctx.lineCap = 'round'
  // Beams and sprays, held from their guns.
  for (const u of w.units) {
    if (u.dead || !u.t.ground || !u.guns.length) continue
    const f = FACTIONS[w.players[u.owner].faction]
    for (const gun of u.guns) {
      const k = gun.w.ground
      if ((k !== 'beam' && k !== 'spray') || !gun.target || !gun.hold) continue
      const from = muzzle(u, gun)
      if (!seen(from.x, from.y) && w.players[u.owner].team !== team) continue
      if (k === 'beam') {
        const e = w.byId.get(gun.target)
        if (!e || e.dead) continue
        const swell = Math.min(2, 1 + gun.hold / 2)
        const flick = 0.85 + 0.15 * Math.sin(clock * 40 + u.id)
        ctx.globalCompositeOperation = 'lighter'
        ctx.strokeStyle = f.glow
        ctx.globalAlpha = 0.35 * flick
        ctx.lineWidth = (5 + swell * 3) * Math.max(1, px * 0.6)
        ctx.beginPath()
        ctx.moveTo(from.x, from.y)
        ctx.lineTo(e.x, e.y)
        ctx.stroke()
        ctx.strokeStyle = '#ffffff'
        ctx.globalAlpha = 0.9
        ctx.lineWidth = (1.2 + swell) * Math.max(1, px * 0.6)
        ctx.stroke()
        // Where it burns.
        ctx.fillStyle = f.glow
        ctx.globalAlpha = 0.6 * flick
        ctx.beginPath()
        ctx.arc(e.x, e.y, 5 + swell * 3, 0, TAU)
        ctx.fill()
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      } else {
        const [core, rim] = SPRAY[w.players[u.owner].faction] ?? SPRAY.republic
        const range = gun.w.range
        ctx.globalCompositeOperation = 'lighter'
        // A cone of puffs, flickering out along it.
        for (let i = 0; i < 14; i++) {
          const t = ((clock * 3 + i / 14 + u.id * 0.37) % 1)
          const a = gun.aim + Math.sin(i * 12.9898 + clock * 7) * CONE * 0.85
          const d = range * t
          const r = 4 + t * 16
          ctx.fillStyle = `rgba(${t < 0.4 ? core : rim},${0.5 * (1 - t)})`
          ctx.beginPath()
          ctx.arc(from.x + Math.cos(a) * d, from.y + Math.sin(a) * d, r, 0, TAU)
          ctx.fill()
        }
        ctx.globalCompositeOperation = 'source-over'
      }
    }
    // Something burning from a spray.
  }
  for (const u of w.units) {
    if (u.dead || !u.burn || !u.seen[team]) continue
    const [core] = SPRAY[w.players[u.burn.by]?.faction ?? 'republic'] ?? SPRAY.republic
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < 3; i++) {
      const a = clock * 5 + i * 2.1 + u.id
      ctx.fillStyle = `rgba(${core},${0.35 + 0.2 * Math.sin(a * 3)})`
      ctx.beginPath()
      ctx.arc(u.x + Math.cos(a) * 5, u.y + Math.sin(a) * 5 - 3, 4 + i, 0, TAU)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  }
  // Shots in flight.
  for (const s of w.gshots ?? []) {
    if (!seen(s.x, s.y) && w.players[s.owner].team !== team) continue
    const f = FACTIONS[w.players[s.owner].faction]
    const sp = Math.hypot(s.vx, s.vy) || 1
    const dx = s.vx / sp
    const dy = s.vy / sp
    if (s.g === 'pulse') {
      ctx.globalCompositeOperation = 'lighter'
      ctx.strokeStyle = f.bolt
      ctx.globalAlpha = 0.5
      ctx.lineWidth = 5 * Math.max(1, px * 0.5)
      ctx.beginPath()
      ctx.moveTo(s.x - dx * 16, s.y - dy * 16)
      ctx.lineTo(s.x, s.y)
      ctx.stroke()
      ctx.strokeStyle = '#ffffff'
      ctx.globalAlpha = 0.9
      ctx.lineWidth = 1.6 * Math.max(1, px * 0.5)
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    } else if (s.g === 'rocket' || s.g === 'swarm') {
      const big = s.g === 'rocket'
      // The smoke trail, then the rocket and its flame.
      const len = big ? 34 : 18
      const trail = ctx.createLinearGradient(s.x, s.y, s.x - dx * len, s.y - dy * len)
      trail.addColorStop(0, 'rgba(210,210,210,0.55)')
      trail.addColorStop(1, 'rgba(160,160,160,0)')
      ctx.strokeStyle = trail
      ctx.lineWidth = big ? 5 : 3
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(s.x - dx * len, s.y - dy * len)
      ctx.stroke()
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = '#ffb060'
      ctx.beginPath()
      ctx.arc(s.x - dx * (big ? 4 : 2), s.y - dy * (big ? 4 : 2), big ? 3.5 : 2.2, 0, TAU)
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = '#3a3a40'
      ctx.lineWidth = big ? 3 : 2
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(s.x + dx * (big ? 7 : 4), s.y + dy * (big ? 7 : 4))
      ctx.stroke()
    } else if (s.g === 'shell') {
      ctx.strokeStyle = 'rgba(255,220,150,0.45)'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(s.x - dx * 14, s.y - dy * 14)
      ctx.lineTo(s.x, s.y)
      ctx.stroke()
      ctx.fillStyle = '#fff2c8'
      ctx.beginPath()
      ctx.arc(s.x, s.y, 3, 0, TAU)
      ctx.fill()
    } else if (s.g === 'artillery') {
      // Lobbed: its shadow on the ground, the shell up in its arc (higher and bigger mid-flight).
      const p = Math.min(1, s.age / s.flight)
      const lift = 4 * p * (1 - p) * (40 + s.flight * 30)
      ctx.fillStyle = 'rgba(0,0,0,0.3)'
      ctx.beginPath()
      ctx.ellipse(s.x, s.y, 4, 2.5, 0, 0, TAU)
      ctx.fill()
      const r = 3.5 + lift / 30
      ctx.strokeStyle = 'rgba(255,200,120,0.35)'
      ctx.lineWidth = r
      ctx.beginPath()
      ctx.moveTo(s.x - dx * 10, s.y - lift - dy * 10 + 2)
      ctx.lineTo(s.x, s.y - lift)
      ctx.stroke()
      ctx.fillStyle = '#ffe2a8'
      ctx.beginPath()
      ctx.arc(s.x, s.y - lift, r, 0, TAU)
      ctx.fill()
    }
  }
  ctx.restore()
}
