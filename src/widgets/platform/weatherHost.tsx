import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { clearForecastCache, describe, fetchForecast, locate, rememberedHere, searchPlaces, weekday, windUnit, type Forecast, type Place } from '../../data/weather'
import { getAccount } from '../../os/account'
import { accountGuard } from '../../os/accountSpace'
import { setWidgetConfig, useWidgetConfig } from '../config'
import { startForecastRefresh } from './forecastRefresh'
import { ToolButton } from './Chrome'
import { Icon, weatherIcon } from './icons'
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
/** Queries/coordinates originate only in trusted user-operated controls, never package events. The buttons go in the
 * widget toolbar; the place search opens in `slot`, under it. */
export function WeatherControls({ id, refresh, eligible, onOpen, slot }: { id: string; refresh: () => void; eligible: () => boolean; onOpen: (open: boolean) => void; slot: HTMLElement | null }) {
  const config = useWidgetConfig(id, { place: null as Place | null, units: 'c' })
  const here = useLocalHere()
  const [open, setOpenState] = useState(false)
  const setOpen = (value: boolean) => { setOpenState(value); onOpen(value) }
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const scope = () => {
    const account = getAccount().user?.id
    return () => eligible() && accountGuard() && getAccount().user?.id === account
  }
  const form = open && slot ? createPortal(<form className="wp-place-form" onSubmit={e => {
      e.preventDefault()
      const allowed = scope()
      if (!allowed()) return
      setBusy(true)
      searchPlaces(query.slice(0, 100)).then(value => allowed() && setResults(value), () => allowed() && setError('Place search unavailable')).finally(() => setBusy(false))
    }}>
      <input aria-label="Search a city" value={query} maxLength={100} autoFocus onChange={e => setQuery(e.target.value)} placeholder="Search a city…" />
      <button disabled={busy || query.trim().length < 2}>Search places</button>
      <button type="button" onClick={() => {
        const allowed = scope()
        if (!allowed()) return
        setBusy(true)
        locate(allowed).then(() => { if (allowed()) { setWidgetConfig(id, { place: null }); setOpen(false) } }, () => allowed() && setError('Location unavailable')).finally(() => setBusy(false))
      }} disabled={busy}>Use my location</button>
      {results.map(place => <button type="button" key={`${place.lat}:${place.lon}`} onClick={() => { if (eligible() && accountGuard()) { setWidgetConfig(id, { place }); setOpen(false) } }}>{place.name}</button>)}
      {error && <span role="status">{error}</span>}
    </form>, slot) : null
  return <>
    <button type="button" className="wp-tool" aria-label="Choose weather place" aria-expanded={open} title="Choose place" onClick={() => setOpen(!open)}><Icon name="pin" /><span className="wp-sr">{config.place?.name ?? here?.name ?? 'Choose place'}</span></button>
    <button type="button" className="wp-tool-text" aria-label="Weather units" title="Switch units" onClick={() => setWidgetConfig(id, { units: config.units === 'f' ? 'c' : 'f' })}>{config.units === 'f' ? '°F' : '°C'}</button>
    <ToolButton icon="refresh" label="Refresh" onClick={() => { clearForecastCache(); refresh() }} />
    {form}
  </>
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
    const sky = describe(forecast.now.code, forecast.now.day), today = forecast.days[0]
    return { weather: { place: place.name.slice(0, 150), units: config.units, summary: `${sky.icon} ${Math.round(forecast.now.temp)}° · ${sky.text}`,
      hours: forecast.hours.slice(1, 7).map(h => `${h.time} ${Math.round(h.temp)}°`), days: forecast.days.slice(1, 4).map(d => `${weekday(d.date)} ${Math.round(d.max)}° / ${Math.round(d.min)}°`),
      now: { temp: Math.round(forecast.now.temp), feels: Math.round(forecast.now.feels), text: sky.text, icon: weatherIcon(forecast.now.code, forecast.now.day), high: Math.round(today?.max ?? forecast.now.temp), low: Math.round(today?.min ?? forecast.now.temp), wind: Math.round(forecast.now.wind), windUnit: windUnit(config.units === 'f' ? 'f' : 'c'), humidity: Math.round(forecast.now.humidity), day: forecast.now.day },
      hourly: forecast.hours.slice(1, 7).map(h => ({ time: h.time, temp: Math.round(h.temp), icon: weatherIcon(h.code, h.day), rain: Math.round(h.precipProb) })),
      daily: forecast.days.slice(1, 6).map(d => ({ label: weekday(d.date), max: Math.round(d.max), min: Math.round(d.min), icon: weatherIcon(d.code, true), rain: Math.round(d.precipProb) })) } }
  }, [value, key, place?.name, error, lifecycle])
}
