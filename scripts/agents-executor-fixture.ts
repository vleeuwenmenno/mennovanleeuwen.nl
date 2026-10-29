// Browser fixture for check:agents-executor-lifecycle; not imported by the app.
import { createElement as h, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useClientCalls } from '../src/terminal/agents/useClientCalls'
import { execute } from '../src/terminal/agents/exec'
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
  return checks
}
