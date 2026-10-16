// Exercises the Empires At War multiplayer socket of a running server: names, resuming, and the
// limits (origin, message size, flooding).
//
//   node scripts/empires-ws.ts [ws://localhost:5173/api/empires/ws]
//
// Names stay taken for 30 s after a test player leaves, so wait that long between runs.

import { OUTDATED_CODE, PROTOCOL } from '../src/apps/games/empires/protocol.ts'

const URL_ = process.argv[2] ?? 'ws://localhost:5173/api/empires/ws'
const ORIGIN = URL_.replace(/^ws/, 'http').replace(/\/api.*/, '')
type Msg = Record<string, any>

/** `ignore`: message types to drop (the name checks don't care about the lobby list). */
function client(origin: string | null = ORIGIN, ignore = ['lobbies']) {
  const ws = new WebSocket(URL_, origin ? ({ headers: { Origin: origin } } as any) : undefined)
  const inbox: Msg[] = []
  const waiters: ((m: Msg) => void)[] = []
  let closed: { code: number; reason: string } | null = null
  const closeWaiters: ((c: { code: number; reason: string }) => void)[] = []
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data))
    if (ignore.includes(m.t)) return
    const w = waiters.shift()
    if (w) w(m)
    else inbox.push(m)
  }
  ws.onclose = (e) => {
    closed = { code: e.code, reason: e.reason }
    for (const w of closeWaiters.splice(0)) w(closed)
  }
  const opened = new Promise<boolean>((res) => {
    ws.onopen = () => res(true)
    ws.onerror = () => res(false)
  })
  return {
    ws,
    opened,
    send: (m: Msg) => ws.send(JSON.stringify(m)),
    next: () => (inbox.length ? Promise.resolve(inbox.shift()!) : new Promise<Msg>((r) => waiters.push(r))),
    closed: () => (closed ? Promise.resolve(closed) : new Promise<{ code: number; reason: string }>((r) => closeWaiters.push(r))),
  }
}

const check = (label: string, ok: boolean, detail: unknown = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, ok ? '' : JSON.stringify(detail))
  if (!ok) process.exitCode = 1
}

const a = client()
check('a connects', await a.opened)
a.send({ t: 'hello', v: PROTOCOL })
const ready = await a.next()
check('ready with a suggestion', ready.t === 'ready' && typeof ready.suggestion === 'string', ready)
a.send({ t: 'claim', name: '  Rex   Vane ' })
const wa = await a.next()
check('a claims "Rex Vane" (tidied)', wa.t === 'welcome' && wa.name === 'Rex Vane', wa)

const b = client()
await b.opened
b.send({ t: 'hello', v: PROTOCOL })
await b.next()
b.send({ t: 'claim', name: 'rex-vane' })
const rb = await b.next()
check('b refused "rex-vane" (same name)', rb.t === 'refused' && /already/.test(rb.why), rb)
b.send({ t: 'claim', name: 'ab' })
const rb2 = await b.next()
check('b refused "ab" (too short)', rb2.t === 'refused' && /At least/.test(rb2.why), rb2)
b.send({ t: 'claim', name: '<script>' })
const rb3 = await b.next()
check('b refused "<script>"', rb3.t === 'refused', rb3)
b.send({ t: 'claim', name: rb.suggestion })
const wb = await b.next()
check('b takes the suggestion', wb.t === 'welcome' && wb.name === rb.suggestion, wb)

const t0 = performance.now()
b.send({ t: 'ping', n: 7 })
const pong = await b.next()
check(`ping/pong (${(performance.now() - t0).toFixed(2)} ms)`, pong.t === 'pong' && pong.n === 7, pong)

// a drops and comes back with its token: same name.
a.ws.close()
await a.closed()
const a2 = client()
await a2.opened
a2.send({ t: 'hello', v: PROTOCOL, token: wa.token })
const back = await a2.next()
check('a resumes as "Rex Vane" with its token', back.t === 'welcome' && back.resumed && back.name === 'Rex Vane' && back.id === wa.id, back)

// While a is back, the name stays taken.
b.send({ t: 'claim', name: 'Rex Vane' })
const rb4 = await b.next()
check('name still taken after resume', rb4.t === 'refused', rb4)

const noOrigin = client(null)
check('no Origin header is refused', !(await noOrigin.opened))
const evil = client('http://evil.example')
check('foreign Origin is refused', !(await evil.opened))

const big = client()
await big.opened
big.send({ t: 'hello', v: PROTOCOL })
await big.next()
big.ws.send('x'.repeat(20000))
const bc = await big.closed()
check('oversized message closes 1009', bc.code === 1009, bc)

const spam = client()
await spam.opened
spam.send({ t: 'hello', v: PROTOCOL })
await spam.next()
for (let i = 0; i < 400; i++) spam.send({ t: 'ping', n: i })
const sc = await spam.closed()
check('flood closes 1008', sc.code === 1008, sc)

const rude = client()
await rude.opened
rude.send({ t: 'claim', name: 'Skipper' })
const rc = await rude.closed()
check('claim before hello closes 1008', rc.code === 1008, rc)

