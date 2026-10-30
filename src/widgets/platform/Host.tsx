import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getNote, updateNote, useAllNotes } from '../../data/notes'
import { getAccount, useAccount } from '../../os/account'
import { notesHidden } from '../../os/deskPrefs'
import { accountGuard } from '../../os/accountSpace'
import { isMobile, useIsMobile } from '../../os/useIsMobile'
import { useWM, type WinState } from '../../os/wm'
import { defaultBuild } from './defaults'
import { hasGrant, useRevisionGrant, allowRevision, revokeRevision, installations, installationVersion, useInstallationPresence, useInstallationRemoved, type Revision } from './installations'
import { CUSTOM_KIND, customState, isInstanceKind, supportsCapabilities, descriptor, verifySnapshot, sourceIdentityOf, type Capability, type Descriptor, type Snapshot, type WidgetInput } from './package'
import { customInput, customRevision } from './records'
import { getWidgetConfig, setWidgetConfig, useWidgetConfig } from '../config'
import { allowNativeText, applyPackageEdit, projectNote, sameNote } from './noteTransactions'
import { Renderer } from './Renderer'
import { execute } from './runtime'
import { RuntimeFailure } from './scheduler'
import { useWidgetVisibility } from './visibility'
import { WeatherControls, usePackageForecast } from './weatherHost'
import { DomainBroker, type DomainKind } from './Broker'
import type { BrokerPresentation } from './brokerTypes'
import './platform.css'

