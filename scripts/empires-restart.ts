// Checks that Empires At War multiplayer survives a server restart (a deploy): it starts the real
// server (server/index.ts) on a free port with a scratch DATA_DIR, plays a battle with two scripted
// players, stops the server with SIGTERM, starts a new one on the same DATA_DIR, and brings both
// players back with their tokens. They must be welcomed back as themselves, get the server's battle
// (a `rejoin` sync), find it waiting while one of them is still away (with nobody counting down
// until the first is back), and then play on with every fingerprint matching the server's. Last, a
// stale, a garbled and another version's state file must be ignored.
//
//   node scripts/empires-restart.ts [seconds of play on each side of the restart]
//
// Exits 1 on any failure.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bot, Server, check, compare, finish, sleep, startBattle, waitFor } from './empires-harness.ts'

const seconds = Number(process.argv[2] ?? 6)
const server = new Server()
const STATE = join(server.data, 'empires-state.json')
const tag = () => Math.floor(Math.random() * 900 + 100)

// --- 1. A battle under way -------------------------------------------------------------------------

await server.start()
const a = new Bot(server, `Alpha ${tag()}`).connect()
const b = new Bot(server, `Bravo ${tag()}`).connect()
await waitFor('both players get a name', () => !!a.token && !!b.token)
await startBattle(a, [b])
let stop = [a.busy(), b.busy()]
await sleep(seconds * 1000)
stop.forEach((f) => f())
const before = a.n
console.log(`played to tick ${a.n} before the restart`)

// --- 2. The restart --------------------------------------------------------------------------------

const stopped = await server.stop()
check(`the server exits cleanly on SIGTERM (code ${stopped.code}, ${Math.round(stopped.ms)} ms)`, stopped.code === 0 && stopped.ms < 3000)
await waitFor('players are told the server is restarting (close code 1012)', () => a.closeCode === 1012 && b.closeCode === 1012, 2000)
check('the state is saved to DATA_DIR', existsSync(STATE))
const saved = JSON.parse(readFileSync(STATE, 'utf8'))
check(`the state file is versioned and small (${(readFileSync(STATE).length / 1024).toFixed(0)} KB)`, saved.v === 2 && saved.players.length === 2 && saved.lobbies.length === 1 && saved.matches.length === 1)
const savedAt = saved.matches[0].n
// Kept for the stale-file checks at the end.
const good = readFileSync(STATE, 'utf8')

await sleep(1500) // the deploy
await server.start()
check('the new server says it carried the battle over', server.log.includes('carried over a restart'))
check('the state file is deleted once read', !existsSync(STATE))

// Alpha comes back first: welcomed as the same player, in the battle, which waits for Bravo.
const ia = a.seen.length
a.connect(a.token)
await waitFor('Alpha is welcomed back as the same player', () => a.since(ia).some((m) => m.t === 'welcome' && m.resumed && m.name === a.name))
await waitFor("Alpha gets the server's battle (rejoin sync)", () => a.since(ia).some((m) => m.t === 'sync' && m.why === 'rejoin'))
check(`the sync is the battle as it was saved (tick ${savedAt}, after ${before} on Alpha's side)`, a.since(ia).find((m) => m.t === 'sync')?.n === savedAt && savedAt >= before)
await waitFor('the battle waits for Bravo, whose time to rejoin starts once Alpha is back', () =>
  a.since(ia).some((m) => m.t === 'roster' && m.away?.some((x: { seat: number; deadline: number }) => x.seat === b.me && x.deadline > Date.now() + 30_000)),
)
const heldAt = a.n
await sleep(1500)
check('no turns run while it waits', a.n === heldAt)

const ib = b.seen.length
b.connect(b.token)
await waitFor('Bravo is welcomed back too', () => b.since(ib).some((m) => m.t === 'welcome' && m.resumed && m.name === b.name))
await waitFor("Bravo gets the server's battle (rejoin sync)", () => b.since(ib).some((m) => m.t === 'sync' && m.why === 'rejoin'))
await waitFor('the battle carries on once both are back', () => a.n > heldAt + 30 && b.n > heldAt + 30, 5000)
check('it carries on from where it was, with no catch-up for the time it was down', a.n < heldAt + 300)

const fromA = a.hashes.size
stop = [a.busy(), b.busy()]
await sleep(seconds * 1000)
stop.forEach((f) => f())
await sleep(500)
const [same, differ] = compare([a, b], savedAt)
check(`${same} fingerprints after the restart equal between the players`, same > 5 && differ === 0)
check("neither player drifted from the server's battle (it checks every fingerprint)", ![...a.since(ia), ...b.since(ib)].some((m) => m.t === 'desync'))
check('hashes were sent after the restart', a.hashes.size > fromA)
console.log(`played on to tick ${a.n} after the restart`)

// --- 3. State that must not come back ----------------------------------------------------------------

/** Starts a server on `file` and says whether Alpha's token is still known to it. */
async function knownAfter(file: string) {
  if (server.running) await server.stop()
  rmSync(STATE, { force: true })
  writeFileSync(STATE, file)
  await server.start()
  const p = new Bot(server, 'Probe')
  // With a token of its own already, it doesn't claim a name on `ready`.
  p.token = a.token
  p.connect(a.token)
  await waitFor('the probe gets an answer', () => p.seen.some((m) => m.t === 'welcome' || m.t === 'ready'))
  const known = p.seen.some((m) => m.t === 'welcome')
  p.ws.close()
  return { known, deleted: !existsSync(STATE) }
}
// Each of these leaves Alpha's token unknown; the good file again shows the probe itself works.
const fresh = await knownAfter(good.replace(/"at":\d+/, `"at":${Date.now()}`))
check('a fresh state file brings the player back', fresh.known && fresh.deleted)
const stale = await knownAfter(good.replace(/"at":\d+/, `"at":${Date.now() - 11 * 60_000}`))
check('a state file older than 10 minutes is ignored (and deleted)', !stale.known && stale.deleted)
const garbled = await knownAfter(good.slice(0, good.length / 2))
check('a garbled state file is ignored (and deleted)', !garbled.known && garbled.deleted && server.log.includes('ignored the state'))
const other = await knownAfter(good.replace('"v":2', '"v":99'))
check('a state file from another version is ignored (and deleted)', !other.known && other.deleted)
// Version 1 kept signed-in players by login only: it still loads, but only as a guest's player.
const old = await knownAfter(good.replace('"v":2', '"v":1').replace(/"account":\d+,/g, ''))
check('a version 1 state file (no account ids) still loads, as guests', old.known && old.deleted)

for (const p of [a, b]) p.ws.close()
await server.dispose()
finish()
