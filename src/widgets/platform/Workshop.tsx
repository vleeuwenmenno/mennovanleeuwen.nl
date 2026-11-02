import { useEffect, useRef, useState } from 'react'
import { pullAll, useSyncStatus } from '../../os/synced'
import { widgetMigrationUnresolved } from '../../os/accountSpace'
import { StatusBanner, type StatusAction } from './Status'
import { widgetsHydrated } from './canonicalState'
import { useWM, type WinState } from '../../os/wm'
import { useAccount } from '../../os/account'
import { ask } from '../../os/Dialogs'
import { defaultBuild } from './defaults'
import { activate, allowRevision, installation, installationIdentity, installationVersion, installations, InstallFailure, recover, removeInstallation, trustBuildEligibility, trustFrontier, trustInstallation, useInstallationPresence, useTrustStatus, type Revision, type TrustEligibility } from './installations'
import { CUSTOM_KIND, isInstanceKind, buildPackage, descriptor, supportsCapabilities, type Descriptor } from './package'
import { cloneDefault, cloneTemplate, readSource, sourceIdentity, sourcePath, WIDGET_HOME } from './sources'
import { execute } from './runtime'
import { Renderer } from './Renderer'
import { MOCK_INPUT } from './mocks'
import { dropWidgetConfig, randomTilt, setWidgetConfig, unsetWidgetConfig } from '../config'
import { closeWidget, openWidget } from '../windows'
import { prettyPath } from '../../terminal/vfs'
import './platform.css'
const access = (kind: string) => kind === 'sticky' ? 'note and edit it through explicit interactions' : kind === 'weather' ? 'host-selected forecast' : kind === CUSTOM_KIND ? 'small saved state (up to 4 KiB, replaced only by explicit button actions) and the clock' : kind === 'clock' ? 'formatted clock and date' : kind + ' data and explicit actions'
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
  const [path, setPath] = useState(win.props.path ?? (custom ? `${WIDGET_HOME}/daily-tally` : `${WIDGET_HOME}/${kind}`))
  // Editing an installed widget opens the folder it was built from, wherever that is, not the starter location.
  const installedAt = current && current.active.source.kind !== 'system' ? sourcePath(current.active.source) : null
  const pathEdited = useRef(!!win.props.path)
  useEffect(() => { if (installedAt && !pathEdited.current) { pathEdited.current = true; setPath(installedAt) } }, [installedAt])
  const [revision, setRevision] = useState<Revision | null>(null)
  const [view, setView] = useState<Descriptor | null>(null)
  const [message, setMessage] = useState(custom ? 'Write the starter template to a folder, edit it in Xed, build and preview with mocks, then activate it as a new widget.' : 'Clone the source folder, edit in Xed, build and preview with mocks, then activate explicitly.')
  // A failed action never leaves a success message behind: it becomes a banner with what to do.
  const [problem, setProblem] = useState<{ code: string; message: string } | null>(null)
  const [dismissed, setDismissed] = useState('')
  const sync = useSyncStatus()
  const unavailable = useInstallationPresence(instance ?? '') && !!instance && !current
  const [optIn, setOptIn] = useState(false)
  // "Trust always", offered for a successful build that passes the canonical gate; checked by the person only.
  const [trustChoice, setTrustChoice] = useState(false)
  const [trustCheck, setTrustCheck] = useState<{ digest: string; result: TrustEligibility } | null>(null)
  const trustedNow = useTrustStatus(instance ?? '', current ? current.active : null).state === 'trusted'
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
    if (!supportsCapabilities(kind, value.snapshot.manifest.capabilities)) throw new Error(`This package asks for capabilities a ${kind} widget cannot have`)
    const result = descriptor(await execute(value.snapshot, MOCK_INPUT))
    if (!mounted.current) return
    generation.current = instance ? installationVersion(instance).generation : 0
    expectedIdentity.current = instance ? installationVersion(instance).identity : ''
    setRevision(value); setView(result); setOptIn(false); setTrustChoice(false)
    setMessage(`Mock preview passed. Built ${value.snapshot.digest}. Source saves do not activate.`)
  }
  const trustable = custom && !!revision && revision.source.kind !== 'system'
  const trustKey = trustable ? JSON.stringify([revision!.source, revision!.snapshot.digest, account.user?.id]) : ''
  useEffect(() => {
    if (!trustKey || !revision) return
    let live = true
    void trustBuildEligibility(revision).then(result => { if (live) setTrustCheck({ digest: trustKey, result }) })
    return () => { live = false }
  }, [trustKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const trustResult = trustCheck?.digest === trustKey ? trustCheck.result : null
  /** What the person decided at their click, captured before activation waits for anything: whether
   * to trust, the click itself, and the revocations of that widget they had seen then. */
  type TrustIntent = { want: boolean; gesture: Event; observed: readonly string[] }
  const intentAt = (id: string, gesture: Event): TrustIntent => ({ want: trustChoice, gesture, observed: trustFrontier(id) })
  /** After an activation: trust it too when the person ticked the box (their click is the gesture). */
  const trustAfter = async (id: string, value: Revision, intent: TrustIntent) => {
    if (!intent.want) return ''
    try { await trustInstallation(id, value, intent.gesture, intent.observed) } catch (error) { return ` Not trusted: ${error instanceof Error ? error.message : 'trust failed'}. It runs after Allow, as before.` }
    return ' Trusted: it runs without asking until you revoke trust or edit it.'
  }
  const verified = async (value: Revision) => {
    const latest = await buildPackage(await readSource(value.source))
    if (latest.digest !== value.snapshot.digest) throw new Error('Source changed after build; build and preview again')
  }
  const adopt = (id: string) => { generation.current = installation(id)!.generation; expectedIdentity.current = installationVersion(id).identity }
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
  // An agent's `widget preview` opens (or refreshes, with a new t) this window on its folder and builds it with mock data.
  useEffect(() => {
    if (!win.props.preview || !win.props.path || account.status !== 'user') return
    setPath(win.props.path)
    void run(async () => { const source = await sourceIdentity(win.props.path!); await preview({ source, snapshot: await buildPackage(await readSource(source)) }) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.props.preview, win.props.path, win.props.t, account.status])
  return <div className="wp-workshop">
    <strong>Widget Workshop · {custom ? (current ? current.active.snapshot.manifest.name : 'new custom widget') : kind}</strong>
    <p>Source is executable JavaScript in a bounded VM. Preview uses sample data. Activation grants only this instance's {access(kind)}.</p>
    <label>Source folder <input aria-label="Widget source folder" value={path} onChange={e => { pathEdited.current = true; setPath(e.target.value); setRevision(null); setView(null); setOptIn(false) }} /></label>
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
      {!custom && <button disabled={busy} onClick={() => void rebuildDefault()}>Rebuild default & preview</button>}
    </div>
    {account.status !== 'user' && <p>Guests can use defaults and notes. Sign in to clone or activate source.</p>}
    {view && <div className="wp-preview" aria-label="Mock widget preview"><Renderer view={view} note={kind === 'sticky' ? MOCK_INPUT.note!.text : undefined} event={() => setMessage('Mock preview: no real writes.')} /></div>}
    {instance || custom ? <>
      <label><input type="checkbox" checked={optIn} onChange={e => setOptIn(e.target.checked)} />Allow this built revision to access {custom && !instance ? 'its own' : "this instance's"} {access(kind)}.</label>
      {trustable && <label className="wp-trust-option" data-trust-option><input type="checkbox" aria-label="Trust this widget, so it runs without asking" checked={trustChoice && !!trustResult?.ok} disabled={!trustResult?.ok || busy} onChange={e => setTrustChoice(e.target.checked)} />Trust this widget, so it runs without asking
        <small>{trustResult?.ok ? `On activation, for your account on every device: only these exact bytes (digest ${revision!.snapshot.digest.slice(0, 16)}…) from ${prettyPath(`${WIDGET_HOME}/${revision!.snapshot.manifest.id}`)}. Any edit asks again. Revoke trust from the widget's toolbar.` : trustResult ? `Not available: ${trustResult.reason}` : 'Checking whether this build can be trusted…'}</small>
      </label>}
      {custom && instance && trustedNow && <p data-trusted>The active revision is trusted: it runs without asking. Revoke trust from the widget's toolbar.</p>}
      <div className="wp-controls">
        {custom && !instance && <button disabled={busy || !revision || !optIn || account.status !== 'user'} onClick={event => { const id = `custom-${crypto.randomUUID().slice(0, 8)}`, intent = intentAt(id, event.nativeEvent); void run(async () => {
          if (!revision) return
          await verified(revision)
          await activate(id, CUSTOM_KIND, revision, 0, installationVersion(id).identity)
          allowRevision(id, revision)
          setWidgetConfig(id, { tilt: randomTilt() })
          setMade(id); adopt(id)
          openWidget(wm, CUSTOM_KIND, id)
          const trusted = await trustAfter(id, revision, intent)
          setMessage(`New widget "${revision.snapshot.manifest.name}" activated and placed on the desktop.${trusted}`); setOptIn(false); setTrustChoice(false)
        }) }}>Activate as new widget</button>}
        {instance && <button disabled={busy || !revision || !optIn || account.status !== 'user'} onClick={event => { const intent = intentAt(instance, event.nativeEvent); void run(async () => {
          if (!revision) return
          await verified(revision)
          await activate(instance, kind, revision, generation.current, expectedIdentity.current)
          allowRevision(instance, revision)
          adopt(instance)
          const trusted = kind === CUSTOM_KIND ? await trustAfter(instance, revision, intent) : ''
          setMessage(`Revision activated. The desktop now loads this immutable snapshot.${trusted}`); setOptIn(false); setTrustChoice(false)
        }) }}>Activate built revision</button>}
        {instance && <button disabled={busy || !current?.previous || !optIn || account.status !== 'user'} onClick={() => void run(async () => {
          await recover(instance, current?.generation ?? 0, installationIdentity(current))
          const active = installation(instance)!.active
          allowRevision(instance, active)
          adopt(instance)
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
    {unavailable && <StatusBanner code="unavailable" message="Installed metadata unavailable. Nothing was deleted and no default is used in its place. Rebuild the default, then activate it explicitly to repair." actions={[{ label: 'Rebuild default', run: () => void rebuildDefault() }]} />}
    {syncProblem && dismissed !== `sync:${syncProblem}` && <StatusBanner code="sync" tone="error" message={syncProblem} actions={[{ label: 'Retry sync', run: () => void pullAll().catch(() => {}) }]} onDismiss={() => setDismissed(`sync:${syncProblem}`)} />}
    {shown && <StatusBanner code={shown.code} tone="error" message={shown.message} actions={actions[shown.code]} onDismiss={() => setDismissed(`${shown.code}:${shown.message}`)} />}
    {message && <p role="status">{message}</p>}
    {current && <pre>Active: {current.active.snapshot.digest}{'\n'}Generation: {current.generation}</pre>}
  </div>
}
