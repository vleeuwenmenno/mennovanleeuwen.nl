// What the Photos app needs from a picture or a video, read from its first bytes (server/photos.ts
// fetches about 128 KB with a byte range, never the whole file): when it was taken, its size, its
// orientation, the camera and lens, the exposure and where it was taken. No library: the EXIF
// block is a small TIFF file, and the containers around it are simple to walk.
//
// Supported:
//   - JPEG: the APP1 "Exif" segment, and the frame header (SOFn) for the size.
//   - TIFF (.tif, and the EXIF block everywhere else): IFD0, the Exif and GPS IFDs, and IFD1's
//     embedded preview (the small JPEG cameras put there).
//   - PNG: the eXIf chunk and IHDR. GIF: the size only.
//   - WebP: the EXIF chunk (it comes after the picture, so usually from a second read) and the size
//     from VP8X, VP8 or VP8L.
//   - HEIC, HEIF and AVIF: the meta box's Exif item (found through iinf and iloc; often past the
//     first read, then a second read fetches just that item), and the primary item's size (ispe)
//     (ispe, or clap when it was padded) and rotation (irot). Mirroring (imir) is not read.
//   - MP4, MOV, M4V and 3GP: mvhd's creation time (UTC) and the first video track's size from
//     tkhd. Phones often put the moov box at the end; the walk then knows exactly where it starts
//     and asks for a second read there.
//
// Dates in EXIF have no time zone: DateTimeOriginal is the camera's wall clock. It is kept as such
// (milliseconds as if it were UTC), so a photo taken at 18:32 in Tokyo shows 18:32 wherever it is
// looked at. A video's creation time is a real instant (UTC); the app turns it into the viewer's
// local time.

export type Meta = {
  /** When it was taken: the camera's wall clock as if UTC (`takenSrc` 'exif'), or a UTC instant ('video') */
  taken: number | null
  takenSrc: 'exif' | 'video' | null
  /** OffsetTimeOriginal ("+02:00"), when the camera wrote one */
  offset: string | null
  width: number | null
  height: number | null
  /** EXIF orientation, 1 to 8 */
  orientation: number | null
  make: string | null
  model: string | null
  lens: string | null
  /** Seconds */
  exposure: number | null
  fnumber: number | null
  iso: number | null
  /** Millimetres */
  focal: number | null
  focal35: number | null
  lat: number | null
  lon: number | null
  /** Metres above sea level */
  alt: number | null
  /** The small JPEG preview embedded in the EXIF block, when it was in the bytes read */
  thumb: Buffer | null
}

/** A second read the walk asks for: `length` bytes from `start`, parsed as `as`. */
export type More = { start: number; length: number; as: 'boxes' | 'riff' | 'tiff-item' }

export const empty = (): Meta => ({
  taken: null,
  takenSrc: null,
  offset: null,
  width: null,
  height: null,
  orientation: null,
  make: null,
  model: null,
  lens: null,
  exposure: null,
  fnumber: null,
  iso: null,
  focal: null,
  focal35: null,
  lat: null,
  lon: null,
  alt: null,
  thumb: null,
})

/** How much the first read takes: enough for any JPEG's EXIF segment (at most 64 KB) and its frame header. */
export const HEAD = 128 * 1024

/** The kind of file by its name: what the index keeps, and how its first bytes are read. */
export function photoKind(name: string): 'image' | 'video' | null {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (['jpg', 'jpeg', 'jpe', 'png', 'webp', 'heic', 'heif', 'avif', 'gif', 'tif', 'tiff'].includes(ext)) return 'image'
  if (['mp4', 'm4v', 'mov', '3gp', 'webm', 'mkv'].includes(ext)) return 'video'
  return null
}

/**
 * Reads what it can from a file's first bytes. Answers the metadata, and a second read to make
 * when what is missing is further on in the file (`size` is the whole file's).
 */
