import type { ZipEntry, ZipIndex } from './zip.ts'

// Tar archives, plain or gzipped. Tar has no table of contents: each file's data follows a 512-byte
// header saying what it is and how long. A plain one is read with ranges, header to header,
// skipping the data in between (readTar), so a big one costs a few reads per file, never a full
// download. A gzipped one can only be read as one stream from the start (scanTar), which the
// server does. Ustar, GNU long names and pax headers are understood. Shared with the server, so
// it stays free of browser-only APIs.

const BLOCK = 512
/** Long names and pax headers are small; anything bigger is not one. */
const META_MAX = 1024 * 1024

export class TarError extends Error {}

type Header = { name: string; size: number; mtime: number; type: string; link: string; mode: number; owner: string }
/** What pax headers and GNU long names say about the header after them */
type Extra = { path?: string; linkpath?: string; size?: number; mtime?: number }

const utf8 = new TextDecoder('utf-8')

/** A NUL-terminated string field. */
function str(b: Uint8Array, from: number, len: number) {
  const s = b.subarray(from, from + len)
  const end = s.indexOf(0)
  return utf8.decode(end < 0 ? s : s.subarray(0, end))
}

/** A number field: octal text, or GNU's base-256 (high bit set) for what does not fit. */
function num(b: Uint8Array, from: number, len: number): number {
  if (b[from] & 0x80) {
    let v = b[from] & 0x7f
    for (let i = 1; i < len; i++) v = v * 256 + b[from + i]
    return v
  }
  const s = str(b, from, len).trim()
  const v = s ? parseInt(s, 8) : 0
  if (!Number.isFinite(v)) throw new TarError('This is not a tar archive (a header has a broken number)')
  return v
}

const pad = (n: number) => Math.ceil(n / BLOCK) * BLOCK

/** The size field, which steps to the next header: a negative one ("-1000" is octal to parseInt)
 * would never move past its own header, and loop on it for good. */
function sizeOf(b: Uint8Array): number {
  const n = num(b, 124, 12)
  if (!Number.isSafeInteger(n) || n < 0) throw new TarError('This is not a tar archive (a header has a broken size)')
  return n
}

/** A header block; null for an all-zero one (the end of the archive). */
function parseHeader(b: Uint8Array): Header | null {
  if (b.every((x) => x === 0)) return null
  // The checksum: all bytes summed with its own field as spaces (some old tars summed signed bytes).
  let sum = 0
  let signed = 0
  for (let i = 0; i < BLOCK; i++) {
    const v = i >= 148 && i < 156 ? 32 : b[i]
    sum += v
    signed += v > 127 ? v - 256 : v
  }
  const want = num(b, 148, 8)
  if (want !== sum && want !== signed) throw new TarError('This is not a tar archive (a header checksum does not match)')
  const ustar = str(b, 257, 6).startsWith('ustar')
  const prefix = ustar ? str(b, 345, 155) : ''
  const name = str(b, 0, 100)
  const user = ustar ? str(b, 265, 32) : ''
  const group = ustar ? str(b, 297, 32) : ''
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: sizeOf(b),
    mtime: num(b, 136, 12),
    type: String.fromCharCode(b[156] || 48),
    link: str(b, 157, 100),
    mode: num(b, 100, 8) & 0o7777,
    owner: `${user || num(b, 108, 8)}/${group || num(b, 116, 8)}`,
  }
}

/** A pax header's records ("27 path=some/long/name\n"), lengths in bytes. */
function parsePax(b: Uint8Array, into: Extra) {
  let at = 0
  while (at < b.length) {
    const space = b.indexOf(32, at)
    if (space < 0) break
    const len = parseInt(utf8.decode(b.subarray(at, space)), 10)
    if (!(len > 0) || at + len > b.length) break
    const record = utf8.decode(b.subarray(space + 1, at + len - 1))
    const eq = record.indexOf('=')
    const key = record.slice(0, eq)
    const value = record.slice(eq + 1)
    if (key === 'path') into.path = value
    else if (key === 'linkpath') into.linkpath = value
    else if (key === 'size' && /^\d+$/.test(value)) into.size = Number(value)
    else if (key === 'mtime' && Number.isFinite(parseFloat(value))) into.mtime = parseFloat(value)
    at += len
  }
}

