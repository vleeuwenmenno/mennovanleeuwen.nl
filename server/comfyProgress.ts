import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import type { ImageProgress } from '../src/data/imageModels.ts'
import type { User } from './auth.ts'
import { guardedLookup } from './egress.ts'

// Live progress of one ComfyUI image job, for its owner's thread only. ComfyUI tells the client
// that queued a prompt (by its client_id) what that prompt does over a WebSocket at /ws?clientId=…:
// `execution_start`, `executing` (which node; null when it is done), `execution_cached`, `progress`
// (step value of max) and, to everyone, `status` (queue size). Its queue position comes from GET
// /queue. Everything here is a nice-to-have on top of the /history polling in agentImages.ts: when
// the socket cannot open or breaks, the job runs and finishes exactly as before, only less detailed.

/** The node ids of the graph imageWorkflow builds, and what each one is doing. */
const NODE_PHASE: Record<string, ImageProgress['phase']> = { '1': 'loading', '2': 'loading', '3': 'loading', '4': 'encoding', '5': 'encoding', '6': 'encoding', '7': 'sampling', '8': 'decoding', '9': 'decoding' }

export type ProgressState = { progress: ImageProgress | null; started: boolean; finished: boolean }
export const progressState = (): ProgressState => ({ progress: null, started: false, finished: false })

const count = (v: unknown, max = 100_000) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max

/**
 * One message from ComfyUI's socket, applied to a job's state. Messages that name another prompt
 * are ignored (`promptId` is ours, once /prompt has answered). True when the progress changed.
 */
export function applyComfyMessage(state: ProgressState, message: unknown, promptId: string | null, steps: number): boolean {
  if (!message || typeof message !== 'object') return false
  const { type, data } = message as { type?: unknown; data?: Record<string, unknown> }
  if (typeof type !== 'string' || !data || typeof data !== 'object') return false
  const id = data.prompt_id
  if (id !== undefined && (typeof id !== 'string' || (promptId !== null && id !== promptId))) return false
  const set = (p: ImageProgress) => {
    const before = JSON.stringify(state.progress)
    state.progress = p
    return JSON.stringify(p) !== before
  }
  if (type === 'execution_start') {
    state.started = true
    return state.progress?.phase === 'queued' || !state.progress ? set({ phase: 'loading' }) : false
  }
  if (type === 'executing') {
    if (data.node === null || data.node === undefined) {
      if (!state.started) return false
      state.finished = true
      return false
    }
    state.started = true
    const phase = typeof data.node === 'string' ? NODE_PHASE[data.node] : undefined
    if (!phase) return false
    return set(phase === 'sampling' ? { phase, value: 0, max: steps } : { phase })
  }
  if (type === 'progress') {
    if (!count(data.value) || !count(data.max) || !(data.max as number) || (data.value as number) > (data.max as number)) return false
    // A step count from another node (a tiled VAE decode, say) is not the picture's progress.
    if (data.node !== undefined && data.node !== null && data.node !== '7') return false
    state.started = true
    return set({ phase: 'sampling', value: data.value as number, max: data.max as number })
  }
  if (type === 'execution_success' || type === 'execution_error' || type === 'execution_interrupted') {
    state.finished = true
    return false
  }
  return false
}

/**
 * Our place in ComfyUI's queue from GET /queue: 1 when we are next, null when ours is already
 * running (or not in the queue at all). Only a count leaves this: other jobs stay unseen.
 */
export function queuePosition(queue: unknown, promptId: string): number | 'running' | null {
  if (!queue || typeof queue !== 'object') return null
  const { queue_running: running, queue_pending: waiting } = queue as { queue_running?: unknown; queue_pending?: unknown }
  const items = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is unknown[] => Array.isArray(x) && typeof x[1] === 'string') : [])
  if (items(running).some((x) => x[1] === promptId)) return 'running'
  const pending = items(waiting)
  const ours = pending.find((x) => x[1] === promptId)
  if (!ours) return null
  const number = typeof ours[0] === 'number' ? ours[0] : Infinity
  return items(running).length + pending.filter((x) => x !== ours && typeof x[0] === 'number' && x[0] < number).length + 1
}

/**
 * Passes progress on at most once per `ms` (4 a second by default): the first at once, the latest
 * after the pause, never the same one twice. `stop` drops whatever is still waiting.
 */
