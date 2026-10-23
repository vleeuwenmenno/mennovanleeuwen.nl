import { api, getAccount, subscribeAccount } from '../../../os/account'
import { pullAll, synced } from '../../../os/synced'
import type { MatchInfo, Turn } from './match'
import type { BattleSnap } from './snapshot'
import { MP_PATH, OUTDATED_CODE, PROTOCOL, REJOIN_MS, type AwaySeat, type AwayVote, type ClientMsg, type LobbyInfo, type MpLobby, type RosterSeat, type ServerMsg } from './protocol'
import { accountKey } from '../../../os/accountSpace'

// The game's end of the multiplayer WebSocket. One connection per tab, kept open while the
// multiplayer screens are up: it reconnects by itself after a drop (resuming the same player with
// the tab's token), measures the round trip, and hands the server's messages to listeners. It
// also keeps what the screens show (who we are, the lobby list, our lobby, its chat) as `view`.
//
// The server carries players, lobbies and battles over a restart (a deploy): it says so as it goes
// down (close code 1012), and we come back as the same player once it's up. Should it have lost us
// anyway (too long away, or its saved state was unusable), `view.lost` says what was lost, so the
// battle screen can offer to play on against the computer rather than wait for turns forever.

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
  /** The battle's players: how each seat is doing and its ping (null until the server says). */
  roster: RosterSeat[] | null
  /** Players who stepped away from the battle: it waits for them (or for the others' votes). */
  away: AwaySeat[]
  /** The server said it was restarting as it closed the connection: we wait for it to come back. */
  restarting: boolean
  /** The server runs another version of the game (protocol.ts PROTOCOL): reloading the page is the
   * only way in, so it doesn't try again. */
  outdated: boolean
  /** The server no longer has the battle or lobby we were in: why, to show until dismissed. */
  lost: { why: string } | null
  /** The remembered name being claimed by itself on connecting (the join screen waits for it);
   * empty while it's still being looked up (the account's copy, signed in on a new device). */
  claiming: string | null
  /** Why the remembered name couldn't be claimed by itself (taken by someone online right now). */
  nameNote: string | null
}
const CHAT_KEEP = 100
/** WebSocket close code 1012, "service restart": the server is going down to come straight back. */
const RESTART_CODE = 1012

/** The name last claimed, to take again by itself next time: in this browser, and with the account
 * when signed in to MvL OS, so it follows the player to their other devices. Settings can change
 * it, or forget it (null) so the next visit asks again. */
export const mpName = synced<string | null>('games:empires-name', null, { normalize: (v) => (typeof v === 'string' && v ? v : null) })

/** The remembered name, waiting for the account's copy when there's none in this browser yet:
 * signed in on a new device (or just signed in again), it arrives a moment after the page loads,
 * which may be after the server asked for a name. */
async function recallName(): Promise<string | null> {
  if (mpName.get()) return mpName.get()
  if (getAccount().status === 'loading')
    await new Promise<void>((resolve) => {
      const done = () => {
        if (getAccount().status === 'loading') return
        off()
        clearTimeout(t)
        resolve()
      }
      const off = subscribeAccount(done)
      // Not waiting long for an account that won't load (offline): the join screen asks instead.
      const t = setTimeout(() => (off(), resolve()), 4000)
    })
  if (getAccount().status === 'user') await pullAll()
  return mpName.get()
}
/** Per tab, so two tabs are two players (handy for trying it alone) and a reload is the same one.
 * The browser also keeps the last one, for a tab opened after the one playing was closed: with it,
 * the server puts the player back in their battle (unless that tab is still connected with it). */
// Both under this tab's account (src/os/accountSpace.ts): another account in this browser starts
// as a player of its own (and the server only takes a token back from the same account).
const TOKEN_KEY = accountKey('mvlos.empires.mp.token')
const LAST_KEY = accountKey('mvlos.empires.mp.last')
const readToken = (): { token?: string; stored?: true } => {
  try {
    const own = sessionStorage.getItem(TOKEN_KEY)
    if (own) return { token: own }
    const last = localStorage.getItem(LAST_KEY)
    return last ? { token: last, stored: true } : {}
  } catch {
    return {}
  }
}
const writeToken = (t: string) => {
  try {
    sessionStorage.setItem(TOKEN_KEY, t)
    localStorage.setItem(LAST_KEY, t)
  } catch {
    // Storage blocked: a reload makes a new player.
  }
}