export function readMeta(buf: Buffer, size: number): { meta: Meta; more: More | null } {
  const meta = empty()
  try {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return jpeg(buf, meta), { meta, more: null }
    if (isTiff(buf, 0)) return tiff(buf, 0, meta, true), { meta, more: null }
    if (buf.length >= 24 && buf.toString('latin1', 1, 4) === 'PNG') return png(buf, meta), { meta, more: null }
    if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF') {
      meta.width = buf.readUInt16LE(6)
      meta.height = buf.readUInt16LE(8)
      return { meta, more: null }
    }
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { meta, more: riff(buf, 12, meta, size) }
    if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') return { meta, more: boxes(buf, 0, buf.length, 0, meta, size) }
  } catch {
    /* a broken or cut-off file: what was read so far stays */
  }
  return { meta, more: null }
}

/** Carries on with a second read (`more`), into the same metadata. */
export function readMore(buf: Buffer, more: More, meta: Meta, size: number): More | null {
  try {
    if (more.as === 'riff') return riff(buf, 0, meta, size, more.start)
    if (more.as === 'boxes') return boxes(buf, 0, buf.length, more.start, meta, size)
    // An Exif item: a 4-byte offset to the TIFF header, then (usually) "Exif\0\0", then TIFF.
    const skip = buf.length >= 4 ? buf.readUInt32BE(0) : 0
    const at = 4 + skip
    if (isTiff(buf, at)) tiff(buf, at, meta)
    else if (buf.toString('latin1', at, at + 6) === 'Exif\0\0' && isTiff(buf, at + 6)) tiff(buf, at + 6, meta)
    else {
      const found = buf.indexOf('Exif\0\0', 0, 'latin1')
      if (found >= 0 && isTiff(buf, found + 6)) tiff(buf, found + 6, meta)
    }
  } catch {
    /* as above */
  }
  return null
}

// --- JPEG -----------------------------------------------------------------------------------------

function jpeg(buf: Buffer, meta: Meta) {
  let at = 2
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) return
    const marker = buf[at + 1]
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      at++
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return // end of image, start of scan: no more headers
    const len = buf.readUInt16BE(at + 2)
    const body = at + 4
    if (marker === 0xe1 && buf.toString('latin1', body, body + 6) === 'Exif\0\0' && meta.make === null && meta.taken === null) tiff(buf.subarray(0, Math.min(buf.length, at + 2 + len)), body + 6, meta)
    // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC): precision, height, width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && body + 5 <= buf.length) {
      meta.height = buf.readUInt16BE(body + 1)
      meta.width = buf.readUInt16BE(body + 3)
      return
    }
    at += 2 + len
  }
}

// --- TIFF and EXIF ----------------------------------------------------------------------------------

const isTiff = (buf: Buffer, at: number) => at + 8 <= buf.length && ((buf[at] === 0x49 && buf[at + 1] === 0x49 && buf[at + 2] === 0x2a && buf[at + 3] === 0) || (buf[at] === 0x4d && buf[at + 1] === 0x4d && buf[at + 2] === 0 && buf[at + 3] === 0x2a))

/** The sizes of TIFF's field types, by type number. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }

type Field = { type: number; count: number; at: number }

/**
 * A TIFF block starting at `base` (offsets inside it count from there). `whole`: the file itself is
 * a TIFF, so IFD0's own size is the picture's.
 */
