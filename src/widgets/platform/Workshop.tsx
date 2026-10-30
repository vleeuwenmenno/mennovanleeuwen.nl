import { useEffect, useRef, useState } from 'react'
import { useWM, type WinState } from '../../os/wm'
import { useAccount } from '../../os/account'
import { ask } from '../../os/Dialogs'
import { defaultBuild } from './defaults'
import { activate, allowRevision, installation, installationIdentity, installationVersion, installations, recover, removeInstallation, type Revision } from './installations'
import { CUSTOM_KIND, isInstanceKind, buildPackage, descriptor, supportsCapabilities, type Descriptor } from './package'
import { cloneDefault, cloneTemplate, readSource, sourceIdentity, WIDGET_HOME } from './sources'
import { execute } from './runtime'
import { Renderer } from './Renderer'
import { MOCK_INPUT } from './mocks'
import { dropWidgetConfig, randomTilt, setWidgetConfig, unsetWidgetConfig } from '../config'
import { closeWidget, openWidget } from '../windows'
import './platform.css'
const access = (kind: string) => kind === 'sticky' ? 'note and edit it through explicit interactions' : kind === 'weather' ? 'host-selected forecast' : kind === CUSTOM_KIND ? 'small saved state (up to 4 KiB, replaced only by explicit button actions) and the clock' : kind + ' data and explicit actions'
export function Workshop({ win }: { win: WinState }) {
  const wm = useWM()
  const account = useAccount()
  const kind = isInstanceKind(win.props.kind) ? win.props.kind : 'weather'
  const custom = kind === CUSTOM_KIND
  // A custom widget made here becomes this window's instance, so later activations update it.
  const [made, setMade] = useState<string | undefined>()
  const instance = win.props.id ?? made
  const records = installations.use()
  const current = instance ? records[instance] : undefined
  const [path, setPath] = useState(custom ? `${WIDGET_HOME}/daily-tally` : `${WIDGET_HOME}/${kind}`)
  const [revision, setRevision] = useState<Revision | null>(null)
  const [view, setView] = useState<Descriptor | null>(null)
  const [message, setMessage] = useState(custom ? 'Write the starter template to a folder, edit it in Xed, build and preview with mocks, then activate it as a new widget.' : 'Clone the source folder, edit in Xed, build and preview with mocks, then activate explicitly.')
  const [optIn, setOptIn] = useState(false)
  const [busy, setBusy] = useState(false)
  const generation = useRef(instance ? installationVersion(instance).generation : 0)
  const expectedIdentity = useRef(instance ? installationVersion(instance).identity : '')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try { await action() } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Widget operation failed') }
    finally { if (mounted.current) setBusy(false) }
  }
  const preview = async (value: Revision) => {
    if (!supportsCapabilities(kind, value.snapshot.manifest.capabilities)) throw new Error(`This package asks for capabilities a ${kind} widget cannot have`)
    const result = descriptor(await execute(value.snapshot, MOCK_INPUT))
    if (!mounted.current) return
    generation.current = instance ? installationVersion(instance).generation : 0
    expectedIdentity.current = instance ? installationVersion(instance).identity : ''
    setRevision(value); setView(result); setOptIn(false)
    setMessage(`Mock preview passed. Built ${value.snapshot.digest}. Source saves do not activate.`)
  }
  const verified = async (value: Revision) => {
    const latest = await buildPackage(await readSource(value.source))
    if (latest.digest !== value.snapshot.digest) throw new Error('Source changed after build; build and preview again')
  }
  const sync = (id: string) => { generation.current = installation(id)!.generation; expectedIdentity.current = installationVersion(id).identity }
  return <div className="wp-workshop">
    <strong>Widget Workshop · {custom ? (current ? current.active.snapshot.manifest.name : 'new custom widget') : kind}</strong>
    <p>Source is executable JavaScript in a bounded VM. Preview uses sample data. Activation grants only this instance's {access(kind)}.</p>
    <label>Source folder <input aria-label="Widget source folder" value={path} onChange={e => { setPath(e.target.value); setRevision(null); setView(null); setOptIn(false) }} /></label>
    <div className="wp-controls">
      {custom ? <>
        <button disabled={busy || account.status !== 'user'} onClick={() => void run(async () => { await cloneTemplate(path); setMessage('Template written. Edit src/main.js in Xed, save, then build.'); wm.open('zed', { path: `${path}/src/main.js`, t: String(Date.now()) }) })}>New custom widget template</button>
        <button disabled={busy || account.status !== 'user'} onClick={() => wm.open('zed', { path: `${path}/src/main.js`, t: String(Date.now()) })}>Open in Xed</button>
        <button onClick={() => wm.open('files', { path: '/usr/share/mvlos/widgets/custom-template' })}>Template source</button>
      </> : <>
        <button disabled={busy || account.status !== 'user'} onClick={() => void run(async () => { await cloneDefault(kind, path); setMessage('Source cloned. Open src/main.js in Xed, edit and save, then build.'); wm.open('zed', { path: `${path}/src/main.js`, t: String(Date.now()) }) })}>Clone & edit in Xed</button>
        <button onClick={() => wm.open('files', { path: `/usr/share/mvlos/widgets/${kind}` })}>System source</button>
      </>}
      <button onClick={() => wm.open('zed', { path: '/usr/share/mvlos/widgets/SDK.md' })}>SDK reference</button>
      <button disabled={busy || account.status !== 'user'} onClick={() => void run(async () => {
        const source = await sourceIdentity(path)
        await preview({ source, snapshot: await buildPackage(await readSource(source)) })
      })}>Build & mock preview</button>
      {!custom && <button disabled={busy} onClick={() => void run(async () => preview({ source: { kind: 'system', path: `/usr/share/mvlos/widgets/${kind}` }, snapshot: await defaultBuild(kind) }))}>Rebuild default & preview</button>}
    </div>
    {account.status !== 'user' && <p>Guests can use defaults and notes. Sign in to clone or activate source.</p>}
    {view && <div className="wp-preview" aria-label="Mock widget preview"><Renderer view={view} note={kind === 'sticky' ? MOCK_INPUT.note!.text : undefined} event={() => setMessage('Mock preview: no real writes.')} /></div>}
    {instance || custom ? <>
      <label><input type="checkbox" checked={optIn} onChange={e => setOptIn(e.target.checked)} />Allow this built revision to access {custom && !instance ? 'its own' : "this instance's"} {access(kind)}.</label>
      <div className="wp-controls">
        {custom && !instance && <button disabled={busy || !revision || !optIn || account.status !== 'user'} onClick={() => void run(async () => {
          if (!revision) return
          await verified(revision)
          const id = `custom-${crypto.randomUUID().slice(0, 8)}`
          await activate(id, CUSTOM_KIND, revision, 0, installationVersion(id).identity)
          allowRevision(id, revision)
          setWidgetConfig(id, { tilt: randomTilt() })
          setMade(id); sync(id)
          openWidget(wm, CUSTOM_KIND, id)
          setMessage(`New widget "${revision.snapshot.manifest.name}" activated and placed on the desktop.`); setOptIn(false)
        })}>Activate as new widget</button>}
        {instance && <button disabled={busy || !revision || !optIn || account.status !== 'user' || !current} onClick={() => void run(async () => {
          if (!revision) return
          await verified(revision)
          await activate(instance, kind, revision, generation.current, expectedIdentity.current)
          allowRevision(instance, revision)
          sync(instance)
          setMessage('Revision activated. The desktop now loads this immutable snapshot.'); setOptIn(false)
        })}>Activate built revision</button>}
        {instance && <button disabled={busy || !current?.previous || !optIn || account.status !== 'user'} onClick={() => void run(async () => {
          await recover(instance, current?.generation ?? 0, installationIdentity(current))
          const active = installation(instance)!.active
          allowRevision(instance, active)
          sync(instance)
          setMessage('Previous revision restored. Note contents, settings and placement unchanged.'); setOptIn(false)
        })}>Recover previous revision</button>}
        {custom && instance && current && <button disabled={busy || account.status !== 'user'} onClick={() => void run(async () => { unsetWidgetConfig(instance, 'state'); setMessage('Saved state cleared.') })}>Reset saved state</button>}
        {custom && instance && current && <button disabled={busy || account.status !== 'user'} onClick={() => void run(async () => {
          if (!await ask({ title: `Remove "${current.active.snapshot.manifest.name}"?`, body: 'Its installation and saved state are deleted and it leaves the desktop. Your source folder stays.', confirm: 'Remove widget', danger: true })) return
          const version = installationVersion(instance)
          await removeInstallation(instance, version.generation, version.identity)
          closeWidget(wm, CUSTOM_KIND, instance)
          dropWidgetConfig(instance)
          setMessage('Widget removed from this account and the desktop.')
        })}>Remove this widget</button>}
      </div>
    </> : <p>Open Source from a widget to activate for that instance.</p>}
    <p role="status">{message}</p>
    {current && <pre>Active: {current.active.snapshot.digest}{'\n'}Generation: {current.generation}</pre>}
  </div>
}
