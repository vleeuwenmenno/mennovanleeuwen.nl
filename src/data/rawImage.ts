/**
 * One still JPEG out of a camera raw (TIFF-based: DNG, iPhone ProRAW, NEF, ARW, CR2) or a
 * multi-picture JPEG (MPF: iPhone gain maps and depth maps), without decoding any pixels.
 *
 * A raw gives its largest embedded JPEG preview (no demosaic), with the raw's orientation written
 * into a minimal EXIF block. A multi-picture JPEG gives its primary picture only: the MPF segment
 * and everything after the primary's end are cut off.
 *
 * Shared by the browser (attaching a file) and the server (image sources, vision input, thumbnails),
 * so it works on plain Uint8Arrays. The input is untrusted: every offset is bounds-checked, every
 * loop is bounded by the input's length or a fixed cap, and nothing is allocated from a size the
 * file claims before that size was checked against the bytes there are.
 */

export class StillImageError extends Error {}

/** File names and types that are camera raws this reads. */
export const RAW_NAME = /\.(dng|nef|arw|cr2)$/i
export const RAW_MIME = /^image\/(x-adobe-dng|dng|x-dng|x-nikon-nef|x-sony-arw|x-canon-cr2)$/i
export const HEIF_NAME = /\.(heic|heif)$/i
export const HEIF_MIME = /^image\/hei[cf](-sequence)?$/i

export const NO_PREVIEW = 'This raw file has no embedded preview; export a JPEG'
export const HEIF_UNSUPPORTED = 'HEIC and HEIF pictures are not supported as sources; export a JPEG'

const MAX_IFDS = 64
const MAX_ENTRIES = 1024
const MAX_DEPTH = 4
const MAX_SUBIFDS = 16
const MAX_VALUES = 64
const MAX_SEGMENTS = 512
const MAX_PREVIEW = 64 * 1024 * 1024
const MAX_PIXELS = 16_777_216
const MAX_SIDE = 8192

const ascii = (b: Uint8Array, start: number, end: number) => {
  let s = ''
  for (let i = start; i < end && i < b.length; i++) s += String.fromCharCode(b[i])
  return s
}

export const isTiff = (b: Uint8Array) =>
  b.length >= 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42))

/** HEIC/HEIF (and the AVIF family, which shares the container): an ISO-BMFF `ftyp` box with an image brand. */
export const isHeif = (b: Uint8Array) => b.length >= 12 && ascii(b, 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(ascii(b, 8, 12))

export const isJpeg = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

type Segment = { marker: number; start: number; end: number }
type JpegInfo = { end: number; width: number; height: number; lossless: boolean; segments: Segment[]; mpf: Segment | null }

const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1]

/**
 * The first picture of a JPEG: where its EOI ends, its frame size, and the segments before its
 * first scan. Null when it is not a complete JPEG. Each step moves forward, so this ends.
 */
function jpegInfo(b: Uint8Array): JpegInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let at = 2, width = 0, height = 0, lossless = false, mpf: Segment | null = null, scanned = false
  const segments: Segment[] = []
  while (at < b.length) {
    if (b[at] !== 0xff) return null
    const start = at
    while (at < b.length && b[at] === 0xff) at++
    if (at >= b.length) return null
    const marker = b[at++]
    if (marker === 0xd9) return scanned && width ? { end: at, width, height, lossless, segments, mpf } : null
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (at + 2 > b.length) return null
    const size = u16be(b, at)
    if (size < 2 || at + size > b.length) return null
    if (!scanned) {
      if (segments.length >= MAX_SEGMENTS) return null
      const segment = { marker, start, end: at + size }
      segments.push(segment)
      if (marker === 0xe2 && size >= 6 && ascii(b, at + 2, at + 6) === 'MPF\0') mpf = segment
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (size < 7) return null
      if (!width) { height = u16be(b, at + 3); width = u16be(b, at + 5) }
    } else if ([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) lossless = true
    at += size
    if (marker === 0xda) {
      scanned = true
      while (at < b.length) {
        if (b[at] !== 0xff) { at++; continue }
        if (at + 1 >= b.length) return null
        const next = b[at + 1]
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { at += 2; continue }
        break
      }
    }
  }
  return null
}