function tiff(buf: Buffer, base: number, meta: Meta, whole = false) {
  const le = buf[base] === 0x49
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const i32 = (o: number) => (le ? buf.readInt32LE(o) : buf.readInt32BE(o))

  /** The fields of the IFD at `off` (from base), and the offset of the next IFD. */
  const ifd = (off: number): { fields: Map<number, Field>; next: number } => {
    const fields = new Map<number, Field>()
    const at = base + off
    if (off < 8 || at + 2 > buf.length) return { fields, next: 0 }
    const n = Math.min(u16(at), 512)
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12
      if (e + 12 > buf.length) break
      const type = u16(e + 2)
      const count = u32(e + 4)
      const bytes = (TYPE_SIZE[type] ?? 1) * count
      const valueAt = bytes <= 4 ? e + 8 : base + u32(e + 8)
      if (valueAt + Math.min(bytes, 1) > buf.length) continue
      fields.set(u16(e), { type, count, at: valueAt })
    }
    const nextAt = at + 2 + n * 12
    return { fields, next: nextAt + 4 <= buf.length ? u32(nextAt) : 0 }
  }

  const num = (f: Field | undefined, i = 0): number | null => {
    if (!f || i >= f.count) return null
    const size = TYPE_SIZE[f.type] ?? 1
    const o = f.at + i * size
    if (o + size > buf.length) return null
    switch (f.type) {
      case 1:
      case 7:
        return buf[o]
      case 3:
        return u16(o)
      case 4:
        return u32(o)
      case 9:
        return i32(o)
      case 5: {
        const d = u32(o + 4)
        return d ? u32(o) / d : null
      }
      case 10: {
        const d = i32(o + 4)
        return d ? i32(o) / d : null
      }
      default:
        return null
    }
  }
  const text = (f: Field | undefined): string | null => {
    if (!f || f.type !== 2) return null
    const s = buf
      .toString('utf8', f.at, Math.min(buf.length, f.at + f.count))
      .replace(/\0[\s\S]*$/, '')
      .trim()
    return s || null
  }

  const ifd0 = ifd(u32(base + 4))
  const f0 = ifd0.fields
  meta.make ??= text(f0.get(0x010f))
  meta.model ??= text(f0.get(0x0110))
  const orientation = num(f0.get(0x0112))
  if (orientation && orientation >= 1 && orientation <= 8) meta.orientation ??= orientation
  if (whole) {
    meta.width ??= num(f0.get(0x0100))
    meta.height ??= num(f0.get(0x0101))
  }
  const modified = date(text(f0.get(0x0132)))

  const exifAt = num(f0.get(0x8769))
  if (exifAt) {
    const f = ifd(exifAt).fields
    const original = date(text(f.get(0x9003)), text(f.get(0x9291))) ?? date(text(f.get(0x9004)), text(f.get(0x9292)))
    if (original !== null && meta.taken === null) {
      meta.taken = original
      meta.takenSrc = 'exif'
      meta.offset = text(f.get(0x9011)) ?? text(f.get(0x9010))
    }
    meta.exposure ??= num(f.get(0x829a))
    meta.fnumber ??= num(f.get(0x829d))
    meta.iso ??= num(f.get(0x8827))
    meta.focal ??= num(f.get(0x920a))
    meta.focal35 ??= num(f.get(0xa405)) || null
    meta.lens ??= text(f.get(0xa434))
    meta.width ??= num(f.get(0xa002))
    meta.height ??= num(f.get(0xa003))
  }
  if (meta.taken === null && modified !== null) {
    meta.taken = modified
    meta.takenSrc = 'exif'
  }

  const gpsAt = num(f0.get(0x8825))
  if (gpsAt) {
    const f = ifd(gpsAt).fields
    const dms = (field: Field | undefined) => {
      const d = num(field, 0)
      const m = num(field, 1) ?? 0
      const s = num(field, 2) ?? 0
      return d === null ? null : d + m / 60 + s / 3600
    }
    const lat = dms(f.get(2))
    const lon = dms(f.get(4))
    // 0,0 is where cameras without a fix put their photos.
    if (lat !== null && lon !== null && (lat !== 0 || lon !== 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      meta.lat = round(text(f.get(1)) === 'S' ? -lat : lat, 6)
      meta.lon = round(text(f.get(3)) === 'W' ? -lon : lon, 6)
      const alt = num(f.get(6))
      if (alt !== null) meta.alt = round(num(f.get(5)) === 1 ? -alt : alt, 1)
    }
  }

  // IFD1: the embedded preview.
  if (ifd0.next && !meta.thumb) {
    const f = ifd(ifd0.next).fields
    const off = num(f.get(0x0201))
    const len = num(f.get(0x0202))
    if (off && len && len < 128 * 1024 && base + off + len <= buf.length && buf[base + off] === 0xff && buf[base + off + 1] === 0xd8) meta.thumb = Buffer.from(buf.subarray(base + off, base + off + len))
  }
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places

/** "2023:07:14 18:32:05" (and sub-seconds) as milliseconds, as if UTC; null for blanks and nonsense. */
export function date(s: string | null, subsec?: string | null): number | null {
  const m = s && /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s)
  if (!m) return null
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number)
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return null
  const ms = subsec && /^\d+$/.test(subsec.trim()) ? Math.round(Number(`0.${subsec.trim()}`) * 1000) : 0
  return Date.UTC(y, mo - 1, d, h, mi, se, ms)
}

