import { useEffect, useRef, useState } from 'react'
import { pullAll, useSyncStatus } from '../../os/synced'
import { widgetMigrationUnresolved } from '../../os/accountSpace'
import { StatusBanner, type StatusAction } from './Status'
import { widgetsHydrated } from './canonicalState'
import { useWM, type WinState } from '../../os/wm'
import { useAccount } from '../../os/account'
import { defaultBuild } from './defaults'
import { activate, allowRevision, installation, installationIdentity, installationVersion, installations, InstallFailure, recover, useInstallationPresence, type Revision } from './installations'
import { isWidgetKind, buildPackage, descriptor, type Descriptor } from './package'
import { cloneDefault, readSource, sourceIdentity, WIDGET_HOME } from './sources'
import { execute } from './runtime'
import { Renderer } from './Renderer'
import { MOCK_INPUT } from './mocks'
import './platform.css'
export function Workshop({ win }: { win: WinState }) {
  const wm = useWM()
  const account = useAccount()
  const kind = isWidgetKind(win.props.kind) ? win.props.kind : 'weather'
  const instance = win.props.id
  const records = installations.use()
  const current = instance ? records[instance] : undefined
  const [path, setPath] = useState(`${WIDGET_HOME}/${kind}`)
  const [revision, setRevision] = useState<Revision | null>(null)
  const [view, setView] = useState<Descriptor | null>(null)
  const [message, setMessage] = useState('Clone the source folder, edit in Xed, build and preview with mocks, then activate explicitly.')
  // A failed action never leaves a success message behind: it becomes a banner with what to do.
  const [problem, setProblem] = useState<{ code: string; message: string } | null>(null)
  const [dismissed, setDismissed] = useState('')
  const sync = useSyncStatus()
  const unavailable = useInstallationPresence(instance ?? '') && !!instance && !current
  const [optIn, setOptIn] = useState(false)
  const [busy, setBusy] = useState(false)
  const generation = useRef(instance ? installationVersion(instance).generation : 0)
  const expectedIdentity = useRef(instance ? installationVersion(instance).identity : '')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setProblem(null); setDismissed('')
    try { await action() } catch (error) {
      if (mounted.current) {
        setMessage('')
        setProblem({ code: error instanceof InstallFailure ? error.code : 'error', message: error instanceof Error ? error.message : 'Widget operation failed' })
      }
    }
    finally { if (mounted.current) setBusy(false) }
  }
  const preview = async (value: Revision) => {
    const result = descriptor(await execute(value.snapshot, MOCK_INPUT))
    if (!mounted.current) return
    generation.current = instance ? installationVersion(instance).generation : 0
    expectedIdentity.current = instance ? installationVersion(instance).identity : ''
    setRevision(value); setView(result); setOptIn(false)
    setMessage(`Mock preview passed. Built ${value.snapshot.digest}. Source saves do not activate.`)
  }
  const rebuildDefault = () => run(async () => preview({ source: { kind: 'system', path: `/usr/share/mvlos/widgets/${kind}` }, snapshot: await defaultBuild(kind) }))
  // Opened from a widget's "Rebuild default": preview the default now; activation stays a separate, explicit step.
  useEffect(() => { if (win.props.rebuild) void rebuildDefault() }, [win.props.rebuild, win.props.t]) // eslint-disable-line react-hooks/exhaustive-deps
  const reload = () => {
    generation.current = instance ? installationVersion(instance).generation : 0
    expectedIdentity.current = instance ? installationVersion(instance).identity : ''
    setOptIn(false); setProblem(null)
    setMessage(`Installation state reloaded. Active: ${current?.active.snapshot.digest ?? 'none'}. Nothing was changed; review it, then activate again to replace it.`)
  }
  const retrySave = () => run(async () => {
    try { await installations.flush?.() } catch (error) { throw new InstallFailure('storage', `Still not saved: ${error instanceof Error ? error.message : 'storage failure'}. The earlier saved revision is intact.`) }
    reload(); setMessage('Saved. The active revision is now stored.')
  })
  const retryAfterSync = async () => {
    setBusy(true)
    try { await pullAll() } catch { /* shown below */ }
    if (!mounted.current) return
    setBusy(false)
    if (widgetsHydrated()) { setProblem(null); setMessage('Widget state is synced. Activate again.') }
    else setProblem({ code: 'unhydrated', message: 'Widget state is still not synced. Check the connection, then retry.' })
  }
  const actions: Record<string, StatusAction[]> = {
    conflict: [{ label: 'Reload installation state', run: reload }],
    unhydrated: [{ label: 'Retry after sync', run: () => void retryAfterSync() }],
    storage: [{ label: 'Retry saving', run: () => void retrySave() }],
  }
  const shown = problem && dismissed !== `${problem.code}:${problem.message}` ? problem : null
  const syncProblem = sync.state === 'error' && (widgetMigrationUnresolved() || /widget/i.test(sync.error ?? '')) ? `Widget data is not synced: ${sync.error ?? 'unknown problem'}. Original data was kept; nothing was overwritten or deleted.` : ''
  return <div className="wp-workshop">
    <strong>Widget Workshop · {kind}</strong>
    <p>Source is executable JavaScript in a bounded VM. Preview uses sample data. Activation grants only this instance's {kind === 'sticky' ? 'note' : kind === 'weather' ? 'selected forecast' : kind+' data and selected actions'}.</p>
    <label>Source folder <input aria-label="Widget source folder" value={path} onChange={e => { setPath(e.target.value); setRevision(null); setView(null); setOptIn(false) }} /></label>
    <div className="wp-controls">
      <button disabled={busy || account.status !== 'user'} onClick={() => void run(async () => { await cloneDefault(kind, path); setMessage('Source cloned. Open src/main.js in Xed, edit and save, then build.'); wm.open('zed', { path: `${path}/src/main.js`, t: String(Date.now()) }) })}>Clone & edit in Xed</button>
      <button onClick={() => wm.open('files', { path: `/usr/share/mvlos/widgets/${kind}` })}>System source</button>
      <button onClick={() => wm.open('zed', { path: '/usr/share/mvlos/widgets/SDK.md' })}>SDK reference</button>
      <button disabled={busy || account.status !== 'user'} onClick={() => void run(async () => {
        const source = await sourceIdentity(path)
        await preview({ source, snapshot: await buildPackage(await readSource(source)) })
      })}>Build & mock preview</button>
      <button disabled={busy} onClick={() => void rebuildDefault()}>Rebuild default & preview</button>
    </div>
    {account.status !== 'user' && <p>Guests can use defaults and notes. Sign in to clone or activate source.</p>}
    {view && <div className="wp-preview" aria-label="Mock widget preview"><Renderer view={view} note={kind === 'sticky' ? MOCK_INPUT.note!.text : undefined} event={() => setMessage('Mock preview: no real writes.')} /></div>}
    {instance ? <>
      <label><input type="checkbox" checked={optIn} onChange={e => setOptIn(e.target.checked)} />Allow this built revision to access this instance's {kind === 'sticky' ? 'note and edit it through explicit interactions' : kind === 'weather' ? 'host-selected forecast' : kind+' data and explicit actions'}.</label>
      <div className="wp-controls">
        <button disabled={busy || !revision || !optIn || account.status !== 'user'} onClick={() => void run(async () => {
          if (!revision) return
          const latest = await buildPackage(await readSource(revision.source))
          if (latest.digest !== revision.snapshot.digest) throw new Error('Source changed after build; build and preview again')
          await activate(instance, kind, revision, generation.current, expectedIdentity.current)
          allowRevision(instance, revision)
          generation.current = installation(instance)!.generation
          expectedIdentity.current = installationVersion(instance).identity
          setMessage('Revision activated. The desktop now loads this immutable snapshot.'); setOptIn(false)
        })}>Activate built revision</button>
        <button disabled={busy || !current?.previous || !optIn || account.status !== 'user'} onClick={() => void run(async () => {
          await recover(instance, current?.generation ?? 0, installationIdentity(current))
          const active = installation(instance)!.active
          allowRevision(instance, active)
          generation.current = installation(instance)!.generation
          expectedIdentity.current = installationVersion(instance).identity
          setMessage('Previous revision restored. Note contents, settings and placement unchanged.'); setOptIn(false)
        })}>Recover previous revision</button>
      </div>
    </> : <p>Open Source from a widget to activate for that instance.</p>}
    {unavailable && <StatusBanner code="unavailable" message="Installed metadata unavailable. Nothing was deleted and no default is used in its place. Rebuild the default, then activate it explicitly to repair." actions={[{ label: 'Rebuild default', run: () => void rebuildDefault() }]} />}
    {syncProblem && dismissed !== `sync:${syncProblem}` && <StatusBanner code="sync" tone="error" message={syncProblem} actions={[{ label: 'Retry sync', run: () => void pullAll().catch(() => {}) }]} onDismiss={() => setDismissed(`sync:${syncProblem}`)} />}
    {shown && <StatusBanner code={shown.code} tone="error" message={shown.message} actions={actions[shown.code]} onDismiss={() => setDismissed(`${shown.code}:${shown.message}`)} />}
    {message && <p role="status">{message}</p>}
    {current && <pre>Active: {current.active.snapshot.digest}{'\n'}Generation: {current.generation}</pre>}
  </div>
}
