import { CUSHIONS, FOOT_X, HEAD_X, L, POCKETS, R, W, type Ball } from './physics'

// Drawing for the pool table. The table itself is painted once per size into its own canvas; the
// balls are ray-traced per pixel into small sprites, so stripes and numbers roll with the ball.

export const MARGIN = 0.17 // cushion plus wooden rail around the bed, in metres
export const TOTAL_W = L + 2 * MARGIN
export const TOTAL_H = W + 2 * MARGIN
const CUSHION_W = 0.05

export const BALL_COLORS: Record<number, [number, number, number]> = {
  0: [246, 243, 232],
  1: [245, 190, 20],
  2: [28, 78, 190],
  3: [212, 40, 40],
  4: [92, 42, 140],
  5: [240, 118, 22],
  6: [18, 120, 58],
  7: [122, 30, 30],
  8: [22, 22, 24],
}
export const ballColor = (id: number) => BALL_COLORS[id > 8 ? id - 8 : id]
/** The one colour every object ball has in the simple game. */
export const PLAIN: [number, number, number] = [196, 30, 36]
export const ballCss = (id: number) => `rgb(${ballColor(id).join(',')})`

export type View = { k: number; ox: number; oy: number; rot?: boolean }
export const viewFor = (width: number): View => {
  const k = width / TOTAL_W
  return { k, ox: MARGIN * k, oy: MARGIN * k }
}

