import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { clearForecastCache, describe, fetchForecast, locate, rememberedHere, searchPlaces, weekday, type Forecast, type Place } from '../../data/weather'
import { getAccount } from '../../os/account'
import { accountGuard } from '../../os/accountSpace'
import { setWidgetConfig, useWidgetConfig } from '../config'
import { startForecastRefresh } from './forecastRefresh'
import type { WidgetInput } from './package'
function useLocalHere() {
  const [here, setHere] = useState(rememberedHere)
  useEffect(() => {
    const update = () => setHere(rememberedHere())
    window.addEventListener('mvlos:weather-here', update)
    window.addEventListener('storage', update)
    return () => { window.removeEventListener('mvlos:weather-here', update); window.removeEventListener('storage', update) }
  }, [])
  return here
}
/** Queries/coordinates originate only in trusted user-operated controls, never package events. */
export function WeatherControls({ id, refresh, eligible }: { id: string; refresh: () => void; eligible: () => boolean }) {
  const config = useWidgetConfig(id, { place: null as Place | null, units: 'c' })
  const here = useLocalHere()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const scope = () => {
    const account = getAccount().user?.id
    return () => eligible() && accountGuard() && getAccount().user?.id === account
  }
  return <div className="wp-controls">
    <button onClick={() => setOpen(!open)} aria-label="Choose weather place">{config.place?.name ?? here?.name ?? 'Choose place'}</button>
    <button aria-label="Weather units" onClick={() => setWidgetConfig(id, { units: config.units === 'f' ? 'c' : 'f' })}>{config.units === 'f' ? '°F' : '°C'}</button>
    <button onClick={() => { clearForecastCache(); refresh() }}>Refresh</button>
    {open && <form onSubmit={e => {
      e.preventDefault()
      const allowed = scope()
      if (!allowed()) return
      setBusy(true)
      searchPlaces(query.slice(0, 100)).then(value => allowed() && setResults(value), () => allowed() && setError('Place search unavailable')).finally(() => setBusy(false))
    }}>
      <input aria-label="Search a city" value={query} maxLength={100} onChange={e => setQuery(e.target.value)} placeholder="Search a city…" />
      <button disabled={busy || query.trim().length < 2}>Search places</button>
      <button type="button" onClick={() => {
        const allowed = scope()
        if (!allowed()) return
        setBusy(true)
        locate(allowed).then(() => { if (allowed()) { setWidgetConfig(id, { place: null }); setOpen(false) } }, () => allowed() && setError('Location unavailable')).finally(() => setBusy(false))
      }} disabled={busy}>Use my location</button>
      {results.map(place => <button type="button" key={`${place.lat}:${place.lon}`} onClick={() => { if (eligible() && accountGuard()) { setWidgetConfig(id, { place }); setOpen(false) } }}>{place.name}</button>)}
      {error && <span role="status">{error}</span>}
    </form>}
  </div>
}
export function usePackageForecast(id: string, enabled: boolean, tick: number, lifecycle: string, eligible: () => boolean) {
  const config = useWidgetConfig(id, { place: null as Place | null, units: 'c' })
  const here = useLocalHere()
  const place = config.place ?? here
  const [value, setValue] = useState<{ key: string; lifecycle: string; forecast: Forecast } | null>(null)
  const [error, setError] = useState<{ key: string; lifecycle: string; message: string } | null>(null)
  const key = `${place?.lat}:${place?.lon}:${config.units}`
  // eligible closes over this lifecycle's account, runtime revision and grant. Its function
  // identity changes on ordinary renders; only the stable lifecycle key restarts the loop.
  useLayoutEffect(() => {
    if (!enabled || !place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return
    let live = true
    const stop = startForecastRefresh(async signal => {
      try {
        const forecast = await fetchForecast(place.lat, place.lon, config.units === 'f' ? 'f' : 'c', signal)
        if (live && eligible() && !signal.aborted) { setValue({ key, lifecycle, forecast }); setError(null) }
        return forecast
      } catch (error) {
        if (live && eligible() && !signal.aborted) setError({ key, lifecycle, message: 'Forecast unavailable' })
        throw error
      }
    }, () => live && eligible())
    return () => { live = false; stop() }
  }, [enabled, key, tick, lifecycle])
  return useMemo<WidgetInput>(() => {
    const forecast = value?.key === key && value.lifecycle === lifecycle ? value.forecast : null
    const message = error?.key === key && error.lifecycle === lifecycle ? error.message : ''
    if (!forecast || !place) return { error: message || (place ? 'Loading forecast…' : 'Choose a place above.') }
    return { weather: { place: place.name.slice(0, 150), units: config.units, summary: `${describe(forecast.now.code, forecast.now.day).icon} ${Math.round(forecast.now.temp)}° · ${describe(forecast.now.code, forecast.now.day).text}`,
      hours: forecast.hours.slice(1, 7).map(h => `${h.time} ${Math.round(h.temp)}°`), days: forecast.days.slice(1, 4).map(d => `${weekday(d.date)} ${Math.round(d.max)}° / ${Math.round(d.min)}°`) } }
  }, [value, key, place?.name, error, lifecycle])
}