// --- PNG and WebP -------------------------------------------------------------------------------------

function png(buf: Buffer, meta: Meta) {
  let at = 8
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    const body = at + 8
    if (type === 'IHDR' && body + 8 <= buf.length) {
      meta.width = buf.readUInt32BE(body)
      meta.height = buf.readUInt32BE(body + 4)
    }
    if (type === 'eXIf' && isTiff(buf, body)) tiff(buf.subarray(0, Math.min(buf.length, body + len)), body, meta)
    if (type === 'IEND') return
    at = body + len + 4
  }
}

/**
 * RIFF chunks from `at` (a WebP's, after its 12-byte header). `origin`: where `buf` starts in the
 * file, for a second read. Answers that second read when the EXIF chunk lies past the bytes read.
 */
function riff(buf: Buffer, at: number, meta: Meta, size: number, origin = 0): More | null {
  let hasExif = false
  while (at + 8 <= buf.length) {
    const type = buf.toString('latin1', at, at + 4)
    const len = buf.readUInt32LE(at + 4)
    const body = at + 8
    if (type === 'VP8X' && body + 10 <= buf.length) {
      hasExif = (buf[body] & 0x08) !== 0
      meta.width ??= 1 + buf.readUIntLE(body + 4, 3)
      meta.height ??= 1 + buf.readUIntLE(body + 7, 3)
    } else if (type === 'VP8 ' && body + 10 <= buf.length) {
      meta.width ??= buf.readUInt16LE(body + 6) & 0x3fff
      meta.height ??= buf.readUInt16LE(body + 8) & 0x3fff
    } else if (type === 'VP8L' && body + 5 <= buf.length) {
      const bits = buf.readUInt32LE(body + 1)
      meta.width ??= (bits & 0x3fff) + 1
      meta.height ??= ((bits >> 14) & 0x3fff) + 1
    } else if (type === 'EXIF') {
      if (body + len > buf.length) return origin + body + len <= size ? { start: origin + at, length: 8 + len, as: 'riff' } : null
      const start = buf.toString('latin1', body, body + 6) === 'Exif\0\0' ? body + 6 : body
      if (isTiff(buf, start)) tiff(buf.subarray(0, body + len), start, meta)
      return null
    }
    at = body + len + (len & 1)
  }
  // The chunks went on past what was read: ask for the next one, if an EXIF chunk is coming.
  const next = origin + at
  return (hasExif || origin > 0) && next < size && at > 0 ? { start: next, length: Math.min(64 * 1024, size - next), as: 'riff' } : null
}

// --- ISO boxes: HEIC, AVIF, MP4, MOV --------------------------------------------------------------------

/**
 * The boxes from `at` to `end` in `buf` (which starts at `origin` in the file). Walks into the
 * ones that matter; answers a second read for what lies past the bytes read.
 */
