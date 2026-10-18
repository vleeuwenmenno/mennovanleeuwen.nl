import { rng } from '../maps.ts'
import { TF, TILE, terrainIndex, type GroundMap } from './types.ts'

// The trees on the ground: flat cel-shaded canopies seen from straight above (big rounded leaf
// lobes, three hard tones lit from the top left, a bold dark outline), cut from one sheet into an
// atlas (public/games/empires/ground/trees/canopies.webp: nine cells, the last a conifer). Drawing
// only: forests stay TF.forest tiles, walls units go round.
//
// Where they stand is worked out once per map (placeCrowns): crowns packed tightly over every forest
// (the ground layer paints a dark canopy floor under them, so no ground shows between), looser ones
// spilling over its edges, and now and then a small group out on open grass. Seeded, so a map always
// looks the same, and sorted top to bottom, so lower crowns overlap higher ones.
//
// The WebGL2 layer draws them as instanced quads (TreeLayer): a pass of soft shadows, cast down and
// to the right, then the crowns, each a little lighter or darker than its neighbours; past the map's
// edge the mirrored copies are drawn greyed, as the ground there is. The flat 2D layer bakes the same
// crowns into its picture once (bakeCrowns).

/** The atlas: three by three cells of CELL pixels. Cells 0-2 big crowns, 3-5 middling, 6-7 small, 8 a conifer. */
export const ATLAS = 'trees/canopies.webp'
const CELL = 256
const GRID = 3
const CONIFER = 8
/** Floats per crown: x, y (world units), size (across, world units), atlas cell, tone (0..1). */
export const CROWN_FLOATS = 5

/**
 * Where a map's crowns stand: x, y, size, cell, tone for each, top to bottom. `forestAt` gives how
 * much forest there is at a world point (0..1, smooth across an edge: the ground layer's own mask).
 */
export function placeCrowns(map: GroundMap, forestAt: (x: number, y: number) => number): Float32Array {
  const g = map.grid
  const W = g.cols * TILE, H = g.rows * TILE
  const rand = rng(map.def.seed * 977 + 31)
  const out: number[][] = []
  const cellFor = (big: boolean) => {
    const r = rand()
    if (r < 0.08) return CONIFER
    if (!big || r < 0.22) return 6 + Math.floor(rand() * 2)
    return Math.floor(rand() * 6)
  }
  // A jittered grid, closer than a crown is wide, so the crowns pack.
  const D = 42
  for (let y = D / 2; y < H; y += D)
    for (let x = D / 2; x < W; x += D) {
      const px = x + (rand() - 0.5) * D * 0.8, py = y + (rand() - 0.5) * D * 0.8
      const roll = rand(), sizeRoll = rand(), tone = rand()
      const m = forestAt(px, py)
      if (m > 0.55) out.push([px, py, 66 + sizeRoll * 34, cellFor(true), tone])
      else if (m > 0.32 && roll < 0.7) out.push([px, py, 50 + sizeRoll * 20, cellFor(sizeRoll > 0.5), tone])
      else if (m > 0.12 && roll < 0.1) out.push([px, py, 38 + sizeRoll * 14, cellFor(false), tone])
    }
  // Small groups out on open grass, away from the bases, roads, water and slopes.
  const GRASS = terrainIndex('grass')
  const busy = TF.water | TF.blocked | TF.ramp | TF.deposit | TF.forest | TF.bridge | TF.ford
  const open = (c: number, r: number) => {
    if (c < 1 || r < 1 || c >= g.cols - 1 || r >= g.rows - 1) return false
    const t = r * g.cols + c
    if (g.terrain[t] !== GRASS || g.flags[t] & busy) return false
    return g.height[t - 1] === g.height[t] && g.height[t + 1] === g.height[t] && g.height[t - g.cols] === g.height[t] && g.height[t + g.cols] === g.height[t]
  }
  const nearSpawn = (x: number, y: number) => map.spawns.some((s) => Math.hypot(s.x - x, s.y - y) < TILE * 13)
  const STEP = TILE * 6
  for (let y = STEP / 2; y < H; y += STEP)
    for (let x = STEP / 2; x < W; x += STEP) {
      const roll = rand(), n = 2 + Math.floor(rand() * 4)
      const cx = x + (rand() - 0.5) * STEP * 0.6, cy = y + (rand() - 0.5) * STEP * 0.6
      if (roll > 0.09 || nearSpawn(cx, cy) || forestAt(cx, cy) > 0.05) continue
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2, d = rand() * TILE * 1.8
        const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d
        const size = 40 + rand() * 18, cell = cellFor(false), tone = rand()
        if (open(Math.floor(px / TILE), Math.floor(py / TILE))) out.push([px, py, size, cell, tone])
      }
    }
  out.sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const f = new Float32Array(out.length * CROWN_FLOATS)
  out.forEach((c, i) => f.set(c, i * CROWN_FLOATS))
  return f
}

