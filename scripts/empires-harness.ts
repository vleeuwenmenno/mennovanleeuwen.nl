// What the Empires At War multiplayer checks that run their own server share (empires-restart.ts,
// empires-rejoin.ts): the real server (server/index.ts) on a free port with a scratch DATA_DIR,
// scripted players that play the battle in lockstep like the game does, and PASS/FAIL reporting.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UNIT } from '../src/apps/games/empires/data.ts'
import { cmd } from '../src/apps/games/empires/commands.ts'
import { matchBrains, matchWorld, stepTurn, type MatchInfo } from '../src/apps/games/empires/match.ts'
import { HASH_EVERY } from '../src/apps/games/empires/protocol.ts'
import { restoreBrain, restoreWorld } from '../src/apps/games/empires/snapshot.ts'
import { stateHash, type World } from '../src/apps/games/empires/sim.ts'
import type { Brain } from '../src/apps/games/empires/ai.ts'

export type Msg = Record<string, any>

// --- Reporting ---------------------------------------------------------------------------------------

let failed = false
export const fail = (why: string) => {
  console.error('FAIL', why)
  failed = true
}
export const ok = (what: string) => console.log('PASS', what)
export const check = (what: string, test: boolean) => (test ? ok(what) : fail(what))
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export async function waitFor(what: string, test: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return ok(what)
    await sleep(50)
  }
  fail(`${what} (timed out)`)
}
/** Prints the verdict and exits 1 on any failure. */
export function finish() {
  console.log(failed ? 'FAILED' : 'all passed')
  process.exit(failed ? 1 : 0)
}

// --- The server --------------------------------------------------------------------------------------

export class Server {
  readonly data = mkdtempSync(join(tmpdir(), 'empires-check-'))
  port = 0
  url = ''
  origin = ''
  log = ''
  private child: ChildProcess | null = null
  private env: Record<string, string>

  constructor(env: Record<string, string> = {}) {
    this.env = env
  }

  async start() {
    if (!this.port) {
      this.port = await new Promise<number>((resolve) => {
        const s = createServer().listen(0, () => {
          const p = (s.address() as { port: number }).port
          s.close(() => resolve(p))
        })
      })
      this.url = `ws://localhost:${this.port}/api/empires/ws`
      this.origin = `http://localhost:${this.port}`
    }
    this.log = ''
    const child = spawn(process.execPath, ['server/index.ts'], {
      env: { ...process.env, PORT: String(this.port), DATA_DIR: this.data, MC_WATCH: 'off', NODE_ENV: 'test', ...this.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout!.on('data', (d) => (this.log += d))
    child.stderr!.on('data', (d) => (this.log += d))
    const end = Date.now() + 15_000
    while (!this.log.includes(`on :${this.port}`)) {
      if (Date.now() > end || child.exitCode !== null) throw new Error(`the server didn't start:\n${this.log}`)
      await sleep(50)
    }
  }

  get running() {
    return !!this.child
  }

  /** SIGTERM, as Docker sends it; resolves with the exit code and how long it took. */
  async stop() {
    const child = this.child!
    const t = performance.now()
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)))
    child.kill('SIGTERM')
    const code = await Promise.race([exited, sleep(8000).then(() => 'timeout' as const)])
    if (code === 'timeout') child.kill('SIGKILL')
    this.child = null
    return { code, ms: performance.now() - t }
  }

  async dispose() {
    if (this.child) await this.stop()
    rmSync(this.data, { recursive: true, force: true })
  }
}

// --- The players -------------------------------------------------------------------------------------

/** A scripted player: claims its name, and plays any battle it's in, in lockstep. */
export class Bot {
  name: string
  ws!: WebSocket
  token = ''
  w?: World
  brains?: Brain[]
  me = -1
  n = 0
  hashes = new Map<number, number>()
  /** Every message but the chatty ones (turns, pongs, lists, chat). */
  seen: Msg[] = []
  /** The last player list, and when the last turn came. */
  roster: Msg | null = null
  lastTurnAt = 0
  /** Turns that handed a seat to an AI or a teammate. */
  handovers: Msg[] = []
  closeCode = 0
  onLobby?: (l: Msg) => void
  private server: Server

  constructor(server: Server, name: string) {
    this.server = server
    this.name = name
  }

  /** `stored`: the token is the browser's last one, as a newly opened tab sends it. */
  connect(token?: string, stored = false) {
    const ws = new WebSocket(this.server.url, { headers: { Origin: this.server.origin } } as any)
    this.ws = ws
    this.closeCode = 0
    ws.onopen = () => this.send({ t: 'hello', ...(token ? { token } : {}), ...(stored ? { stored } : {}) })
    ws.onmessage = (e) => this.handle(JSON.parse(String(e.data)))
    ws.onclose = (e) => (this.closeCode = e.code)
    return this
  }

