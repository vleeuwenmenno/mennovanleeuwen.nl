import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

// A small WebSocket server (RFC 6455), so the server keeps its no-dependencies rule. Text
// messages only, no extensions (no compression: messages are small and latency matters more).
// Each connection pings every 15 s and is dropped when nothing has come back for 40 s.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const PING_EVERY = 15_000
const DEAD_AFTER = 40_000
/** A client that can't keep up (this much unsent) is dropped rather than buffered forever. */
const MAX_BUFFERED = 1 << 20

export type WsOptions = {
  /** Largest message accepted, in bytes; bigger ones close the connection. */
  maxMessage: number
}

export class WsConnection {
  onMessage: (text: string) => void = () => {}
  onClose: () => void = () => {}
  open = true
  private buf: Buffer = Buffer.alloc(0)
  private frags: Buffer[] = []
  private fragSize = 0
  private lastSeen = Date.now()
  private timer: NodeJS.Timeout
  private socket: Duplex
  private max: number

  constructor(socket: Duplex, head: Buffer, opts: WsOptions) {
    this.socket = socket
    this.max = opts.maxMessage
    // Small frames go out at once instead of waiting to be batched (Nagle).
    ;(socket as Socket).setNoDelay?.(true)
    socket.on('data', (d: Buffer) => this.read(d))
    socket.on('error', () => this.gone())
    socket.on('close', () => this.gone())
    socket.on('end', () => this.gone())
    this.timer = setInterval(() => {
      if (Date.now() - this.lastSeen > DEAD_AFTER) this.socket.destroy()
      else this.frame(0x9, Buffer.alloc(0))
    }, PING_EVERY)
    // What came with the upgrade is read once the caller has set onMessage and onClose.
    if (head.length) setImmediate(() => this.read(head))
  }

  send(text: string) {
    if (!this.open) return
    if (this.socket.writableLength > MAX_BUFFERED) {
      this.socket.destroy()
      return
    }
    this.frame(0x1, Buffer.from(text, 'utf8'))
  }

  close(code = 1000, reason = '') {
    if (!this.open) return
    const r = Buffer.from(reason, 'utf8').subarray(0, 120)
    const body = Buffer.alloc(2 + r.length)
    body.writeUInt16BE(code, 0)
    r.copy(body, 2)
    this.frame(0x8, body)
    this.socket.end()
    setTimeout(() => this.socket.destroy(), 2000).unref()
    this.gone()
  }

  private gone() {
    if (!this.open) return
    this.open = false
    clearInterval(this.timer)
    this.onClose()
  }

  private frame(op: number, payload: Buffer) {
    // Pongs and pings count too: a peer that never reads is dropped, not buffered for.
    if (this.socket.writableLength > MAX_BUFFERED) return void this.socket.destroy()
    const n = payload.length
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
    head[0] = 0x80 | op
    if (n < 126) head[1] = n
    else if (n < 65536) {
      head[1] = 126
      head.writeUInt16BE(n, 2)
    } else {
      head[1] = 127
      head.writeBigUInt64BE(BigInt(n), 2)
    }
    this.socket.write(n ? Buffer.concat([head, payload]) : head)
  }

  private read(data: Buffer) {
    this.lastSeen = Date.now()
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data
    while (this.open) {
      const b = this.buf
      if (b.length < 2) return
      const fin = (b[0] & 0x80) !== 0
      const op = b[0] & 0x0f
      // Browsers always mask what they send; anything else isn't a browser speaking WebSocket.
      if (!(b[1] & 0x80)) return this.close(1002, 'unmasked')
      let len = b[1] & 0x7f
      let at = 2
      if (len === 126) {
        if (b.length < 4) return
        len = b.readUInt16BE(2)
        at = 4
      } else if (len === 127) {
        if (b.length < 10) return
        const big = b.readBigUInt64BE(2)
        if (big > BigInt(this.max)) return this.close(1009, 'too big')
        len = Number(big)
        at = 10
      }
      if (len > this.max) return this.close(1009, 'too big')
      if (b.length < at + 4 + len) return
      const mask = b.subarray(at, at + 4)
      const payload = Buffer.from(b.subarray(at + 4, at + 4 + len))
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3]
      this.buf = b.subarray(at + 4 + len)

      // Control frames are small and whole (RFC 6455 5.5).
      if (op >= 0x8 && (len > 125 || !fin)) return this.close(1002, 'bad control frame')
      if (op === 0x8) {
        this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000)
        return
      }
      if (op === 0x9) {
        this.frame(0xa, payload)
        continue
      }
      if (op === 0xa) continue
      if (op === 0x2) return this.close(1003, 'text only')
      if (op !== 0x1 && op !== 0x0) return this.close(1002, 'bad opcode')
      if (op === 0x0 && !this.frags.length) return this.close(1002, 'stray continuation')
      this.frags.push(payload)
      this.fragSize += len
      if (this.fragSize > this.max) return this.close(1009, 'too big')
      if (!fin) continue
      const text = (this.frags.length === 1 ? this.frags[0] : Buffer.concat(this.frags)).toString('utf8')
      this.frags = []
      this.fragSize = 0
      this.onMessage(text)
    }
  }
}

/** Answers a WebSocket upgrade, or refuses it with `status` when the request isn't one. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, opts: WsOptions): WsConnection | null {
  const key = req.headers['sec-websocket-key']
  if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string') {
    refuse(socket, 400, 'Bad Request')
    return null
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  return new WsConnection(socket, head, opts)
}

export function refuse(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}
