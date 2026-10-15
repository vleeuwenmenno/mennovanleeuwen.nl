import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  clearForecastCache,
  describe,
  fetchForecast,
  locate,
  rememberedHere,
  searchPlaces,
  weekday,
  WIDGET_SKIES,
  windUnit,
  type Forecast,
  type Place,
  type Units,
} from '../data/weather'
import type { MenuItem } from '../os/ContextMenu'
import { useWindowMenu } from '../os/windowMenu'
import type { WinState } from '../os/wm'
import { createWithTilt, setWidgetConfig, tiltMenu, useWidgetConfig } from './config'
import type { WidgetDef } from './types'

// The weather widget: now, the next hours and the next days for one place, from the shared Open-Meteo
// fetch (src/data/weather.ts). The place is the browser's own location unless you set one; a place
// you set syncs with the widget's other settings, the browser's location stays on this device.
// Double-click (or the menu) opens the full Weather app.

type Config = { place: Place | null; units: Units; tilt: number }
const DEFAULTS: Config = { place: null, units: 'c', tilt: 0 }

function useWeather(id: string) {
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  const [here, setHere] = useState<Place | null>(rememberedHere)
  const [forecast, setForecast] = useState<Forecast | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const place = config.place ?? here

  useEffect(() => {
    if (config.place) return
    locate().then(setHere, (e: Error) => !here && setError(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.place])

  useEffect(() => {
    if (!place) return
    let live = true
    fetchForecast(place.lat, place.lon, config.units).then(
      (f) => live && (setForecast(f), setError(null)),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [place?.lat, place?.lon, config.units, tick])

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15 * 60_000)
    return () => clearInterval(t)
  }, [])

  return { config, place, forecast, error, refresh: () => (clearForecastCache(), setTick((n) => n + 1)) }
}

function PlacePicker({ id, onDone }: { id: string; onDone: () => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    if (q.trim().length < 2) return setResults([])
    const t = setTimeout(() => searchPlaces(q.trim()).then(setResults, () => setResults([])), 250)
    return () => clearTimeout(t)
  }, [q])
  const pick = (place: Place | null) => {
    setWidgetConfig(id, { place })
    onDone()
  }
  return (
    <div className="wx-picker">
      <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => (e.key === 'Escape' ? onDone() : e.key === 'Enter' && results[0] && pick(results[0]))} placeholder="Search a city…" aria-label="Search a city" spellCheck={false} />
      <ul>
        <li>
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true)
              locate().then(
                () => pick(null),
                () => setBusy(false),
              )
            }}
          >
            📍 {busy ? 'Finding you…' : 'Use my location'}
          </button>
        </li>
        {results.map((r) => (
          <li key={`${r.lat},${r.lon}`}>
            <button onClick={() => pick(r)}>{r.name}</button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function openWeatherApp(place: Place | null, units: Units) {
  const detail: { app: string; props: Record<string, string> } = {
    app: 'weather',
    props: { t: String(Date.now()), units },
  }
  if (place) {
    detail.props.lat = String(place.lat)
    detail.props.lon = String(place.lon)
    detail.props.name = place.name
  }
  window.dispatchEvent(new CustomEvent('mvlos:open', { detail }))
}

export function Weather({ id }: { win: WinState; id: string }) {
  const { config, place, forecast, error, refresh } = useWeather(id)
  const [picking, setPicking] = useState(false)
  const windowMenu = useWindowMenu()
  const unit = config.units === 'f' ? '°F' : '°'
  const now = forecast?.now
  const sky = now ? describe(now.code, now.day) : null
  const hours = forecast?.hours.slice(1, 7) ?? []
  const days = forecast?.days.slice(1, 4) ?? []

  return (
    <div
      className="wx"
      onDoubleClick={() => {
        if (picking) return
        openWeatherApp(place, config.units)
      }}
    >
      <div className="wx-head">
        <button className="wx-place" onClick={() => setPicking((p) => !p)} title="Change the place">
          {config.place ? '' : '📍 '}
          {place?.name ?? 'Set a place'}
        </button>
        <button className="sticky-btn" onClick={refresh} title="Refresh" aria-label="Refresh">
          ⟳
        </button>
        <button className="sticky-btn" onClick={windowMenu} title="More" aria-label="Weather menu">
          ⋯
        </button>
      </div>
      {picking ? (
        <PlacePicker id={id} onDone={() => setPicking(false)} />
      ) : !place ? (
        <p className="wx-note">
          {error ?? 'Finding where you are…'} ·{' '}
          <button className="link-btn" onClick={() => setPicking(true)}>
            pick a city
          </button>
        </p>
      ) : !forecast ? (
        <p className="wx-note">{error ?? 'Looking at the sky…'}</p>
      ) : (
        <>
          <div className="wx-now">
            <span className="wx-icon" aria-hidden>
              {sky!.icon}
            </span>
            <span className="wx-temp">
              {Math.round(now!.temp)}
              {unit}
            </span>
            <span className="wx-desc">
              {sky!.text}
              <span>
                feels {Math.round(now!.feels)}
                {unit} · {Math.round(now!.wind)} {windUnit(config.units)} · {now!.humidity}%
              </span>
            </span>
          </div>
          <ol className="wx-hours" aria-label="Next hours">
            {hours.map((h) => (
              <li key={h.iso}>
                <span>{h.time}</span>
                <span aria-hidden>{describe(h.code, h.day).icon}</span>
                <span>{Math.round(h.temp)}°</span>
              </li>
            ))}
          </ol>
          <ol className="wx-days" aria-label="Next days">
            {days.map((d) => (
              <li key={d.date}>
                <span>{weekday(d.date)}</span>
                <span aria-hidden>{describe(d.code).icon}</span>
                <span>
                  {Math.round(d.max)}° <span className="wx-min">{Math.round(d.min)}°</span>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}

function useWeatherFrame(id: string): CSSProperties {
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  const place = config.place ?? rememberedHere()
  const [forecast, setForecast] = useState<Forecast | null>(null)
  useEffect(() => {
    if (place) fetchForecast(place.lat, place.lon, config.units).then(setForecast, () => {})
  }, [place?.lat, place?.lon, config.units])
  const now = forecast?.now
  const sky = now ? describe(now.code, now.day).sky : 'cloudy'
  const look = now && !now.day && (sky === 'clear' || sky === 'cloudy') ? WIDGET_SKIES.night : WIDGET_SKIES[sky]
  return { ['--widget-bg' as string]: look.bg, ['--widget-fg' as string]: look.fg, ['--widget-tilt' as string]: `${config.tilt}deg` }
}

function useWeatherMenu(id: string): MenuItem[] {
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  const place = config.place ?? rememberedHere()
  return [
    { label: 'Open Weather', onSelect: () => openWeatherApp(place, config.units) },
    { separator: true },
    ...(config.place ? [{ label: 'Use my location instead', onSelect: () => setWidgetConfig(id, { place: null }) }] : []),
    {
      label: 'Units',
      submenu: [
        { label: 'Celsius, km/h', checked: config.units === 'c', onSelect: () => setWidgetConfig(id, { units: 'c' }) },
        { label: 'Fahrenheit, mph', checked: config.units === 'f', onSelect: () => setWidgetConfig(id, { units: 'f' }) },
      ],
    },
    tiltMenu(id, config.tilt),
  ]
}

export const weatherWidget: WidgetDef = {
  kind: 'weather',
  name: 'Weather',
  blurb: 'Now, the next hours and days, for where you are or any city',
  glyph: '⛅',
  size: [290, 300],
  resizable: true,
  Component: Weather,
  useFrame: useWeatherFrame,
  useMenu: useWeatherMenu,
  create: createWithTilt,
}
