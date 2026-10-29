import assert from 'node:assert/strict'
import { createServer } from 'vite'
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
try {
  const { readAppData, appDataDenial, APP_DATA_POLICY } = await vite.ssrLoadModule('/src/terminal/appData.ts')
  const { appDataResponse } = await vite.ssrLoadModule('/src/terminal/appDataResponse.ts')
  const signal = new AbortController().signal
  const paths: string[] = []
  const get = async (path: string) => { paths.push(path); return { notes: { value: [{ id: '1', text: '{c:red}literal{/}', updated: 1 }, { id: '2', deleted: 1 }, { id: '3', purged: true }] }, unrelatedSecret: 'never output' } }
  const notes = await readAppData(['notes'], signal, get)
  assert.deepEqual(JSON.parse(notes), { notes: [{ id: '1', text: '{c:red}literal{/}', updated: 1 }] })
  assert.ok(!notes.includes('{c:'))
  assert.deepEqual(paths, ['/api/state'])
  const calendar = await readAppData(['calendar', '2026-10-01', '2026-11-01'], signal, async (path: string) => { assert.ok(path.startsWith('/api/calendar/events?')); return { events: [{ title: 'meeting' }], errors: ['one calendar unavailable'] } })
  assert.equal(JSON.parse(calendar).errors.length, 1)
  for (const args of [['notes', 'delete'], ['tasks', 'run'], ['calendar', '2026-02-30', '2026-03-02'], ['calendar', '2026-10-01', '2028-01-01']]) {
    await assert.rejects(readAppData(args, signal, () => { throw Error('must not fetch') }), /mvl:/)
  }
  const tasks = JSON.parse(await readAppData(['tasks'], signal, async () => ({ enabled: true, tasks: [{ id: 't', status: 'active', active: 1, instruction: 'private prompt' }] })))
  assert.deepEqual(tasks, { enabled: true, tasks: [{ id: 't', status: 'active', active: 1 }] })
  await assert.rejects(readAppData(['notes'], signal, async () => { throw Error('Unauthorized') }), /Unauthorized/)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(readAppData(['notes'], cancelled.signal, () => { throw Error('must not fetch') }), (e: { status: number }) => e.status === 130)
  const during = new AbortController()
  await assert.rejects(readAppData(['notes'], during.signal, async () => { during.abort(); return { notes: { value: [{ text: 'late private output' }] } } }), (e: { status: number }) => e.status === 130)
  await assert.rejects(readAppData(['notes'], signal, async () => ({ notes: { value: [{ text: '{'.repeat(100000) }] } })), /limit/)
  await assert.rejects(readAppData(['notes'], signal, get, { step: () => 'steps', write: () => null, stop() {} }), /budget/)
  const processing = new AbortController()
  const many = { notes: { value: Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: 'note' })) } }
  setTimeout(() => processing.abort(), 0)
  await assert.rejects(readAppData(['notes'], processing.signal, async () => many), /cancelled|abort/i)
  assert.deepEqual(await appDataResponse(new Response('{"notes":[]}'), { signal }), { notes: [] })
  await assert.rejects(appDataResponse(new Response('x'.repeat(65537)), { signal }), /65536/)
  await assert.rejects(appDataResponse(new Response('['.repeat(40) + '0' + ']'.repeat(40)), { signal }), /limit/)
  const responseAbort = new AbortController()
  let closed = false
  const streaming = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { closed = true } })
  const reading = appDataResponse(new Response(streaming), { signal: responseAbort.signal })
  responseAbort.abort()
  await assert.rejects(reading, /abort/i)
  assert.equal(closed, true)
  assert.equal(APP_DATA_POLICY.agentDefault, 'deny')
  assert.ok(appDataDenial(['notes'], {}))
  assert.ok(appDataDenial(['notes'], { network: true }))
  assert.ok(appDataDenial(['notes'], { appDataRead: ['notes'] }))
  assert.ok(appDataDenial(['notes'], { network: true, appDataRead: ['calendar'] }))
  assert.equal(appDataDenial(['notes'], { network: true, appDataRead: ['notes'] }), null)
  assert.equal(appDataDenial(['tasks'], { network: true, appDataRead: ['background-tasks'] }), null)
  assert.ok(appDataDenial(['constructor'], { network: true, appDataRead: ['notes'] }))
  console.log('PASS app data: reads, projection, markup, validation, authorization errors, cancellation')
} finally { await vite.close() }
