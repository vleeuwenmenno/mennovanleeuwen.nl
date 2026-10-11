// Plays a real multiplayer battle against a running server with two scripted players (and two AI
// seats), to check the lockstep: both players and the server must stay identical while orders
// fly, and orders must come back quickly.
//
//   node scripts/empires-match.ts [seconds] [ws://localhost:5173/api/empires/ws]
//
// Prints the order round trip (sent to seen in a turn), turn arrival jitter, and whether anyone
// drifted. Exits 1 on a drift or a gap in the turns.

import { UNIT } from '../src/apps/games/empires/data.ts'
import { cmd, type Cmd } from '../src/apps/games/empires/commands.ts'
import { matchBrains, matchWorld, stepTurn, type MatchInfo } from '../src/apps/games/empires/match.ts'
import { HASH_EVERY } from '../src/apps/games/empires/protocol.ts'
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

type Player = {
  name: string
  ws: WebSocket
  send: (m: unknown) => void
  w?: World
  brains?: Brain[]
  me?: number
  n: number
  hashes: Map<number, number>
  sent: Map<string, { at: number; n: number }>
  rtts: number[]
  /** Ticks between the last turn seen when an order was sent and the turn that carried it. */
  lag: number[]
  gaps: number[]
  lastTurnAt: number
  onLobby?: (l: Msg) => void
  started?: () => void
}

function player(name: string): Promise<Player> {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL_, { headers: { Origin: ORIGIN } } as any)
    const p: Player = { name, ws, send: (m) => ws.send(JSON.stringify(m)), n: 0, hashes: new Map(), sent: new Map(), rtts: [], lag: [], gaps: [], lastTurnAt: 0 }
    ws.onopen = () => p.send({ t: 'hello' })
    ws.onmessage = (e) => {
      const m: Msg = JSON.parse(String(e.data))
      if (m.t === 'ready') p.send({ t: 'claim', name })
      else if (m.t === 'welcome') resolve(p)
      else if (m.t === 'lobby' && m.lobby) p.onLobby?.(m.lobby)
      else if (m.t === 'match') {
        const info = m.match as MatchInfo
        p.w = matchWorld(info)
        p.brains = matchBrains(info)
        p.me = m.me
        p.send({ t: 'loaded' })
        p.started?.()
      } else if (m.t === 'turn') {
        const now = performance.now()
        if (p.lastTurnAt) p.gaps.push(now - p.lastTurnAt)
        p.lastTurnAt = now
        if (m.n !== p.n + 1) fail(`${name} got turn ${m.n} after ${p.n}`)
        p.n = m.n
        for (const [seat, c] of m.c as [number, Cmd][]) {
          const key = JSON.stringify(c)
          if (seat === p.me && p.sent.has(key)) {
            const s = p.sent.get(key)!
            p.rtts.push(now - s.at)
            p.lag.push(m.n - s.n)
            p.sent.delete(key)
          }
        }
        stepTurn(p.w!, p.brains!, m.c)
        p.w!.events.length = 0
        if (m.n % HASH_EVERY === 0) {
          const h = stateHash(p.w!)
          p.hashes.set(m.n, h)
          p.send({ t: 'hash', n: m.n, h })
        }
      } else if (m.t === 'desync') fail(`server says ${name} drifted at tick ${m.n}`)
      else if (m.t === 'error') console.log(`${name} error:`, m.why)
      else if (m.t === 'over') console.log(`${name}: battle over, team ${m.winner} won`)
    }
  })
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
    if (l.slots[i].faction !== 'droid') b.send({ t: 'slot', i, patch: { faction: 'droid' } })
    else if (!l.slots[i].ready) b.send({ t: 'ready', on: true })
    else done()
  }
  b.send({ t: 'ready', on: false })
})
const started = Promise.all([a, b].map((p) => new Promise<void>((r) => (p.started = r))))
a.send({ t: 'start' })
await started
console.log(`battle ${lobbyId} started: ${seconds} s of play`)

// Each player keeps busy: builds ships, sends the fleet about, now and then something odd.
const busy = (p: Player) => {
  const mine = Object.values(UNIT).filter((u) => u.faction === p.w!.players[p.me!].faction && (u.tier === 'fighter' || u.tier === 'gunship') && u.level === 1)
  let k = 0
  return setInterval(() => {
    const w = p.w!
    const ships = w.units.filter((u) => !u.dead && u.owner === p.me && u.t.tier !== 'station' && u.t.tier !== 'mine')
    const c =
      k++ % 3 === 0
        ? cmd('build', mine[k % mine.length].id)
        : cmd('move', ships.map((u) => u.id), Math.round(Math.random() * w.w), Math.round(Math.random() * w.h), k % 2 === 0)
    p.sent.set(JSON.stringify({ f: c.f, a: c.f === 'build' ? [c.a[0], false] : [...c.a, false].slice(0, 5) }), { at: performance.now(), n: p.n })
    p.send({ t: 'cmd', c })
    // A tampered client: someone else's ships, a nonsense unit. The server must drop these.
    if (k % 7 === 0) p.send({ t: 'cmd', c: { f: 'build', a: ['not-a-ship'] } })
    if (k % 11 === 0) p.send({ t: 'cmd', c: { f: 'move', a: [[1, 2, 3], 'x', NaN] } })
  }, 700)
}
const timers = [busy(a), busy(b)]
await new Promise((r) => setTimeout(r, seconds * 1000))
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
  const lags = new Map<number, number>()
  for (const l of p.lag) lags.set(l, (lags.get(l) ?? 0) + 1)
  console.log(`  orders landed in the turn after the last one seen + ${[...lags].sort((x, y) => x[0] - y[0]).map(([l, c]) => `${l - 1}: ${c}x`).join(', ')}`)
}
const common = [...a.hashes.keys()].filter((n) => b.hashes.has(n))
const differ = common.filter((n) => a.hashes.get(n) !== b.hashes.get(n))
if (differ.length) fail(`players differ at ticks ${differ.slice(0, 5).join(', ')}`)
console.log(`${common.length} fingerprints compared between the players${differ.length ? '' : ', all equal'}; the server checked each player's too`)
a.send({ t: 'leave' })
b.send({ t: 'leave' })
setTimeout(() => process.exit(failed ? 1 : 0), 300)
