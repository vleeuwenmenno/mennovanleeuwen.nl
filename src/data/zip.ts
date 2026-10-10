// What is in a ZIP, without unpacking it: its table of contents (the central directory at the
// end of the file) is all that is read. From a server that answers Range requests (Seafile's file
// server does) only the last bytes are fetched, so a big archive opens at once; otherwise the
// whole file is fetched (up to a limit). ZIP64 (over 4 GB, or over 65535 entries) is read too.
// The server reads it too, to unpack (server/unzip.ts), so it stays free of browser-only APIs.

export type ZipEntry = {
  /** The full path inside the archive, without a trailing slash for folders */
  path: string
  dir: boolean
  size: number
  compressed: number
  mtime: number
  /** 0 stored, 8 deflated, other numbers other methods */
  method: number
  encrypted: boolean
  comment: string
  /** Where its local header starts in the archive (its data follows that header) */
  offset: number
  /** CRC-32 of the unpacked data, to check an unpacked file against */
  crc: number
}

export type ZipIndex = { entries: ZipEntry[]; size: number; comment: string; zip64: boolean }

const EOCD = 0x06054b50
const EOCD64 = 0x06064b50
const EOCD64_LOCATOR = 0x07064b50
const CDH = 0x02014b50
const FULL_LIMIT = 300 * 1024 * 1024

class ZipError extends Error {}

/** Bytes from..to (inclusive) of the file at `url`, with Range when the server allows. */
async function bytes(url: string, from: number, to: number): Promise<{ data: Uint8Array; total: number | null; ranged: boolean }> {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } })
  if (!res.ok) throw new ZipError(`The file server answered ${res.status}`)
  if (res.status === 206) {
    const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1])
    return { data: new Uint8Array(await res.arrayBuffer()), total: isFinite(total) ? total : null, ranged: true }
  }
  // No ranges: the whole file came back.
  const length = Number(res.headers.get('content-length'))
  if (length > FULL_LIMIT) throw new ZipError('The server sends this archive only whole, and it is too big to read here')
  const all = new Uint8Array(await res.arrayBuffer())
  return { data: all, total: all.length, ranged: false }
}

/** The last `n` bytes, when the size is not known (a suffix range). */
async function lastBytes(url: string, n: number): Promise<{ data: Uint8Array; total: number | null; ranged: boolean }> {
  const res = await fetch(url, { headers: { Range: `bytes=-${n}` } })
  if (!res.ok) throw new ZipError(`The file server answered ${res.status}`)
  const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1])
  const data = new Uint8Array(await res.arrayBuffer())
  return res.status === 206 ? { data, total: isFinite(total) ? total : null, ranged: true } : { data, total: data.length, ranged: false }
}

const u16 = (d: DataView, o: number) => d.getUint16(o, true)
const u32 = (d: DataView, o: number) => d.getUint32(o, true)
const u64 = (d: DataView, o: number) => Number(d.getBigUint64(o, true))

/** DOS date and time, as ZIPs keep them (local time, two-second steps). */
function dosTime(date: number, time: number) {
  if (!date) return 0
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime()
}

const utf8 = new TextDecoder('utf-8')
// Names without the UTF-8 flag are in the old DOS code page; plain ASCII reads the same either way.
const cp437 = (() => {
  try {
    return new TextDecoder('ibm866')
  } catch {
    return utf8
  }
})()

