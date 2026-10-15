// Checks sending credits to an ally in Empires At War.
//
//   1. The sim alone: a gift moves exactly that many credits and is logged on both sides; gifts to
//      an enemy, to ourselves, of more than we have, of nothing, a negative or broken number, and a
//      second one within the cooldown are all refused; the order's cleaning turns away what isn't
//      a whole number of credits or a seat. An AI ally takes a gift and spends it, and an AI with
//      plenty helps out a broke human teammate (once, then not again for a while), the same in two
//      copies of the battle.
//   2. Over the network: it starts the real server and plays a 2 v 2 with four scripted players,
//      Alpha and Charlie against Bravo and Delta. Alpha sends Charlie credits; gifts to an enemy, of
//      too much, negative ones and a burst of them are refused by the server (with a reason), as is a
//      repair order on an enemy's station (one on an ally's goes through); and
//      every player's battle stays identical to the server's throughout.
//
//   node scripts/empires-allies.ts
//
// Exits 1 on any failure.

import { AID, aidAllies, newBrain, think, type Brain } from '../src/apps/games/empires/ai.ts'
import { cleanCmd, cmd, runCmd } from '../src/apps/games/empires/commands.ts'
import { MAPS } from '../src/apps/games/empires/maps.ts'
import { GIFT_COOLDOWN, STEP, cantGive, newWorld, stateHash, tick, type World } from '../src/apps/games/empires/sim.ts'
import { Bot, Server, check, compare, finish, sleep, startBattle, waitFor } from './empires-harness.ts'

// --- 1. The sim -----------------------------------------------------------------------------------------

const map = MAPS.find((m) => m.spawns.length === 4) ?? MAPS[0]
/** Seat 0 is a person; 1 its AI ally; 2 and 3 the AI enemies. */
const seats = [0, 1, 2, 3].map((i) => ({ faction: i < 2 ? ('republic' as const) : ('droid' as const), team: i < 2 ? 0 : 1, spawn: i }))
const make = () => {
  const w = newWorld(map, seats, { seed: 777, credits: 2000 })
  const brains: Brain[] = [1, 2, 3].map((i) => newBrain(i, 'medium'))
  return { w, brains }
}
const step = (w: World, brains: Brain[], secs: number) => {
  for (let i = 0; i < Math.round(secs / STEP); i++) {
    for (const b of brains) think(w, b, STEP)
    aidAllies(w, brains)
    tick(w)
    w.events.length = 0
  }
}

{
  const { w, brains } = make()
  const me = w.players[0]
  const ally = w.players[1]
  const give = (to: number, amount: unknown) => {
    const c = cleanCmd({ f: 'give', a: [to, amount] }, w)
    return c ? runCmd(w, 0, c) : 'refused by the cleaning'
  }
  check('the order is cleaned: a negative amount never reaches the sim', cleanCmd({ f: 'give', a: [1, -500] }, w) === null)
  check('nor half a credit, a string or a seat that isn\'t there', cleanCmd({ f: 'give', a: [1, 0.5] }, w) === null && cleanCmd({ f: 'give', a: [1, '500'] }, w) === null && cleanCmd({ f: 'give', a: [9, 500] }, w) === null)
  check('nothing at all is refused', !!cantGive(w, 0, 1, 0))
  check('a gift to an enemy is refused', /ally/.test(String(give(2, 300))) && w.players[2].credits === 2000)
  check('a gift to ourselves is refused', !!cantGive(w, 0, 0, 300))
  check('more than we have is refused', /Not enough credits/.test(String(give(1, 2001))) && me.credits === 2000)
  const before = { me: me.credits, ally: ally.credits }
  const r = give(1, 750)
  check(`a gift to the AI ally goes through (${r ?? 'ok'})`, r === null && me.credits === before.me - 750 && ally.credits === before.ally + 750)
  check('and shows in both ledgers, naming the other side', me.ledger.at(-1)?.kind === 'gift' && me.ledger.at(-1)?.amount === -750 && me.ledger.at(-1)?.seat === 1 && ally.ledger.at(-1)?.amount === 750 && ally.ledger.at(-1)?.seat === 0)
  check('a second gift straight after is refused (cooldown)', /Wait a moment/.test(String(give(1, 10))))
  step(w, brains, GIFT_COOLDOWN + 0.1)
  check(`after ${GIFT_COOLDOWN} s the next one goes`, give(1, 10) === null)
  // The AI ally carries on with its gifted credits: it spends them.
  const spentBefore = Object.values(ally.spentBy).reduce((a, b) => a + b, 0)
  step(w, brains, 60)
  const spent = Object.values(ally.spentBy).reduce((a, b) => a + b, 0) - spentBefore
  check(`the AI ally spends the credits it was given (${Math.round(spent)} in a minute)`, spent > 760)
}