/** Headers that only describe the next one. */
const META = new Set(['x', 'g', 'L', 'K'])

function applyMeta(h: Header, data: Uint8Array, extra: Extra) {
  if (h.type === 'x') parsePax(data, extra)
  else if (h.type === 'L') extra.path = str(data, 0, data.length)
  else if (h.type === 'K') extra.linkpath = str(data, 0, data.length)
  // 'g' (pax for the whole archive) says nothing the listing uses.
}

/** How many data bytes follow a header. */
const dataLength = (h: Header, extra: Extra) => (META.has(h.type) ? h.size : (extra.size ?? h.size))

/** An entry for the listing, or null for what is not a file, folder or link (devices, fifos). */
function toEntry(h: Header, extra: Extra, offset: number): ZipEntry | null {
  const raw = (extra.path ?? h.name).replace(/\\/g, '/')
  const path = raw
    .split('/')
    .filter((p) => p && p !== '.')
    .join('/')
  if (!path) return null
  const file = h.type === '0' || h.type === '7' || h.type === '\0'
  const dir = h.type === '5' || (file && raw.endsWith('/'))
  const link = h.type === '1' || h.type === '2'
  if (!file && !dir && !link) return null
  const size = dir || link ? 0 : (extra.size ?? h.size)
  return {
    path,
    dir,
    size,
    compressed: size,
    mtime: (extra.mtime ?? h.mtime) * 1000,
    method: 0,
    encrypted: false,
    comment: '',
    offset,
    crc: 0,
    ...(link ? { link: extra.linkpath ?? h.link } : {}),
    mode: h.mode,
    owner: h.owner,
  }
}

/**
 * A plain tar's entries, read header to header with `range` (from..to, inclusive). Small files
 * come several to a read; a big one is skipped over with a fresh read after it.
 */
export async function readTar(range: (from: number, to: number) => Promise<Uint8Array>, size: number, maxEntries = 100_000): Promise<ZipIndex> {
  if (size < BLOCK) throw new TarError('This is not a tar archive (it is too short)')
  let buf: Uint8Array = new Uint8Array(0)
  let bufAt = 0
  let window = 64 * 1024
  const read = async (at: number, n: number) => {
    if (at + n > size) throw new TarError('The archive ends in the middle of a file (it is cut off)')
    if (at >= bufAt && at + n <= bufAt + buf.length) return buf.subarray(at - bufAt, at - bufAt + n)
    buf = await range(at, Math.min(size, at + Math.max(n, window)) - 1)
    bufAt = at
    if (buf.length < n) throw new TarError('The file server sent less than was asked for')
    return buf.subarray(0, n)
  }
  const entries: ZipEntry[] = []
  let extra: Extra = {}
  let at = 0
  while (at + BLOCK <= size) {
    const h = parseHeader(await read(at, BLOCK))
    if (!h) break
    const len = dataLength(h, extra)
    if (at + BLOCK + len > size) throw new TarError('The archive ends in the middle of a file (it is cut off)')
    if (META.has(h.type)) {
      if (len > META_MAX) throw new TarError('This is not a tar archive (a name header is too big)')
      applyMeta(h, await read(at + BLOCK, len), extra)
    } else {
      const e = toEntry(h, extra, at + BLOCK)
      extra = {}
      if (e && entries.push(e) > maxEntries) throw new TarError(`The archive holds more than ${maxEntries.toLocaleString('en-GB')} entries`)
      // After a small file the next header is probably near: read ahead. After a big one, not.
      window = len < 32 * 1024 ? 64 * 1024 : 4 * 1024
    }
    at += BLOCK + pad(len)
  }
  return { entries, size, comment: '', zip64: false, format: 'tar' }
}

