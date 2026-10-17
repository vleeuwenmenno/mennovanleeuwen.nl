import { LEVEL_H, valueNoise } from './terrain.ts'
import { TERRAINS, TF, TILE, type GroundLayer, type GroundMap } from './types.ts'

// The ground under a battle, drawn with WebGL2 (types.ts GroundLayer): one full-screen triangle a
// frame, its fragment shader working out each pixel's world point and painting the land there. All
// the work that doesn't move is done once, in setMap, into a few textures:
// - the land's shape: the tile-corner elevations (TileGrid `elev`) upsampled to 4 samples a tile and
//   smoothed, and from it a shade map: where the sun (top left) is hidden behind higher ground, soft
//   edged, and how deep each spot sits in a valley;
// - blend masks at 4 samples a tile, from the tile grid's terrain and flags, blurred a little: grass,
//   dirt, sand, mud, road, rock, forest, crystals, water (with its depth), ford and bridge;
// - a small tiling noise texture, and the round 1 ground textures as detail inside the splat.
// The shader warps the mask lookups with noise so edges come out organic, lights the land from the
// heightmap with a few hard-ish tones (the game's cel-shaded look), puts rock on steep slopes with
// strata, paints forests as solid canopy with crowns and a cast shadow, moves the water, and past
// the map's edge draws the map mirrored, greyed and darkened, with a faint line on the edge.
//
// Where WebGL2 is missing, createGroundLayer returns a flat 2D layer (`gl: false`) that draws one
// baked picture of the same masks, lit by the same heightmap.

/** Mask samples per tile, both ways. */
const S = 4
/** World units per mask sample. */
const TEX = TILE / S

/** Options for createGroundLayer (dev and tests): `flat` forces the 2D fallback. */
export type GroundLayerOptions = { flat?: boolean; base?: string }

/** The baked masks and heights for a map, shared by the WebGL2 layer and the flat fallback. */
type Fields = {
  /** Mask size in samples. */
  fw: number
  fh: number
  /** RGBA masks: a = grass, dirt, sand, mud; b = road, rock, forest, crystal; c = water, ford, bridge, depth. */
  a: Uint8Array
  b: Uint8Array
  c: Uint8Array
  /** Heights at sample corners, (fw + 1) × (fh + 1). */
  hw: number
  hh: number
  height: Float32Array
  /** Sun (0 hidden .. 255 lit) and valley shade (255 open) at the same corners, interleaved. */
  shade: Uint8Array
  /** The bridges, in world units: x0, y0, x1, y1 and width, each (mirror copies included). */
  bridges: number[]
}

const T = (id: (typeof TERRAINS)[number]) => TERRAINS.indexOf(id)

/** Separable box blur of one channel of an RGBA buffer, `r` samples each way. */
function blur(buf: Uint8Array, w: number, h: number, ch: number, r: number) {
  const tmp = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    let sum = 0
    for (let x = -r; x <= r; x++) sum += buf[(y * w + Math.min(w - 1, Math.max(0, x))) * 4 + ch]
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / (2 * r + 1)
      sum += buf[(y * w + Math.min(w - 1, x + r + 1)) * 4 + ch] - buf[(y * w + Math.max(0, x - r)) * 4 + ch]
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      buf[(y * w + x) * 4 + ch] = Math.round(sum / (2 * r + 1))
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
}