/** Does this JPEG's header (before its first scan) hold an MPF segment? Reads only the header, so a prefix of the file is enough. */
export function jpegHasMpf(b: Uint8Array): boolean {
  if (!isJpeg(b)) return false
  let at = 2
  for (let n = 0; n < MAX_SEGMENTS && at + 4 <= b.length; n++) {
    if (b[at] !== 0xff) return false
    while (at < b.length && b[at] === 0xff) at++
    const marker = b[at++]
    if (marker === 0xd9 || marker === 0xda || at + 2 > b.length) return false
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    const size = u16be(b, at)
    if (size < 2) return false
    if (marker === 0xe2 && size >= 6 && ascii(b, at + 2, at + 6) === 'MPF\0') return true
    at += size
  }
  return false
}

/** A JPEG's frame size (of its first picture), or null when it is not a complete baseline or progressive JPEG. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  const info = jpegInfo(b)
  return info && !info.lossless ? { width: info.width, height: info.height } : null
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** A minimal EXIF APP1 segment holding only Orientation (big-endian TIFF, one IFD entry). */
function orientationSegment(orientation: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xe1, 0, 34,
    0x45, 0x78, 0x69, 0x66, 0, 0,
    0x4d, 0x4d, 0, 42, 0, 0, 0, 8,
    0, 1,
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0,
    0, 0, 0, 0,
  ])
}

/**
 * The JPEG's first picture alone: the MPF segment dropped and the bytes cut at its EOI.
 * `orientation` (from a raw's IFD0) replaces any EXIF the picture has. Null when not a JPEG.
 */
function primary(b: Uint8Array, orientation: number | null): Uint8Array | null {
  const info = jpegInfo(b)
  if (!info || info.lossless) return null
  const drop = info.segments.filter((s) => s === info.mpf || (orientation !== null && s.marker === 0xe1 && ascii(b, s.start + 4, s.start + 10) === 'Exif\0\0'))
  if (!drop.length && orientation === null && info.end === b.length) return b
  const parts: Uint8Array[] = [b.subarray(0, 2)]
  if (orientation !== null && orientation !== 1) parts.push(orientationSegment(orientation))
  let at = 2
  for (const s of drop) { parts.push(b.subarray(at, s.start)); at = s.end }
  parts.push(b.subarray(at, info.end))
  return concat(parts)
}

/** A multi-picture JPEG as its primary picture; any other input is returned as it is (the source checks judge it). */
export function jpegPrimary(b: Uint8Array): Uint8Array {
  if (!isJpeg(b)) return b
  const info = jpegInfo(b)
  if (!info?.mpf) return b
  return primary(b, null) ?? b
}

/**
 * The largest embedded JPEG preview of a TIFF-based raw, oriented like the raw. By default one
 * within the sources' 8192 pixels a side and 16 megapixels wins over a larger one (the server cannot
 * scale); `largest` takes the largest regardless (the browser draws it down).
 */
