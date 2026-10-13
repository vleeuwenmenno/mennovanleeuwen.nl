// Plays a real multiplayer battle against a running server with two scripted players (and two AI
// seats), to check the lockstep: both players and the server must stay identical while orders
// fly, and orders must come back quickly. Along the way Bravo's game is tampered with (it must be
// put right by the server), Bravo's connection drops and comes back (it must pick the battle up
// again), and finally Bravo leaves (an AI takes over its fleet; Alpha carries on without drifting).
//
//   node scripts/empires-match.ts [seconds] [ws://localhost:5173/api/empires/ws]
//
// Exits 1 on a drift that isn't put right, a gap in the turns, or a missed step.

import { UNIT } from '../src/apps/games/empires/data.ts'
import { cmd, type Cmd } from '../src/apps/games/empires/commands.ts'
import { matchBrains, matchWorld, stepTurn, type MatchInfo } from '../src/apps/games/empires/match.ts'
import { HASH_EVERY } from '../src/apps/games/empires/protocol.ts'
import { restoreBrain, restoreWorld } from '../src/apps/games/empires/snapshot.ts'
import { stateHash, type World } from '../src/apps/games/empires/sim.ts'
import type { Brain } from '../src/apps/games/empires/ai.ts'

const seconds = Number(process.argv[2] ?? 40)
const URL_ = process.argv[3] ?? 'ws://localhost:5173/api/empires/ws'
const ORIGIN = URL_.replace(/^ws/, 'http').replace(/\/api.*/, '')
type Msg = Record<string, any>
let failed = false
const fail = (why: string) => {
  console.error('FAIL', why)
  failed = true
}
const ok = (what: string) => console.log('PASS', what)

type Player = {
  name: string
  ws: WebSocket
  token: string
  send: (m: unknown) => void
  w?: World
  brains?: Brain[]
  me?: number
  n: number
  hashes: Map<number, number>
  sent: Map<string, { at: number; n: number }>
  rtts: number[]
  gaps: number[]
  lastTurnAt: number
  seen: Msg[]
  takeovers: number
  onLobby?: (l: Msg) => void
  started?: () => void
  welcomed?: () => void
}

function connect(p: Player, token?: string) {
  const ws = new WebSocket(URL_, { headers: { Origin: ORIGIN } } as any)
  p.ws = ws
  p.send = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
  ws.onopen = () => p.send({ t: 'hello', ...(token ? { token } : {}) })
  ws.onmessage = (e) => handle(p, JSON.parse(String(e.data)))
}

function handle(p: Player, m: Msg) {
  if (m.t !== 'turn' && m.t !== 'pong' && m.t !== 'lobbies' && m.t !== 'lobby' && m.t !== 'chat') p.seen.push(m)
  if (m.t === 'ready') p.send({ t: 'claim', name: p.name })
  else if (m.t === 'welcome') {
    p.token = m.token
    p.welcomed?.()
  } else if (m.t === 'lobby' && m.lobby) p.onLobby?.(m.lobby)
  else if (m.t === 'match') {
    const info = m.match as MatchInfo
    if (p.w && p.me === m.me) return // the same battle, after a reconnect: a sync follows
    p.w = matchWorld(info)
    p.brains = matchBrains(info)
    p.me = m.me
    p.send({ t: 'loaded' })
    p.started?.()
  } else if (m.t === 'sync') {
    p.w = restoreWorld(m.world)!
    p.brains = m.brains.map(restoreBrain)
    p.n = m.n
    p.lastTurnAt = 0
  } else if (m.t === 'turn') {
    const now = performance.now()
    if (p.lastTurnAt) p.gaps.push(now - p.lastTurnAt)
    p.lastTurnAt = now
    if (m.n !== p.n + 1) fail(`${p.name} got turn ${m.n} after ${p.n}`)
    p.n = m.n
    if (m.ai) p.takeovers += m.ai.length
    for (const [seat, c] of m.c as [number, Cmd][]) {
      const key = JSON.stringify(c)
      if (seat === p.me && p.sent.has(key)) {
        p.rtts.push(now - p.sent.get(key)!.at)
        p.sent.delete(key)
      }
    }
    stepTurn(p.w!, p.brains!, m)
    p.w!.events.length = 0
    if (m.n % HASH_EVERY === 0) {
      const h = stateHash(p.w!)
      p.hashes.set(m.n, h)
      p.send({ t: 'hash', n: m.n, h })
    }
  } else if (m.t === 'error') console.log(`${p.name} error:`, m.why)
  else if (m.t === 'over') console.log(`${p.name}: battle over, team ${m.winner} won`)
}

function player(name: string): Promise<Player> {
  const p: Player = { name, ws: null as unknown as WebSocket, token: '', send: () => {}, n: 0, hashes: new Map(), sent: new Map(), rtts: [], gaps: [], lastTurnAt: 0, seen: [], takeovers: 0 }
  return new Promise((resolve) => {
    p.welcomed = () => {
      p.welcomed = undefined
      resolve(p)
    }
    connect(p)
  })
}
/** How the latest player list Alpha got shows Bravo. */
const bravoSeen = () => a.seen.filter((m) => m.t === 'roster').at(-1)?.seats[b.me!]?.status
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (what: string, test: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return ok(what)
    await sleep(50)
  }
  fail(`${what} (timed out)`)
}

const tag = Math.floor(Math.random() * 900 + 100)
const a = await player(`Alpha ${tag}`)
const b = await player(`Bravo ${tag}`)

