import type { GroundKit } from '../groundKit.ts'
import { UNIT } from '../data.ts'
import type { Owner, World } from '../sim.ts'
import { sees } from './fog.ts'
import { TF, TILE, type GroundLayer } from './types.ts'
import { CARRY, FIELD_KYBER, commandAreas, fieldAt, fieldTiles, groundMapOf, groundMaps, groundPlacement, knownBuildings, type GroundPlacement } from './world.ts'

// The battle screen's ground pieces (see groundKit.ts): thumbnails of the tile map, the fog veil,
// the placement ghost and the minimap's ground. In the browser only; ground/load.ts hands them to the
// screen.

const TAU = Math.PI * 2
const OWN = '#7dffa0'
const ENEMY = '#ff5a50'

/** Each terrain's colour at a pixel a tile (types.ts TERRAINS order), lit by height. */
const TERRAIN_RGB: [number, number, number][] = [
  [122, 98, 72], // dirt
  [93, 112, 64], // grass
  [138, 133, 126], // rocky
  [176, 158, 112], // sand
  [214, 220, 226], // snow
  [70, 66, 66], // ash
  [128, 104, 80], // cracked
  [110, 112, 118], // urban
  [120, 128, 136], // metal
]

const thumbs = new Map<string, HTMLCanvasElement>()
function thumb(id: string): HTMLCanvasElement | null {
  let c = thumbs.get(id)
  if (c) return c
  const map = groundMapOf(id)
  if (!map) return null
  const g = map.grid
  c = document.createElement('canvas')
  c.width = g.cols
  c.height = g.rows
  const x = c.getContext('2d')!
  const img = x.createImageData(g.cols, g.rows)
  for (let i = 0; i < g.cols * g.rows; i++) {
    let [r, gg, b] = TERRAIN_RGB[g.terrain[i]] ?? TERRAIN_RGB[0]
    let k = 0.72 + 0.17 * g.height[i]
    if (g.flags[i] & TF.water) [r, gg, b, k] = [53, 90, 122, 1]
    else if (g.flags[i] & TF.deposit) [r, gg, b, k] = [79, 227, 216, 0.9]
    else if (g.flags[i] & TF.blocked) k *= 0.55
    img.data[i * 4] = Math.min(255, r * k)
    img.data[i * 4 + 1] = Math.min(255, gg * k)
    img.data[i * 4 + 2] = Math.min(255, b * k)
    img.data[i * 4 + 3] = 255
  }
  x.putImageData(img, 0, 0)
  thumbs.set(id, c)
  return c
}

/** The fog's alpha outside our sight (0-255): dims the land without hiding it. */
const VEIL = 120

/**
 * The fog of war at one pixel a tile, blurred a little ([1 4 6 4 1] across and down) so a sight
 * disc's stepped edge reads as a soft round one once scaled up with smoothing: clear in sight, a
 * half-dark veil everywhere else. Worked out again only after the sim's fog refresh (four times a
 * second), for the team looking.
 */