export function rawPreview(b: Uint8Array, { largest = false } = {}): Uint8Array {
  if (!isTiff(b)) throw new StillImageError('Not a camera raw file')
  const le = b[0] === 0x49
  const len = b.length
  const u16 = (at: number) => (at >= 0 && at + 2 <= len ? (le ? b[at] | (b[at + 1] << 8) : (b[at] << 8) | b[at + 1]) : -1)
  const u32 = (at: number) => (at >= 0 && at + 4 <= len ? (le ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000 : ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) + b[at] * 0x1000000) : -1)
  /** An entry's SHORT or LONG values (at most MAX_VALUES), or [] when they are another type or out of bounds. */
  const values = (entry: number): number[] => {
    const type = u16(entry + 2), count = u32(entry + 4)
    const size = type === 3 ? 2 : type === 4 || type === 13 ? 4 : 0
    if (!size || count < 1 || count > MAX_VALUES) return []
    const at = count * size <= 4 ? entry + 8 : u32(entry + 8)
    if (at < 0 || at + count * size > len) return []
    const out: number[] = []
    for (let i = 0; i < count; i++) out.push(size === 2 ? u16(at + i * 2) : u32(at + i * 4))
    return out
  }

  const first = u32(4)
  if (first < 8 || first + 2 > len) throw new StillImageError('Invalid raw file')
  const queue: { at: number; depth: number }[] = [{ at: first, depth: 0 }]
  const seen = new Set<number>()
  const candidates: { at: number; length: number }[] = []
  let orientation: number | null = null, ifds = 0
  while (queue.length && ifds < MAX_IFDS) {
    const { at, depth } = queue.shift()!
    if (at < 8 || at + 2 > len || seen.has(at)) continue
    seen.add(at); ifds++
    const count = u16(at)
    if (count < 1 || count > MAX_ENTRIES || at + 2 + count * 12 + 4 > len) continue
    let strips: number[] = [], counts: number[] = [], jif = -1, jifLength = -1, subs = 0
    for (let i = 0; i < count; i++) {
      const entry = at + 2 + i * 12, tag = u16(entry)
      if (tag === 273) strips = values(entry)
      else if (tag === 279) counts = values(entry)
      else if (tag === 513) jif = values(entry)[0] ?? -1
      else if (tag === 514) jifLength = values(entry)[0] ?? -1
      else if (tag === 274 && at === first) {
        const o = values(entry)[0]
        if (o >= 1 && o <= 8) orientation = o
      } else if (tag === 330 && depth < MAX_DEPTH) {
        for (const sub of values(entry)) if (subs++ < MAX_SUBIFDS) queue.push({ at: sub, depth: depth + 1 })
      }
    }
    if (jif > 0 && jifLength > 0) candidates.push({ at: jif, length: jifLength })
    if (strips.length === 1 && counts.length === 1) candidates.push({ at: strips[0], length: counts[0] })
    const next = u32(at + 2 + count * 12)
    if (next > 0) queue.push({ at: next, depth })
  }

  let best: { bytes: Uint8Array; area: number; fits: boolean } | null = null
  for (const c of candidates) {
    if (c.at < 8 || c.length < 4 || c.length > MAX_PREVIEW || c.at + c.length > len) continue
    const slice = b.subarray(c.at, c.at + c.length)
    if (slice[0] !== 0xff || slice[1] !== 0xd8) continue
    const info = jpegInfo(slice)
    if (!info || info.lossless || !info.width || !info.height) continue
    const area = info.width * info.height, fits = largest || (area <= MAX_PIXELS && info.width <= MAX_SIDE && info.height <= MAX_SIDE)
    if (!best || (fits && !best.fits) || (fits === best.fits && area > best.area)) best = { bytes: slice, area, fits }
  }
  if (!best) throw new StillImageError(NO_PREVIEW)
  const out = primary(best.bytes, orientation)
  if (!out) throw new StillImageError(NO_PREVIEW)
  return out === best.bytes ? best.bytes.slice() : out
}

/**
 * Any picture as one still image: a raw as its preview JPEG, a multi-picture JPEG as its primary
 * picture, everything else as it is. HEIC is refused with a clear message. Never throws anything
 * but a StillImageError.
 */
export function stillImage(b: Uint8Array, options: { largest?: boolean } = {}): Uint8Array {
  try {
    if (isTiff(b)) return rawPreview(b, options)
    if (isHeif(b)) throw new StillImageError(HEIF_UNSUPPORTED)
    return jpegPrimary(b)
  } catch (e) {
    if (e instanceof StillImageError) throw e
    throw new StillImageError('Invalid raw file')
  }
}

/** Would stillImage change these bytes? Judged from a prefix (the first 64 KiB is plenty). */
export const needsStill = (prefix: Uint8Array) => isTiff(prefix) || isHeif(prefix) || jpegHasMpf(prefix)