/** Bakes a map's masks, heights and shade (once per map). */
function bakeFields(map: GroundMap): Fields {
  const g = map.grid
  const { cols, rows } = g
  const fw = cols * S, fh = rows * S
  const a = new Uint8Array(fw * fh * 4), b = new Uint8Array(fw * fh * 4), c = new Uint8Array(fw * fh * 4)
  // How far each water tile lies from dry land (for depth).
  const fromLand = new Uint8Array(cols * rows).fill(9)
  const queue: number[] = []
  for (let i = 0; i < cols * rows; i++) if (!(g.flags[i] & TF.water)) (fromLand[i] = 0), queue.push(i)
  for (let q = 0; q < queue.length; q++) {
    const t = queue[q], tc = t % cols, tr = (t - tc) / cols
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = tc + dx, nr = tr + dy
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const u = nr * cols + nc
      if (fromLand[u] > fromLand[t] + 1) (fromLand[u] = fromLand[t] + 1), queue.push(u)
    }
  }
  const GRASS = T('grass'), DIRT = T('dirt'), SAND = T('sand'), MUD = T('mud'), ROAD = T('road'), ROCKY = T('rocky')
  for (let y = 0; y < fh; y++)
    for (let x = 0; x < fw; x++) {
      const t = Math.floor(y / S) * cols + Math.floor(x / S)
      const o = (y * fw + x) * 4
      const ter = g.terrain[t], f = g.flags[t]
      a[o] = ter === GRASS ? 255 : 0
      a[o + 1] = ter === DIRT || (ter !== GRASS && ter !== SAND && ter !== MUD && ter !== ROAD && ter !== ROCKY) ? 255 : 0
      a[o + 2] = ter === SAND ? 255 : 0
      a[o + 3] = ter === MUD ? 255 : 0
      b[o] = ter === ROAD ? 255 : 0
      b[o + 1] = ter === ROCKY ? 255 : 0
      b[o + 2] = f & TF.forest ? 255 : 0
      b[o + 3] = f & TF.deposit ? 255 : 0
      c[o] = f & TF.water ? 255 : 0
      c[o + 1] = f & TF.ford ? 255 : 0
      c[o + 2] = f & TF.bridge ? 255 : 0
      c[o + 3] = f & TF.water ? Math.min(255, fromLand[t] * 70) : 0
    }
  // Round 1 maps: trees and boulders that block become forest and rock in the masks.
  for (const p of map.props) {
    if (!p.blocks) continue
    const tree = p.kind.startsWith('tree')
    const rad = (p.size * (tree ? 0.42 : 0.3)) / TEX
    const cx = p.x / TEX, cy = p.y / TEX
    for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(fh - 1, Math.ceil(cy + rad)); y++)
      for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(fw - 1, Math.ceil(cx + rad)); x++)
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < rad * rad) b[(y * fw + x) * 4 + (tree ? 2 : 1)] = 255
  }
  for (let ch = 0; ch < 4; ch++) {
    blur(a, fw, fh, ch, 3), blur(a, fw, fh, ch, 3)
    blur(b, fw, fh, ch, 2), blur(b, fw, fh, ch, 2)
    blur(c, fw, fh, ch, 2), blur(c, fw, fh, ch, 2)
  }
  // Heights: the corner elevations, bilinear to 4 samples a tile, then smoothed.
  const hw = fw + 1, hh = fh + 1
  let height = new Float32Array(hw * hh)
  const elev = g.elev
  const ew = cols + 1
  const corner = (x: number, y: number) => (elev ? elev[Math.min(rows, Math.max(0, y)) * ew + Math.min(cols, Math.max(0, x))] : g.height[Math.min(rows - 1, y) * cols + Math.min(cols - 1, x)] * LEVEL_H)
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < hw; x++) {
      const u = x / S, v = y / S
      const i = Math.floor(u), j = Math.floor(v), fx = u - i, fy = v - j
      const h00 = corner(i, j), h10 = corner(i + 1, j), h01 = corner(i, j + 1), h11 = corner(i + 1, j + 1)
      height[y * hw + x] = h00 + (h10 - h00) * fx + (h01 - h00) * fy + (h00 - h10 - h01 + h11) * fx * fy
    }
  // Widen the steep steps into cliff slopes about two tiles across (a box blur a tile wide), then
  // round them off.
  {
    const R = 3
    const tmp = new Float32Array(height.length)
    for (let y = 0; y < hh; y++) {
      let sum = 0
      for (let x = -R; x <= R; x++) sum += height[y * hw + Math.min(hw - 1, Math.max(0, x))]
      for (let x = 0; x < hw; x++) {
        tmp[y * hw + x] = sum / (2 * R + 1)
        sum += height[y * hw + Math.min(hw - 1, x + R + 1)] - height[y * hw + Math.max(0, x - R)]
      }
    }
    for (let x = 0; x < hw; x++) {
      let sum = 0
      for (let y = -R; y <= R; y++) sum += tmp[Math.min(hh - 1, Math.max(0, y)) * hw + x]
      for (let y = 0; y < hh; y++) {
        height[y * hw + x] = sum / (2 * R + 1)
        sum += tmp[Math.min(hh - 1, y + R + 1) * hw + x] - tmp[Math.max(0, y - R) * hw + x]
      }
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(height.length)
    for (let y = 0; y < hh; y++)
      for (let x = 0; x < hw; x++) {
        let sum = 0
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) sum += height[Math.min(hh - 1, Math.max(0, y + dy)) * hw + Math.min(hw - 1, Math.max(0, x + dx))] * (dx && dy ? 1 : dx || dy ? 2 : 4)
        next[y * hw + x] = sum / 16
      }
    height = next
  }
  // Shade: march towards the sun (top left, 38 degrees up) for what hides it, and compare each
  // spot with the ground round it for how deep it sits.
  const shade = new Uint8Array(hw * hh * 2)
  const H = (x: number, y: number) => height[Math.min(hh - 1, Math.max(0, Math.round(y))) * hw + Math.min(hw - 1, Math.max(0, Math.round(x)))]
  const rise = Math.tan((38 * Math.PI) / 180) * TEX * Math.SQRT2
  const wide = new Float32Array(hw * hh)
  {
    // A wide blur of the heights (box, radius 6 samples), for the valley shade.
    const R = 6
    const tmp = new Float32Array(hw * hh)
    for (let y = 0; y < hh; y++) {
      let sum = 0
      for (let x = -R; x <= R; x++) sum += height[y * hw + Math.min(hw - 1, Math.max(0, x))]
      for (let x = 0; x < hw; x++) {
        tmp[y * hw + x] = sum / (2 * R + 1)
        sum += height[y * hw + Math.min(hw - 1, x + R + 1)] - height[y * hw + Math.max(0, x - R)]
      }
    }
    for (let x = 0; x < hw; x++) {
      let sum = 0
      for (let y = -R; y <= R; y++) sum += tmp[Math.min(hh - 1, Math.max(0, y)) * hw + x]
      for (let y = 0; y < hh; y++) {
        wide[y * hw + x] = sum / (2 * R + 1)
        sum += tmp[Math.min(hh - 1, y + R + 1) * hw + x] - tmp[Math.max(0, y - R) * hw + x]
      }
    }
  }
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < hw; x++) {
      const h0 = height[y * hw + x]
      let occl = 0
      for (let s = 1; s <= 40; s++) {
        const d = H(x - s, y - s) - h0 - s * rise
        if (d > occl) occl = d
      }
      const sun = 1 - Math.min(1, occl / 14)
      const valley = 1 - Math.min(0.45, Math.max(0, wide[y * hw + x] - h0) / 60)
      shade[(y * hw + x) * 2] = Math.round(sun * 255)
      shade[(y * hw + x) * 2 + 1] = Math.round(valley * 255)
    }
  // Bridges are drawn from their shapes, straight-edged: each one and its mirror copies.
  const bridges: number[] = []
  const W = cols * TILE, Hh = rows * TILE
  for (const br of map.def.features?.bridges ?? []) {
    const ends = [[br.from[0] * TILE, br.from[1] * TILE, br.to[0] * TILE, br.to[1] * TILE]]
    if (map.def.mirror === 'diagonal') ends.push([W - br.from[1] * TILE, Hh - br.from[0] * TILE, W - br.to[1] * TILE, Hh - br.to[0] * TILE])
    else if (map.def.sym === 'point') ends.push([W - br.from[0] * TILE, Hh - br.from[1] * TILE, W - br.to[0] * TILE, Hh - br.to[1] * TILE])
    for (const e of ends) {
      // A copy lying on its original (a bridge on the mirror line) is drawn once.
      if (bridges.length && [0, 5, 10, 15].some((k) => k < bridges.length && Math.abs(bridges[k] - e[0]) + Math.abs(bridges[k + 1] - e[1]) + Math.abs(bridges[k + 2] - e[2]) + Math.abs(bridges[k + 3] - e[3]) < 2)) continue
      if (Math.abs(e[0] - e[2]) + Math.abs(e[1] - e[3]) < 1) continue
      if (bridges.length < 20) bridges.push(e[0], e[1], e[2], e[3], br.width * TILE)
      // The same bridge listed with its ends swapped is still the same bridge.
      for (let k = 0; k + 5 <= bridges.length - 5; k += 5)
        if (Math.abs(bridges[k] - e[2]) + Math.abs(bridges[k + 1] - e[3]) + Math.abs(bridges[k + 2] - e[0]) + Math.abs(bridges[k + 3] - e[1]) < 2) {
          bridges.length -= 5
          break
        }
    }
  }
  return { fw, fh, a, b, c, hw, hh, height, shade, bridges }
}

