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
  /** Tar only: where a link points (a link is listed, not unpacked) */
  link?: string
  /** Tar only: permission bits, and owner/group as the archive names them */
  mode?: number
  owner?: string
}

/** What an archive holds. Tar archives (data/tar.ts) come in the same shape, as stored entries. */
export type ZipIndex = { entries: ZipEntry[]; size: number; comment: string; zip64: boolean; format?: 'zip' | 'tar' | 'tgz' }

const EOCD = 0x06054b50
const EOCD64 = 0x06064b50
const EOCD64_LOCATOR = 0x07064b50
const CDH = 0x02014b50
const FULL_LIMIT = 300 * 1024 * 1024

class ZipError extends Error {}

/** Where an archive is read from: an address (with Range requests), or a Blob already here (a file kept in this browser). */
type Source = string | Blob
/** How an address is fetched: fetch itself in the browser; on the server, one that refuses internal addresses. */
type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/** Bytes from..to (inclusive) of the file at `url`, with Range when the server allows. */
async function bytes(url: Source, from: number, to: number, get: Fetcher = fetch): Promise<{ data: Uint8Array; total: number | null; ranged: boolean }> {
  if (typeof url !== 'string') return { data: new Uint8Array(await url.slice(from, to + 1).arrayBuffer()), total: url.size, ranged: true }
  const res = await get(url, { headers: { Range: `bytes=${from}-${to}` } })
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
async function lastBytes(url: Source, n: number, get: Fetcher = fetch): Promise<{ data: Uint8Array; total: number | null; ranged: boolean }> {
  if (typeof url !== 'string') return bytes(url, Math.max(0, url.size - n), url.size - 1)
  const res = await get(url, { headers: { Range: `bytes=-${n}` } })
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

export async function readZip(url: Source, knownSize?: number, get: Fetcher = fetch): Promise<ZipIndex> {
  // The end record is in the last 22 bytes, or up to 64 KB more with an archive comment.
  const tail = 22 + 65535 + 20
  const probe = knownSize !== undefined ? await bytes(url, Math.max(0, knownSize - tail), Math.max(0, knownSize - 1), get) : await lastBytes(url, tail, get)
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
    const rec = whole ? whole.subarray(recordAt, recordAt + 56) : (await bytes(url, recordAt, recordAt + 55, get)).data
    const rv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength)
    if (u32(rv, 0) !== EOCD64) throw new ZipError('The ZIP64 table of contents is damaged')
    count = u64(rv, 32)
    cdSize = u64(rv, 40)
    cdOffset = u64(rv, 48)
  }

  // The table of contents itself: from what is already here, or one more range. Its size comes
  // from the file, so it is checked before it is fetched (100,000 entries fit in far less).
  if (cdSize > 64 * 1024 * 1024 || cdOffset + cdSize > size) throw new ZipError('The table of contents is damaged (it claims to be bigger than it can be)')
  let cd: Uint8Array
  if (whole) cd = whole.subarray(cdOffset, cdOffset + cdSize)
  else if (cdOffset >= tailStart) cd = tailData.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
  else cd = (await bytes(url, cdOffset, cdOffset + cdSize - 1, get)).data

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
  return { entries, size, comment, zip64, format: 'zip' }
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

/**
 * One file's bytes, unpacked: `range` fetches from..to (inclusive) of the archive. Stored and
 * deflated files only, as nearly every ZIP has them; the others (and encrypted ones) throw.
 */
export async function readEntry(e: ZipEntry, range: (from: number, to: number) => Promise<Uint8Array>): Promise<Uint8Array> {
  if (e.encrypted) throw new ZipError('password-protected')
  if (e.method !== 0 && e.method !== 8) throw new ZipError(`unsupported compression method ${METHODS[e.method] ?? e.method}`)
  if (!e.compressed) return new Uint8Array(0)
  // The local header repeats the name and has its own extra field, so its length is read first.
  const head = await range(e.offset, e.offset + 29)
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const start = e.offset + 30 + v.getUint16(26, true) + v.getUint16(28, true)
  const data = await range(start, start + e.compressed - 1)
  if (e.method === 0) return data
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// --- Writing ------------------------------------------------------------------------------------
//
// A ZIP made as it is sent, for downloading several files at once (the Photos app's selection,
// zipped on the server: server/photos.ts). Files are stored as they are (photos and videos do
// not shrink), each one's CRC and size go in a data descriptor after it, and the table of contents
// comes at the end, so nothing is held in memory but the piece passing through. ZIP64 records are
// written where they are needed: a file over 4 GB (when its size is known up front) and anything
// that starts past 4 GB into the archive. Names are UTF-8 (flag 11).

/** One file to write, opened only when its turn comes; null (or a throw) leaves it out. */
export type ZipInput = { name: string; mtime: number; open: () => Promise<{ body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>; size: number | null; /** The name, when it is only known once opened */ name?: string; mtime?: number } | null> }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** CRC-32 of `data`, carrying on from `crc` (0 to start). The server passes node's own, which is faster. */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8)
  return ~c >>> 0
}

const MAX32 = 0xffffffff
const encoder = new TextEncoder()

function dosStamp(ms: number): { date: number; time: number } {
  const d = new Date(ms || Date.now())
  if (d.getFullYear() < 1980) return { date: (1 << 5) | 1, time: 0 }
  return { date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1) }
}

