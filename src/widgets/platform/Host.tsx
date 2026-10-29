import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getNote, updateNote, useAllNotes } from '../../data/notes'
import { clearForecastCache, describe, fetchForecast, locate, rememberedHere, searchPlaces, weekday, type Forecast, type Place } from '../../data/weather'
import { getAccount, useAccount } from '../../os/account'
import { accountGuard } from '../../os/accountSpace'
import { useIsMobile } from '../../os/useIsMobile'
import { useWM, type WinState } from '../../os/wm'
import { setWidgetConfig, useWidgetConfig } from '../config'
import { defaultBuild } from './defaults'
import { hasGrant, allowRevision, revokeRevision, installations, type Revision } from './installations'
import { descriptor, verifySnapshot, sourceIdentityOf, type Descriptor, type Snapshot, type WidgetInput } from './package'
import { noteRevision } from './editor'
import { Renderer } from './Renderer'
import { execute } from './runtime'
import './platform.css'
export const MOCK_INPUT: WidgetInput = { note: { text: 'Sample note\n- [ ] Try a checklist', revision: 'mock:1' }, weather: { place: 'Sample city', units: 'c', summary: '☀ 18° · Clear sky', hours: ['12:00 18°', '13:00 19°'], days: ['Tomorrow 20° / 12°'] } }
export function useRuntimeVisible() {
  const mobile = useIsMobile()
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  return visible && !mobile
}
/** Trusted controls: package code cannot supply geocoder queries or coordinates. */
function WeatherControls({ id, refresh }: { id: string; refresh: () => void }) {
  const config = useWidgetConfig(id, { place: null as Place | null, units: 'c' })
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <div className="wp-controls">
    <button onClick={() => setOpen(!open)} aria-label="Choose weather place">{config.place?.name ?? rememberedHere()?.name ?? 'Choose place'}</button>
    <button aria-label="Weather units" onClick={() => setWidgetConfig(id, { units: config.units === 'f' ? 'c' : 'f' })}>{config.units === 'f' ? '°F' : '°C'}</button>
    <button onClick={refresh}>Refresh</button>
    {open && <form onSubmit={e => {
      e.preventDefault(); setBusy(true)
      searchPlaces(query.slice(0, 100)).then(setResults, () => setError('Place search unavailable')).finally(() => setBusy(false))
    }}>
      <input aria-label="Search a city" value={query} maxLength={100} onChange={e => setQuery(e.target.value)} placeholder="Search a city…" />
      <button disabled={busy || query.trim().length < 2}>Search places</button>
      <button type="button" onClick={() => { setBusy(true); locate().then(place => { setWidgetConfig(id, { place }); setOpen(false) }, () => setError('Location unavailable')).finally(() => setBusy(false)) }} disabled={busy}>Use my location</button>
      {results.map(place => <button type="button" key={`${place.lat}:${place.lon}`} onClick={() => { setWidgetConfig(id, { place }); setOpen(false) }}>{place.name}</button>)}
      {error && <span role="status">{error}</span>}
    </form>}
  </div>
}
function useForecast(id: string, enabled: boolean, tick: number) {
  const config = useWidgetConfig(id, { place: null as Place | null, units: 'c' })
  const place = config.place ?? rememberedHere()
  const [value, setValue] = useState<{ key: string; forecast: Forecast } | null>(null)
  const [error, setError] = useState('')
  const key = `${place?.lat}:${place?.lon}:${config.units}`
  useEffect(() => {
    if (!enabled || !place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return
    let live = true
    setError('')
    fetchForecast(place.lat, place.lon, config.units === 'f' ? 'f' : 'c').then(forecast => live && setValue({ key, forecast }), () => live && setError('Forecast unavailable'))
    return () => { live = false }
  }, [enabled, key, tick]) // Only the host-selected place, never package-supplied data.
  return useMemo<WidgetInput>(() => {
    const forecast = value?.key === key ? value.forecast : null
    if (!forecast || !place) return { error: error || (place ? 'Loading forecast…' : 'Choose a place above.') }
    return { weather: { place: place.name.slice(0, 150), units: config.units, summary: `${describe(forecast.now.code, forecast.now.day).icon} ${Math.round(forecast.now.temp)}° · ${describe(forecast.now.code, forecast.now.day).text}`,
      hours: forecast.hours.slice(1, 7).map(h => `${h.time} ${Math.round(h.temp)}°`),
      days: forecast.days.slice(1, 4).map(d => `${weekday(d.date)} ${Math.round(d.max)}° / ${Math.round(d.min)}°`) } }
  }, [value, key, place?.name, error])
}
export function PackageHost({ win, id }: { win: WinState; id: string }) {
  const wm = useWM()
  const account = useAccount()
  const all = useAllNotes()
  const records = installations.use()
  const kind = win.props.kind === 'sticky' ? 'sticky' : 'weather'
  const current = records[id]
  const note = kind === 'sticky' ? all.find(n => n.id === id) : undefined
  const alive = !!note && !note.deleted && !note.purged
  const visible = useRuntimeVisible() && !win.minimized
  const [builtin, setBuiltin] = useState<Snapshot | null>(null)
  const [verified, setVerified] = useState<{ current: typeof current; revision: Revision } | null>(null)
  const [error, setError] = useState('')
  const [view, setView] = useState<Descriptor | null>(null)
  const [consent, setConsent] = useState(0)
  const [busy, setBusy] = useState(false)
  const eventAbort = useRef<AbortController | null>(null)
  const [tick, setTick] = useState(0)
  const revision: Revision | null = current ? verified?.current === current ? verified.revision : null : builtin ? { source: { kind: 'system', path: `/usr/share/mvlos/widgets/${kind}` }, snapshot: builtin } : null
  const permitted = revision && hasGrant(id, revision)
  const weather = useForecast(id, kind === 'weather' && visible && !!permitted && !!revision?.snapshot.manifest.capabilities.includes('weather.read'), tick)
  const input = useMemo<WidgetInput>(() => kind === 'weather' ? revision?.snapshot.manifest.capabilities.includes('weather.read') ? weather : {} : alive && note && revision?.snapshot.manifest.capabilities.includes('note.read') ? { note: { text: note.text, revision: noteRevision(note) } } : { error: 'Waiting for note sync' }, [kind, weather, alive, note?.text, note?.edited, note?.updated, revision?.snapshot.digest])
  const identity = JSON.stringify([account.status, account.user?.id, revision?.source, revision?.snapshot.digest, current?.generation, consent])
  useEffect(() => {
    if (!current) return
    let live = true
    Promise.resolve().then(async () => {
      if (current.kind !== kind) throw new Error('Installation kind mismatch')
      const source = sourceIdentityOf(current.active.source)
      const snapshot = await verifySnapshot(current.active.snapshot)
      if (snapshot.manifest.capabilities.some(c => !(kind === 'sticky' ? ['note.read', 'note.write'] : ['weather.read']).includes(c))) throw new Error('Invalid instance capability')
      if (live) setVerified({ current, revision: { source, snapshot } })
    }).catch(() => live && setError('Installed package unavailable; rebuild or recover in Source'))
    return () => { live = false }
  }, [current, kind])
  useEffect(() => { let live = true; defaultBuild(kind).then(value => live && setBuiltin(value), () => live && setError('Default package build failed')); return () => { live = false } }, [kind])
  useEffect(() => () => { eventAbort.current?.abort() }, [identity, visible])
  useEffect(() => { if (note?.deleted || note?.purged) wm.close(win.pid) }, [note?.deleted, note?.purged, win.pid, wm])
  useEffect(() => {
    if (!visible || !revision || !permitted || kind === 'sticky' && !alive) return
    const abort = new AbortController()
    // Debounce descriptor refresh only; native input writes remain immediate.
    const timer = setTimeout(() => {
      execute(revision.snapshot, input, undefined, abort.signal).then(result => { if (!abort.signal.aborted && accountGuard()) { setView(descriptor(result)); setError('') } }, failure => !abort.signal.aborted && setError(failure.message))
    }, 80)
    return () => { clearTimeout(timer); abort.abort() }
  }, [identity, visible, permitted, input])
  if (kind === 'sticky' && !alive) return null
  const validNow = () => visible && document.visibilityState === 'visible' && window.innerWidth >= 720 && revision && hasGrant(id, revision) && accountGuard() && getAccount().user?.id === account.user?.id && installations.get()[id]?.generation === current?.generation
  const write = (text: string) => { if (validNow() && revision?.snapshot.manifest.capabilities.includes('note.write') && text.length <= 32768 && getNote(id) && !getNote(id)!.deleted && !getNote(id)!.purged) updateNote(id, { text }) }
  const event = async (event: string) => {
    if (!validNow() || !revision || busy) return
    const bound = input.note
    setBusy(true)
    try {
      const controller = new AbortController()
      eventAbort.current = controller
      const effect = await execute(revision.snapshot, input, event, controller.signal)
      const fresh = getNote(id)
      if (validNow() && effect && 'expectedRevision' in effect && bound && fresh && !fresh.deleted && !fresh.purged && fresh.text === bound.text && noteRevision(fresh) === effect.expectedRevision) write(effect.text)
    } catch (error) { setError(error instanceof Error ? error.message : 'Widget event failed') }
    finally { setBusy(false) }
  }
  const spacing = revision ? JSON.parse(revision.snapshot.files['styles/tokens.json']) as { gap?: string; padding?: string } : {}
  const token = (value?: string) => value === 'compact' ? '4px' : value === 'roomy' ? '14px' : '8px'
  return <div className="wp-package" data-package-digest={revision?.snapshot.digest} style={{ '--wp-gap': token(spacing.gap), padding: token(spacing.padding) } as CSSProperties}>
    <div className="wp-controls">
      {kind === 'weather' && <WeatherControls id={id} refresh={() => { clearForecastCache(); setTick(n => n + 1) }} />}
      <button onClick={() => wm.open('widgetworkshop', { id, kind })} aria-label="Edit widget source">Source</button>
      {permitted && revision?.source.kind !== 'system' && <button onClick={() => { if (revision) revokeRevision(id, revision); setConsent(n => n + 1); setView(null) }}>Pause access</button>}
      {kind === 'sticky' && <button onClick={() => wm.open('notebook', { id })}>Notebook & links</button>}
    </div>
    {!permitted && revision ? <button onClick={() => { try { allowRevision(id, revision); setConsent(n => n + 1) } catch (error) { setError(error instanceof Error ? error.message : 'Source unavailable; clone and rebuild locally') } }}>Allow this revision to access this {kind === 'sticky' ? 'note' : 'forecast'}</button> : view ? <Renderer key={identity} view={view} note={input.note?.text} write={revision?.snapshot.manifest.capabilities.includes('note.write') ? write : undefined} event={event} /> : <span>Loading widget…</span>}
    {error && <p role="status">{error}</p>}
  </div>
}
