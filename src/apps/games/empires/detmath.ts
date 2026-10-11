// Math that gives the same answer, bit for bit, in every browser. Multiplayer runs the battle on
// every player's machine in lockstep, so one ship turned a hair differently in one browser would
// split the battles apart for good. JavaScript's + - * / and Math.sqrt are exactly rounded
// everywhere, but Math.sin, cos, atan2, exp, hypot and ** are left to each engine, and Chrome,
// Firefox and Safari don't agree on their last bits. So the sim uses these instead: fdlibm's
// polynomials, built from nothing but exactly rounded operations. Accurate to a unit or two in the
// last place, which is far finer than any ship can tell.

const PIO2_HI = 1.5707963267341256 // pi/2 to 33 bits
const PIO2_LO = 6.077100506506192e-11 // pi/2 - PIO2_HI
const INV_PIO2 = 0.6366197723675814

/** sin on [-pi/4, pi/4]. */
function ksin(x: number) {
  const z = x * x
  const v = z * x
  const r = 8.33333333332248946124e-3 + z * (-1.98412698298579493134e-4 + z * (2.75573137070700676789e-6 + z * (-2.50507602534068634195e-8 + z * 1.58969099521155010221e-10)))
  return x + v * (-1.66666666666666324348e-1 + z * r)
}

/** cos on [-pi/4, pi/4]. */
function kcos(x: number) {
  const z = x * x
  const r = z * (4.16666666666666019037e-2 + z * (-1.38888888888741095749e-3 + z * (2.48015872894767294178e-5 + z * (-2.75573143513906633035e-7 + z * (2.08757232129817482790e-9 + z * -1.13596475577881948265e-11)))))
  return 1 - (0.5 * z - z * r)
}

/** Splits x into a quarter turn count and what's left in [-pi/4, pi/4]. Plenty for the angles a
 * battle sees (accurate well past a million radians). */
function reduce(x: number): [number, number] {
  const n = Math.round(x * INV_PIO2)
  return [((n % 4) + 4) % 4, x - n * PIO2_HI - n * PIO2_LO]
}

export function sin(x: number) {
  if (!Number.isFinite(x)) return NaN
  const [q, y] = reduce(x)
  return q === 0 ? ksin(y) : q === 1 ? kcos(y) : q === 2 ? -ksin(y) : -kcos(y)
}

export function cos(x: number) {
  if (!Number.isFinite(x)) return NaN
  const [q, y] = reduce(x)
  return q === 0 ? kcos(y) : q === 1 ? -ksin(y) : q === 2 ? -kcos(y) : ksin(y)
}

const ATAN_HI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.5707963267948965580]
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17]

/** atan for x >= 0. */
function atanPos(x: number) {
  if (x > 7.37e19) return ATAN_HI[3] + ATAN_LO[3]
  let id = -1
  if (x >= 0.4375) {
    if (x < 1.1875) {
      if (x < 0.6875) {
        id = 0
        x = (2 * x - 1) / (2 + x)
      } else {
        id = 1
        x = (x - 1) / (x + 1)
      }
    } else if (x < 2.4375) {
      id = 2
      x = (x - 1.5) / (1 + 1.5 * x)
    } else {
      id = 3
      x = -1 / x
    }
  } else if (x < 1.862645149230957e-9) return x
  const z = x * x
  const w = z * z
  const s1 = z * (3.33333333333329318027e-1 + w * (1.42857142725034663711e-1 + w * (9.09088713343650656196e-2 + w * (6.66107313738753120669e-2 + w * (4.97687799461593236017e-2 + w * 1.62858201153657823623e-2)))))
  const s2 = w * (-1.99999999998764832476e-1 + w * (-1.11111104054623557880e-1 + w * (-7.69187620504482999495e-2 + w * (-5.83357013379057348645e-2 + w * -3.65315727442169155270e-2))))
  if (id < 0) return x - x * (s1 + s2)
  return ATAN_HI[id] - (x * (s1 + s2) - ATAN_LO[id] - x)
}

export function atan2(y: number, x: number) {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN
  const neg = y < 0 || Object.is(y, -0)
  if (y === 0) return x > 0 || Object.is(x, 0) ? y : neg ? -Math.PI : Math.PI
  if (x === 0) return neg ? -Math.PI / 2 : Math.PI / 2
  const a = atanPos(Math.abs(y / x))
  if (x > 0) return neg ? -a : a
  return neg ? a - Math.PI : Math.PI - a
}

export const hypot = (x: number, y: number) => Math.sqrt(x * x + y * y)

/** The square of v: `v ** 2` is left to each engine, `v * v` is not. */
export const sq = (v: number) => v * v

const LN2_HI = 6.93147180369123816490e-1
const LN2_LO = 1.90821492927058770002e-10
const INV_LN2 = 1.44269504088896338700
const scale = new DataView(new ArrayBuffer(8))

export function exp(x: number) {
  if (Number.isNaN(x)) return NaN
  if (x > 709) return Infinity
  if (x < -708) return 0
  const k = Math.round(x * INV_LN2)
  const hi = x - k * LN2_HI
  const lo = k * LN2_LO
  const r = hi - lo
  const t = r * r
  const c = r - t * (1.66666666666666019037e-1 + t * (-2.77777777770155933842e-3 + t * (6.61375632143793436117e-5 + t * (-1.65339022054652515390e-6 + t * 4.13813679705723846039e-8))))
  const y = 1 - (lo - (r * c) / (2 - c) - hi)
  // 2^k, exactly, written straight into the exponent bits.
  scale.setUint32(0, (k + 1023) << 20)
  scale.setUint32(4, 0)
  return y * scale.getFloat64(0)
}
