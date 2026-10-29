import assert from 'node:assert/strict'
import { createServer } from 'vite'
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
try {
  const { readAppData, APP_DATA_POLICY } = await vite.ssrLoadModule('/src/terminal/appData.ts')
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
  assert.equal(APP_DATA_POLICY.agentDefault, 'deny')
  console.log('PASS app data: reads, projection, markup, validation, authorization errors, cancellation')
} finally { await vite.close() }
