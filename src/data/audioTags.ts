import { parseSf } from './seafile'

// A music file's tags (title, artist, album, cover) and stream details (sample rate, channels),
// read from its first bytes: ID3v2 and the first MPEG frame for MP3, the metadata blocks for FLAC.
// Other formats answer with what their name says.

export type AudioTags = {
  title?: string
  artist?: string
  album?: string
  year?: string
  track?: string
  /** Hz */
  sampleRate?: number
  channels?: number
  /** kbit/s, from the MPEG frame header (FLAC's is worked out from size and length) */
  bitrate?: number
  /** An object URL for the embedded picture */
  cover?: string
}

const HEAD = 256 * 1024
const MAX_HEAD = 4 * 1024 * 1024

async function bytes(path: string, from: number, to: number): Promise<Uint8Array> {
  const at = parseSf(path)
  if (!at) throw new Error('Not a Seafile file')
  const res = await fetch(`/api/seafile/raw?repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}`, { headers: { Range: `bytes=${from}-${to}` } })
  if (!res.ok) throw new Error(`Seafile answered ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

const cache = new Map<string, Promise<AudioTags>>()

/** The tags of a Seafile music file; cached for the session. Never rejects. */
export function readTags(path: string): Promise<AudioTags> {
  let hit = cache.get(path)
  if (!hit) {
    hit = load(path).catch(() => ({}))
    cache.set(path, hit)
  }
  return hit
}

async function load(path: string): Promise<AudioTags> {
  let head = await bytes(path, 0, HEAD - 1)
  // FLAC asks for more as it walks its blocks: the head at least doubles each time, so a file of
  // many tiny blocks takes a few requests, not one per block. A short answer is the end of the file.
  let ended = head.length < HEAD
  const more = async (n: number) => {
    if (ended || n <= head.length || n > MAX_HEAD) return head
    const want = Math.min(MAX_HEAD, Math.max(n, head.length * 2))
    head = await bytes(path, 0, want - 1)
    ended = head.length < want
    return head
  }
  if (ascii(head, 0, 4) === 'fLaC') return flac(head, more)
  if (ascii(head, 0, 3) === 'ID3') {
    const size = 10 + synchsafe(head, 6)
    if (size > head.length && size <= MAX_HEAD) head = await bytes(path, 0, size + 4095)
    const tags = id3(head)
    return { ...tags, ...mpeg(head, size) }
  }
  return mpeg(head, 0)
}

// --- MP3 -----------------------------------------------------------------------------------------

const synchsafe = (b: Uint8Array, i: number) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f)
const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const ascii = (b: Uint8Array, from: number, len: number) => String.fromCharCode(...b.subarray(from, from + len))

function text(b: Uint8Array): string {
  const enc = b[0]
  const body = b.subarray(1)
  const label = enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : enc === 3 ? 'utf-8' : 'latin1'
  return new TextDecoder(label).decode(body).replace(/\0+$/, '').split('\0')[0].trim()
}

function id3(b: Uint8Array): AudioTags {
  const version = b[3]
  const size = Math.min(b.length, 10 + synchsafe(b, 6))
  const out: AudioTags = {}
  let i = 10
  if (b[5] & 0x40) i += version === 4 ? synchsafe(b, 10) : 4 + u32(b, 10)
  while (i + 10 <= size) {
    const id = version === 2 ? ascii(b, i, 3) : ascii(b, i, 4)
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break
    const len = version === 2 ? (b[i + 3] << 16) | (b[i + 4] << 8) | b[i + 5] : version === 4 ? synchsafe(b, i + 4) : u32(b, i + 4)
    const start = i + (version === 2 ? 6 : 10)
    const frame = b.subarray(start, start + len)
    if (id === 'TIT2' || id === 'TT2') out.title = text(frame)
    else if (id === 'TPE1' || id === 'TP1') out.artist = text(frame)
    else if (id === 'TALB' || id === 'TAL') out.album = text(frame)
    else if (id === 'TRCK' || id === 'TRK') out.track = text(frame)
    else if ((id === 'TDRC' || id === 'TYER' || id === 'TYE') && !out.year) out.year = text(frame).slice(0, 4)
    else if ((id === 'APIC' || id === 'PIC') && !out.cover) out.cover = apic(frame, version === 2)
    i = start + len
  }
  return out
}

function apic(f: Uint8Array, v2: boolean): string | undefined {
  const enc = f[0]
  let i = 1
  let mime = 'image/jpeg'
  if (v2) i += 3
  else {
    const end = f.indexOf(0, i)
    mime = ascii(f, i, end - i) || mime
    i = end + 1
  }
  i += 1 // picture type
  // The description ends in one zero byte, or two for UTF-16.
  if (enc === 1 || enc === 2) {
    while (i + 1 < f.length && (f[i] || f[i + 1])) i += 2
    i += 2
  } else {
    while (i < f.length && f[i]) i++
    i++
  }
  if (i >= f.length) return undefined
  return URL.createObjectURL(new Blob([f.slice(i)], { type: imageType(mime.includes('/') ? mime : `image/${mime}`) }))
}

/** The file names its picture's type, and a blob: URL has this site's origin: only plain pictures,
 * never HTML or SVG, which would run as the site if the URL were ever opened. */
const imageType = (mime: string) => (/^image\/(jpeg|jpg|png|gif|webp|bmp|avif)$/i.test(mime.trim()) ? mime.trim().toLowerCase().replace('jpg', 'jpeg') : 'image/jpeg')

const MPEG_RATES = [
  [11025, 12000, 8000], // 2.5
  [0, 0, 0],
  [22050, 24000, 16000], // 2
  [44100, 48000, 32000], // 1
]
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

/** The first MPEG audio frame's header, after any ID3 tag. */
function mpeg(b: Uint8Array, from: number): AudioTags {
  for (let i = from; i + 4 < b.length && i < from + 64 * 1024; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue
    const version = (b[i + 1] >> 3) & 3
    const layer = (b[i + 1] >> 1) & 3
    const bitIndex = b[i + 2] >> 4
    const rateIndex = (b[i + 2] >> 2) & 3
    if (version === 1 || layer === 0 || bitIndex === 15 || bitIndex === 0 || rateIndex === 3) continue
    const sampleRate = MPEG_RATES[version][rateIndex]
    const bitrate = layer === 1 ? (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitIndex] : undefined
    return { sampleRate, channels: b[i + 3] >> 6 === 3 ? 1 : 2, bitrate }
  }
  return {}
}

// --- FLAC ----------------------------------------------------------------------------------------

async function flac(b: Uint8Array, more: (n: number) => Promise<Uint8Array>): Promise<AudioTags> {
  const out: AudioTags = {}
  let i = 4
  for (;;) {
    if (i + 4 > b.length) b = await more(i + 4)
    if (i + 4 > b.length) break
    const last = b[i] & 0x80
    const type = b[i] & 0x7f
    const len = (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]
    const start = i + 4
    if ((type === 4 || (type === 6 && !out.cover)) && start + len > b.length) b = await more(start + len)
    const block = b.subarray(start, start + len)
    if (type === 0 && block.length >= 18) {
      out.sampleRate = (block[10] << 12) | (block[11] << 4) | (block[12] >> 4)
      out.channels = ((block[12] >> 1) & 7) + 1
    } else if (type === 4 && block.length === len) Object.assign(out, vorbis(block))
    else if (type === 6 && !out.cover && block.length === len) out.cover = picture(block)
    i = start + len
    if (last) break
  }
  return out
}

const le32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0

function vorbis(b: Uint8Array): AudioTags {
  const utf8 = new TextDecoder()
  let i = 4 + le32(b, 0)
  const n = le32(b, i)
  i += 4
  const out: AudioTags = {}
  for (let k = 0; k < n && i + 4 <= b.length; k++) {
    const len = le32(b, i)
    const entry = utf8.decode(b.subarray(i + 4, i + 4 + len))
    i += 4 + len
    const eq = entry.indexOf('=')
    const key = entry.slice(0, eq).toUpperCase()
    const value = entry.slice(eq + 1).trim()
    if (key === 'TITLE') out.title = value
    else if (key === 'ARTIST' && !out.artist) out.artist = value
    else if (key === 'ALBUM') out.album = value
    else if (key === 'TRACKNUMBER') out.track = value
    else if (key === 'DATE' && !out.year) out.year = value.slice(0, 4)
  }
  return out
}

const be32 = u32

function picture(b: Uint8Array): string | undefined {
  let i = 4
  const mimeLen = be32(b, i)
  const mime = ascii(b, i + 4, mimeLen)
  i += 4 + mimeLen
  i += 4 + be32(b, i) // description
  i += 16 // width, height, depth, colours
  const len = be32(b, i)
  i += 4
  if (i + len > b.length) return undefined
  return URL.createObjectURL(new Blob([b.slice(i, i + len)], { type: imageType(mime) }))
}