/** Loads the atlas (once). */
let atlasImg: Promise<HTMLImageElement | null> | null = null
export function loadAtlas(base: string) {
  atlasImg ??= new Promise((ok) => {
    const img = new Image()
    img.onload = () => ok(img)
    img.onerror = () => ok(null)
    img.src = base + ATLAS
  })
  return atlasImg
}

/** A crown's brightness from its tone (0..1): a little lighter or darker than its neighbours. */
const shade = (tone: number) => 0.9 + tone * 0.18

/** The atlas drawn into a canvas with its colours scaled by `k` (and `dark`: one flat colour). */
function tinted(atlas: HTMLImageElement, k: number, dark = false) {
  const c = document.createElement('canvas')
  c.width = atlas.width
  c.height = atlas.height
  const x = c.getContext('2d')!
  x.drawImage(atlas, 0, 0)
  if (dark) {
    x.globalCompositeOperation = 'source-in'
    x.fillStyle = '#0a1206'
    x.fillRect(0, 0, c.width, c.height)
    return c
  }
  const d = x.getImageData(0, 0, c.width, c.height)
  for (let i = 0; i < d.data.length; i += 4) for (let j = 0; j < 3; j++) d.data[i + j] = Math.min(255, d.data[i + j] * k)
  x.putImageData(d, 0, 0)
  return c
}

/**
 * The crowns drawn into a 2D picture of the whole map at `k` pixels a world unit (the flat
 * fallback): shadows first, then the crowns, top to bottom, each in one of three shades.
 */
export function bakeCrowns(ctx: CanvasRenderingContext2D, crowns: Float32Array, atlas: HTMLImageElement, k: number) {
  const n = crowns.length / CROWN_FLOATS
  const dark = tinted(atlas, 1, true)
  const shades = [shade(0.15), shade(0.5), shade(0.85)].map((t) => tinted(atlas, t))
  const at = (i: number) => {
    const [x, y, s, cell, tone] = crowns.subarray(i * CROWN_FLOATS, (i + 1) * CROWN_FLOATS)
    return { x, y, s, tone, sx: (cell % GRID) * CELL, sy: Math.floor(cell / GRID) * CELL }
  }
  ctx.save()
  ctx.globalAlpha = 0.4
  for (let i = 0; i < n; i++) {
    const { x, y, s, sx, sy } = at(i)
    ctx.drawImage(dark, sx, sy, CELL, CELL, (x - s * 0.53 + s * 0.14) * k, (y - s * 0.53 + s * 0.2) * k, s * 1.06 * k, s * 1.06 * k)
  }
  ctx.globalAlpha = 1
  for (let i = 0; i < n; i++) {
    const { x, y, s, tone, sx, sy } = at(i)
    ctx.drawImage(shades[Math.min(2, Math.floor(tone * 3))], sx, sy, CELL, CELL, (x - s * 0.5) * k, (y - s * 0.5) * k, s * k, s * k)
  }
  ctx.restore()
}

// --- WebGL2 ---------------------------------------------------------------------------------------