{
  // An AI with plenty helps out its broke human teammate: once, then not again for AID.every seconds.
  const a = make()
  const b = make()
  for (const c of [a, b]) {
    c.w.players[0].credits = 0
    c.w.players[1].credits = AID.rich + 2000
  }
  step(a.w, a.brains, 0.5)
  step(b.w, b.brains, 0.5)
  const got = a.w.players[0].got ?? 0
  check(`a rich AI ally sends a broke player ${AID.amount} credits`, got === AID.amount && a.w.players[1].gave === AID.amount)
  check('and it never helps an enemy', !a.w.players[2].got && !a.w.players[3].got)
  a.w.players[0].credits = 0
  a.w.players[1].credits = AID.rich + 2000
  b.w.players[0].credits = 0
  b.w.players[1].credits = AID.rich + 2000
  step(a.w, a.brains, 10)
  step(b.w, b.brains, 10)
  check(`not again within ${AID.every} s`, (a.w.players[0].got ?? 0) === AID.amount)
  check('both copies of the battle agree', stateHash(a.w) === stateHash(b.w))
}

// --- 2. Over the network ---------------------------------------------------------------------------------

const server = new Server()
await server.start()
const tag = Math.floor(Math.random() * 900 + 100)
const [a, b, c, d] = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((n) => new Bot(server, `${n} ${tag}`).connect())
await waitFor('four players get a name', () => [a, b, c, d].every((p) => p.token))
await startBattle(a, [b, c, d], 'vanth')
check('Alpha and Charlie against Bravo and Delta', a.w!.players[a.me].team === a.w!.players[c.me].team && a.w!.players[a.me].team !== a.w!.players[b.me].team)
const busy = [b, d].map((p) => p.busy())
await sleep(1500)

const errors = () => a.seen.filter((m) => m.t === 'error').map((m) => String(m.why))
const gift = (to: number, amount: unknown) => a.send({ t: 'cmd', c: { f: 'give', a: [to, amount] } })

const charlie0 = a.w!.players[c.me].credits
a.send({ t: 'cmd', c: cmd('give', c.me, 400) })
await waitFor('Alpha gives Charlie 400 credits, on every copy of the battle', () => [a, b, c, d].every((p) => p.w!.players[c.me].got === 400 && p.w!.players[a.me].gave === 400))
check('Charlie has them', a.w!.players[c.me].credits >= charlie0 + 400 - 1)

let n = errors().length
gift(b.me, 100)
await waitFor('a gift to an enemy is refused by the server, saying why', () => errors().slice(n).some((x) => /ally/.test(x)))
await sleep(1200)
n = errors().length
gift(c.me, Math.floor(a.w!.players[a.me].credits) + 5000)
await waitFor('more credits than Alpha has are refused', () => errors().slice(n).some((x) => /Not enough credits/.test(x)))
n = errors().length
gift(c.me, -300)
await waitFor('a negative gift is refused', () => errors().slice(n).some((x) => /didn't make sense/.test(x)))
n = errors().length
gift(c.me, 12.5)
await waitFor('half credits are refused', () => errors().slice(n).some((x) => /didn't make sense/.test(x)))

// A burst: ten gifts as fast as the socket takes them. At most one a second gets through.
await sleep(1200)
n = errors().length
const gave0 = a.w!.players[a.me].gave ?? 0
for (let i = 0; i < 10; i++) gift(c.me, 10)
await sleep(2500)
const landed = ((a.w!.players[a.me].gave ?? 0) - gave0) / 10
check(`a burst of ten gifts: ${landed} landed, the rest refused (${errors().length - n} refusals)`, landed >= 1 && landed <= 3 && errors().length - n >= 7)

// Repair orders: on an enemy's station refused by the server, saying why; on an ally's, let through
// (the sim then decides on every copy alike; Alpha has nothing that can repair it).
await sleep(1200)
const stationOf = (seat: number) => a.w!.units.find((u) => !u.dead && u.owner === seat && u.t.tier === 'station')!
const mine = a.w!.units.filter((u) => !u.dead && u.owner === a.me && u.t.tier !== 'station').map((u) => u.id).slice(0, 5)
n = errors().length
a.send({ t: 'cmd', c: cmd('mend', mine, stationOf(b.me).id, false) })
await waitFor('a repair order on an enemy\'s station is refused by the server, saying why', () => errors().slice(n).some((x) => /allies/.test(x)))
n = errors().length
a.send({ t: 'cmd', c: cmd('mend', mine, stationOf(c.me).id, false) })
await sleep(1200)
check('one on an ally\'s station goes through', errors().length === n)

await sleep(2000)
busy.forEach((f) => f())
const [same, differ] = compare([a, b, c, d], 0)
check(`${same} fingerprints equal between all four players`, same > 5 && differ === 0)
check("nobody drifted from the server's battle (it checks every fingerprint)", ![a, b, c, d].some((p) => p.seen.some((m) => m.t === 'desync')))
for (const p of [a, b, c, d]) p.ws.close()
await server.dispose()
finish()