function boxes(buf: Buffer, at: number, end: number, origin: number, meta: Meta, size: number, depth = 0): More | null {
  let sawMoov = false
  while (at + 8 <= end) {
    let len = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    let header = 8
    if (len === 1) {
      if (at + 16 > buf.length) return null
      len = Number(buf.readBigUInt64BE(at + 8))
      header = 16
    } else if (len === 0) len = (depth ? end : size - origin) - at
    if (len < header) return null
    const body = at + header
    const stop = Math.min(end, at + len, buf.length)
    if (type === 'moov' || type === 'trak' || type === 'mdia') {
      if (type === 'moov') sawMoov = true
      boxes(buf, body, stop, origin, meta, size, depth + 1)
    } else if (type === 'mvhd' && body + 20 <= buf.length) {
      // Version 1 has 64-bit times. Seconds since 1904-01-01 UTC.
      const secs = buf[body] === 1 ? Number(buf.readBigUInt64BE(body + 4)) : buf.readUInt32BE(body + 4)
      const ms = (secs - 2082844800) * 1000
      // 0 (and the odd camera that writes 1904 or 1970) means "not set".
      if (secs > 2082844800 + 86400 * 365 && meta.taken === null) {
        meta.taken = ms
        meta.takenSrc = 'video'
      }
    } else if (type === 'tkhd' && meta.width === null) {
      const off = body + (buf[body] === 1 ? 88 : 76)
      if (off + 8 <= buf.length) {
        const w = buf.readUInt32BE(off) / 65536
        const h = buf.readUInt32BE(off + 4) / 65536
        if (w > 0 && h > 0) {
          meta.width = Math.round(w)
          meta.height = Math.round(h)
        }
      }
    } else if (type === 'meta' && depth === 0) {
      return heifMeta(buf, body + 4, stop, origin, meta, size)
    } else if (type === 'mdat' && depth === 0 && !sawMoov) {
      // The movie's header comes after its media data: read from there (unless it was read already).
      const next = origin + at + len
      if (at + len + 8 <= buf.length) {
        at += len
        continue
      }
      if (next < size) return { start: next, length: Math.min(size - next, HEAD), as: 'boxes' }
      return null
    }
    at += len
  }
  return null
}

/**
 * A HEIF meta box's contents: the Exif item (by iinf, located by iloc), and the primary item's
 * size and rotation (pitm, then its properties in iprp: ispe and irot).
 */
