import type { MatchInfo, Turn } from './match'
import type { BattleSnap } from './snapshot'
import { MP_PATH, type ClientMsg, type LobbyInfo, type MpLobby, type ServerMsg } from './protocol'

// The game's end of the multiplayer WebSocket. One connection per tab, kept open while the
// multiplayer screens are up: it reconnects by itself after a drop (resuming the same player with
// the tab's token), measures the round trip, and hands the server's messages to listeners. It
// also keeps what the screens show (who we are, the lobby list, our lobby, its chat) as `view`.

export type NetStatus = 'connecting' | 'online' | 'offline'
type Listener = (m: ServerMsg) => void

export type ChatLine = { from: string; text: string; at: number }
/** Everything the multiplayer screens draw, replaced (never changed in place) on every update. */
export type NetView = {
  status: NetStatus
  /** Us, once a name is ours. */
  me: { id: string; name: string } | null
  /** A free name to offer on the join screen, and the signed-in login if any. */
  suggestion: string
  login: string | null
  lobbies: LobbyInfo[]
  lobby: MpLobby | null
  chat: ChatLine[]
  /** The last thing the server turned down, for a toast. */
  problem: { why: string; n: number } | null
  rtt: number
  /** The battle we're in, and our seat in it, from its start until we leave its screen. */
  match: { info: MatchInfo; me: number } | null
}
const CHAT_KEEP = 100

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

/** Whether this tab was in the multiplayer screens: a reload goes straight back to them (and the
 * server puts the player back in their lobby or battle). */
const ACTIVE_KEY = 'mvlos.empires.mp.active'
export const mpActive = {
  get: () => {
    try {
      return sessionStorage.getItem(ACTIVE_KEY) === '1'
    } catch {
      return false
    }
  },
  set: (on: boolean) => {
    try {
      if (on) sessionStorage.setItem(ACTIVE_KEY, '1')
      else sessionStorage.removeItem(ACTIVE_KEY)
    } catch {
      // Storage blocked: a reload lands on the main menu.
    }
  },
}

export class Net {
  status: NetStatus = 'connecting'
  /** Smoothed round trip in milliseconds. */
  rtt = 0
  /** Server clock minus ours, in milliseconds. */
  clockOffset = 0
  name = ''
  id = ''
  view: NetView = { status: 'connecting', me: null, suggestion: '', login: null, lobbies: [], lobby: null, chat: [], problem: null, rtt: 0, match: null }
  /** The battle's turns not yet played, oldest first. Kept out of `view`: they come 30 a second
   * and the battle screen takes them straight from here. */
  turns: Turn[] = []
  /** The server's battle to carry on from, when ours drifted or we came back mid-battle. */
  sync: { n: number; world: string; brains: BattleSnap['brains']; why: 'drift' | 'rejoin' } | null = null
  private viewListeners = new Set<() => void>()
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

  /** For useSyncExternalStore: `view` changes. */
  subscribe = (fn: () => void) => {
    this.viewListeners.add(fn)
    return () => void this.viewListeners.delete(fn)
  }
  getView = () => this.view

  private patch(p: Partial<NetView>) {
    this.view = { ...this.view, ...p }
    for (const fn of this.viewListeners) fn()
  }

  private track(m: ServerMsg) {
    switch (m.t) {
      case 'ready':
        return this.patch({ me: null, suggestion: m.suggestion, login: m.login })
      case 'welcome':
        return this.patch({ me: { id: m.id, name: m.name } })
      case 'refused':
        return this.patch({ suggestion: m.suggestion, problem: { why: m.why, n: (this.view.problem?.n ?? 0) + 1 } })
      case 'lobbies':
        return this.patch({ lobbies: m.list })
      case 'lobby':
        // A new lobby (or none) starts with an empty chat.
        return this.patch({ lobby: m.lobby, chat: m.lobby && m.lobby.id === this.view.lobby?.id ? this.view.chat : [] })
      case 'chat':
        return this.patch({ chat: [...this.view.chat, { from: m.from, text: m.text, at: m.at }].slice(-CHAT_KEEP) })
      case 'kicked':
      case 'error':
        return this.patch({ problem: { why: m.why, n: (this.view.problem?.n ?? 0) + 1 } })
      case 'match':
        this.turns = []
        // The same battle again (we reconnected): keep the screen, a sync follows.
        if (this.view.match?.info.id === m.match.id && this.view.match.me === m.me) return
        this.sync = null
        return this.patch({ match: { info: m.match, me: m.me } })
      case 'turn':
        if (this.view.match) this.turns.push({ n: m.n, c: m.c, ...(m.ai ? { ai: m.ai } : {}) })
        return
      case 'sync':
        // Every turn queued so far is from before it.
        this.turns = []
        this.sync = { n: m.n, world: m.world, brains: m.brains, why: m.why }
        return
      case 'pong':
        // Redraws for the ping readout are cheap but needn't happen on every pong.
        if (Math.abs(this.rtt - this.view.rtt) > 3) this.patch({ rtt: this.rtt })
    }
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

  /** Off the battle screen: back to the lobby. */
  endMatch() {
    this.turns = []
    this.sync = null
    this.patch({ match: null })
  }

  /** Out of the lobby (and its battle, if one is on): straight to the list, without waiting for
   * the server to say so. */
  leave() {
    this.send({ t: 'leave' })
    this.turns = []
    this.sync = null
    this.patch({ match: null, lobby: null, chat: [] })
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
    this.patch({ status: s })
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
      this.track(m)
      for (const fn of [...this.listeners]) fn(m)
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      clearInterval(this.pingTimer)
      this.pings.clear()
      // 4000: another connection of ours took over (a reload); this one is done.
      if (e.code === 4000) this.closed = true
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
