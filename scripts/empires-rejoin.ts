// Checks stepping away from an Empires At War battle and coming back: it starts the real server
// (with the minute to rejoin cut to a few seconds) and plays a 2 v 2 with four scripted players,
// Alpha and Charlie against Bravo and Delta. In turn:
//
//   a. Bravo drops: the others see it away with a deadline, and the ticks stop. Bravo comes back
//      from a "new tab" (the browser's last token) and picks the battle up; it carries on in sync.
//   b. Delta drops and nobody votes: when time runs out, an AI admiral takes Delta's fleet and the
//      battle carries on. Delta, coming back too late, is told why.
//   c. Charlie drops: Alpha votes to take over Charlie's fleet, Bravo votes for the AI (no
//      decision, still waiting), then Bravo agrees: Alpha gets Charlie's ships and credits, on
//      every machine at the same tick.
//   d. Bravo drops again, and Alpha, the only one left, votes for the AI: the battle goes on.
//
// All along, every fingerprint must match the server's.
//
//   node scripts/empires-rejoin.ts
//
// Exits 1 on any failure.

import { Bot, Server, check, compare, finish, sleep, startBattle, waitFor, type Msg } from './empires-harness.ts'

const REJOIN = 6000
const server = new Server({ EMPIRES_REJOIN_MS: String(REJOIN) })
await server.start()
const tag = Math.floor(Math.random() * 900 + 100)
const [a, b, c, d] = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((n) => new Bot(server, `${n} ${tag}`).connect())
await waitFor('four players get a name', () => [a, b, c, d].every((p) => p.token))
await startBattle(a, [b, c, d], 'vanth')
check(`Alpha and Charlie against Bravo and Delta (seats ${[a, b, c, d].map((p) => p.me).join(', ')})`, a.w!.players[a.me].team === a.w!.players[c.me].team && a.w!.players[b.me].team === a.w!.players[d.me].team && a.w!.players[a.me].team !== a.w!.players[b.me].team)
const busy = [a, b, c, d].map((p) => p.busy())
await sleep(3000)

const awayIn = (p: Bot, seat: number) => (p.roster?.away ?? []).find((x: Msg) => x.seat === seat)
const status = (p: Bot, seat: number) => p.roster?.seats[seat]?.status
/** No turns for a while: the battle waits. */
async function stands(what: string, p: Bot, ms = 1200) {
  const n = p.n
  await sleep(ms)
  check(what, p.n === n)
}
const moves = async (what: string, p: Bot) => {
  const n = p.n
  await waitFor(what, () => p.n > n + 20, 4000)
}

// --- a. Away and back ---------------------------------------------------------------------------------

b.ws.close()
await waitFor('the others see Bravo away, with a deadline about a minute (here: 6 s) off', () => {
  const x = awayIn(a, b.me)
  return !!x && x.deadline > Date.now() + REJOIN / 2 && x.deadline <= Date.now() + REJOIN + 1000 && !!awayIn(c, b.me)
})
await stands('no turns run while Bravo is away', a)
const ib = b.seen.length
// From a newly opened tab: the browser's last token, which a tab still connected with it keeps.
const probe = new Bot(server, 'Probe')
probe.token = a.token
probe.connect(a.token, true)
await waitFor("the browser's last token doesn't take over a tab still playing with it", () => probe.seen.some((m) => m.t === 'ready'))
probe.ws.close()
b.connect(b.token, true)
await waitFor('Bravo, back from a new tab, is the same player', () => b.since(ib).some((m) => m.t === 'welcome' && m.resumed))
await waitFor("Bravo gets the server's battle (rejoin sync)", () => b.since(ib).some((m) => m.t === 'sync' && m.why === 'rejoin'))
await moves('the battle carries on once Bravo is back', a)
check('the others see Bravo playing again', status(a, b.me) === 'playing' && !a.roster?.away)
const rejoinedAt = b.since(ib).find((m) => m.t === 'sync')!.n
await sleep(2500)

// --- b. Time runs out ---------------------------------------------------------------------------------