const VERT = `#version 300 es
layout(location = 0) in vec4 aCrown;  // x, y, size, cell
layout(location = 1) in float aTone;
uniform vec2 uView;
uniform vec2 uCam;
uniform float uScale;
uniform vec4 uMirror;   // sx, sy, ox, oy: a mirror region's flip and offset (1, 1, 0, 0: the map)
uniform float uShadow;  // 1: the shadow pass
out vec2 vUv;
out float vTone;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  if (gl_VertexID >= 4) corner = vec2(float(gl_VertexID == 5), 1.0 - float(gl_VertexID == 5));
  vec2 c = vec2(aCrown.x * uMirror.x + uMirror.z, aCrown.y * uMirror.y + uMirror.w);
  float s = aCrown.z * (uShadow > 0.5 ? 1.06 : 1.0);
  vec2 off = uShadow > 0.5 ? vec2(0.14, 0.2) * aCrown.z : vec2(0.0);
  vec2 w = c + off + (corner - 0.5) * s;
  vec2 px = (w - uCam) * uScale + 0.5 * uView;
  gl_Position = vec4(px.x / uView.x * 2.0 - 1.0, 1.0 - px.y / uView.y * 2.0, 0.0, 1.0);
  float cell = aCrown.w;
  vec2 base = vec2(mod(cell, ${GRID}.0), floor(cell / ${GRID}.0)) / ${GRID}.0;
  vUv = base + corner / ${GRID}.0;
  vTone = aTone;
}`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uAtlas;
uniform float uShadow;
uniform float uGrey;
in vec2 vUv;
in float vTone;
out vec4 outColor;
void main() {
  if (uShadow > 0.5) {
    // A soft shadow: the crown's shape from a blurrier mip.
    float a = texture(uAtlas, vUv, 2.5).a;
    outColor = vec4(vec3(0.03, 0.06, 0.02) * 0.42 * a, 0.42 * a);
    return;
  }
  vec4 t = texture(uAtlas, vUv);
  vec3 c = t.rgb * (0.9 + vTone * 0.18);
  c += vec3(0.012, 0.008, -0.01) * (fract(vTone * 7.31) - 0.5) * t.a;
  if (uGrey > 0.5) {
    float g = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(g), c, 0.18) * 0.5;
  }
  outColor = vec4(c, t.a);
}`

/** The crowns in a WebGL2 ground layer: an instance buffer, the atlas and a small program. */
export class TreeLayer {
  private gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private vao: WebGLVertexArrayObject
  private buf: WebGLBuffer
  private atlas: WebGLTexture | null = null
  private count = 0
  private loc: Record<string, WebGLUniformLocation | null> = {}
  private world = [1, 1]
  readonly ready: Promise<void>

  constructor(gl: WebGL2RenderingContext, base: string) {
    this.gl = gl
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`tree shader: ${gl.getShaderInfoLog(s)}`)
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT))
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`tree program: ${gl.getProgramInfoLog(p)}`)
    this.prog = p
    for (const u of ['uView', 'uCam', 'uScale', 'uMirror', 'uShadow', 'uGrey', 'uAtlas']) this.loc[u] = gl.getUniformLocation(p, u)
    this.vao = gl.createVertexArray()!
    this.buf = gl.createBuffer()!
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    const stride = CROWN_FLOATS * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0)
    gl.vertexAttribDivisor(0, 1)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 16)
    gl.vertexAttribDivisor(1, 1)
    gl.bindVertexArray(null)
    this.ready = loadAtlas(base).then((img) => {
      if (!img || gl.isContextLost()) return
      const t = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, t)
      // Premultiplied, so the mipmaps keep clean edges.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.generateMipmap(gl.TEXTURE_2D)
      // No smaller than 8 pixels a cell: below that the cells would bleed into each other.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 5)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      this.atlas = t
    })
  }

  /** The map's crowns, uploaded once. */
  setCrowns(crowns: Float32Array, worldW: number, worldH: number) {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    gl.bufferData(gl.ARRAY_BUFFER, crowns, gl.STATIC_DRAW)
    this.count = crowns.length / CROWN_FLOATS
    this.world = [worldW, worldH]
  }

  /**
   * Draws the crowns over the ground: for the map and every mirror region the view reaches (greyed),
   * a shadow pass then a crown pass. `scale` is device pixels per world unit, (pw, ph) the canvas.
   * Returns the draw calls made.
   */
  draw(cam: { x: number; y: number }, scale: number, pw: number, ph: number) {
    const gl = this.gl
    if (!this.atlas || !this.count) return 0
    let calls = 0
    const [W, H] = this.world
    const L = this.loc
    gl.useProgram(this.prog)
    gl.bindVertexArray(this.vao)
    gl.enable(gl.BLEND)
    gl.enable(gl.SCISSOR_TEST)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.atlas)
    gl.uniform1i(L.uAtlas, 0)
    gl.uniform2f(L.uView, pw, ph)
    gl.uniform2f(L.uCam, cam.x, cam.y)
    gl.uniform1f(L.uScale, scale)
    // The view in world units, a crown's width bigger, to see which mirror regions it reaches.
    const hx = pw / 2 / scale + 80, hy = ph / 2 / scale + 80
    const x0 = cam.x - hx, x1 = cam.x + hx, y0 = cam.y - hy, y1 = cam.y + hy
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const rx0 = i * W, ry0 = j * H
        if (x1 < rx0 || x0 > rx0 + W || y1 < ry0 || y0 > ry0 + H) continue
        // Each region's crowns stay inside it, so the map's edge stays a clean line.
        const sx0 = Math.round((rx0 - cam.x) * scale + pw / 2), sx1 = Math.round((rx0 + W - cam.x) * scale + pw / 2)
        const sy0 = Math.round((ry0 - cam.y) * scale + ph / 2), sy1 = Math.round((ry0 + H - cam.y) * scale + ph / 2)
        gl.scissor(sx0, ph - sy1, sx1 - sx0, sy1 - sy0)
        gl.uniform4f(L.uMirror, i ? -1 : 1, j ? -1 : 1, i < 0 ? 0 : i > 0 ? 2 * W : 0, j < 0 ? 0 : j > 0 ? 2 * H : 0)
        gl.uniform1f(L.uGrey, i || j ? 1 : 0)
        for (const shadow of [1, 0]) {
          gl.uniform1f(L.uShadow, shadow)
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count)
          calls++
        }
      }
    gl.disable(gl.BLEND)
    gl.disable(gl.SCISSOR_TEST)
    gl.bindVertexArray(null)
    return calls
  }

  dispose() {
    const gl = this.gl
    if (this.atlas) gl.deleteTexture(this.atlas)
    gl.deleteBuffer(this.buf)
    gl.deleteVertexArray(this.vao)
    gl.deleteProgram(this.prog)
  }
}
