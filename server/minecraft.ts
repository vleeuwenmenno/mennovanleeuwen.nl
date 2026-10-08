import { connect } from 'node:net'

// Asks the Minecraft server directly with the Server List Ping protocol (the request the game's
// multiplayer menu sends), so the status is live instead of coming from a public API's cache.
// Only the one hard-coded server is ever contacted.

export const MC_HOST = 'cloud.mvl.sh'
export const MC_PORT = 25565
const CACHE_MS = 10_000

export type McStatus = {
  online: boolean
  version?: string
  motd?: string
  players: { online: number; max: number; list: string[] }
  icon?: string
  checkedAt: number
}

function varint(n: number): Buffer {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n >>>= 7
    if (n) b |= 0x80
    out.push(b)
  } while (n)
  return Buffer.from(out)
}

/** Reads a VarInt at `offset`; null when the buffer does not hold all of it yet. */
function readVarint(buf: Buffer, offset: number): [number, number] | null {
  let n = 0
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null
    const b = buf[offset + i]
    n |= (b & 0x7f) << (7 * i)
    if (!(b & 0x80)) return [n, offset + i + 1]
  }
  throw new Error('bad varint')
}

/** Flattens a chat component ({text, extra: [...]}) or a plain string to text. */
function chatText(c: unknown): string {
  if (typeof c === 'string') return c
  if (!c || typeof c !== 'object') return ''
  const o = c as { text?: string; extra?: unknown[] }
  return (o.text ?? '') + (o.extra ?? []).map(chatText).join('')
}

function ping(host: string, port: number, timeoutMs = 4000): Promise<McStatus> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port })
    let buf = Buffer.alloc(0)
    const fail = (err: Error) => {
      sock.destroy()
      reject(err)
    }
    sock.setTimeout(timeoutMs, () => fail(new Error('timeout')))
    sock.on('error', fail)
    sock.on('connect', () => {
      const h = Buffer.from(host)
      const portBuf = Buffer.alloc(2)
      portBuf.writeUInt16BE(port)
      // Handshake (packet 0x00, protocol -1 = "just asking", next state 1 = status), then status request.
      const handshake = Buffer.concat([varint(0), varint(767), varint(h.length), h, portBuf, varint(1)])
      sock.write(Buffer.concat([varint(handshake.length), handshake, varint(1), varint(0)]))
    })
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      const len = readVarint(buf, 0)
      if (!len || buf.length < len[1] + len[0]) return
      const id = readVarint(buf, len[1])!
      const strLen = readVarint(buf, id[1])!
      const json = JSON.parse(buf.subarray(strLen[1], strLen[1] + strLen[0]).toString('utf8'))
      sock.end()
      resolve({
        online: true,
        version: json.version?.name,
        motd: chatText(json.description).replace(/§./g, '').trim() || undefined,
        players: {
          online: json.players?.online ?? 0,
          max: json.players?.max ?? 0,
          list: (json.players?.sample ?? []).map((p: { name: string }) => p.name).filter((n: string) => !!n && !n.includes('§')),
        },
        icon: typeof json.favicon === 'string' ? json.favicon : undefined,
        checkedAt: Date.now(),
      })
    })
  })
}

let cached: { at: number; value: Promise<McStatus> } | null = null

/** The server's status, cached for 10 seconds however many visitors ask. Offline when it does not answer. */
export function minecraftStatus(): Promise<McStatus> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const value = ping(MC_HOST, MC_PORT).catch(() => ({ online: false, players: { online: 0, max: 0, list: [] }, checkedAt: Date.now() }))
  cached = { at: Date.now(), value }
  return value
}