export function throttleProgress(emit: (p: ImageProgress) => void, ms = 250, now: () => number = Date.now) {
  let last = -Infinity
  let latest: ImageProgress | null = null
  let sent = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = () => {
    timer = null
    if (!latest) return
    const key = JSON.stringify(latest)
    if (key === sent) return
    sent = key
    last = now()
    emit(latest)
  }
  return {
    push(p: ImageProgress) {
      latest = p
      if (timer || JSON.stringify(p) === sent) return
      const wait = last + ms - now()
      if (wait <= 0) fire()
      else timer = setTimeout(fire, wait)
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
      latest = null
    },
  }
}

const MAX_MESSAGE = 1024 * 1024 // Text messages are small; latent previews (binary) can be larger.
const MAX_FRAME = 8 * 1024 * 1024

/**
 * A WebSocket to ComfyUI's /ws for `clientId`, reading text messages as JSON into `onMessage`.
 * Connects through the same egress check as every other ComfyUI request. Resolves null when the
 * socket cannot be opened (an older or proxied ComfyUI, a refused upgrade, 5 s without an answer).
 */
export async function openComfySocket(user: User, base: string, token: string, clientId: string, signal: AbortSignal, onMessage: (message: unknown) => void): Promise<{ close: () => void } | null> {
  let url: URL
  try { url = new URL(`${base}/ws?clientId=${encodeURIComponent(clientId)}`) } catch { return null }
  let lookup: Awaited<ReturnType<typeof guardedLookup>>
  try { lookup = await guardedLookup(user, url, signal) } catch { return null }
  if (signal.aborted) return null
  const key = randomBytes(16).toString('base64')
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve) => {
    let settled = false
    const settle = (v: { close: () => void } | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    const req = send(url, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(lookup ? { lookup: lookup as never } : {}),
      signal,
    })
    const timer = setTimeout(() => { req.destroy(); settle(null) }, 5000)
    req.on('error', () => settle(null))
    req.on('response', (res: IncomingMessage) => { res.resume(); settle(null) })
    req.on('upgrade', (res: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (res.statusCode !== 101 || res.headers['sec-websocket-accept'] !== accept) { socket.destroy(); return settle(null) }
      const close = () => { signal.removeEventListener('abort', close); socket.destroy() }
      signal.addEventListener('abort', close, { once: true })
      socket.on('error', close)
      socket.on('close', close)
      const reader = frameReader(onMessage, (payload) => socket.write(clientFrame(10, payload)), close)
      if (head.length) reader(head)
      socket.on('data', reader)
      settle({ close })
    })
    req.end()
  })
}

/** Parses server frames (unmasked) from a byte stream: text messages to `onText` as JSON, pings answered. */
export function frameReader(onMessage: (message: unknown) => void, pong: (payload: Buffer) => void, close: () => void) {
  let buffer: Buffer = Buffer.alloc(0)
  let parts: Buffer[] = []
  let partsSize = 0
  let fragmentedText: boolean | null = null
  return (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    for (;;) {
      if (buffer.length < 2) return
      const fin = (buffer[0] & 0x80) !== 0, opcode = buffer[0] & 0x0f, masked = (buffer[1] & 0x80) !== 0
      let length = buffer[1] & 0x7f, at = 2
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); at = 4 }
      else if (length === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_FRAME)) return close()
        length = Number(big); at = 10
      }
      if (length > MAX_FRAME) return close()
      const mask = masked ? at : -1
      if (masked) at += 4
      if (buffer.length < at + length) return
      let payload = buffer.subarray(at, at + length)
      if (masked) payload = Buffer.from(payload.map((b, i) => b ^ buffer[mask + (i % 4)]))
      buffer = buffer.subarray(at + length)
      if (opcode === 8) return close()
      if (opcode === 9) { pong(Buffer.from(payload)); continue }
      if (opcode === 10) continue
      if (opcode === 1 || opcode === 2) { fragmentedText = opcode === 1; parts = []; partsSize = 0 }
      else if (opcode !== 0 || fragmentedText === null) continue
      if (fragmentedText) {
        partsSize += payload.length
        if (partsSize > MAX_MESSAGE) return close()
        parts.push(Buffer.from(payload))
      }
      if (!fin) continue
      const text = fragmentedText ? Buffer.concat(parts).toString() : null
      fragmentedText = null; parts = []; partsSize = 0
      if (text === null) continue // Binary: a latent preview, not shown here.
      let message: unknown
      try { message = JSON.parse(text) } catch { continue }
      onMessage(message)
    }
  }
}

/** One masked client frame (clients must mask). */
function clientFrame(opcode: number, payload: Buffer) {
  const mask = randomBytes(4)
  const head = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length]) : Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 255])
  return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))])
}