/** The battle this browser was last in, and when it last heard of it: a player who closed the tab
 * (or the game) has REJOIN_MS (protocol.ts) to come back to it, so the menus offer that. */
const BATTLE_KEY = accountKey('mvlos.empires.mp.battle')
/** How long a battle waits for a player who stepped away, in words: "3 minutes". */
export const REJOIN_WAIT = `${REJOIN_MS / 60_000} minutes`
function keepBattle(id: string | null) {
  try {
    if (id) localStorage.setItem(BATTLE_KEY, JSON.stringify({ id, at: Date.now() }))
    else localStorage.removeItem(BATTLE_KEY)
  } catch {
    // Storage blocked: the menus just don't offer to rejoin.
  }
}
/** Whether a battle this browser was in may still be waiting for us. */
export function battleToRejoin(): boolean {
  try {
    const b = JSON.parse(localStorage.getItem(BATTLE_KEY) ?? 'null') as { id: string; at: number } | null
    return !!b && Date.now() - b.at < REJOIN_MS
  } catch {
    return false
  }
}

/** Asks the server whether a battle is waiting for us: for this browser's player (its last token),
 * or signed in, for the account's player on another device. Null when it can't say (offline). */
export async function awayBattle(): Promise<boolean | null> {
  try {
    return (await api<{ battle: boolean }>('/api/empires/away', { method: 'POST', json: { token: readToken().token ?? null } })).battle
  } catch {
    return null
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
  view: NetView = {
    status: 'connecting', me: null, suggestion: '', login: null, lobbies: [], lobby: null, chat: [], problem: null, rtt: 0, match: null, roster: null, away: [], restarting: false, outdated: false, lost: null, claiming: null, nameNote: null,
  }
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
  /** The battle in `view.match` has ended on the server (its result is up). */
  private over = false
  /** The lobby's last notice ("The battle reached its time limit"), to say why a battle ended. */
  private lastNotice = ''

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
      case 'ready': {
        // Asked for a name again although we had one: the server doesn't know us any more, and
        // whatever we were in is gone with us.
        const why = this.view.match && !this.over ? (this.view.restarting ? 'The server restarted and lost this battle.' : 'The server no longer has this battle: the connection was gone too long.')
          : this.view.lobby ? (this.view.restarting ? 'The server restarted and lost the battle you were setting up.' : 'The server no longer has the battle you were setting up: the connection was gone too long.')
          : null
        keepBattle(null)
        return this.patch({ me: null, suggestion: m.suggestion, login: m.login, lobby: null, chat: [], away: [], ...(why ? { lost: { why } } : {}) })
      }
      case 'welcome':
        return this.patch({ me: { id: m.id, name: m.name }, claiming: null, nameNote: null })
      case 'refused':
        if (this.view.claiming)
          return this.patch({ claiming: null, suggestion: m.suggestion, nameNote: `${this.view.claiming}, the name you used last time, can't be used right now: ${m.why.charAt(0).toLowerCase()}${m.why.slice(1)}.` })
        return this.patch({ suggestion: m.suggestion, problem: { why: m.why, n: (this.view.problem?.n ?? 0) + 1 } })
      case 'lobbies':
        return this.patch({ lobbies: m.list })
      case 'lobby': {
        // No battle of ours there (any more): nothing to offer rejoining.
        if (!m.lobby || m.lobby.state === 'open') keepBattle(null)
        // Our battle's lobby open again (or gone) before the battle ended: the server stopped it
        // (a time limit, an error), or it was lost while we were away.
        const ended = !!this.view.match && !this.over && (!m.lobby || m.lobby.state === 'open')
        // A new lobby (or none) starts with an empty chat.
        return this.patch({
          lobby: m.lobby,
          chat: m.lobby && m.lobby.id === this.view.lobby?.id ? this.view.chat : [],
          ...(ended ? { lost: { why: m.why ?? (this.lastNotice ? `${this.lastNotice}.` : 'The server no longer has this battle.') }, away: [] } : {}),
          // Out of a battle while away, seen from a fresh start (the tab was closed): a toast.
          ...(!ended && m.why ? { problem: { why: m.why, n: (this.view.problem?.n ?? 0) + 1 } } : {}),
        })
      }
      case 'chat':
        if (!m.from) this.lastNotice = m.text
        return this.patch({ chat: [...this.view.chat, { from: m.from, text: m.text, at: m.at }].slice(-CHAT_KEEP) })
      case 'kicked':
      case 'error':
        return this.patch({ problem: { why: m.why, n: (this.view.problem?.n ?? 0) + 1 } })
      case 'match':
        this.turns = []
        // The same battle again (we reconnected): keep the screen, a sync follows.
        if (this.view.match?.info.id === m.match.id && this.view.match.me === m.me) return
        this.sync = null
        this.over = false
        this.lastNotice = ''
        keepBattle(m.match.id)
        return this.patch({ match: { info: m.match, me: m.me }, roster: null, away: [], lost: null })
      case 'roster':
        if (this.view.match) keepBattle(this.view.match.info.id)
        return this.patch({ roster: m.seats, away: m.away ?? [] })
      case 'over':
        this.over = true
        keepBattle(null)
        return
      case 'turn':
        if (this.view.match) this.turns.push({ n: m.n, c: m.c, ...(m.ai ? { ai: m.ai } : {}), ...(m.give ? { give: m.give } : {}) })
        if (this.view.match && m.n % 150 === 0) keepBattle(this.view.match.info.id)
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
    keepBattle(null)
    this.patch({ match: null, roster: null, away: [], lost: null })
  }

  /** The "the server lost it" notice has been read. */
  dismissLost() {
    keepBattle(null)
    this.patch({ lost: null })
  }

  /** Out of the lobby (and its battle, if one is on): straight to the list, without waiting for
   * the server to say so. */
  leave() {
    this.send({ t: 'leave' })
    this.turns = []
    this.sync = null
    keepBattle(null)
    this.patch({ match: null, roster: null, lobby: null, chat: [], away: [], lost: null })
  }

  /** In a battle that's still on: closing the game then only steps away from it (see leave). */
  inBattle() {
    return !!this.view.match && !this.over && !this.view.lost
  }

  /** About the player in `seat`, who stepped away: wait for them, or carry on without them. */
  vote(seat: number, v: AwayVote) {
    this.send({ t: 'vote', seat, v })
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
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, ...readToken() } satisfies ClientMsg))
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
        // A name just taken is the one to take by itself next time (also on another device, signed
        // in). Coming back as the same player leaves it be: it was kept when taken, and may since
        // have been changed or forgotten in Settings, for the next new start.
        if (!m.resumed) mpName.set(m.name)
      }
      if (m.t === 'welcome' || m.t === 'ready') this.setStatus('online')
      this.track(m)
      // Back from the restart (`track` needed to know it was one, to say what was lost).
      if ((m.t === 'welcome' || m.t === 'ready') && this.view.restarting) this.patch({ restarting: false })
      for (const fn of [...this.listeners]) fn(m)
      // A new player here: take the name used last time straight away, if there is one. Taken by
      // someone online right now, the join screen says so and offers it again to try.
      if (m.t === 'ready') void this.reclaim(ws)
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      clearInterval(this.pingTimer)
      this.pings.clear()
      // 4000: another connection of ours took over (a reload); this one is done.
      if (e.code === 4000) this.closed = true
      // Another version of the game than the server's: trying again won't help, reloading will.
      if (e.code === OUTDATED_CODE) {
        this.closed = true
        this.patch({ outdated: true })
        this.setStatus('offline')
      }
      if (this.closed) return
      if (e.code === RESTART_CODE) this.patch({ restarting: true })
      this.setStatus('offline')
      // Back off: 0.5, 1, 2, 4, then every 5 seconds.
      const wait = Math.min(5000, 500 * 2 ** this.retry++)
      this.retryTimer = window.setTimeout(() => this.open(), wait)
    }
  }

  /** Claims the remembered name by itself, once it's known; with none, the join screen asks. */
  private async reclaim(ws: WebSocket) {
    const now = mpName.get()
    this.patch({ claiming: now ?? '', nameNote: null })
    const name = now ?? (await recallName())
    // Gone meanwhile (a new connection asks again), or a name taken some other way.
    if (this.ws !== ws || this.view.me) return
    if (!name) return this.patch({ claiming: null })
    this.patch({ claiming: name })
    this.send({ t: 'claim', name })
  }

  private ping() {
    const n = ++this.pingN
    this.pings.set(n, performance.now())
    // Pings that never came back don't pile up.
    if (this.pings.size > 10) this.pings.delete(this.pings.keys().next().value!)
    this.send({ t: 'ping', n, ...(this.rtt ? { rtt: Math.round(this.rtt) } : {}) })
  }
}