// A client of another version (or from before there were versions) would play another battle.
const old = client()
await old.opened
old.send({ t: 'hello' })
const oc = await old.closed()
check(`a hello without the protocol version closes ${OUTDATED_CODE}`, oc.code === OUTDATED_CODE, oc)

// Fragmented and large-but-allowed message (over 126 bytes: 16-bit length path).
const c = client()
await c.opened
c.send({ t: 'hello', v: PROTOCOL })
await c.next()
c.send({ t: 'claim', name: 'Commodore Test', pad: 'y'.repeat(9000) })
const wc = await c.next()
check('9 KB message (16-bit length) works', wc.t === 'welcome', wc)

for (const x of [a2, b, c]) x.ws.close()

// --- Lobbies ---
const tag = Math.floor(Math.random() * 900 + 100)
async function named(name: string) {
  const x = client(ORIGIN, [])
  await x.opened
  x.send({ t: 'hello', v: PROTOCOL })
  await x.next()
  x.send({ t: 'claim', name })
  await x.next() // welcome
  await x.next() // lobbies
  return x
}
/** The next message of type `t` (that `ok` accepts), skipping others. */
async function until(x: ReturnType<typeof client>, t: string, ok: (m: Msg) => boolean = () => true) {
  for (;;) {
    const m = await x.next()
    if (m.t === t && ok(m)) return m
  }
}
const host = await named(`Host ${tag}`)
const guest = await named(`Guest ${tag}`)
const third = await named(`Third ${tag}`)
host.send({ t: 'create' })
const made = (await until(host, 'lobby')).lobby
check('host creates a lobby and sits in spawn 1', made.slots[0].kind === 'human' && made.host === made.slots[0].player && made.slots[1].kind === 'open', made)
const listed = await until(guest, 'lobbies')
check('others see it in the list', listed.list.some((l: Msg) => l.id === made.id && l.players === 1 && l.seats === 2), listed)
guest.send({ t: 'join', id: made.id })
const joinedL = (await until(guest, 'lobby')).lobby
check('guest joins into the open spawn', joinedL.slots[1].kind === 'human' && joinedL.slots[1].name === `Guest ${tag}`, joinedL)
const note = await until(host, 'chat')
check('host hears that the guest joined', note.from === '' && /joined/.test(note.text), note)
third.send({ t: 'join', id: made.id })
const full = await until(third, 'error')
check('a full lobby turns the third away', /full/.test(full.why), full)
guest.send({ t: 'slot', i: 0, patch: { faction: 'droid' } })
const notHost = await until(guest, 'error')
check("a guest can't change the host's spawn", /host/.test(notHost.why), notHost)
host.send({ t: 'setup', map: 'vanth' })
const bigger = (await until(guest, 'lobby', (m) => m.lobby.map === 'vanth')).lobby
check('host switches to a 4-spawn map, players keep their seats', bigger.map === 'vanth' && bigger.slots.length === 4 && bigger.slots[1].name === `Guest ${tag}`, bigger)
// Six spawns: a huge map, and a generated map for six, each with six seats, the new ones open and
// alternating sides; then back to four.
host.send({ t: 'setup', map: 'velkar' })
const six = (await until(guest, 'lobby', (m) => m.lobby.map === 'velkar')).lobby
check('host switches to a 6-spawn map: six seats, the new ones open on alternating sides', six.slots.length === 6 && six.slots[1].name === `Guest ${tag}` && six.slots.slice(4).every((s: Msg, i: number) => s.kind === 'open' && s.team === i % 2), six.slots)
host.send({ t: 'setup', map: 'generated', gen: { players: 6, size: 'large', seed: 7 } })
const genSix = (await until(guest, 'lobby', (m) => m.lobby.map === 'generated')).lobby
check('a generated map for six players has six seats', genSix.slots.length === 6 && genSix.gen.players === 6, genSix.gen)
host.send({ t: 'setup', map: 'generated', gen: { players: 9 } })
const genBad = (await until(guest, 'lobby', (m) => m.lobby.map === 'generated' && m.lobby.gen.players !== 6)).lobby
check('a player count the generator has no layout for falls back to two', genBad.slots.length === 2 && genBad.gen.players === 2, genBad.gen)
host.send({ t: 'setup', map: 'vanth' })
await until(guest, 'lobby', (m) => m.lobby.map === 'vanth')
guest.send({ t: 'ready', on: true })
const readied = (await until(host, 'lobby', (m) => m.lobby.slots[1].ready)).lobby
check('guest gets ready', readied.slots[1].ready === true, readied)
host.send({ t: 'slot', i: 2, patch: { kind: 'ai' } })
const unreadied = (await until(guest, 'lobby', (m) => m.lobby.slots[2].kind === 'ai')).lobby
check('a change makes everyone ready up again', unreadied.slots[2].kind === 'ai' && unreadied.slots[1].ready === false, unreadied)
check('a new AI seat plays Balanced', unreadied.slots[2].profile === 'balanced', unreadied.slots[2])
host.send({ t: 'slot', i: 2, patch: { profile: 'offensive' } })
const styled = (await until(guest, 'lobby', (m) => m.lobby.slots[2].profile === 'offensive')).lobby
check('host picks the AI seat\'s profile', styled.slots[2].profile === 'offensive', styled.slots[2])
host.send({ t: 'slot', i: 2, patch: { profile: 'reckless' } })
const unknown = (await until(guest, 'lobby')).lobby
check('a profile that doesn\'t exist is ignored', unknown.slots[2].profile === 'offensive', unknown.slots[2])
guest.send({ t: 'slot', i: 2, patch: { profile: 'defensive' } })
const refusedStyle = await until(guest, 'error')
check("a guest can't change an AI seat's profile", /host/.test(refusedStyle.why), refusedStyle)
// Reinforcements: defaults on a new lobby; the server cleans whatever the host sends, and only the
// host may change them (a tampered client can't make them free or negative).
check('a new lobby has the default reinforcement rules', made.reinforce?.strike === true && made.reinforce?.ships === true && made.reinforce?.surcharge === 15, made.reinforce)
host.send({ t: 'setup', reinforce: { surcharge: 999 } })
const capped = (await until(guest, 'lobby', (m) => m.lobby.reinforce?.surcharge !== 15)).lobby
check('a surcharge over 50% is brought down to 50%', capped.reinforce.surcharge === 50, capped.reinforce)
host.send({ t: 'setup', reinforce: { surcharge: -40 } })
const floored = (await until(guest, 'lobby', (m) => m.lobby.reinforce?.surcharge !== 50)).lobby
check('a negative surcharge becomes 0%', floored.reinforce.surcharge === 0, floored.reinforce)
host.send({ t: 'setup', reinforce: { surcharge: 13, strike: false } })
const stepped = (await until(guest, 'lobby', (m) => m.lobby.reinforce?.strike === false)).lobby
check('a surcharge goes onto its 5% steps, strike craft off, warships still on', stepped.reinforce.surcharge === 15 && stepped.reinforce.strike === false && stepped.reinforce.ships === true, stepped.reinforce)
host.send({ t: 'setup', reinforce: { ships: 'yes', surcharge: 'free' } })
const junk = (await until(guest, 'lobby')).lobby
check('junk switches and surcharges fall back to the defaults', junk.reinforce.ships === true && junk.reinforce.surcharge === 15, junk.reinforce)
guest.send({ t: 'setup', reinforce: { surcharge: 0 } })
const notTheirs = await until(guest, 'error')
check("a guest can't change the reinforcement rules", /host/.test(notTheirs.why), notTheirs)
// Defense stations: 2 per player on a new lobby; the host picks one of the steps (Off is 0), junk
// is ignored, and only the host may change it.
check('a new lobby allows 2 defense stations per player', made.stations === 2, made.stations)
host.send({ t: 'setup', stations: 0 })
const off = (await until(guest, 'lobby', (m) => m.lobby.stations === 0)).lobby
check('the host turns defense stations off', off.stations === 0, off.stations)
host.send({ t: 'setup', stations: 5 })
const odd = (await until(guest, 'lobby')).lobby
check('a limit that is not one of the steps is ignored', odd.stations === 0, odd.stations)
host.send({ t: 'setup', stations: 6 })
const sixForts = (await until(guest, 'lobby', (m) => m.lobby.stations === 6)).lobby
check('the host sets 6', sixForts.stations === 6, sixForts.stations)
guest.send({ t: 'setup', stations: 1 })
const notTheirs2 = await until(guest, 'error')
check("a guest can't change the defense station limit", /host/.test(notTheirs2.why), notTheirs2)
// Defense platforms on ore: off on a new lobby; the host turns them on or off, junk is ignored,
// and only the host may change it.
check('a new lobby has defense platforms on ore off', made.oreDefense === false, made.oreDefense)
host.send({ t: 'setup', oreDefense: true })
const oreOn = (await until(guest, 'lobby', (m) => m.lobby.oreDefense === true)).lobby
check('the host turns defense platforms on ore on', oreOn.oreDefense === true, oreOn.oreDefense)
host.send({ t: 'setup', oreDefense: 'yes', stations: 4 })
const oreJunk = (await until(guest, 'lobby', (m) => m.lobby.stations === 4)).lobby
check('a switch that is not true or false is ignored', oreJunk.oreDefense === true, oreJunk.oreDefense)
guest.send({ t: 'setup', oreDefense: false })
const notTheirs3 = await until(guest, 'error')
check("a guest can't change defense platforms on ore", /host/.test(notTheirs3.why), notTheirs3)
host.send({ t: 'slot', i: 1, patch: { kind: 'open' } })
const kicked = await until(guest, 'kicked')
check('host can take a player out', /host/.test(kicked.why), kicked)
host.send({ t: 'leave' })
const gone = await until(third, 'lobbies')
const after = gone.list.some((l: Msg) => l.id === made.id) ? (await until(third, 'lobbies')).list : gone.list
check('an empty lobby closes', !after.some((l: Msg) => l.id === made.id), after)
for (const x of [host, guest, third]) x.ws.close()
setTimeout(() => process.exit(), 200)