function heifMeta(buf: Buffer, at: number, end: number, origin: number, meta: Meta, size: number): More | null {
  let exifId: number | null = null
  let primary: number | null = null
  const locations = new Map<number, { offset: number; length: number }>()
  /** ipco's properties in order (ipma counts them from 1), and which belong to which item. */
  const props: { type: string; at: number }[] = []
  const assoc = new Map<number, number[]>()
  let p = at
  while (p + 8 <= end) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    if (len < 8) break
    const body = p + 8
    const stop = Math.min(end, p + len)
    if (type === 'iinf') {
      const version = buf[body]
      let q = body + 4 + (version === 0 ? 2 : 4)
      while (q + 8 <= stop) {
        const l = buf.readUInt32BE(q)
        if (l < 8) break
        if (buf.toString('latin1', q + 4, q + 8) === 'infe') {
          const v = buf[q + 8]
          if (v >= 2) {
            const id = v === 2 ? buf.readUInt16BE(q + 12) : buf.readUInt32BE(q + 12)
            const typeAt = q + 12 + (v === 2 ? 2 : 4) + 2
            if (buf.toString('latin1', typeAt, typeAt + 4) === 'Exif') exifId = id
          }
        }
        q += l
      }
    } else if (type === 'iloc') {
      const version = buf[body]
      let q = body + 4
      const offsetSize = buf[q] >> 4
      const lengthSize = buf[q] & 15
      const baseSize = buf[q + 1] >> 4
      const indexSize = version === 1 || version === 2 ? buf[q + 1] & 15 : 0
      q += 2
      const read = (n: number) => {
        const v = n === 0 ? 0 : n === 4 ? buf.readUInt32BE(q) : n === 8 ? Number(buf.readBigUInt64BE(q)) : n === 2 ? buf.readUInt16BE(q) : 0
        q += n
        return v
      }
      const count = version < 2 ? read(2) : read(4)
      for (let i = 0; i < count && q < stop; i++) {
        const id = version < 2 ? read(2) : read(4)
        if (version === 1 || version === 2) read(2) // construction method
        read(2) // data reference index
        const base = read(baseSize)
        const extents = read(2)
        for (let e = 0; e < extents; e++) {
          if (indexSize) read(indexSize)
          const offset = read(offsetSize)
          const length = read(lengthSize)
          if (e === 0) locations.set(id, { offset: base + offset, length })
        }
      }
    } else if (type === 'pitm') {
      primary = buf[body] === 0 ? buf.readUInt16BE(body + 4) : buf.readUInt32BE(body + 4)
    } else if (type === 'iprp') {
      let q = body
      while (q + 8 <= stop) {
        const l = buf.readUInt32BE(q)
        const t = buf.toString('latin1', q + 4, q + 8)
        if (l < 8) break
        if (t === 'ipco') for (let r = q + 8; r + 8 <= Math.min(stop, q + l); ) {
          const pl = buf.readUInt32BE(r)
          if (pl < 8) break
          props.push({ type: buf.toString('latin1', r + 4, r + 8), at: r + 8 })
          r += pl
        }
        if (t === 'ipma') {
          const version = buf[q + 8]
          const wide = (buf[q + 11] & 1) === 1
          let r = q + 12
          const count = buf.readUInt32BE(r)
          r += 4
          for (let i = 0; i < count && r < stop; i++) {
            const id = version < 1 ? buf.readUInt16BE(r) : buf.readUInt32BE(r)
            r += version < 1 ? 2 : 4
            const n = buf[r++]
            const list: number[] = []
            for (let k = 0; k < n; k++) {
              list.push(wide ? buf.readUInt16BE(r) & 0x7fff : buf[r] & 0x7f)
              r += wide ? 2 : 1
            }
            assoc.set(id, list)
          }
        }
        q += l
      }
    }
    p += len
  }
  for (const index of primary === null ? [] : (assoc.get(primary) ?? [])) {
    const prop = props[index - 1]
    if (prop?.type === 'ispe' && prop.at + 12 <= buf.length && !meta.width) {
      meta.width = buf.readUInt32BE(prop.at + 4)
      meta.height = buf.readUInt32BE(prop.at + 8)
    }
    // The clean aperture: the picture's real size, when the coded one was padded (HEVC codes in whole blocks).
    if (prop?.type === 'clap' && prop.at + 16 <= buf.length) {
      const w = buf.readUInt32BE(prop.at) / (buf.readUInt32BE(prop.at + 4) || 1)
      const h = buf.readUInt32BE(prop.at + 8) / (buf.readUInt32BE(prop.at + 12) || 1)
      if (w > 0 && h > 0) {
        meta.width = Math.round(w)
        meta.height = Math.round(h)
      }
    }
    // Rotated counter-clockwise by 90° steps, as EXIF orientation (which irot overrides).
    if (prop?.type === 'irot' && prop.at < buf.length) meta.orientation = [1, 8, 3, 6][buf[prop.at] & 3]
  }
  const fromIrot = meta.orientation
  const loc = exifId === null ? null : locations.get(exifId)
  if (!loc || !loc.length || loc.length > 1024 * 1024) return null
  // The item is in the bytes read already, or a second read fetches just it.
  const local = loc.offset - origin
  if (local >= 0 && local + loc.length <= buf.length) {
    readMore(buf.subarray(local, local + loc.length), { start: loc.offset, length: loc.length, as: 'tiff-item' }, meta, size)
    if (fromIrot) meta.orientation = fromIrot
    return null
  }
  return loc.offset + loc.length <= size ? { start: loc.offset, length: loc.length, as: 'tiff-item' } : null
}