export async function readZip(url: string, knownSize?: number): Promise<ZipIndex> {
  // The end record is in the last 22 bytes, or up to 64 KB more with an archive comment.
  const tail = 22 + 65535 + 20
  const probe = knownSize !== undefined ? await bytes(url, Math.max(0, knownSize - tail), Math.max(0, knownSize - 1)) : await lastBytes(url, tail)
  const whole = probe.ranged ? null : probe.data
  const tailData = whole ? whole.subarray(Math.max(0, whole.length - tail)) : probe.data
  const view = new DataView(tailData.buffer, tailData.byteOffset, tailData.byteLength)

  let at = -1
  for (let i = tailData.length - 22; i >= 0; i--) {
    if (u32(view, i) === EOCD) {
      at = i
      break
    }
  }
  if (at < 0) throw new ZipError('This is not a ZIP archive (no table of contents at its end)')

  // The archive's size: known from the listing, or from the file server; servers often keep
  // Content-Range from the browser (CORS), and then the end record says where it sits.
  const size = whole ? whole.length : (knownSize ?? probe.total ?? u32(view, at + 16) + u32(view, at + 12) + (tailData.length - at))
  const tailStart = size - tailData.length
  let count = u16(view, at + 10)
  let cdSize = u32(view, at + 12)
  let cdOffset = u32(view, at + 16)
  const comment = utf8.decode(tailData.subarray(at + 22, at + 22 + u16(view, at + 20)))
  let zip64 = false

  // ZIP64: the real numbers are in a record before the end record.
  if (at >= 20 && u32(view, at - 20) === EOCD64_LOCATOR) {
    zip64 = true
    const recordAt = u64(view, at - 20 + 8)
    const rec = whole ? whole.subarray(recordAt, recordAt + 56) : (await bytes(url, recordAt, recordAt + 55)).data
    const rv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength)
    if (u32(rv, 0) !== EOCD64) throw new ZipError('The ZIP64 table of contents is damaged')
    count = u64(rv, 32)
    cdSize = u64(rv, 40)
    cdOffset = u64(rv, 48)
  }

  // The table of contents itself: from what is already here, or one more range.
  let cd: Uint8Array
  if (whole) cd = whole.subarray(cdOffset, cdOffset + cdSize)
  else if (cdOffset >= tailStart) cd = tailData.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
  else cd = (await bytes(url, cdOffset, cdOffset + cdSize - 1)).data

  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
  const entries: ZipEntry[] = []
  let o = 0
  for (let n = 0; n < count && o + 46 <= cd.length; n++) {
    if (u32(cv, o) !== CDH) throw new ZipError('The table of contents is damaged')
    const flags = u16(cv, o + 8)
    const method = u16(cv, o + 10)
    const time = u16(cv, o + 12)
    const date = u16(cv, o + 14)
    const crc = u32(cv, o + 16)
    let compressed = u32(cv, o + 20)
    let size = u32(cv, o + 24)
    let offset = u32(cv, o + 42)
    const nameLen = u16(cv, o + 28)
    const extraLen = u16(cv, o + 30)
    const commentLen = u16(cv, o + 32)
    const external = u32(cv, o + 38)
    const raw = cd.subarray(o + 46, o + 46 + nameLen)
    const name = (flags & 0x800 ? utf8 : cp437).decode(raw)
    // ZIP64 sizes (and the offset) live in the extra field when the plain ones are all ones.
    if (compressed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      let e = o + 46 + nameLen
      const end = e + extraLen
      while (e + 4 <= end) {
        const id = u16(cv, e)
        const len = u16(cv, e + 2)
        if (id === 1) {
          let p = e + 4
          if (size === 0xffffffff) (size = u64(cv, p)), (p += 8)
          if (compressed === 0xffffffff) (compressed = u64(cv, p)), (p += 8)
          if (offset === 0xffffffff) offset = u64(cv, p)
          break
        }
        e += 4 + len
      }
    }
    const dir = name.endsWith('/') || ((external >>> 16) & 0o170000) === 0o040000
    entries.push({
      path: name.replace(/\/+$/, ''),
      dir,
      size,
      compressed,
      mtime: dosTime(date, time),
      method,
      encrypted: !!(flags & 1),
      comment: commentLen ? utf8.decode(cd.subarray(o + 46 + nameLen + extraLen, o + 46 + nameLen + extraLen + commentLen)) : '',
      offset,
      crc,
    })
    o += 46 + nameLen + extraLen + commentLen
  }
  return { entries, size, comment, zip64 }
}

/** What is directly in a folder of the archive ('' is the top), folders made up from paths too. */
export function listFolder(index: ZipIndex, folder: string): { folders: { name: string; count: number; size: number }[]; files: ZipEntry[] } {
  const prefix = folder ? `${folder}/` : ''
  const folders = new Map<string, { count: number; size: number }>()
  const files: ZipEntry[] = []
  for (const e of index.entries) {
    if (!e.path.startsWith(prefix) || e.path === folder) continue
    const rest = e.path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash >= 0 || e.dir) {
      const name = slash >= 0 ? rest.slice(0, slash) : rest
      const f = folders.get(name) ?? { count: 0, size: 0 }
      if (!e.dir) {
        f.count++
        f.size += e.size
      }
      folders.set(name, f)
    } else files.push(e)
  }
  return { folders: [...folders].map(([name, f]) => ({ name, ...f })), files }
}

export const METHODS: Record<number, string> = { 0: 'Stored', 8: 'Deflated', 9: 'Deflate64', 12: 'BZIP2', 14: 'LZMA', 93: 'Zstandard', 95: 'XZ', 99: 'AES' }