class FogShade {
  readonly canvas = document.createElement('canvas')
  private g: CanvasRenderingContext2D
  private img: ImageData
  private a: Float32Array
  private b: Float32Array
  key = ''
  constructor(readonly cols: number, readonly rows: number) {
    this.canvas.width = cols
    this.canvas.height = rows
    this.g = this.canvas.getContext('2d')!
    this.img = this.g.createImageData(cols, rows)
    for (let i = 0; i < cols * rows; i++) {
      this.img.data[i * 4] = 3
      this.img.data[i * 4 + 1] = 5
      this.img.data[i * 4 + 2] = 8
    }
    this.a = new Float32Array(cols * rows)
    this.b = new Float32Array(cols * rows)
  }
  update(w: World, team: number, reveal: boolean) {
    const key = `${team}:${reveal}:${Math.floor(w.time * 4)}:${w.units.length}`
    if (key === this.key) return
    this.key = key
    const { cols, rows, a, b } = this
    const fog = w.ground!.fog
    const n = cols * rows
    for (let i = 0; i < n; i++) a[i] = reveal || sees(fog, team, i) ? 0 : VEIL
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
}

/** One fog canvas per world (the battle's, the minimap's share it). */
const shades = new WeakMap<World, FogShade>()
function shadeOf(w: World, team: number, reveal: boolean) {
  let s = shades.get(w)
  const g = w.ground!.map.grid
  if (!s) shades.set(w, (s = new FogShade(g.cols, g.rows)))
  s.update(w, team, reveal)
  return s
}

function fog(ctx: CanvasRenderingContext2D, w: World, team: number, reveal: boolean) {
  const s = shadeOf(w, team, reveal)
  const smooth = ctx.imageSmoothingEnabled
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(s.canvas, 0, 0, w.w, w.h)
  ctx.imageSmoothingEnabled = smooth
}

function ghost(ctx: CanvasRenderingContext2D, w: World, me: Owner, unitId: string, p: GroundPlacement, zoom: number) {
  const px = 1 / zoom
  const spec = UNIT[unitId]?.ground
  const [fw, fh] = spec?.foot ?? [6, 6]
  // Our command range, where a building may go (a standalone one, such as a Command Center, may go
  // anywhere away from the enemy instead).
  if (spec && !spec.standalone) {
    ctx.strokeStyle = OWN
    ctx.globalAlpha = 0.45
    ctx.lineWidth = 1.5 * px
    ctx.setLineDash([8 * px, 6 * px])
    for (const a of commandAreas(w, me)) {
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
  for (const t of p.door) {
    ctx.strokeStyle = t.ok ? 'rgba(90, 255, 130, 0.7)' : 'rgba(255, 70, 60, 0.85)'
    ctx.strokeRect(t.tc * TILE + 3, t.tr * TILE + 3, TILE - 6, TILE - 6)
  }
  ctx.strokeStyle = p.why ? ENEMY : OWN
  ctx.lineWidth = 2 * px
  ctx.strokeRect(p.tc * TILE, p.tr * TILE, fw * TILE, fh * TILE)
}

function minimap(ctx: CanvasRenderingContext2D, w: World, team: number, ox: number, oy: number, s: number, reveal: boolean) {
  const t = thumb(w.map.ground!)
  if (!t) return
  const smooth = ctx.imageSmoothingEnabled
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(t, ox, oy, w.w * s, w.h * s)
  // Crystal fields as they run down: an emptied tile shows as bare gravel.
  const cols = w.ground!.nav.cols
  ctx.fillStyle = '#6e6a62'
  w.ground!.fields.forEach((_, f) => {
    if ((w.kyber?.[f] ?? 1) >= FIELD_KYBER) return
    for (const { tile, fill } of fieldTiles(w, f)) {
      if (fill > 0) continue
      const c = tile % cols
      ctx.fillRect(ox + c * TILE * s, oy + ((tile - c) / cols) * TILE * s, Math.ceil(TILE * s), Math.ceil(TILE * s))
    }
  })
  ctx.drawImage(shadeOf(w, team, reveal).canvas, ox, oy, w.w * s, w.h * s)
  ctx.imageSmoothingEnabled = smooth
}

/** What the crystal fields looked like when the ground layer was last told, per world. */
const kyberKeys = new WeakMap<World, string>()
/** How full each tile's crystals are, for the ground layer (setKyber): only when it changed since the
 * last call for this world (in sixteenths of a tile), else null. Tiles that aren't crystal read full. */
function kyber(w: World): Uint8Array | null {
  const g = w.ground!
  if (!w.kyber) return null
  const key = w.kyber.map((k, f) => Math.ceil((k / FIELD_KYBER) * g.fields[f].tiles.length * 16)).join(',')
  if (kyberKeys.get(w) === key) return null
  kyberKeys.set(w, key)
  const fill = new Uint8Array(g.nav.cols * g.nav.rows).fill(255)
  g.fields.forEach((_, f) => {
    for (const { tile, fill: k } of fieldTiles(w, f)) fill[tile] = Math.round(k * 255)
  })
  return fill
}

/** The kit, with the picture of the ground from `layer` (the WebGL2 one, or the 2D stand-in). */
export const screenKit = (layer: () => GroundLayer): GroundKit => ({
  maps: groundMaps,
  thumb,
  layer,
  placement: groundPlacement,
  commandAreas,
  known: knownBuildings,
  fog,
  ghost,
  minimap,
  fieldAt,
  kyber,
  carry: CARRY,
})