export function paintTable(ctx: CanvasRenderingContext2D, v: View) {
  const { k } = v
  ctx.save()
  ctx.translate(v.ox, v.oy)
  ctx.scale(k, k)

  // Wooden frame.
  const wood = ctx.createLinearGradient(0, -MARGIN, 0, W + MARGIN)
  wood.addColorStop(0, '#6e4322')
  wood.addColorStop(0.5, '#5a3418')
  wood.addColorStop(1, '#3f230f')
  ctx.fillStyle = wood
  ctx.beginPath()
  ctx.roundRect(-MARGIN, -MARGIN, L + 2 * MARGIN, W + 2 * MARGIN, 0.05)
  ctx.fill()
  // A little grain.
  ctx.globalAlpha = 0.07
  ctx.strokeStyle = '#000'
  ctx.lineWidth = 0.002
  for (let i = 0; i < 70; i++) {
    const y = -MARGIN + ((i * 37) % 100) / 100 * (W + 2 * MARGIN)
    ctx.beginPath()
    ctx.moveTo(-MARGIN, y)
    ctx.bezierCurveTo(L * 0.3, y + 0.01, L * 0.7, y - 0.01, L + MARGIN, y + 0.004)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 0.004
  ctx.beginPath()
  ctx.roundRect(-MARGIN + 0.004, -MARGIN + 0.004, L + 2 * MARGIN - 0.008, W + 2 * MARGIN - 0.008, 0.046)
  ctx.stroke()

  // Diamonds on the rails.
  ctx.fillStyle = '#efe6cf'
  const mid = CUSHION_W + (MARGIN - CUSHION_W) / 2
  const diamond = (x: number, y: number) => {
    ctx.beginPath()
    ctx.ellipse(x, y, 0.007, 0.007, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  for (let i = 1; i < 8; i++) {
    if (i === 4) continue
    diamond((L * i) / 8, -mid)
    diamond((L * i) / 8, W + mid)
  }
  for (let i = 1; i < 4; i++) {
    diamond(-mid, (W * i) / 4)
    diamond(L + mid, (W * i) / 4)
  }

  // Leather pocket rims on the wood.
  ctx.fillStyle = '#1b1410'
  for (const [i, [px, py]] of POCKETS.entries()) {
    ctx.beginPath()
    ctx.arc(px, py, (i === 1 || i === 4 ? 0.064 : 0.066) + 0.014, 0, Math.PI * 2)
    ctx.fill()
  }

  // The bed, lit from a lamp above the middle.
  const cloth = ctx.createRadialGradient(L / 2, W / 2, 0.1, L / 2, W / 2, L * 0.62)
  cloth.addColorStop(0, '#1a8a4e')
  cloth.addColorStop(1, '#0c5e35')
  ctx.fillStyle = cloth
  ctx.fillRect(0, 0, L, W)

  // Pockets: the hole, then the throat between the jaws. They go over the
  // corners of the bed, where it falls away into the pocket, and under the cushions.
  for (const [i, [px, py]] of POCKETS.entries()) {
    const side = i === 1 || i === 4
    const r = side ? 0.064 : 0.066
    const hole = ctx.createRadialGradient(px, py, 0, px, py, r)
    hole.addColorStop(0, '#000')
    hole.addColorStop(0.75, '#050505')
    hole.addColorStop(1, '#151515')
    ctx.fillStyle = hole
    ctx.beginPath()
    ctx.arc(px, py, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = '#030303'
  for (let i = 0; i < CUSHIONS.length; i++) {
    const a = CUSHIONS[i]
    for (let j = 0; j < CUSHIONS.length; j++) {
      if (i === j) continue
      const b = CUSHIONS[j]
      // Fill between facing jaws that belong to the same pocket.
      for (const [ja, na] of [[0, 1], [3, 2]] as const) {
        for (const [jb, nb] of [[0, 1], [3, 2]] as const) {
          if (Math.hypot(a[na][0] - b[nb][0], a[na][1] - b[nb][1]) > 0.18) continue
          ctx.beginPath()
          ctx.moveTo(...a[na])
          ctx.lineTo(...a[ja])
          ctx.lineTo(...b[jb])
          ctx.lineTo(...b[nb])
          ctx.fill()
        }
      }
    }
  }

  // Cushions, slightly darker cloth, with a lit nose.
  for (const c of CUSHIONS) {
    const horizontal = c[1][1] === c[2][1]
    const back = horizontal ? (c[1][1] === 0 ? -CUSHION_W : W + CUSHION_W) : c[1][0] === 0 ? -CUSHION_W : L + CUSHION_W
    ctx.fillStyle = '#0d6a3b'
    ctx.beginPath()
    ctx.moveTo(...c[0])
    for (const p of c.slice(1)) ctx.lineTo(...p)
    if (horizontal) {
      ctx.lineTo(c[3][0], back)
      ctx.lineTo(c[0][0], back)
    } else {
      ctx.lineTo(back, c[3][1])
      ctx.lineTo(back, c[0][1])
    }
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = 'rgba(160,255,190,0.18)'
    ctx.lineWidth = 0.004
    ctx.beginPath()
    ctx.moveTo(...c[1])
    ctx.lineTo(...c[2])
    ctx.stroke()
  }
  // Shadow the cushions throw onto the bed.
  const shade = (x: number, y: number, w: number, h: number, x0: number, y0: number, x1: number, y1: number) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1)
    g.addColorStop(0, 'rgba(0,0,0,0.28)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(x, y, w, h)
  }
  shade(0, 0, L, 0.03, 0, 0, 0, 0.03)
  shade(0, W - 0.03, L, 0.03, 0, W, 0, W - 0.03)
  shade(0, 0, 0.03, W, 0, 0, 0.03, 0)
  shade(L - 0.03, 0, 0.03, W, L, 0, L - 0.03, 0)

  // Head string and spots.
  ctx.strokeStyle = 'rgba(255,255,255,0.09)'
  ctx.lineWidth = 0.003
  ctx.beginPath()
  ctx.moveTo(HEAD_X, 0)
  ctx.lineTo(HEAD_X, W)
  ctx.stroke()
  ctx.fillStyle = 'rgba(255,255,255,0.22)'
  for (const x of [HEAD_X, FOOT_X]) {
    ctx.beginPath()
    ctx.arc(x, W / 2, 0.004, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

// --- Ball sprites --------------------------------------------------------------------------------

const TEX = 64
const COS_SPOT = 0.9 // number circles cover this much of the sphere
const SIN_SPOT = Math.sqrt(1 - COS_SPOT * COS_SPOT)
const textures = new Map<number, Uint8ClampedArray>()

function numberTexture(id: number) {
  let t = textures.get(id)
  if (t) return t
  const c = document.createElement('canvas')
  c.width = c.height = TEX
  const x = c.getContext('2d')!
  x.fillStyle = '#f8f5ec'
  x.beginPath()
  x.arc(TEX / 2, TEX / 2, TEX / 2, 0, Math.PI * 2)
  x.fill()
  x.fillStyle = '#111'
  x.font = `700 ${id > 9 ? 30 : 36}px Arial, Helvetica, sans-serif`
  x.textAlign = 'center'
  x.textBaseline = 'middle'
  x.fillText(String(id), TEX / 2, TEX / 2 + 2)
  if (id === 6 || id === 9) x.fillRect(TEX / 2 - 8, TEX / 2 + 17, 16, 3)
  t = x.getImageData(0, 0, TEX, TEX).data
  textures.set(id, t)
  return t
}

type Disc = { size: number; px: Float32Array; py: Float32Array; pz: Float32Array; shade: Float32Array; spec: Float32Array; alpha: Float32Array; idx: Int32Array }
let disc: Disc | null = null

// Light from a lamp up and to the upper left; the viewer looks straight down (+z).
const LIGHT = (() => {
  const l = [-0.3, -0.4, -1]
  const n = Math.hypot(...l)
  return l.map((c) => c / n)
})()
const HALF = (() => {
  const h = [LIGHT[0], LIGHT[1], LIGHT[2] - 1]
  const n = Math.hypot(...h)
  return h.map((c) => c / n)
})()

function makeDisc(radius: number): Disc {
  const size = Math.ceil(radius * 2) + 2
  const c = (size - 1) / 2
  const px: number[] = []
  const py: number[] = []
  const pz: number[] = []
  const shade: number[] = []
  const spec: number[] = []
  const alpha: number[] = []
  const idx: number[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / radius
      const dy = (y - c) / radius
      const d = Math.hypot(dx, dy)
      const a = Math.max(0, Math.min(1, (1 - d) * radius + 0.5))
      if (a <= 0) continue
      const dd = Math.min(1, d)
      const nx = d > 1 ? dx / d : dx
      const ny = d > 1 ? dy / d : dy
      const nz = -Math.sqrt(Math.max(0, 1 - dd * dd))
      const diff = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2])
      const s = Math.pow(Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]), 70)
      px.push(nx)
      py.push(ny)
      pz.push(nz)
      // Ambient, diffuse, and a darker rim where the ball turns away.
      shade.push((0.3 + 0.78 * diff) * (0.75 + 0.25 * -nz))
      spec.push(s * 0.95)
      alpha.push(a)
      idx.push((y * size + x) * 4)
    }
  }
  return { size, px: new Float32Array(px), py: new Float32Array(py), pz: new Float32Array(pz), shade: new Float32Array(shade), spec: new Float32Array(spec), alpha: new Float32Array(alpha), idx: new Int32Array(idx) }
}

export type Sprite = { canvas: HTMLCanvasElement; img: ImageData; size: number }

/** Renders a ball, as it is turned, into its sprite. `plain` balls are all red, without numbers. */
export function paintBall(ball: Ball, radius: number, sprite: Sprite | undefined, plain = false): Sprite {
  if (!disc || Math.abs(disc.size - (Math.ceil(radius * 2) + 2)) > 0) disc = makeDisc(radius)
  const D = disc
  if (!sprite || sprite.size !== D.size) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = D.size
    sprite = { canvas, img: canvas.getContext('2d')!.createImageData(D.size, D.size), size: D.size }
  }
  const out = sprite.img.data
  const m = ball.m
  const id = ball.id
  const base = plain && id !== 0 ? PLAIN : ballColor(id)
  const tex = id === 0 || plain ? null : numberTexture(id)
  const stripe = id > 8 && !plain
  for (let i = 0; i < D.idx.length; i++) {
    const x = D.px[i]
    const y = D.py[i]
    const z = D.pz[i]
    // The point in the ball's own frame.
    const qx = m[0] * x + m[1] * y + m[2] * z
    const qy = m[3] * x + m[4] * y + m[5] * z
    const qz = m[6] * x + m[7] * y + m[8] * z
    let r: number
    let g: number
    let b: number
    if (stripe && Math.abs(qz) > 0.5) {
      r = 246
      g = 243
      b = 232
    } else {
      r = base[0]
      g = base[1]
      b = base[2]
    }
    if (tex && Math.abs(qx) > COS_SPOT) {
      // Number circles on both sides of the ball.
      const s = qx > 0 ? 1 : -1
      const u = Math.floor(((-s * qy) / SIN_SPOT + 1) * 0.5 * (TEX - 1))
      const v = Math.floor((qz / SIN_SPOT + 1) * 0.5 * (TEX - 1))
      if (u >= 0 && u < TEX && v >= 0 && v < TEX) {
        const t = (v * TEX + u) * 4
        const a = tex[t + 3] / 255
        r = r + (tex[t] - r) * a
        g = g + (tex[t + 1] - g) * a
        b = b + (tex[t + 2] - b) * a
      }
    } else if (id === 0 && Math.abs(qz) > 0.975) {
      // Two red dots on the cue ball, so its spin shows.
      r = 200
      g = 30
      b = 40
    }
    const sh = D.shade[i]
    const sp = D.spec[i] * 255
    const o = D.idx[i]
    out[o] = r * sh + sp
    out[o + 1] = g * sh + sp
    out[o + 2] = b * sh + sp
    out[o + 3] = D.alpha[i] * 255
  }
  sprite.canvas.getContext('2d')!.putImageData(sprite.img, 0, 0)
  return sprite
}

/** The cue stick, tip `gap` metres behind the cue ball, pointing along `angle`. */
export function paintCue(ctx: CanvasRenderingContext2D, v: View, x: number, y: number, angle: number, gap: number) {
  ctx.save()
  ctx.translate(v.ox + x * v.k, v.oy + y * v.k)
  ctx.rotate(angle)
  ctx.scale(v.k, v.k)
  const tip = -(R + gap)
  const len = 1.45
  const butt = tip - len
  // Shadow on the cloth, offset away from the lamp.
  ctx.fillStyle = 'rgba(0,0,0,0.25)'
  ctx.beginPath()
  ctx.moveTo(tip + 0.03, 0.022)
  ctx.lineTo(butt + 0.03, 0.04)
  ctx.lineTo(butt + 0.03, 0.06)
  ctx.lineTo(tip + 0.03, 0.03)
  ctx.fill()
  const halfAt = (t: number) => 0.0065 + (0.0145 - 0.0065) * t
  const seg = (from: number, to: number, fill: string | CanvasGradient) => {
    const a = (tip - from) / len
    const b = (tip - to) / len
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.moveTo(from, -halfAt(a))
    ctx.lineTo(to, -halfAt(b))
    ctx.lineTo(to, halfAt(b))
    ctx.lineTo(from, halfAt(a))
    ctx.closePath()
    ctx.fill()
  }
  const shaft = ctx.createLinearGradient(0, -0.012, 0, 0.012)
  shaft.addColorStop(0, '#f6e2b5')
  shaft.addColorStop(0.5, '#e2c48c')
  shaft.addColorStop(1, '#b8955a')
  const buttWood = ctx.createLinearGradient(0, -0.015, 0, 0.015)
  buttWood.addColorStop(0, '#7a4521')
  buttWood.addColorStop(0.5, '#4b2510')
  buttWood.addColorStop(1, '#2a1306')
  seg(tip, tip - 0.008, '#3b6fb0') // chalked tip
  seg(tip - 0.008, tip - 0.03, '#f4f1e8') // ferrule
  seg(tip - 0.03, tip - 0.8, shaft)
  seg(tip - 0.8, tip - 0.82, '#d9d2c0')
  seg(tip - 0.82, butt + 0.32, buttWood)
  seg(butt + 0.32, butt + 0.06, '#1d1d1f') // wrap
  seg(butt + 0.06, butt, buttWood)
  ctx.restore()
}