export function useRuntimeVisible() {
  const mobile = useIsMobile()
  const shell = useWidgetVisibility()
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  return shell && visible && !mobile
}
type Presented = { tree: Descriptor; input: WidgetInput; identity: string; broker?: BrokerPresentation; note?: { text: string; revision: string } }
const EMPTY_VIEW: Descriptor = { type: 'column', children: [] }
export function PackageHost({ win, id }: { win: WinState; id: string }) {
  const root = useRef<HTMLDivElement>(null)
  const wm = useWM()
  const account = useAccount()
  const all = useAllNotes()
  const records = installations.use()
  const kind = isInstanceKind(win.props.kind) ? win.props.kind : 'weather'
  const custom = kind === CUSTOM_KIND
  const current = records[id]
  const unavailable = useInstallationPresence(id) && !current
  const removed = useInstallationRemoved(id)
  const stored = useWidgetConfig<{ state?: unknown }>(id, {}).state
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60000))
  const version = installationVersion(id)
  const note = kind === 'sticky' ? all.find(n => n.id === id) : undefined
  const alive = !!note && !note.deleted && !note.purged
  const visible = useRuntimeVisible() && !win.minimized
  const [builtin, setBuiltin] = useState<Snapshot | null>(null)
  const [verified, setVerified] = useState<{ current: typeof current; revision: Revision } | null>(null)
  const [error, setError] = useState('')
  const [view, setView] = useState<Presented | null>(null)
  const [consent, setConsent] = useState(0)
  const busy = useRef(false)
  const eventAbort = useRef<AbortController | null>(null)
  const renderAbort = useRef<AbortController | null>(null)
  const [tick, setTick] = useState(0)
  const [domainPage,setDomainPage]=useState(0)
  const [broker,setBroker]=useState<{identity:string;value:BrokerPresentation}|null>(null)
  const [pages, setPages] = useState<number[]>([0])
  const revision: Revision | null = current ? verified?.current === current ? verified.revision : null : !unavailable && builtin ? { source: { kind: 'system', path: `/usr/share/mvlos/widgets/${kind}` }, snapshot: builtin } : null
  const permitted = useRevisionGrant(id, revision)
  const holdsState = !!revision?.snapshot.manifest.capabilities.includes('custom.state')
  const stateProblem = custom && holdsState ? (() => { try { customState(stored); return '' } catch { return 'Stored widget state is invalid or too large. Reset it from Source.' } })() : ''
  const identity = JSON.stringify([id, kind, account.status, account.user?.id, revision?.source, revision?.snapshot.digest, version.identity, consent, permitted])
  const latest = useRef({ identity, visible })
  latest.current = { identity, visible }
  const eligible = () => latest.current.visible && !notesHidden.get() && document.visibilityState === 'visible' && !isMobile() && !!root.current?.isConnected && !root.current.closest('.is-notes-hidden, .is-covered') && accountGuard() && getAccount().user?.id === account.user?.id
  const validNow = (expected = identity) => eligible() && latest.current.identity === expected && !!revision && hasGrant(id, revision) && installationVersion(id).identity === version.identity
  const weather = usePackageForecast(id, kind === 'weather' && visible && !!permitted && !!revision?.snapshot.manifest.capabilities.includes('weather.read'), tick, identity, () => validNow())
  const domain = ['agenda','inbox','status','minecraft'].includes(kind)
  const presentedBroker = broker?.identity===identity?broker.value:undefined
  const brokerRef=useRef(presentedBroker);brokerRef.current=presentedBroker
  const present=useCallback((value:BrokerPresentation|null)=>setBroker(value?{identity,value}:null),[identity])
  const start = Math.min(pages[pages.length - 1], note?.text.length ?? 0)
  const input = useMemo<WidgetInput>(() => custom ? { custom: customInput(stateProblem ? null : stored, holdsState, minute * 60000) } : domain ? presentedBroker?.input ?? {} : kind === 'weather' ? revision?.snapshot.manifest.capabilities.includes('weather.read') ? weather : {} : alive && note && revision?.snapshot.manifest.capabilities.includes('note.read') ? { note: projectNote(note, start) } : { error: 'Waiting for note sync' }, [kind, weather, alive, note?.text, note?.edited, note?.updated, revision?.snapshot.digest, start, presentedBroker, domain, custom, stored, holdsState, stateProblem, minute])
  useEffect(() => {
    if (!current) return
    let live = true
    Promise.resolve().then(async () => {
      if (current.kind !== kind) throw new Error('Installation kind mismatch')
      const source = sourceIdentityOf(current.active.source)
      const snapshot = await verifySnapshot(current.active.snapshot)
      if (!supportsCapabilities(kind,snapshot.manifest.capabilities)) throw new Error('Invalid instance capability')
      if (live) setVerified({ current, revision: { source, snapshot } })
    }).catch(() => live && setError('Installed package unavailable; rebuild or recover in Source'))
    return () => { live = false }
  }, [current, kind])
  useEffect(() => { if (!custom) return; if (!visible) return; const timer = setInterval(() => setMinute(Math.floor(Date.now() / 60000)), 30_000); return () => clearInterval(timer) }, [custom, visible])
  useEffect(() => { if (custom) return; let live = true; defaultBuild(kind).then(value => live && setBuiltin(value), () => live && setError('Default package build failed')); return () => { live = false } }, [kind, custom])
  useLayoutEffect(() => () => { renderAbort.current?.abort(); eventAbort.current?.abort() }, [identity, visible])
  useEffect(() => { if (note?.deleted || note?.purged) wm.close(win.pid) }, [note?.deleted, note?.purged, win.pid, wm])
  useEffect(() => {
    if (!visible || !revision || !permitted || kind === 'sticky' && !alive) return
    const abort = new AbortController()
    renderAbort.current = abort
    const bound: Presented['note'] = input.note && note ? { text: note.text, revision: input.note.revision } : undefined
    const timer = setTimeout(() => {
      execute(revision.snapshot, input, undefined, abort.signal, { owner: `widget:${id}`, eligible: () => validNow() }).then(result => {
        const fresh = getNote(id)
        if (!abort.signal.aborted && validNow() && (!bound || fresh && sameNote(fresh, bound))) { setView({ tree: descriptor(result), input, identity, note: bound, broker: presentedBroker }); setError('') }
      }, failure => { if (!abort.signal.aborted && !(failure instanceof RuntimeFailure && failure.code === 'cancelled')) setError(failure.message) })
    }, 80)
    return () => { clearTimeout(timer); abort.abort() }
  }, [identity, visible, permitted, input])
  if (kind === 'sticky' && !alive) return null
  const write = (text: string, expected: string): string => {
    const fresh = getNote(id)
    if (fresh && !fresh.deleted && !fresh.purged && validNow() && revision?.snapshot.manifest.capabilities.includes('note.write') && fresh.text === expected) {
      if (allowNativeText(fresh.text, text)) { updateNote(id, { text }); return text }
      setError('Note edit exceeds the supported size; existing contents were kept')
    }
    return fresh?.text ?? expected
  }
  const event = async (event: string) => {
    const presented = view
    const fresh = getNote(id)
    if (!presented || !validNow(presented.identity) || !revision || busy.current || presented.input !== input || presented.note && (!fresh || !sameNote(fresh, presented.note))) return
    busy.current = true
    const controller = new AbortController()
    eventAbort.current = controller
    try {
      const effect = await execute(revision.snapshot, presented.input, event, controller.signal, { owner: `widget:${id}`, eligible: () => validNow(presented.identity) })
      if (effect && effect.type === 'custom.replace') {
        const live = customRevision(getWidgetConfig<{ state?: unknown }>(id, {}).state ?? null)
        if (revision.snapshot.manifest.capabilities.includes('custom.state') && validNow(presented.identity) && !controller.signal.aborted && presented.input.custom?.revision === live && effect.expectedRevision === live) setWidgetConfig(id, { state: customState(effect.state) })
        else if (!controller.signal.aborted) setError('Widget state changed meanwhile; the action was not applied')
        return
      }
      const latestNote = getNote(id)
      if (effect && 'expectedRevision' in effect && validNow(presented.identity) && !controller.signal.aborted && presented.note && presented.input.note && latestNote && !latestNote.deleted && !latestNote.purged && revision.snapshot.manifest.capabilities.includes('note.write')) {
        const next = applyPackageEdit(latestNote, presented.note, presented.input.note, effect)
        if (next !== null) updateNote(id, { text: next })
      }
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Widget event failed') }
    finally { busy.current = false }
  }
  const resource=(handle:string)=>{
    const bound=view?.broker
    if(!bound||bound!==brokerRef.current||!validNow(view!.identity)||view!.input!==input)return undefined
    const value=bound.resources.get(handle)
    return value&&value.valid?.()!==false?value:undefined
  }
  const domainPaging=presentedBroker?.input[kind as DomainKind]?.page
  const spacing = revision ? JSON.parse(revision.snapshot.files['styles/tokens.json']) as { gap?: string; padding?: string } : {}
  const token = (value?: string) => value === 'compact' ? '4px' : value === 'roomy' ? '14px' : '8px'
  const shown = permitted && view?.identity === identity ? view : null
  const actionsEnabled = !!shown && shown.input === input && (!shown.note || !!note && sameNote(note, shown.note)) && visible
  return <div ref={root} className="wp-package" data-package-digest={revision?.snapshot.digest} style={{ '--wp-gap': token(spacing.gap), padding: token(spacing.padding), ...(custom && revision ? { minHeight: revision.snapshot.manifest.sizing.height } : {}) } as CSSProperties}>
    {domain&&visible&&permitted&&revision?.snapshot.manifest.capabilities.includes(`${kind}.read` as Capability)&&<DomainBroker kind={kind as DomainKind} id={id} lifecycle={identity} page={domainPage} tick={tick} capabilities={revision.snapshot.manifest.capabilities} eligible={()=>validNow()} present={present}/>}
    <div className="wp-controls">
      {domain&&<button onClick={()=>setTick(value=>value+1)}>Refresh</button>}
      {kind === 'weather' && <WeatherControls id={id} refresh={() => setTick(n => n + 1)} eligible={eligible} />}
      <button onClick={() => wm.open('widgetworkshop', { id, kind })} aria-label="Edit widget source">Source</button>
      {permitted && revision?.source.kind !== 'system' && <button onClick={() => { if (revision) revokeRevision(id, revision); setConsent(n => n + 1); setView(null) }}>Pause access</button>}
      {kind === 'sticky' && <button onClick={() => wm.open('notebook', { id })}>Notebook & links</button>}
    </div>
    {!permitted && revision ? <button onClick={() => { try { allowRevision(id, revision); setConsent(n => n + 1) } catch (error) { setError(error instanceof Error ? error.message : 'Source unavailable; clone and rebuild locally') } }}>Allow this revision to access this {kind === 'sticky' ? 'note' : kind === 'weather' ? 'forecast' : custom ? 'widget\'s small saved state' : kind+' data and selected actions'}</button> : <>
      <Renderer key={identity} view={shown?.tree ?? EMPTY_VIEW} note={permitted && input.note ? note?.text : undefined} write={revision?.snapshot.manifest.capabilities.includes('note.write') ? write : undefined} event={event} actionsEnabled={actionsEnabled} resource={resource} />
      {input.note && <div className="wp-controls" aria-label="Checklist pages">
        <button disabled={pages.length <= 1} onClick={() => setPages(value => value.slice(0, -1))}>Previous items</button>
        <button disabled={input.note.next === undefined} onClick={() => setPages(value => [...value, input.note!.next!])}>Next items</button>
      </div>}
      {domainPaging&&<div className="wp-controls" aria-label="Data pages"><span>{domainPaging.shown} of {domainPaging.total} · page {domainPaging.page+1}/{domainPaging.pages}</span><button disabled={domainPaging.page===0} onClick={()=>setDomainPage(domainPaging.page-1)}>Previous results</button><button disabled={domainPaging.page+1>=domainPaging.pages} onClick={()=>setDomainPage(domainPaging.page+1)}>Next results</button></div>}
      {!shown && <span>Loading widget…</span>}
    </>}
    {custom && !current && <p role="status" data-custom-unavailable>{removed ? 'This custom widget was removed. Take it off the desktop from its menu, or recreate it in the Workshop.' : unavailable ? 'This custom widget\'s installation record is unreadable and was kept untouched. Open the Workshop to rebuild and activate it again.' : 'This custom widget is not installed on this device (yet). It was kept on the desktop; wait for sync, or open the Workshop to install it again.'} <button onClick={() => wm.open('widgetworkshop', { kind: CUSTOM_KIND })}>Open Workshop</button></p>}
    {stateProblem && <p role="status">{stateProblem}</p>}
    {unavailable && !custom && <p role="status">Installed metadata unavailable. Rebuild default or source in Source, then activate explicitly to repair.</p>}
    {error && <p role="status">{error}</p>}
  </div>
}