// Alpha hosts on a four-spawn map with two AI; Bravo joins on the other side.
let lobbyId = ''
await new Promise<void>((done) => {
  let step = 0
  a.onLobby = (l) => {
    lobbyId = l.id
    if (step === 0) {
      step = 1
      a.send({ t: 'setup', map: 'vanth' })
    } else if (step === 1 && l.map === 'vanth') {
      step = 2
      a.send({ t: 'slot', i: 2, patch: { kind: 'ai', difficulty: 'hard' } })
      a.send({ t: 'slot', i: 3, patch: { kind: 'ai', difficulty: 'medium' } })
    } else if (step === 2 && l.slots[3].kind === 'ai') {
      step = 3
      b.send({ t: 'join', id: l.id })
    } else if (step === 3 && l.slots.some((s: Msg) => s.name === b.name)) {
      step = 4
      done()
    }
  }
  a.send({ t: 'create' })
})
await new Promise<void>((done) => {
  b.onLobby = (l) => {
    const i = l.slots.findIndex((s: Msg) => s.name === b.name)
    if (i < 0) return
    if (l.slots[i].faction !== 'droid') b.send({ t: 'slot', i, patch: { faction: 'droid' } })
    else if (!l.slots[i].ready) b.send({ t: 'ready', on: true })
    else done()
  }
  b.send({ t: 'ready', on: false })
})
a.onLobby = b.onLobby = undefined
const started = Promise.all([a, b].map((p) => new Promise<void>((r) => (p.started = r))))
a.send({ t: 'start' })
await started
console.log(`battle ${lobbyId} started: ${seconds} s of play`)

// Each player keeps busy: builds ships, sends the fleet about, now and then something odd.
const busy = (p: Player) => {
  let k = 0
  return setInterval(() => {
    const w = p.w
    if (!w || p.ws.readyState !== WebSocket.OPEN) return
    const mine = Object.values(UNIT).filter((u) => u.faction === w.players[p.me!].faction && (u.tier === 'fighter' || u.tier === 'gunship') && u.level === 1)
    const ships = w.units.filter((u) => !u.dead && u.owner === p.me && u.t.tier !== 'station' && u.t.tier !== 'mine')
    const c =
      k++ % 3 === 0
        ? cmd('build', mine[k % mine.length].id)
        : cmd('move', ships.map((u) => u.id), Math.round(Math.random() * w.w), Math.round(Math.random() * w.h), k % 2 === 0)
    p.sent.set(JSON.stringify({ f: c.f, a: c.f === 'build' ? [c.a[0], false, 0] : [...c.a, false].slice(0, 5) }), { at: performance.now(), n: p.n })
    p.send({ t: 'cmd', c })
    // A tampered client: a nonsense unit, garbage arguments. The server must drop these.
    if (k % 7 === 0) p.send({ t: 'cmd', c: { f: 'build', a: ['not-a-ship'] } })
    if (k % 11 === 0) p.send({ t: 'cmd', c: { f: 'move', a: [[1, 2, 3], 'x', NaN] } })
  }, 700)
}
const timers = [busy(a), busy(b)]
const phase = seconds * 1000 * 0.25

// 1. Bravo's game drifts: the server must notice and send its own battle.
await sleep(phase)
b.w!.players[b.me!].credits += 1
await waitFor("a drifted game gets the server's battle", () => b.seen.some((m) => m.t === 'desync') && b.seen.some((m) => m.t === 'sync' && m.why === 'drift'), 3000)

// 2. Bravo's connection drops for two seconds, then comes back with its token.
await sleep(phase / 2)
const before = b.seen.length
b.ws.close()
await waitFor('the others see a dropped player as away', () => bravoSeen() === 'away', 3000)
await sleep(1500)
connect(b, b.token)
await waitFor('a dropped player is put back in the battle', () => b.seen.slice(before).some((m) => m.t === 'welcome' && m.resumed) && b.seen.slice(before).some((m) => m.t === 'sync' && m.why === 'rejoin'), 5000)
await waitFor('the others see them back', () => bravoSeen() === 'playing', 3000)

// 3. Bravo leaves for good: an AI takes its fleet, and Alpha carries on.
await sleep(phase)
const left = b.n
b.send({ t: 'leave' })
await waitFor("an AI takes over the leaver's fleet", () => a.takeovers === 1, 3000)
await waitFor('the others see that they gave up', () => bravoSeen() === 'left', 3000)
await sleep(phase / 2)
timers.forEach(clearInterval)

const stats = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y)
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN
  return `median ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, max ${at(1).toFixed(1)} ms (${s.length})`
}
for (const p of [a, b]) {
  console.log(`${p.name}: tick ${p.n}, ${p.w!.units.filter((u) => !u.dead).length} units alive`)
  console.log(`  order round trip: ${stats(p.rtts)}`)
  console.log(`  turn spacing:     ${stats(p.gaps)}`)
}
// Fingerprints after the last sync, while both were playing, must all match.
const fixedAt = Math.max(...b.seen.filter((m) => m.t === 'sync').map((m) => m.n))
const common = [...a.hashes.keys()].filter((n) => b.hashes.has(n) && n > fixedAt && n <= left)
const differ = common.filter((n) => a.hashes.get(n) !== b.hashes.get(n))
if (differ.length) fail(`players differ at ticks ${differ.slice(0, 5).join(', ')}`)
else ok(`${common.length} fingerprints after the last sync equal between the players`)
if (a.seen.some((m) => m.t === 'desync')) fail('Alpha drifted from the server')
else ok("Alpha never drifted from the server's battle (it checked every fingerprint)")
a.send({ t: 'leave' })
setTimeout(() => process.exit(failed ? 1 : 0), 300)
