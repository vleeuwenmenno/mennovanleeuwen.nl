// A scripted opponent for trying Empires At War multiplayer alone: it joins the first open
// battle in the list, plays the Confederacy, gets ready, and once the battle starts plays it in
// lockstep like a real player (builds fighters, sends them at the nearest enemy station).
//
//   node scripts/empires-bot.ts [name] [ws://localhost:5173/api/empires/ws]
//
// Host a battle in the game first, then start the bot. Ctrl+C stops it (an AI takes its fleet).

import { UNIT } from '../src/apps/games/empires/data.ts'
import { cmd } from '../src/apps/games/empires/commands.ts'
import { matchBrains, matchWorld, stepTurn } from '../src/apps/games/empires/match.ts'
import { HASH_EVERY, type ClientMsg, type ServerMsg } from '../src/apps/games/empires/protocol.ts'
import { restoreBrain, restoreWorld } from '../src/apps/games/empires/snapshot.ts'
import { stateHash, type World } from '../src/apps/games/empires/sim.ts'
import type { Brain } from '../src/apps/games/empires/ai.ts'

const name = process.argv[2] ?? 'Bot Rook'
const url = process.argv[3] ?? 'ws://localhost:5173/api/empires/ws'
const ws = new WebSocket(url, { headers: { Origin: url.replace(/^ws/, 'http').replace(/\/api.*/, '') } } as unknown as string[])
const send = (m: ClientMsg) => ws.send(JSON.stringify(m))
const say = (...a: unknown[]) => console.log(new Date().toTimeString().slice(0, 8), ...a)

let joined = false
let greeted = false
let w: World | null = null
let brains: Brain[] = []
let me = -1
let n = 0

// Pings like the game does, so the others see its round trip in the player list.
let rtt = 0
const pings = new Map<number, number>()
let pingN = 0
ws.onopen = () => {
  send({ t: 'hello' })
  setInterval(() => {
    pings.set(++pingN, performance.now())
    send({ t: 'ping', n: pingN, ...(rtt ? { rtt: Math.round(rtt) } : {}) })
  }, 2000)
}
ws.onclose = (e) => {
  say('connection closed', e.code, e.reason)
  process.exit()
}
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data)) as ServerMsg
  switch (m.t) {
    case 'pong': {
      const at = pings.get(m.n)
      pings.delete(m.n)
      if (at !== undefined) rtt = performance.now() - at
      return
    }
    case 'ready':
      return send({ t: 'claim', name })
    case 'refused':
      say(`"${name}" refused (${m.why}): playing as ${m.suggestion}`)
      return send({ t: 'claim', name: m.suggestion })
    case 'welcome':
      return say(`online as ${m.name}; waiting for a battle to join`)
    case 'lobbies': {
      const l = !joined && m.list.find((x) => x.state === 'open' && x.players < x.seats)
      if (l) {
        joined = true
        say(`joining ${l.name}`)
        send({ t: 'join', id: l.id })
      }
      return
    }
    case 'lobby': {
      if (!m.lobby) {
        joined = false
        return say('out of the lobby')
      }
      if (m.lobby.state !== 'open') return
      const i = m.lobby.slots.findIndex((s) => s.kind === 'human' && s.name === name)
      if (i < 0) return
      if (!greeted) {
        greeted = true
        send({ t: 'chat', text: "Hello! I'm a bot. I'll take the droids." })
      }
      if (m.lobby.slots[i].faction !== 'droid') send({ t: 'slot', i, patch: { faction: 'droid' } })
      else if (!m.lobby.slots[i].ready) send({ t: 'ready', on: true })
      return
    }
    case 'match':
      if (w && me === m.me) return
      w = matchWorld(m.match)
      brains = matchBrains(m.match)
      me = m.me
      n = 0
      say(`battle on ${m.match.map}, playing seat ${me + 1}`)
      return send({ t: 'loaded' })
    case 'sync':
      w = restoreWorld(m.world)
      brains = m.brains.map(restoreBrain)
      n = m.n
      return say(`picked up the server's battle at tick ${m.n} (${m.why})`)
    case 'turn': {
      if (!w) return
      if (m.n !== n + 1) say(`turn ${m.n} after ${n}: a gap`)
      n = m.n
      stepTurn(w, brains, m, (seat, c, r) => seat === me && typeof r === 'string' && say(`${c.f} refused: ${r}`))
      w.events.length = 0
      if (n % HASH_EVERY === 0) send({ t: 'hash', n, h: stateHash(w) })
      if (n % 90 === 45) play(w)
      return
    }
    case 'desync':
      return say(`drifted at tick ${m.n}; the server will send its battle`)
    case 'over':
      w = null
      return say(`battle over: team ${m.winner} won`)
    case 'chat':
      return m.from && m.from !== name && say(`${m.from}: ${m.text}`)
    case 'error':
    case 'kicked':
      return say(m.why)
  }
}

/** Every three seconds: another fighter, and once there are six, everyone at the enemy. */
function play(w: World) {
  const fighter = Object.values(UNIT).find((u) => u.faction === w.players[me].faction && u.tier === 'fighter' && u.level === 1)
  if (fighter) send({ t: 'cmd', c: cmd('build', fighter.id) })
  const ships = w.units.filter((u) => !u.dead && u.owner === me && u.t.tier !== 'station' && u.t.tier !== 'mine' && u.t.tier !== 'defense')
  const home = w.byId.get(w.players[me].station)
  const foes = w.units.filter((u) => !u.dead && u.t.tier === 'station' && w.players[u.owner].team !== w.players[me].team)
  const foe = home ? foes.sort((a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y))[0] : foes[0]
  if (foe && ships.length >= 6) send({ t: 'cmd', c: cmd('move', ships.map((u) => u.id), foe.x, foe.y, true) })
}
