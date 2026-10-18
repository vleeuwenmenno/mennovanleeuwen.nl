import { LEVEL_H, RUIN_HALF, expandFeatures, valueNoise } from './terrain.ts'
import { TreeLayer, bakeCrowns, loadAtlas, placeCrowns } from './trees.ts'
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
// strata, paints forests as a dark canopy floor with a cast shadow (trees.ts draws the crowns over
// it), moves the water, and past the map's edge draws the map mirrored, greyed and darkened, with a
// faint line on the edge.
//
// Where WebGL2 is missing, createGroundLayer returns a flat 2D layer (`gl: false`) that draws one
// baked picture of the same masks, lit by the same heightmap.

/** The most bridges and ruins the shader draws. */
const MAX_BRIDGES = 8
const MAX_RUINS = 16
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
  /** The ruins, in world units: middle x, y and half width, half height, each (mirror copies included). */
  ruins: number[]
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

/** How much forest the baked mask has at a world point (0..1), for placing the crowns. */
function forestAt(f: Fields) {
  return (x: number, y: number) => {
    const u = Math.min(f.fw - 1, Math.max(0, x / TEX - 0.5)), v = Math.min(f.fh - 1, Math.max(0, y / TEX - 0.5))
    const i = Math.min(f.fw - 2, Math.floor(u)), j = Math.min(f.fh - 2, Math.floor(v)), fx = u - i, fy = v - j
    const at = (a: number, b: number) => f.b[(b * f.fw + a) * 4 + 2] / 255
    return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy
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
  // Bridges and ruins are drawn from their shapes (every symmetric copy), straight-edged.
  const ex = expandFeatures(map.def)
  const bridges: number[] = []
  for (const br of ex.bridges.slice(0, MAX_BRIDGES)) bridges.push(br.from[0] * TILE, br.from[1] * TILE, br.to[0] * TILE, br.to[1] * TILE, br.width * TILE)
  const ruins: number[] = []
  ex.ruins.slice(0, MAX_RUINS).forEach((rn, k) => {
    const [hx, hy] = ex.ruinTurn[k] ? [RUIN_HALF[1], RUIN_HALF[0]] : RUIN_HALF
    ruins.push(rn[0] * TILE, rn[1] * TILE, hx * TILE, hy * TILE)
  })
  return { fw, fh, a, b, c, hw, hh, height, shade, bridges, ruins }
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
uniform vec4 uBr[8];
uniform float uBrW[8];
uniform int uBrN;
uniform vec4 uRuin[16];
uniform int uRuinN;
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

// A round tree crown or boulder from a cell lookup: returns colour in rgb and coverage in a.
vec4 crown(vec4 cc, float r, float aa, vec3 dark, vec3 mid, vec3 light, vec3 sun) {
  float cover = 1.0 - smoothstep(r - aa, r + aa, cc.x);
  if (cover <= 0.0) return vec4(0.0);
  vec3 cn = normalize(vec3(-cc.y, -cc.z, max(0.0, r - cc.x) * 2.2 + 0.05 * r));
  float lit = dot(cn, sun);
  vec3 c = mix(dark, mix(mid, light, smoothstep(0.62, 0.74, lit)), smoothstep(0.15, 0.3, lit));
  c = mix(c, dark * 0.55, smoothstep(r * 0.78, r * 0.95, cc.x));
  return vec4(c, cover);
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
  // (Some raw weight stays in, so where every mask is thin, as under a road's edge, the blend never
  // falls to nothing.)
  vec4 Ak = A * 0.25 + smoothstep(vec4(0.25), vec4(0.75), A) * 0.75;
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
  vec3 grass = mix(vec3(0.50, 0.53, 0.22), vec3(0.60, 0.60, 0.27), smoothstep(0.3, 0.7, n1.r)) * (1.0 + gd);
  grass = mix(grass, vec3(0.42, 0.48, 0.21), smoothstep(0.55, 0.8, n2.g) * 0.35);
  vec3 dirt = mix(vec3(0.67, 0.53, 0.35), vec3(0.74, 0.60, 0.41), n1.g) * (1.0 + dd);
  vec3 sand = vec3(0.78, 0.69, 0.50) * (1.0 + dd * 0.6);
  vec3 mud = vec3(0.54, 0.46, 0.34) * (1.0 + dd * 0.8);
  float sum = Ak.r + Ak.g + Ak.b + Ak.a + 0.01;
  vec3 col = (grass * Ak.r + dirt * (Ak.g + 0.01) + sand * Ak.b + mud * Ak.a) / sum;
  // A darker painted rim where grass ends.
  col *= 1.0 - 0.12 * (smoothstep(0.3, 0.45, A.r) - smoothstep(0.5, 0.7, A.r));
  float road = smoothstep(0.4, 0.5, roadMask);
  float roadEdge = smoothstep(0.28, 0.4, roadMask) - road;
  col = mix(col, vec3(0.47, 0.39, 0.27), roadEdge * 0.45);
  col = mix(col, vec3(0.70, 0.59, 0.41) * (1.0 + dd * 0.7), road);

  // Rock: on steep slopes, and bare plateau tops, with strata and strong light.
  vec3 rock = vec3(0.60, 0.57, 0.52) * (1.0 + rd * 0.45);
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
  float tone = 1.0 + clamp(rel * (1.5 + cliff * 1.6), -0.5, 0.4 - cliff * 0.16);
  tone = mix(tone, floor(tone * 5.0 + 0.5) / 5.0, 0.4 * cliff + 0.12);
  tone *= mix(0.52, 1.0, sh.r) * mix(1.0, sh.g, 0.8);
  // Where the riverbed dips under ground the water doesn't cover (round a bridge's ends), its
  // slope isn't shaded: it would show as a dark hollow.
  tone = mix(tone, 1.0, smoothstep(-1.0, -8.0, h) * (1.0 - smoothstep(0.3, 0.45, C.r)) * 0.85);
  // Higher ground a touch brighter, so plateaus stand out from the land round them.
  tone *= 1.0 + clamp(h, 0.0, 140.0) / 64.0 * 0.07;
  col *= tone;

  // Forest shadow on the ground beside it (the sun is top left, so it falls down and right).
  float forest = smoothstep(0.44, 0.52, B.b);
  col *= 1.0 - 0.32 * smoothstep(0.4, 0.55, Bs.b) * (1.0 - forest);

  // Water: deeper further from the banks, moving ripples and glints, foam on the edge.
  float water = smoothstep(0.42, 0.56, C.r);
  if (water > 0.0) {
    vec4 r1 = nz(m + vec2(uTime * 9.0, -uTime * 6.0), 420.0), r2 = nz(m * 0.9 - vec2(uTime * 5.0, uTime * 8.0), 300.0);
    float depth = smoothstep(0.05, 0.7, C.a);
    vec3 wcol = mix(vec3(0.24, 0.53, 0.60), vec3(0.09, 0.29, 0.45), depth);
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

  // Boulders along the banks and round the ford, each with a shadow.
  float bank = smoothstep(0.16, 0.36, C.r) * (1.0 - smoothstep(0.58, 0.8, C.r));
  float fordEdge = smoothstep(0.04, 0.3, C.g) * (1.0 - smoothstep(0.55, 0.85, C.g));
  float wantRock = max(bank * 0.42, fordEdge * 0.8) * (1.0 - road) * (1.0 - smoothstep(0.02, 0.15, C.b));
  if (wantRock > 0.01) {
    float cs = 17.0;
    vec4 sc = cells((m - vec2(5.0, 6.0)) / cs);
    float sr = 0.26 + fract(sc.w * 3.7) * 0.2;
    if (fract(sc.w * 13.7) < wantRock) col *= 1.0 - 0.3 * (1.0 - smoothstep(sr - 0.05, sr + 0.05, sc.x));
    vec4 bc = cells(m / cs);
    float br = 0.26 + fract(bc.w * 3.7) * 0.2;
    if (fract(bc.w * 13.7) < wantRock) {
      vec4 bo = crown(bc, br, 1.2 / uScale / cs, vec3(0.30, 0.29, 0.28), vec3(0.50, 0.49, 0.46), vec3(0.70, 0.68, 0.63), sun);
      col = mix(col, bo.rgb, bo.a);
    }
  }

  // Kyber crystal fields: plain gravel, a few darker pebbles in it. The crystal clusters themselves
  // are objects the battle draws on top (they run out and go).
  float crys = smoothstep(0.4, 0.55, B.a);
  if (crys > 0.0) {
    vec4 cc = cells(m / 9.0);
    vec3 gravel = vec3(0.56, 0.52, 0.46) * tone;
    float pebble = (1.0 - smoothstep(0.16, 0.22, cc.x)) * step(0.8, cc.w);
    col = mix(col, mix(gravel, gravel * 0.84, pebble), crys);
  }

  // Bridges: a plank deck at its banks' level with rails and posts, its shadow on the water below.
  // Round 1 maps have no bridge shapes: their bridge tiles show as a deck from the masks.
  float aa = 1.0 / uScale;
  if (uBrN == 0) {
    float deck = smoothstep(0.45, 0.58, C.b);
    col = mix(col, vec3(0.58, 0.47, 0.35), deck);
  }
  for (int i = 0; i < 8; i++) {
    if (i >= uBrN) break;
    float hw = uBrW[i] * 0.5;
    vec3 sp = onBridge(i, m - vec2(7.0, 9.0));
    float shade = (1.0 - smoothstep(hw - aa, hw + aa, abs(sp.y))) * step(0.0, sp.x) * step(sp.x, sp.z);
    col *= 1.0 - 0.35 * shade * water;
    vec3 bp = onBridge(i, m);
    float inDeck = (1.0 - smoothstep(hw - aa, hw + aa, abs(bp.y))) * smoothstep(-aa, aa, bp.x) * (1.0 - smoothstep(bp.z - aa, bp.z + aa, bp.x));
    if (inDeck <= 0.0) continue;
    // Steel plates with seams across and down the middle, girders along the sides.
    float pl = fract(bp.x / 22.0);
    float seam = smoothstep(0.0, 0.04, pl) * (1.0 - smoothstep(0.96, 1.0, pl)) * smoothstep(0.4, 1.1, abs(bp.y));
    vec3 wood = mix(vec3(0.47, 0.49, 0.51), vec3(0.55, 0.57, 0.59), hash2(vec2(floor(bp.x / 22.0), step(0.0, bp.y) + float(i) * 3.0)).x) * mix(0.72, 1.0, seam);
    wood *= 0.94 + n3.a * 0.12;
    float girder = smoothstep(hw - 11.0, hw - 10.0, abs(bp.y));
    vec3 girderCol = mix(vec3(0.30, 0.32, 0.34), vec3(0.44, 0.46, 0.48), step(0.0, -bp.y));
    girderCol = mix(girderCol, vec3(0.72, 0.74, 0.74), (1.0 - smoothstep(0.8, 1.8, abs(abs(bp.y) - (hw - 6.0)))) * 0.55);
    // Bolts along the girders.
    girderCol *= 1.0 - 0.35 * (1.0 - smoothstep(0.9, 1.6, length(vec2(fract(bp.x / 11.0) * 11.0 - 5.5, abs(bp.y) - (hw - 3.0)))));
    wood = mix(wood, girderCol, girder);
    float rim = smoothstep(hw - 1.6, hw - 0.4, abs(bp.y)) + (1.0 - smoothstep(0.4, 1.6, bp.x)) + smoothstep(bp.z - 1.6, bp.z - 0.4, bp.x);
    wood = mix(wood, vec3(0.14, 0.15, 0.16), clamp(rim, 0.0, 1.0) * 0.85);
    col = mix(col, wood, inDeck);
  }
  // Round pylons at the bridges' corners.
  for (int i = 0; i < 8; i++) {
    if (i >= uBrN) break;
    vec3 bp = onBridge(i, m);
    float hw = uBrW[i] * 0.5;
    vec2 cn = vec2(bp.x < bp.z * 0.5 ? bp.x : bp.x - bp.z, abs(bp.y) - hw + 1.0);
    float d = length(cn);
    if (d < 14.0) {
      vec4 py = crown(vec4(d / 13.0, -cn.x / 13.0, -cn.y * sign(bp.y + 0.001) / 13.0, 0.0), 0.9, aa / 13.0, vec3(0.20, 0.21, 0.22), vec3(0.42, 0.44, 0.46), vec3(0.74, 0.76, 0.76), sun);
      col = mix(col, py.rgb, py.a);
    }
  }

  // Ruins: an old foundation of flagstones with broken walls and corner columns, casting shadows.
  for (int i = 0; i < 16; i++) {
    if (i >= uRuinN) break;
    vec2 hs = uRuin[i].zw;
    vec2 q = m - uRuin[i].xy;
    vec2 qs = q - vec2(6.0, 7.0);
    vec2 e = abs(q) - hs, es = abs(qs) - hs;
    if (max(es.x, es.y) > 12.0 && max(e.x, e.y) > 12.0) continue;
    // Which stretch of wall a point is on (a side and a run along it), and whether that stretch stands.
    float edge = abs(max(e.x, e.y)), edgeS = abs(max(es.x, es.y));
    float runP = e.x > e.y ? q.y + 300.0 * sign(q.x) : q.x + 700.0 * sign(q.y);
    float runS = es.x > es.y ? qs.y + 300.0 * sign(qs.x) : qs.x + 700.0 * sign(qs.y);
    float stands = step(0.38, hash2(vec2(floor(runP / 15.0), float(i))).x);
    float standsS = step(0.38, hash2(vec2(floor(runS / 15.0), float(i))).x);
    float corner = step(max(abs(e.x), abs(e.y)), 7.0);
    float cornerS = step(max(abs(es.x), abs(es.y)), 7.0);
    float wallS = max((1.0 - smoothstep(3.0, 4.0, edgeS)) * standsS, cornerS);
    col *= 1.0 - 0.32 * wallS;
    if (max(e.x, e.y) < 0.0) {
      vec4 fl = cells(q / 11.0);
      vec3 flag = mix(vec3(0.62, 0.58, 0.50), vec3(0.70, 0.66, 0.57), fl.w);
      flag *= 1.0 - smoothstep(0.55, 0.62, fl.x) * 0.25;
      float moss = smoothstep(0.45, 0.7, nz(m, 60.0).r);
      col = mix(col, mix(flag * tone, col, moss * 0.6), 0.85);
    }
    float wall = max((1.0 - smoothstep(3.0, 4.0, edge)) * stands, corner);
    if (wall > 0.0) {
      vec3 stone = mix(vec3(0.70, 0.66, 0.58), vec3(0.78, 0.74, 0.66), step(0.0, -q.x - q.y)) * (0.92 + n3.b * 0.16);
      float outline = corner > 0.0 ? smoothstep(5.5, 7.0, max(abs(e.x), abs(e.y))) : smoothstep(2.6, 3.6, edge);
      stone = mix(stone, vec3(0.22, 0.20, 0.17), outline * 0.9);
      col = mix(col, stone, wall);
    }
  }

  // Forest: a dark canopy floor, so no ground shows between the crowns drawn over it (trees.ts).
  if (forest > 0.0) {
    vec4 fc = cells(m / 30.0);
    vec3 floorCol = vec3(0.09, 0.16, 0.10) * (0.9 + fc.w * 0.2) * mix(0.85, 1.0, sh.r);
    col = mix(col, floorCol, forest);
  }

  // Past the edge: greyed and darkened, with a faint line along the edge itself.
  if (outside > 0.0) {
    float g = lum(col);
    col = mix(vec3(g), col, 0.18) * 0.5;
  }
  col = mix(col, vec3(0.82, 0.80, 0.72), (1.0 - smoothstep(0.0, 1.5, abs(outside) * uScale)) * 0.35);
  outColor = vec4(col, 1.0);
}`

/** Which texture goes in which sampler, by texture unit. */
const UNITS: [string, string][] = [['uH', 'h'], ['uSh', 'sh'], ['uA', 'a'], ['uB', 'b'], ['uC', 'c'], ['uN', 'noise'], ['uGrass', 'grass'], ['uDirt', 'dirt'], ['uRock', 'rock']]

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
  /** The bridges' and ruins' uniforms, made once per map. */
  private brEnds = new Float32Array(MAX_BRIDGES * 4)
  private brWidths = new Float32Array(MAX_BRIDGES)
  private ruinData = new Float32Array(MAX_RUINS * 4)
  private world = [1, 1]
  private base: string
  private trees: TreeLayer
  /** Settles once the detail textures and the trees' atlas are in. */
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
    this.trees = new TreeLayer(gl, base)
    for (const u of ['uView', 'uCam', 'uScale', 'uWorld', 'uTime', 'uField', 'uHsize', 'uBr', 'uBrW', 'uBrN', 'uRuin', 'uRuinN', 'uH', 'uSh', 'uA', 'uB', 'uC', 'uN', 'uGrass', 'uDirt', 'uRock']) this.loc[u] = gl.getUniformLocation(p, u)
    // Grey stand-ins until the detail textures load.
    for (const k of ['grass', 'dirt', 'rock']) this.tex[k] = this.texture(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([115, 115, 115, 255]), true)
    const N = 128
    this.tex.noise = this.texture(N, N, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, noiseTexture(N), true, true)
    this.ready = Promise.all([
      this.trees.ready,
      ...[['grass', 'grass-a'], ['dirt', 'dirt-a'], ['rock', 'rocky-a']].map(
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
    ]).then(() => undefined)
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
    this.brEnds.fill(0)
    this.brWidths.fill(0)
    for (let i = 0; i < f.bridges.length / 5; i++) this.brEnds.set(f.bridges.slice(i * 5, i * 5 + 4), i * 4), (this.brWidths[i] = f.bridges[i * 5 + 4])
    this.ruinData.fill(0)
    this.ruinData.set(f.ruins)
    this.trees.setCrowns(placeCrowns(map, forestAt(f)), this.world[0], this.world[1])
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
    const n = f.bridges.length / 5
    gl.uniform1i(L.uBrN, n)
    if (n) {
      gl.uniform4fv(L.uBr, this.brEnds)
      gl.uniform1fv(L.uBrW, this.brWidths)
    }
    const nr = f.ruins.length / 4
    gl.uniform1i(L.uRuinN, nr)
    if (nr) gl.uniform4fv(L.uRuin, this.ruinData)
    const units = UNITS
    for (let i = 0; i < units.length; i++) {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, this.tex[units[i][1]])
      gl.uniform1i(L[units[i][0]], i)
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    this.drawCalls++
    this.drawCalls += this.trees.draw(cam, cam.zoom * (pw / w), pw, ph)
  }

  dispose() {
    const gl = this.ctx
    for (const t of Object.values(this.tex)) gl.deleteTexture(t)
    this.tex = {}
    this.trees.dispose()
    gl.deleteProgram(this.prog)
    gl.deleteVertexArray(this.vao)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

// --- The flat fallback ---------------------------------------------------------------------------

/** Without WebGL2: one baked picture of the land (2 samples a tile), lit by its heightmap, with the
 * trees' crowns baked over it at 8 pixels a tile once the atlas is in, drawn with the camera, and its
 * mirror images past the edges in grey. */
class FlatLayer implements GroundLayer {
  readonly canvas: HTMLCanvasElement
  readonly gl = false
  drawCalls = 0
  private pic: HTMLCanvasElement | null = null
  private grey: HTMLCanvasElement | null = null
  private world = [1, 1]
  private base: string
  /** Which setMap the crowns being baked belong to (a later map wins). */
  private mapNo = 0
  ready: Promise<void>

  constructor(canvas: HTMLCanvasElement, base: string) {
    this.canvas = canvas
    this.base = base
    this.ready = loadAtlas(base).then(() => undefined)
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
        if (f.b[o + 3] > 115) c = mix(c, [143, 133, 117], 0.7)
        if (f.c[o] > 120) c = f.c[o + 1] > 100 ? [105, 135, 125] : mix([76, 143, 148], [28, 77, 112], Math.min(1, f.c[o + 3] / 180))
        if (f.c[o + 2] > 120) c = [148, 118, 86]
        if (f.b[o + 2] > 120) c = [23, 41, 26]
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
    // The crowns: the picture drawn again at 8 pixels a tile with them over it, and greyed for the
    // mirror copies.
    const no = ++this.mapNo
    const crowns = placeCrowns(map, forestAt(f))
    loadAtlas(this.base).then((atlas) => {
      if (!atlas || no !== this.mapNo) return
      const k = 8 / TILE
      const tw = Math.round(this.world[0] * k), th = Math.round(this.world[1] * k)
      const tc = document.createElement('canvas')
      tc.width = tw
      tc.height = th
      const ctx = tc.getContext('2d')!
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(pic, 0, 0, tw, th)
      bakeCrowns(ctx, crowns, atlas, k)
      const d = ctx.getImageData(0, 0, tw, th)
      for (let i = 0; i < d.data.length; i += 4) d.data[i] = d.data[i + 1] = d.data[i + 2] = (d.data[i] * 0.3 + d.data[i + 1] * 0.59 + d.data[i + 2] * 0.11) * 0.5
      const tg = document.createElement('canvas')
      tg.width = tw
      tg.height = th
      tg.getContext('2d')!.putImageData(d, 0, 0)
      this.pic = tc
      this.grey = tg
    })
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
  return new FlatLayer(opts.flat ? canvas : document.createElement('canvas'), base)
}