/** A tiling value-noise texture: four channels at four frequencies. */
function noiseTexture(size: number) {
  const out = new Uint8Array(size * size * 4)
  const freqs = [4, 8, 16, 32]
  freqs.forEach((f, ch) => {
    const n = valueNoise(1000 + ch)
    // Wrap the lattice so the texture tiles: sample on a torus by blending four shifted copies.
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const u = (x / size) * f, v = (y / size) * f
        const wx = x / size, wy = y / size
        const val = n(u, v) * (1 - wx) * (1 - wy) + n(u - f, v) * wx * (1 - wy) + n(u, v - f) * (1 - wx) * wy + n(u - f, v - f) * wx * wy
        out[(y * size + x) * 4 + ch] = Math.round(Math.min(1, Math.max(0, (val - 0.5) * 1.6 + 0.5)) * 255)
      }
  })
  return out
}

// --- WebGL2 --------------------------------------------------------------------------------------

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uView;
uniform vec2 uCam;
uniform float uScale;
uniform vec2 uWorld;
uniform float uTime;
uniform vec2 uField;
uniform vec2 uHsize;
uniform vec4 uBr[4];
uniform float uBrW[4];
uniform int uBrN;
uniform sampler2D uH, uSh, uA, uB, uC, uN, uGrass, uDirt, uRock;
out vec4 outColor;

const float TEX = ${TEX.toFixed(1)};
const vec3 SUN = vec3(-0.5, -0.58, 0.64);