/** Pulls exact amounts from a stream of chunks. */
class Reader {
  private it: AsyncIterator<Uint8Array>
  private max: number
  private chunk: Uint8Array = new Uint8Array(0)
  private pos = 0
  total = 0

  constructor(source: AsyncIterable<Uint8Array>, max: number) {
    this.it = source[Symbol.asyncIterator]()
    this.max = max
  }

  private async fill(): Promise<boolean> {
    while (this.pos >= this.chunk.length) {
      const r = await this.it.next()
      if (r.done) return false
      this.chunk = r.value
      this.pos = 0
      this.total += r.value.length
      if (this.total > this.max) throw new TarError(`It unpacks to more than ${Math.round(this.max / 1024 ** 3)} GB`)
    }
    return true
  }

  /** Exactly `n` bytes; null when the stream has ended right here. */
  async read(n: number): Promise<Uint8Array | null> {
    if (!(await this.fill())) return null
    if (this.chunk.length - this.pos >= n) {
      const out = this.chunk.subarray(this.pos, this.pos + n)
      this.pos += n
      return out
    }
    const out = new Uint8Array(n)
    let got = 0
    while (got < n) {
      if (!(await this.fill())) throw new TarError('The archive ends in the middle of a file (it is cut off)')
      const k = Math.min(n - got, this.chunk.length - this.pos)
      out.set(this.chunk.subarray(this.pos, this.pos + k), got)
      got += k
      this.pos += k
    }
    return out
  }

  /** The next `n` bytes, chunk by chunk as they come. */
  async *take(n: number): AsyncGenerator<Uint8Array> {
    let left = n
    while (left > 0) {
      if (!(await this.fill())) throw new TarError('The archive ends in the middle of a file (it is cut off)')
      const k = Math.min(left, this.chunk.length - this.pos)
      const out = this.chunk.subarray(this.pos, this.pos + k)
      this.pos += k
      left -= k
      yield out
    }
  }

  async skip(n: number) {
    for await (const _ of this.take(n));
  }
}

/**
 * Reads a tar stream (a gzipped one, unzipped) from the start. `onEntry` gets each entry with its
 * data, which it may read or leave: what it leaves is skipped. Stops with an error past `maxBytes`
 * (against archives that unpack to far more than they look) or `maxEntries`.
 */
export async function scanTar(
  source: AsyncIterable<Uint8Array>,
  onEntry: (e: ZipEntry, data: AsyncIterable<Uint8Array>) => Promise<void> | void,
  { maxBytes = 64 * 1024 ** 3, maxEntries = 100_000 } = {},
): Promise<{ entries: number; bytes: number }> {
  const r = new Reader(source, maxBytes)
  let extra: Extra = {}
  let at = 0
  let count = 0
  for (;;) {
    const block = await r.read(BLOCK)
    if (!block) {
      if (at === 0) throw new TarError('This is not a tar archive (it is empty)')
      break
    }
    const h = parseHeader(block)
    if (!h) break
    const len = dataLength(h, extra)
    if (META.has(h.type)) {
      if (len > META_MAX) throw new TarError('This is not a tar archive (a name header is too big)')
      applyMeta(h, (await r.read(len)) ?? new Uint8Array(0), extra)
      await r.skip(pad(len) - len)
    } else {
      const e = toEntry(h, extra, at + BLOCK)
      extra = {}
      let used = 0
      if (e) {
        if (++count > maxEntries) throw new TarError(`The archive holds more than ${maxEntries.toLocaleString('en-GB')} entries`)
        const data = (async function* () {
          for await (const chunk of r.take(len)) {
            used += chunk.length
            yield chunk
          }
        })()
        await onEntry(e, data)
      }
      await r.skip(len - used + (pad(len) - len))
    }
    at += BLOCK + pad(len)
  }
  return { entries: count, bytes: r.total }
}
