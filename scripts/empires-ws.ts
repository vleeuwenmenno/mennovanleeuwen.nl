// Exercises the Empires At War multiplayer socket of a running server: names, resuming, and the
// limits (origin, message size, flooding).
//
//   node scripts/empires-ws.ts [ws://localhost:5173/api/empires/ws]
//
// Names stay taken for 30 s after a test player leaves, so wait that long between runs.
const URL_ = process.argv[2] ?? 'ws://localhost:5173/api/empires/ws'
const ORIGIN = URL_.replace(/^ws/, 'http').replace(/\/api.*/, '')
type Msg = Record<string, any>

function client(origin: string | null = ORIGIN) {
  const ws = new WebSocket(URL_, origin ? ({ headers: { Origin: origin } } as any) : undefined)
  const inbox: Msg[] = []
  const waiters: ((m: Msg) => void)[] = []
  let closed: { code: number; reason: string } | null = null
  const closeWaiters: ((c: { code: number; reason: string }) => void)[] = []
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data))
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
a.send({ t: 'hello' })
const ready = await a.next()
check('ready with a suggestion', ready.t === 'ready' && typeof ready.suggestion === 'string', ready)
a.send({ t: 'claim', name: '  Rex   Vane ' })
const wa = await a.next()
check('a claims "Rex Vane" (tidied)', wa.t === 'welcome' && wa.name === 'Rex Vane', wa)

const b = client()
await b.opened
b.send({ t: 'hello' })
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
a2.send({ t: 'hello', token: wa.token })
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
big.send({ t: 'hello' })
await big.next()
big.ws.send('x'.repeat(20000))
const bc = await big.closed()
check('oversized message closes 1009', bc.code === 1009, bc)

const spam = client()
await spam.opened
spam.send({ t: 'hello' })
await spam.next()
for (let i = 0; i < 400; i++) spam.send({ t: 'ping', n: i })
const sc = await spam.closed()
check('flood closes 1008', sc.code === 1008, sc)

const rude = client()
await rude.opened
rude.send({ t: 'claim', name: 'Skipper' })
const rc = await rude.closed()
check('claim before hello closes 1008', rc.code === 1008, rc)

// Fragmented and large-but-allowed message (over 126 bytes: 16-bit length path).
const c = client()
await c.opened
c.send({ t: 'hello' })
await c.next()
c.send({ t: 'claim', name: 'Commodore Test', pad: 'y'.repeat(9000) })
const wc = await c.next()
check('9 KB message (16-bit length) works', wc.t === 'welcome', wc)

for (const x of [a2, b, c]) x.ws.close()
setTimeout(() => process.exit(), 200)