float hAt(vec2 w) { return texture(uH, (w / TEX + 0.5) / uHsize).r; }
vec4 nz(vec2 w, float scale) { return texture(uN, w / scale); }
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
// Where a point lies on bridge i: x = along it (0 at one end, its length at the other), y = across
// (0 on its middle line), z = its length.
vec3 onBridge(int i, vec2 p) {
  vec2 a = uBr[i].xy, b = uBr[i].zw;
  vec2 d = b - a;
  float len = length(d);
  vec2 u = d / max(len, 1.0);
  return vec3(dot(p - a, u), dot(p - a, vec2(-u.y, u.x)), len);
}
// Nearest jittered cell point: x = distance, yz = offset to it, w = a random value for the cell.
vec4 cells(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec4 best = vec4(9.0, 0.0, 0.0, 0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 h = hash2(i + o);
      vec2 d = o + 0.15 + h * 0.7 - f;
      float l = length(d);
      if (l < best.x) best = vec4(l, d, fract(h.x * 7.13 + h.y));
    }
  return best;
}

void main() {
  vec2 fc = vec2(gl_FragCoord.x, uView.y - gl_FragCoord.y);
  vec2 w = uCam + (fc - 0.5 * uView) / uScale;
  // Past the edge, the map mirrored.
  vec2 m = uWorld - abs(uWorld - abs(w));
  m = clamp(m, vec2(1.0), uWorld - 1.0);
  float outside = max(max(-w.x, w.x - uWorld.x), max(-w.y, w.y - uWorld.y));

  vec4 n1 = nz(m, 1400.0), n2 = nz(m, 300.0), n3 = nz(m, 90.0);
  vec2 warp = (n3.rg - 0.5) * 16.0 + (n2.ba - 0.5) * 12.0;
  vec2 fuv = (m + warp) / TEX / uField;
  vec4 A = texture(uA, fuv);
  vec4 B = texture(uB, fuv);
  // Roads follow a calmer line than the rest.
  float roadMask = texture(uB, (m + warp * 0.25) / TEX / uField).r;
  // Sharpen the ground's blends a little, so grass meets dirt along a clear (but soft) edge.
  vec4 Ak = smoothstep(vec4(0.25), vec4(0.75), A);
  vec4 C = texture(uC, (m + warp * 0.35) / TEX / uField);
  vec4 Bs = texture(uB, (m + warp - vec2(11.0, 13.0)) / TEX / uField);

  // The land's shape and light.
  float e = 5.0;
  float h = hAt(m);
  // Slopes drawn a little steeper than they are, so plateaus read as raised.
  vec3 nrm = normalize(vec3(-(hAt(m + vec2(e, 0.0)) - hAt(m - vec2(e, 0.0))) / (2.0 * e), -(hAt(m + vec2(0.0, e)) - hAt(m - vec2(0.0, e))) / (2.0 * e), 0.36));
  vec3 sun = normalize(SUN);
  float rel = dot(nrm, sun) - sun.z;
  vec2 sh = texture(uSh, (m / TEX + 0.5) / uHsize).rg;
  float slope = 1.0 - nrm.z;

  // Ground: grass and dirt in big calm areas, sand and mud at the water, roads.
  vec3 gTex = texture(uGrass, m / 256.0).rgb, dTex = texture(uDirt, m / 256.0).rgb, rTex = texture(uRock, m / 200.0).rgb;
  float gd = (lum(gTex) - 0.38) * 0.55, dd = (lum(dTex) - 0.45) * 0.5, rd = (lum(rTex) - 0.45) * 0.6;
  vec3 grass = mix(vec3(0.44, 0.53, 0.20), vec3(0.54, 0.59, 0.25), smoothstep(0.3, 0.7, n1.r)) * (1.0 + gd);
  grass = mix(grass, vec3(0.38, 0.47, 0.20), smoothstep(0.55, 0.8, n2.g) * 0.35);
  vec3 dirt = mix(vec3(0.62, 0.50, 0.33), vec3(0.69, 0.57, 0.39), n1.g) * (1.0 + dd);
  vec3 sand = vec3(0.78, 0.69, 0.50) * (1.0 + dd * 0.6);
  vec3 mud = vec3(0.54, 0.46, 0.34) * (1.0 + dd * 0.8);
  float sum = Ak.r + Ak.g + Ak.b + Ak.a + 0.001;
  vec3 col = (grass * Ak.r + dirt * Ak.g + sand * Ak.b + mud * Ak.a) / sum;
  // A darker painted rim where grass ends.
  col *= 1.0 - 0.12 * (smoothstep(0.3, 0.45, A.r) - smoothstep(0.5, 0.7, A.r));
  float road = smoothstep(0.4, 0.5, roadMask);
  float roadEdge = smoothstep(0.28, 0.4, roadMask) - road;
  col = mix(col, vec3(0.47, 0.39, 0.27), roadEdge * 0.45);
  col = mix(col, vec3(0.70, 0.59, 0.41) * (1.0 + dd * 0.7), road);

  // Rock: on steep slopes, and bare plateau tops, with strata and strong light.
  vec3 rock = vec3(0.66, 0.62, 0.56) * (1.0 + rd * 0.45);
  float strata = smoothstep(0.78, 0.9, fract(h / 9.0 + n3.b * 0.8));
  // Cliff rock broken into angular blocks, each lit by how its face turns to the sun.
  vec4 blk = cells(m / 15.0);
  float facet = dot(normalize(blk.yz + 0.001), normalize(sun.xy));
  float cracks = smoothstep(0.64, 0.72, blk.x) * 0.35;
  float cliff = smoothstep(0.28, 0.5, slope);
  float bare = smoothstep(0.45, 0.6, B.g) * (1.0 - cliff);
  rock *= 1.0 + facet * 0.16 * max(cliff, bare);
  col = mix(col, rock * (1.0 - (strata * 0.22 + cracks * 0.3) * cliff), max(cliff, bare * 0.9));

  // Light: a few hard-ish tones, the sun hidden behind higher ground, valleys a little darker.
  float tone = 1.0 + clamp(rel * (1.5 + cliff * 1.6), -0.5, 0.4);
  tone = mix(tone, floor(tone * 5.0 + 0.5) / 5.0, 0.4 * cliff + 0.12);
  tone *= mix(0.58, 1.0, sh.r) * mix(1.0, sh.g, 0.8);
  col *= tone;

  // Forest shadow on the ground beside it (the sun is top left, so it falls down and right).
  float forest = smoothstep(0.44, 0.52, B.b);
  col *= 1.0 - 0.32 * smoothstep(0.4, 0.55, Bs.b) * (1.0 - forest);

  // Water: deeper further from the banks, moving ripples and glints, foam on the edge.
  float water = smoothstep(0.42, 0.56, C.r);
  if (water > 0.0) {
    vec4 r1 = nz(m + vec2(uTime * 9.0, -uTime * 6.0), 420.0), r2 = nz(m * 0.9 - vec2(uTime * 5.0, uTime * 8.0), 300.0);
    float depth = smoothstep(0.05, 0.7, C.a);
    vec3 wcol = mix(vec3(0.30, 0.55, 0.57), vec3(0.12, 0.31, 0.45), depth);
    float ripple = (r1.r + r2.g) * 0.5;
    wcol *= 0.97 + (ripple - 0.5) * 0.08;
    // Small glints drifting on the surface.
    vec4 g1 = nz(m + vec2(uTime * 11.0, -uTime * 7.0), 260.0), g2 = nz(m * 1.17 - vec2(-uTime * 6.0, uTime * 9.0), 210.0);
    float glint = smoothstep(0.76, 0.82, g1.b * g2.g * 1.25);
    wcol += vec3(0.75, 0.86, 0.86) * glint * 0.1 * (0.3 + depth);
    // The ford: clear shallow water over a stony bed.
    float ford = smoothstep(0.2, 0.7, C.g);
    vec4 st = cells(m / 11.0);
    float stone = (1.0 - smoothstep(0.32, 0.42, st.x)) * step(0.25, st.w);
    vec3 bed = mix(vec3(0.50, 0.47, 0.37), vec3(0.62, 0.60, 0.55) * (0.85 + 0.3 * step(0.0, -st.y - st.z)), stone);
    vec3 shallow = mix(bed, vec3(0.30, 0.55, 0.56), 0.38) * (0.96 + ripple * 0.1);
    wcol = mix(wcol, shallow, ford);
    float foam = (smoothstep(0.42, 0.5, C.r) - smoothstep(0.5, 0.62, C.r)) * smoothstep(0.3, 0.6, r2.r + 0.15);
    wcol = mix(wcol, vec3(0.86, 0.90, 0.86), foam * 0.6);
    col = mix(col, wcol, water);
  }

  // Kyber crystals: pale gravel with blue shards.
  float crys = smoothstep(0.4, 0.55, B.a);
  if (crys > 0.0) {
    vec3 gravel = vec3(0.55, 0.57, 0.60) * tone;
    vec4 cc = cells(m / 9.0);
    float shard = (1.0 - smoothstep(0.24, 0.3, cc.x / (0.55 + cc.w * 0.6))) * step(0.3, cc.w);
    float facet = step(0.0, cc.y + cc.z);
    vec3 blue = mix(vec3(0.42, 0.78, 1.0), vec3(0.18, 0.40, 0.85), facet);
    vec3 c2 = mix(gravel, blue, shard);
    c2 += vec3(0.1, 0.25, 0.45) * (1.0 - smoothstep(0.0, 0.6, cc.x)) * 0.35;
    col = mix(col, c2, crys);
  }

  // Bridges: a plank deck at its banks' level with rails and posts, its shadow on the water below.
  // Round 1 maps have no bridge shapes: their bridge tiles show as a deck from the masks.
  float aa = 1.0 / uScale;
  if (uBrN == 0) {
    float deck = smoothstep(0.45, 0.58, C.b);
    col = mix(col, vec3(0.58, 0.47, 0.35), deck);
  }
  for (int i = 0; i < 4; i++) {
    if (i >= uBrN) break;
    float hw = uBrW[i] * 0.5;
    vec3 sp = onBridge(i, m - vec2(7.0, 9.0));
    float shade = (1.0 - smoothstep(hw - aa, hw + aa, abs(sp.y))) * step(0.0, sp.x) * step(sp.x, sp.z);
    col *= 1.0 - 0.35 * shade * water;
    vec3 bp = onBridge(i, m);
    float inDeck = (1.0 - smoothstep(hw - aa, hw + aa, abs(bp.y))) * smoothstep(-aa, aa, bp.x) * (1.0 - smoothstep(bp.z - aa, bp.z + aa, bp.x));
    if (inDeck <= 0.0) continue;
    float pl = fract(bp.x / 12.0);
    float seam = smoothstep(0.0, 0.1, pl) * (1.0 - smoothstep(0.88, 1.0, pl));
    vec3 wood = mix(vec3(0.50, 0.40, 0.29), vec3(0.62, 0.51, 0.37), hash2(vec2(floor(bp.x / 12.0), float(i))).x) * mix(0.7, 1.0, seam);
    wood *= 1.0 + (lum(dTex) - 0.45) * 0.4;
    // Rails along both sides, with posts.
    float rail = smoothstep(hw - 5.0, hw - 4.0, abs(bp.y));
    float post = rail * (1.0 - smoothstep(2.5, 3.5, abs(fract(bp.x / 26.0) - 0.5) * 26.0 - 9.0));
    vec3 railCol = mix(vec3(0.36, 0.28, 0.20), vec3(0.50, 0.40, 0.29), step(0.0, -bp.y));
    wood = mix(wood, railCol, rail);
    wood = mix(wood, vec3(0.28, 0.22, 0.16), post * 0.6);
    // A dark outline round the deck.
    float rim = smoothstep(hw - 1.6, hw - 0.4, abs(bp.y)) + (1.0 - smoothstep(0.4, 1.6, bp.x)) + smoothstep(bp.z - 1.6, bp.z - 0.4, bp.x);
    wood = mix(wood, vec3(0.16, 0.12, 0.09), clamp(rim, 0.0, 1.0) * 0.85);
    col = mix(col, wood, inDeck);
  }

  // Forest: one canopy of crowns lit from the top left, gaps dark, a dark rim at its edge.
  if (forest > 0.0) {
    vec4 cr = cells(m / 21.0);
    float r = 0.62 + cr.w * 0.18;
    float crown = 1.0 - smoothstep(r * 0.85, r, cr.x);
    vec3 cn = normalize(vec3(-cr.y, -cr.z, max(0.0, r - cr.x) * 1.6 + 0.05));
    float lit = dot(cn, sun);
    vec3 dark = vec3(0.10, 0.20, 0.10), mid = vec3(0.17, 0.32, 0.14), light = vec3(0.30, 0.46, 0.19);
    vec3 canopy = mix(dark, mix(mid, light, smoothstep(0.55, 0.7, lit)), smoothstep(0.1, 0.25, lit) * crown);
    canopy *= 0.9 + cr.w * 0.2;
    float edge = smoothstep(0.44, 0.48, B.b) - smoothstep(0.5, 0.56, B.b);
    canopy = mix(canopy, vec3(0.06, 0.11, 0.06), edge * 0.85);
    col = mix(col, canopy, forest);
  }

  // Past the edge: greyed and darkened, with a faint line along the edge itself.
  if (outside > 0.0) {
    float g = lum(col);
    col = mix(vec3(g), col, 0.18) * 0.5;
  }
  col = mix(col, vec3(0.82, 0.80, 0.72), (1.0 - smoothstep(0.0, 1.5, abs(outside) * uScale)) * 0.35);
  outColor = vec4(col, 1.0);
}`

class GlLayer implements GroundLayer {
  readonly canvas: HTMLCanvasElement
  readonly gl = true
  /** Draw calls issued so far (for measuring). */
  drawCalls = 0
  private ctx: WebGL2RenderingContext
  private prog: WebGLProgram
  private vao: WebGLVertexArrayObject
  private tex: Record<string, WebGLTexture> = {}
  private loc: Record<string, WebGLUniformLocation | null> = {}
  private fields: Fields | null = null
  private world = [1, 1]
  private base: string
  /** Settles once the detail textures are in. */
  ready: Promise<void>

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, base: string) {
    this.canvas = canvas
    this.ctx = gl
    this.base = base
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`ground shader: ${gl.getShaderInfoLog(s)}`)
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT))
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`ground program: ${gl.getProgramInfoLog(p)}`)
    this.prog = p
    this.vao = gl.createVertexArray()!
    for (const u of ['uView', 'uCam', 'uScale', 'uWorld', 'uTime', 'uField', 'uHsize', 'uBr', 'uBrW', 'uBrN', 'uH', 'uSh', 'uA', 'uB', 'uC', 'uN', 'uGrass', 'uDirt', 'uRock']) this.loc[u] = gl.getUniformLocation(p, u)
    // Grey stand-ins until the detail textures load.
    for (const k of ['grass', 'dirt', 'rock']) this.tex[k] = this.texture(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([115, 115, 115, 255]), true)
    const N = 128
    this.tex.noise = this.texture(N, N, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, noiseTexture(N), true, true)
    this.ready = Promise.all(
      [['grass', 'grass-a'], ['dirt', 'dirt-a'], ['rock', 'rocky-a']].map(
        ([k, file]) =>
          new Promise<void>((ok) => {
            const img = new Image()
            img.onload = () => {
              if (this.ctx.isContextLost()) return ok()
              const t = gl.createTexture()!
              gl.bindTexture(gl.TEXTURE_2D, t)
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img)
              gl.generateMipmap(gl.TEXTURE_2D)
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
              gl.deleteTexture(this.tex[k])
              this.tex[k] = t
              ok()
            }
            img.onerror = () => ok()
            img.src = `${this.base}terrain/${file}.webp`
          }),
      ),
    ).then(() => undefined)
  }

  private texture(w: number, h: number, internal: number, format: number, type: number, data: ArrayBufferView, linear: boolean, repeat = false) {
    const gl = this.ctx
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data)
    const f = linear ? gl.LINEAR : gl.NEAREST
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f)
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
    return t
  }

  setMap(map: GroundMap) {
    const gl = this.ctx
    for (const k of ['h', 'sh', 'a', 'b', 'c']) if (this.tex[k]) gl.deleteTexture(this.tex[k])
    const f = bakeFields(map)
    this.fields = f
    this.world = [map.grid.cols * TILE, map.grid.rows * TILE]
    this.tex.h = this.texture(f.hw, f.hh, gl.R16F, gl.RED, gl.FLOAT, f.height, true)
    this.tex.sh = this.texture(f.hw, f.hh, gl.RG8, gl.RG, gl.UNSIGNED_BYTE, f.shade, true)
    this.tex.a = this.texture(f.fw, f.fh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, f.a, true)
    this.tex.b = this.texture(f.fw, f.fh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, f.b, true)
    this.tex.c = this.texture(f.fw, f.fh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, f.c, true)
  }

  draw(cam: { x: number; y: number; zoom: number }, w: number, h: number, dpr: number, time: number) {
    const gl = this.ctx
    const f = this.fields
    if (!f || gl.isContextLost()) return
    const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr))
    if (this.canvas.width !== pw || this.canvas.height !== ph) (this.canvas.width = pw), (this.canvas.height = ph)
    gl.viewport(0, 0, pw, ph)
    gl.useProgram(this.prog)
    gl.bindVertexArray(this.vao)
    const L = this.loc
    gl.uniform2f(L.uView, pw, ph)
    gl.uniform2f(L.uCam, cam.x, cam.y)
    gl.uniform1f(L.uScale, cam.zoom * (pw / w))
    gl.uniform2f(L.uWorld, this.world[0], this.world[1])
    gl.uniform1f(L.uTime, time)
    gl.uniform2f(L.uField, f.fw, f.fh)
    gl.uniform2f(L.uHsize, f.hw, f.hh)
    const n = Math.min(4, f.bridges.length / 5)
    gl.uniform1i(L.uBrN, n)
    if (n) {
      const ends = new Float32Array(16), widths = new Float32Array(4)
      for (let i = 0; i < n; i++) ends.set(f.bridges.slice(i * 5, i * 5 + 4), i * 4), (widths[i] = f.bridges[i * 5 + 4])
      gl.uniform4fv(L.uBr, ends)
      gl.uniform1fv(L.uBrW, widths)
    }
    const units: [string, string][] = [['uH', 'h'], ['uSh', 'sh'], ['uA', 'a'], ['uB', 'b'], ['uC', 'c'], ['uN', 'noise'], ['uGrass', 'grass'], ['uDirt', 'dirt'], ['uRock', 'rock']]
    for (let i = 0; i < units.length; i++) {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, this.tex[units[i][1]])
      gl.uniform1i(L[units[i][0]], i)
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    this.drawCalls++
  }

  dispose() {
    const gl = this.ctx
    for (const t of Object.values(this.tex)) gl.deleteTexture(t)
    this.tex = {}
    gl.deleteProgram(this.prog)
    gl.deleteVertexArray(this.vao)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

// --- The flat fallback ---------------------------------------------------------------------------

/** Without WebGL2: one baked picture of the land (2 samples a tile), lit by its heightmap, drawn with
 * the camera, and its mirror images past the edges in grey. */
class FlatLayer implements GroundLayer {
  readonly canvas: HTMLCanvasElement
  readonly gl = false
  drawCalls = 0
  private pic: HTMLCanvasElement | null = null
  private grey: HTMLCanvasElement | null = null
  private world = [1, 1]
  ready = Promise.resolve()

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
  }

  setMap(map: GroundMap) {
    const f = bakeFields(map)
    this.world = [map.grid.cols * TILE, map.grid.rows * TILE]
    const step = 2 // mask samples per picture pixel
    const pw = f.fw / step, ph = f.fh / step
    const pic = document.createElement('canvas')
    pic.width = pw
    pic.height = ph
    const img = new ImageData(pw, ph)
    const grey = new ImageData(pw, ph)
    const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t)
    for (let y = 0; y < ph; y++)
      for (let x = 0; x < pw; x++) {
        const o = (y * step * f.fw + x * step) * 4
        const hx = x * step, hy = y * step
        const H = (dx: number, dy: number) => f.height[Math.min(f.hh - 1, Math.max(0, hy + dy)) * f.hw + Math.min(f.hw - 1, Math.max(0, hx + dx))]
        const gx = (H(1, 0) - H(-1, 0)) / (2 * TEX), gy = (H(0, 1) - H(0, -1)) / (2 * TEX)
        const len = Math.hypot(gx, gy, 1)
        const rel = (0.5 * gx + 0.58 * gy + 0.64) / len / Math.hypot(0.5, 0.58, 0.64) - 0.64 / Math.hypot(0.5, 0.58, 0.64)
        const slope = 1 - 1 / len
        const sun = f.shade[(hy * f.hw + hx) * 2] / 255, valley = f.shade[(hy * f.hw + hx) * 2 + 1] / 255
        const A = [f.a[o], f.a[o + 1], f.a[o + 2], f.a[o + 3]].map((v) => v / 255)
        const sum = A[0] + A[1] + A[2] + A[3] + 0.001
        const base = [[102, 128, 48], [150, 120, 80], [199, 176, 128], [112, 94, 69]]
        let c = [0, 1, 2].map((i) => base.reduce((acc, col, k) => acc + col[i] * A[k], 0) / sum)
        if (f.b[o] > 115) c = [178, 150, 105]
        const rock = Math.max(Math.min(1, Math.max(0, (slope - 0.22) / 0.2)), f.b[o + 1] > 140 ? 0.85 : 0)
        c = mix(c, [143, 138, 128], rock)
        const tone = (1 + Math.max(-0.55, Math.min(0.32, rel * 2))) * (0.6 + 0.4 * sun) * valley
        c = c.map((v) => v * tone)
        if (f.b[o + 3] > 115) c = mix(c, [110, 170, 230], 0.6)
        if (f.c[o] > 120) c = f.c[o + 1] > 100 ? [105, 135, 125] : mix([76, 143, 148], [28, 77, 112], Math.min(1, f.c[o + 3] / 180))
        if (f.c[o + 2] > 120) c = [148, 118, 86]
        if (f.b[o + 2] > 120) c = [38, 72, 32]
        const q = (y * pw + x) * 4
        img.data[q] = c[0]
        img.data[q + 1] = c[1]
        img.data[q + 2] = c[2]
        img.data[q + 3] = 255
        const g = (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) * 0.5
        grey.data[q] = grey.data[q + 1] = grey.data[q + 2] = g
        grey.data[q + 3] = 255
      }
    pic.getContext('2d')!.putImageData(img, 0, 0)
    const gc = document.createElement('canvas')
    gc.width = pw
    gc.height = ph
    gc.getContext('2d')!.putImageData(grey, 0, 0)
    this.pic = pic
    this.grey = gc
  }

  draw(cam: { x: number; y: number; zoom: number }, w: number, h: number, dpr: number) {
    if (!this.pic || !this.grey) return
    const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr))
    if (this.canvas.width !== pw || this.canvas.height !== ph) (this.canvas.width = pw), (this.canvas.height = ph)
    const ctx = this.canvas.getContext('2d')!
    const s = cam.zoom * (pw / w)
    const [W, H] = this.world
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, pw, ph)
    ctx.imageSmoothingEnabled = true
    for (let my = -1; my <= 1; my++)
      for (let mx = -1; mx <= 1; mx++) {
        // A mirror copy: flipped across the edge it sits beyond.
        ctx.setTransform(s * (mx ? -1 : 1), 0, 0, s * (my ? -1 : 1), pw / 2 - cam.x * s + (mx ? (mx > 0 ? 2 * W : 0) * s : 0), ph / 2 - cam.y * s + (my ? (my > 0 ? 2 * H : 0) * s : 0))
        ctx.drawImage(mx || my ? this.grey : this.pic, 0, 0, W, H)
        this.drawCalls++
      }
    ctx.setTransform(s, 0, 0, s, pw / 2 - cam.x * s, ph / 2 - cam.y * s)
    ctx.strokeStyle = 'rgba(210, 205, 185, 0.35)'
    ctx.lineWidth = 1.5 / s
    ctx.strokeRect(0, 0, W, H)
  }

  dispose() {
    this.pic = this.grey = null
  }
}

/** The ground layer for a battle: WebGL2 where it can, else the flat fallback. */
export function createGroundLayer(opts: GroundLayerOptions = {}): GroundLayer {
  const canvas = document.createElement('canvas')
  const base = opts.base ?? '/games/empires/ground/'
  if (!opts.flat) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance' })
    if (gl) {
      try {
        return new GlLayer(canvas, gl, base)
      } catch (e) {
        console.warn('ground layer: WebGL2 failed, drawing flat', e)
      }
    }
  }
  // A canvas that had a WebGL context can't give a 2D one: start over with a fresh canvas.
  return new FlatLayer(opts.flat ? canvas : document.createElement('canvas'))
}