/** Names made unique within the archive: a second "a.jpg" becomes "a (2).jpg". */
function uniqueName(name: string, taken: Set<string>): string {
  const clean = name.replace(/[\\/]+/g, '_').replace(/^\.*$/, '_')
  let out = clean
  const dot = clean.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, '']
  for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${stem} (${n})${ext}`
  taken.add(out.toLowerCase())
  return out
}

/**
 * The archive's bytes, piece by piece, for `files` in order. Files that cannot be opened are
 * left out and listed in a "Not included.txt" at the end. A file whose size was not known up
 * front and turns out to be over 4 GB throws, as the archive would be wrong.
 */
export async function* writeZip(files: Iterable<ZipInput> | AsyncIterable<ZipInput>, opts: { crc?: (data: Uint8Array, crc: number) => number } = {}): AsyncGenerator<Uint8Array> {
  const crcOf = opts.crc ?? crc32
  const taken = new Set<string>()
  const central: Uint8Array[] = []
  const skipped: string[] = []
  let offset = 0
  let count = 0

  async function* entry(name: string, mtime: number, body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, known: number | null): AsyncGenerator<Uint8Array> {
    const raw = encoder.encode(name)
    const { date, time } = dosStamp(mtime)
    const big = known !== null && known >= MAX32
    // The local header: the CRC and sizes follow the data (flag 3); a big file says so with a ZIP64 extra.
    const local = new DataView(new ArrayBuffer(30 + raw.length + (big ? 20 : 0)))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, big ? 45 : 20, true)
    local.setUint16(6, 0x0808, true)
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(18, big ? MAX32 : 0, true)
    local.setUint32(22, big ? MAX32 : 0, true)
    local.setUint16(26, raw.length, true)
    local.setUint16(28, big ? 20 : 0, true)
    new Uint8Array(local.buffer).set(raw, 30)
    if (big) {
      local.setUint16(30 + raw.length, 1, true)
      local.setUint16(32 + raw.length, 16, true)
    }
    const start = offset
    yield new Uint8Array(local.buffer)
    offset += local.byteLength

    let crc = 0
    let size = 0
    for await (const piece of body) {
      if (!piece.length) continue
      crc = crcOf(piece, crc)
      size += piece.length
      if (!big && size >= MAX32) throw new Error(`${name} is over 4 GB`)
      yield piece
    }
    offset += size

    // The data descriptor: 8-byte sizes after a ZIP64 local header, 4-byte ones otherwise.
    const desc = new DataView(new ArrayBuffer(big ? 24 : 16))
    desc.setUint32(0, 0x08074b50, true)
    desc.setUint32(4, crc, true)
    if (big) {
      desc.setBigUint64(8, BigInt(size), true)
      desc.setBigUint64(16, BigInt(size), true)
    } else {
      desc.setUint32(8, size, true)
      desc.setUint32(12, size, true)
    }
    yield new Uint8Array(desc.buffer)
    offset += desc.byteLength

    // Its entry in the table of contents, with a ZIP64 extra for whatever does not fit in 32 bits.
    const extra: bigint[] = []
    if (size >= MAX32) extra.push(BigInt(size), BigInt(size))
    if (start >= MAX32) extra.push(BigInt(start))
    const cd = new DataView(new ArrayBuffer(46 + raw.length + (extra.length ? 4 + extra.length * 8 : 0)))
    cd.setUint32(0, 0x02014b50, true)
    cd.setUint16(4, (3 << 8) | 45, true)
    cd.setUint16(6, extra.length || big ? 45 : 20, true)
    cd.setUint16(8, 0x0808, true)
    cd.setUint16(12, time, true)
    cd.setUint16(14, date, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, size >= MAX32 ? MAX32 : size, true)
    cd.setUint32(24, size >= MAX32 ? MAX32 : size, true)
    cd.setUint16(28, raw.length, true)
    cd.setUint16(30, extra.length ? 4 + extra.length * 8 : 0, true)
    cd.setUint32(38, (0o100644 << 16) >>> 0, true)
    cd.setUint32(42, start >= MAX32 ? MAX32 : start, true)
    new Uint8Array(cd.buffer).set(raw, 46)
    if (extra.length) {
      let at = 46 + raw.length
      cd.setUint16(at, 1, true)
      cd.setUint16(at + 2, extra.length * 8, true)
      at += 4
      for (const v of extra) {
        cd.setBigUint64(at, v, true)
        at += 8
      }
    }
    central.push(new Uint8Array(cd.buffer))
    count++
  }

  for await (const f of files) {
    let opened: Awaited<ReturnType<ZipInput['open']>> = null
    let why = 'it could not be read'
    try {
      opened = await f.open()
    } catch (e) {
      why = (e as Error).message || why
    }
    if (!opened) {
      skipped.push(`${f.name}: ${why}`)
      continue
    }
    yield* entry(uniqueName(opened.name ?? f.name, taken), opened.mtime ?? f.mtime, opened.body, opened.size)
  }
  if (skipped.length) {
    const note = encoder.encode(`These were not included:\n\n${skipped.join('\n')}\n`)
    yield* entry(uniqueName('Not included.txt', taken), Date.now(), [note], note.length)
  }

  // The table of contents, then its end record (with ZIP64's in front when anything is past 4 GB).
  const cdStart = offset
  let cdSize = 0
  for (const c of central) {
    yield c
    cdSize += c.length
  }
  offset += cdSize
  if (cdStart >= MAX32 || count >= 0xffff) {
    const rec = new DataView(new ArrayBuffer(56 + 20))
    rec.setUint32(0, 0x06064b50, true)
    rec.setBigUint64(4, 44n, true)
    rec.setUint16(12, 45, true)
    rec.setUint16(14, 45, true)
    rec.setBigUint64(24, BigInt(count), true)
    rec.setBigUint64(32, BigInt(count), true)
    rec.setBigUint64(40, BigInt(cdSize), true)
    rec.setBigUint64(48, BigInt(cdStart), true)
    rec.setUint32(56, 0x07064b50, true)
    rec.setBigUint64(64, BigInt(cdStart + cdSize), true)
    rec.setUint32(72, 1, true)
    yield new Uint8Array(rec.buffer)
  }
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, Math.min(count, 0xffff), true)
  end.setUint16(10, Math.min(count, 0xffff), true)
  end.setUint32(12, cdSize >= MAX32 ? MAX32 : cdSize, true)
  end.setUint32(16, cdStart >= MAX32 ? MAX32 : cdStart, true)
  yield new Uint8Array(end.buffer)
}
