import { useEffect, useRef, useState } from 'react'
import { useWM, type WinState } from '../../os/wm'
import { useAccount } from '../../os/account'
import { defaultBuild } from './defaults'
import { activate, allowRevision, installation, installations, recover, type Revision } from './installations'
import { buildPackage, descriptor, type Descriptor } from './package'
import { cloneDefault, readSource, sourceIdentity, WIDGET_HOME } from './sources'
import { execute } from './runtime'
import { Renderer } from './Renderer'
import { MOCK_INPUT } from './Host'
import './platform.css'
export function Workshop({ win }: { win: WinState }) {
  const wm = useWM()
  const account = useAccount()
  const kind = win.props.kind === 'sticky' ? 'sticky' : 'weather'
  const instance = win.props.id
  const records = installations.use()
  const current = instance ? records[instance] : undefined
  const [path, setPath] = useState(`${WIDGET_HOME}/${kind}`)
  const [revision, setRevision] = useState<Revision | null>(null)
  const [view, setView] = useState<Descriptor | null>(null)
  const [message, setMessage] = useState('Clone the source folder, edit in Xed, build and preview with mocks, then activate explicitly.')
  const [optIn, setOptIn] = useState(false)
  const [busy, setBusy] = useState(false)
  const generation = useRef(current?.generation ?? 0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try { await action() } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Widget operation failed') }
    finally { if (mounted.current) setBusy(false) }
  }
  const preview = async (value: Revision) => {
    const result = descriptor(await execute(value.snapshot, MOCK_INPUT))
    if (!mounted.current) return
    generation.current = instance ? installation(instance)?.generation ?? 0 : 0
    setRevision(value); setView(result); setOptIn(false)
    setMessage(`Mock preview passed. Built ${value.snapshot.digest}. Source saves do not activate.`)
  }
  return <div className="wp-workshop">
    <strong>Widget Workshop · {kind}</strong>
    <p>Source is executable JavaScript in a bounded VM. Preview uses sample data. Activation grants only this instance's {kind === 'sticky' ? 'note' : 'selected forecast'}.</p>
    <label>Source folder <input aria-label="Widget source folder" value={path} onChange={e => { setPath(e.target.value); setRevision(null); setView(null); setOptIn(false) }} /></label>
    <div className="wp-controls">
      <button disabled={busy || account.status !== 'user'} onClick={() => void run(async () => { await cloneDefault(kind, path); setMessage('Source cloned. Open src/main.js in Xed, edit and save, then build.'); wm.open('zed', { path: `${path}/src/main.js`, t: String(Date.now()) }) })}>Clone & edit in Xed</button>
      <button onClick={() => wm.open('files', { path: `/usr/share/mvlos/widgets/${kind}` })}>System source</button>
      <button onClick={() => wm.open('zed', { path: '/usr/share/mvlos/widgets/SDK.md' })}>SDK reference</button>
      <button disabled={busy || account.status !== 'user'} onClick={() => void run(async () => {
        const source = await sourceIdentity(path)
        await preview({ source, snapshot: await buildPackage(await readSource(source)) })
      })}>Build & mock preview</button>
      <button disabled={busy} onClick={() => void run(async () => preview({ source: { kind: 'system', path: `/usr/share/mvlos/widgets/${kind}` }, snapshot: await defaultBuild(kind) }))}>Rebuild default & preview</button>
    </div>
    {account.status !== 'user' && <p>Guests can use defaults and notes. Sign in to clone or activate source.</p>}
    {view && <div className="wp-preview" aria-label="Mock widget preview"><Renderer view={view} note={kind === 'sticky' ? MOCK_INPUT.note!.text : undefined} event={() => setMessage('Mock preview: no real writes.')} /></div>}
    {instance ? <>
      <label><input type="checkbox" checked={optIn} onChange={e => setOptIn(e.target.checked)} />Allow this built revision to access this instance's {kind === 'sticky' ? 'note and edit it through explicit interactions' : 'host-selected forecast'}.</label>
      <div className="wp-controls">
        <button disabled={busy || !revision || !optIn || account.status !== 'user'} onClick={() => void run(async () => {
          if (!revision) return
          const latest = await buildPackage(await readSource(revision.source))
          if (latest.digest !== revision.snapshot.digest) throw new Error('Source changed after build; build and preview again')
          await activate(instance, kind, revision, generation.current)
          allowRevision(instance, revision)
          generation.current = installation(instance)!.generation
          setMessage('Revision activated. The desktop now loads this immutable snapshot.'); setOptIn(false)
        })}>Activate built revision</button>
        <button disabled={busy || !current?.previous || !optIn || account.status !== 'user'} onClick={() => void run(async () => {
          await recover(instance, current?.generation ?? 0)
          const active = installation(instance)!.active
          allowRevision(instance, active)
          generation.current = installation(instance)!.generation
          setMessage('Previous revision restored. Note contents, settings and placement unchanged.'); setOptIn(false)
        })}>Recover previous revision</button>
      </div>
    </> : <p>Open Source from a Weather or Sticky widget to activate for that instance.</p>}
    <p role="status">{message}</p>
    {current && <pre>Active: {current.active.snapshot.digest}{'\n'}Generation: {current.generation}</pre>}
  </div>
}
