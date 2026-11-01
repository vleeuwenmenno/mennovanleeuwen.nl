import { Session } from '../src/terminal/agents/app'
import { claimClientCall, sendClientResult } from '../src/data/agents'
// Browser fixture for check:agents-executor-lifecycle; not imported by the app.
import { createElement as h, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useClientCalls } from '../src/terminal/agents/useClientCalls'
import { execute, runAgentCall } from '../src/terminal/agents/exec'
import { AGENT_LIMITS } from '../src/terminal/limits'
import type { ClientCalls } from '../src/terminal/agents/lifecycle'
import { lookup } from '../src/terminal/fs'
export async function run() {
  const checks: { name: string; ok: boolean }[] = []
  const grant = { mode: 'acceptEdits', root: '/tmp', write: true, delete: false, network: false, steering: false }
  for (const action of ['stop', 'unmount', 'switch', 'clientDone']) {
    for (const pending of [true, false]) {
      const host = document.createElement('div'); document.body.append(host)
      const root = createRoot(host)
      let owner!: ClientCalls
      function View({ thread }: { thread: string }) {
        owner = useClientCalls(thread)
        return h('button', { onClick: () => owner.stop() }, 'Stop test executor')
      }
      flushSync(() => root.render(h(StrictMode, null, h(View, { thread: 'a' }))))
      const captured = owner
      let release!: (value: boolean) => void, entered!: () => void
      let ran = 0, delivered = 0
      const began = new Promise<void>(r => entered = r)
      const name = 'lifecycle-' + action + '-' + pending
      const task = captured.run(name, () => pending ? new Promise<boolean>(r => release = r) : Promise.resolve(true), async signal => {
        ran++; entered()
        return execute('sleep 30; touch ' + name, '/tmp', grant, AGENT_LIMITS, signal)
      }, async () => delivered++)
      if (!pending) await began
      if (action === 'stop') host.querySelector('button')!.click()
      if (action === 'unmount') flushSync(() => root.unmount())
      if (action === 'switch') flushSync(() => root.render(h(StrictMode, null, h(View, { thread: 'b' }))))
      if (action === 'clientDone') captured.done(name)
      if (pending) release(true)
      await task
      checks.push({ name: action + (pending ? ' during pending claim' : ' during real execution'), ok: ran === (pending ? 0 : 1) && delivered === 0 && !lookup('/tmp/' + name) })
      if (action === 'switch' || action === 'unmount') {
        await captured.run('late', async () => true, async () => { ran++; }, async () => {})
        checks.push({ name: action + ' rejects stale stream callbacks', ok: ran === (pending ? 0 : 1) })
      }
      if (action !== 'unmount') flushSync(() => root.unmount())
      host.remove()
    }
  }
  // A newly-created conversation keeps its send stream across the null -> assigned ID render.
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  let owner!: ClientCalls
  function NewThread({ id, createdHere }: { id: string | null; createdHere: string | null }) {
    owner = useClientCalls(id, createdHere)
    return null
  }
  flushSync(() => root.render(h(NewThread, { id: null, createdHere: null })))
  const original = owner
  flushSync(() => root.render(h(NewThread, { id: 'created', createdHere: 'created' })))
  let ran = false
  await original.run('new-thread', async () => true, async () => { ran = true }, async () => {})
  checks.push({ name: 'new conversation adopts its assigned ID without losing the send stream executor', ok: original === owner && ran })
  flushSync(() => root.unmount()); host.remove()
  // Real UI hook + CLI Session.runClient route, transport mocked at fetch only.
  // Both claim, run actual mvl/jq-safe, deliver structured results, and cancel in-flight reads.
  const savedFetch = window.fetch
  const replies: { status: number; result?: { stdout: string } }[] = []
  let reads = 0, hold = false, entered!: () => void
  window.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/claim')) return Response.json({ ok: true })
    if (url.endsWith('/result')) { replies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }) }
    if (url === '/api/state') {
      reads++; entered?.()
      if (hold) await new Promise<void>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
      return Response.json({ notes: { value: [{ id: 'fixture', text: 'same msh' }] } })
    }
    return savedFetch(input, init)
  }
  try {
    for (const surface of ['ui', 'cli'] as const) {
      const host = document.createElement('div'); document.body.append(host)
      const root = createRoot(host)
      let owner!: ClientCalls
      function View() { owner = useClientCalls('integration'); return null }
      flushSync(() => root.render(h(View)))
      const ctx = { cwd: '/tmp', env: {}, signal: new AbortController().signal, size: { cols: 100, rows: 30 } }
      const session = new Session(ctx as never, { thread: { id: 'integration' }, messages: [], workdir: null, mode: 'quick', model: '', projectId: null, permission: 'plan', tools: [], first: '' } as never)
      const cli = session as unknown as { runClient: (id: string, message: number, index: number, call: { name: string; arguments: Record<string, unknown> }, grant: object) => Promise<void>; clientCalls: ClientCalls; draw: () => void }
      cli.draw = () => {} // Screen painting is irrelevant to the executor transport.
      const serverGrant = { mode: 'plan', write: false, delete: false, network: false, steering: false, appDataRead: ['notes'] as const }
      const call = { name: 'terminal', arguments: { command: "mvl notes | jq-safe -c '.notes | map({text})'" } }
      const dispatch = (id: string, grant = serverGrant) => surface === 'cli'
        ? cli.runClient(id, 1, 0, call, grant)
        : owner.run(id, () => claimClientCall('integration', id), signal => runAgentCall({ ...call, workdir: null, fallbackDir: '/tmp', grant, signal }), a => sendClientResult('integration', id, a.output, a.status, { result: a.result }))
      const before = replies.length
      await dispatch(surface + '-success')
      checks.push({ name: surface + ' claimed mvl + jq-safe returns structured real interpreter result', ok: replies.length === before + 1 && replies.at(-1)?.status === 0 && replies.at(-1)?.result?.stdout === '[{"text":"same msh"}]' })
      const count = reads
      await dispatch(surface + '-denied', { ...serverGrant, appDataRead: [] } as unknown as typeof serverGrant)
      checks.push({ name: surface + ' resource refusal occurs before HTTP', ok: reads === count && replies.at(-1)?.status !== 0 })
      hold = true
      const began = new Promise<void>(r => entered = r)
      const pending = dispatch(surface + '-cancel')
      await began
      const delivered = replies.length
      if (surface === 'cli') cli.clientCalls.done(surface + '-cancel')
      else owner.stop()
      await pending
      checks.push({ name: surface + ' lifecycle cancellation aborts actual mvl read without late result', ok: replies.length === delivered })
      hold = false
      cli.clientCalls.close()
      flushSync(() => root.unmount()); host.remove()
    }
  } finally { window.fetch = savedFetch }
  return checks
}