d.ws.close()
await waitFor('the others see Delta away', () => !!awayIn(a, d.me))
await stands('no turns run while Delta is away', a, 2000)
await waitFor("when time runs out, an AI admiral takes Delta's fleet", () => a.handovers.some((m) => m.ai?.some(([s]: [number]) => s === d.me)), REJOIN + 3000)
check('the others see Delta out, handed to the AI', status(a, d.me) === 'dropped' && a.roster?.seats[d.me].to === undefined)
await moves('the battle carries on without Delta', a)
const id = d.seen.length
d.connect(d.token)
await waitFor('Delta, back too late, is told why it is out of the battle', () => d.since(id).some((m) => m.t === 'lobby' && m.lobby === null && /away too long/.test(m.why ?? '')))
d.ws.close()

// --- c. A teammate takes over -------------------------------------------------------------------------

const shipsOf = (p: Bot, seat: number) => p.w!.units.filter((u) => !u.dead && u.owner === seat && u.t.tier !== 'station' && u.t.tier !== 'mine' && u.t.tier !== 'defense').length
c.ws.close()
await waitFor('the others see Charlie away', () => !!awayIn(a, c.me) && !!awayIn(b, c.me))
b.send({ t: 'vote', seat: c.me, v: b.me })
await waitFor("an enemy can't take over Charlie's fleet", () => b.seen.some((m) => m.t === 'error' && /take over/.test(m.why)))
a.send({ t: 'vote', seat: c.me, v: a.me })
b.send({ t: 'vote', seat: c.me, v: 'ai' })
await waitFor('everyone sees who voted what', () => {
  const v = awayIn(a, c.me)?.votes ?? []
  return v.some(([s, x]: [number, unknown]) => s === a.me && x === a.me) && v.some(([s, x]: [number, unknown]) => s === b.me && x === 'ai')
})
await stands('votes that differ decide nothing: the battle still waits', a)
const charlieShips = shipsOf(a, c.me)
const alphaShips = shipsOf(a, a.me)
const charlieCredits = a.w!.players[c.me].credits
b.send({ t: 'vote', seat: c.me, v: a.me })
await waitFor("once both agree, Alpha takes over Charlie's fleet (one turn, on every machine)", () =>
  [a, b].every((p) => p.handovers.some((m) => m.give?.some(([f, t]: [number, number]) => f === c.me && t === a.me))),
)
await sleep(300)
check(`Charlie's ${charlieShips} ships are Alpha's now (Alpha had ${alphaShips}, Charlie has ${shipsOf(a, c.me)} left)`, shipsOf(a, c.me) === 0 && shipsOf(b, c.me) === 0 && charlieShips > 0)
check(`and Charlie's credits (${Math.round(charlieCredits)}) with them`, a.w!.players[c.me].credits < charlieCredits)
check("an AI admiral runs Charlie's base", a.brains!.some((x) => x.o === c.me) && status(a, c.me) === 'dropped' && a.roster?.seats[c.me].to === a.me)
await moves('the battle carries on', b)
const ic = c.seen.length
c.connect(c.token)
await waitFor("Charlie, back later, is told Alpha took over its fleet", () => c.since(ic).some((m) => m.t === 'lobby' && m.lobby === null && (m.why ?? '').includes(a.name)))
c.ws.close()
await sleep(2000)

// --- d. The only one left votes for the AI ------------------------------------------------------------

const before = { a: a.hashes.size }
b.ws.close()
await waitFor('Alpha sees Bravo away', () => !!awayIn(a, b.me))
a.send({ t: 'vote', seat: b.me, v: 'ai' })
await waitFor("Alpha's vote alone decides: an AI admiral takes Bravo's fleet", () => a.handovers.some((m) => m.ai?.some(([s]: [number]) => s === b.me)), 3000)
await moves('the battle carries on', a)
await sleep(2000)
busy.forEach((f) => f())

// --- In sync all along ---------------------------------------------------------------------------------

const [same, differ] = compare([a, b], rejoinedAt)
check(`${same} fingerprints equal between Alpha and Bravo after Bravo rejoined`, same > 5 && differ === 0)
check("nobody drifted from the server's battle (it checks every fingerprint)", ![a, b, c, d].some((p) => p.seen.some((m) => m.t === 'desync')))
check('Alpha kept sending fingerprints to the end', a.hashes.size > before.a)
console.log(`played to tick ${a.n}`)
for (const p of [a, b, c, d]) p.ws.close()
await server.dispose()
finish()