  send(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m))
  }

  /** Messages since `i` (an index into `seen`). */
  since(i: number) {
    return this.seen.slice(i)
  }

  private handle(m: Msg) {
    if (m.t !== 'turn' && m.t !== 'pong' && m.t !== 'lobbies' && m.t !== 'chat') this.seen.push(m)
    if (m.t === 'ready' && !this.token) this.send({ t: 'claim', name: this.name })
    else if (m.t === 'welcome') this.token = m.token
    else if (m.t === 'lobby' && m.lobby) this.onLobby?.(m.lobby)
    else if (m.t === 'roster') this.roster = m
    else if (m.t === 'match') {
      if (this.w && this.me === m.me) return // the same battle, after a reconnect: a sync follows
      const info = m.match as MatchInfo
      this.w = matchWorld(info)
      this.brains = matchBrains(info)
      this.me = m.me
      this.send({ t: 'loaded' })
    } else if (m.t === 'sync') {
      this.w = restoreWorld(m.world)!
      this.brains = m.brains.map(restoreBrain)
      this.n = m.n
    } else if (m.t === 'turn') {
      if (m.n !== this.n + 1) fail(`${this.name} got turn ${m.n} after ${this.n}`)
      this.n = m.n
      this.lastTurnAt = performance.now()
      if (m.ai || m.give) this.handovers.push(m)
      stepTurn(this.w!, this.brains!, m)
      this.w!.events.length = 0
      if (m.n % HASH_EVERY === 0) {
        const h = stateHash(this.w!)
        this.hashes.set(m.n, h)
        this.send({ t: 'hash', n: m.n, h })
      }
    }
  }

  /** Gives orders now and then, as a real player would; returns the stopper. */
  busy() {
    let k = 0
    const id = setInterval(() => {
      const w = this.w
      if (!w || this.ws.readyState !== WebSocket.OPEN || this.me < 0) return
      const mine = Object.values(UNIT).filter((u) => u.faction === w.players[this.me].faction && u.tier === 'fighter' && u.level === 1)
      const ships = w.units.filter((u) => !u.dead && u.owner === this.me && u.t.tier !== 'station' && u.t.tier !== 'mine' && u.t.tier !== 'defense')
      this.send({ t: 'cmd', c: k++ % 2 === 0 ? cmd('build', mine[k % mine.length].id) : cmd('move', ships.map((u) => u.id), Math.round(Math.random() * w.w), Math.round(Math.random() * w.h), false) })
    }, 500)
    return () => clearInterval(id)
  }
}

/** Fingerprints at ticks every bot in `bots` has, after `after`: [how many, how many differ]. */
export function compare(bots: Bot[], after: number) {
  const common = [...bots[0].hashes.keys()].filter((n) => n > after && bots.every((b) => b.hashes.has(n)))
  const differ = common.filter((n) => bots.some((b) => b.hashes.get(n) !== bots[0].hashes.get(n)))
  return [common.length, differ.length] as const
}

/** `host` sets up a battle on `map` (spawns not taken stay open, then close), everyone else joins
 * and gets ready, and it starts. Resolves once every bot has played a turn. */
export async function startBattle(host: Bot, others: Bot[], map?: string) {
  await new Promise<void>((done) => {
    let step = 0
    host.onLobby = (l) => {
      if (step === 0) {
        step = 1
        if (map) host.send({ t: 'setup', map })
        else host.onLobby!(l)
      } else if (step === 1 && (!map || l.map === map)) {
        step = 2
        for (const b of others) b.send({ t: 'join', id: l.id })
      } else if (step === 2 && others.every((b) => l.slots.some((s: Msg) => s.name === b.name))) {
        step = 3
        // Whatever is still open is closed, so the battle is just these players.
        l.slots.forEach((s: Msg, i: number) => s.kind === 'open' && host.send({ t: 'slot', i, patch: { kind: 'closed' } }))
        done()
      }
    }
    host.send({ t: 'create' })
  })
  await Promise.all(
    others.map(
      (b) =>
        new Promise<void>((done) => {
          b.onLobby = (l) => {
            const i = l.slots.findIndex((s: Msg) => s.name === b.name)
            if (i < 0) return
            if (l.slots[i].ready) done()
            else b.send({ t: 'ready', on: true })
          }
          b.send({ t: 'ready', on: true })
        }),
    ),
  )
  host.onLobby = undefined
  for (const b of others) b.onLobby = undefined
  host.send({ t: 'start' })
  await waitFor('the battle starts for everyone', () => [host, ...others].every((b) => b.n > 0), 25_000)
}
