import { MP_PATH, type ClientMsg, type ServerMsg } from './protocol'

// The game's end of the multiplayer WebSocket. One connection per tab, kept open while the
// multiplayer screens are up: it reconnects by itself after a drop (resuming the same player with
// the tab's token), measures the round trip, and hands the server's messages to listeners.

export type NetStatus = 'connecting' | 'online' | 'offline'
type Listener = (m: ServerMsg) => void

/** Per tab, so two tabs are two players (handy for trying it alone) and a reload is the same one. */
const TOKEN_KEY = 'mvlos.empires.mp.token'
const readToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined
  } catch {
    return undefined
  }
}
const writeToken = (t: string) => {
  try {
    sessionStorage.setItem(TOKEN_KEY, t)
  } catch {
    // Storage blocked: a reload makes a new player.
  }
}

export class Net {
  status: NetStatus = 'connecting'
  /** Smoothed round trip in milliseconds. */
  rtt = 0
  /** Server clock minus ours, in milliseconds. */
  clockOffset = 0
  name = ''
  id = ''
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private statusListeners = new Set<(s: NetStatus) => void>()
  private retry = 0
  private retryTimer = 0
  private pingTimer = 0
  private pings = new Map<number, number>()
  private pingN = 0
  private closed = false

  constructor() {
    this.open()
  }

  send(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m))
  }

  on(fn: Listener) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  onStatus(fn: (s: NetStatus) => void) {
    this.statusListeners.add(fn)
    return () => void this.statusListeners.delete(fn)
  }

  /** Asks for a name; resolves with null once it's ours, or why not and a name to try instead. */
  claim(name: string): Promise<{ why: string; suggestion: string } | null> {
    return new Promise((resolve) => {
      const off = this.on((m) => {
        if (m.t === 'welcome') {
          off()
          resolve(null)
        } else if (m.t === 'refused') {
          off()
          resolve({ why: m.why, suggestion: m.suggestion })
        }
      })
      this.send({ t: 'claim', name })
    })
  }

  /** Done with multiplayer: closes for good (no reconnecting). */
  close() {
    this.closed = true
    clearTimeout(this.retryTimer)
    clearInterval(this.pingTimer)
    this.ws?.close()
    this.setStatus('offline')
  }

  private setStatus(s: NetStatus) {
    if (this.status === s) return
    this.status = s
    for (const fn of this.statusListeners) fn(s)
  }

  private open() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${MP_PATH}`)
    this.ws = ws
    this.setStatus('connecting')
    ws.onopen = () => {
      this.retry = 0
      ws.send(JSON.stringify({ t: 'hello', token: readToken() } satisfies ClientMsg))
      clearInterval(this.pingTimer)
      this.ping()
      this.pingTimer = window.setInterval(() => this.ping(), 2000)
    }
    ws.onmessage = (e) => {
      let m: ServerMsg
      try {
        m = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (m.t === 'pong') {
        const sent = this.pings.get(m.n)
        if (sent === undefined) return
        this.pings.delete(m.n)
        const now = performance.now()
        const rtt = now - sent
        this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt
        this.clockOffset = m.at - (Date.now() - rtt / 2)
      }
      if (m.t === 'welcome') {
        writeToken(m.token)
        this.name = m.name
        this.id = m.id
      }
      if (m.t === 'welcome' || m.t === 'ready') this.setStatus('online')
      for (const fn of [...this.listeners]) fn(m)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      clearInterval(this.pingTimer)
      this.pings.clear()
      if (this.closed) return
      this.setStatus('offline')
      // Back off: 0.5, 1, 2, 4, then every 5 seconds.
      const wait = Math.min(5000, 500 * 2 ** this.retry++)
      this.retryTimer = window.setTimeout(() => this.open(), wait)
    }
  }

  private ping() {
    const n = ++this.pingN
    this.pings.set(n, performance.now())
    // Pings that never came back don't pile up.
    if (this.pings.size > 10) this.pings.delete(this.pings.keys().next().value!)
    this.send({ t: 'ping', n })
  }
}
