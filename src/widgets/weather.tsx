import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { MenuItem } from '../os/ContextMenu'
import { useWindowMenu } from '../os/windowMenu'
import type { WinState } from '../os/wm'
import { randomTilt, setWidgetConfig, TILTS, useWidgetConfig } from './config'
import type { WidgetDef } from './types'

// The weather widget: now, the next hours and the next days for one place, from Open-Meteo (free,
// no key, called straight from the browser). The place is the browser's own location unless you
// set one; a place you set syncs with the widget's other settings, the browser's location stays
// on this device.

type Place = { name: string; lat: number; lon: number }
type Config = { place: Place | null; units: 'c' | 'f'; tilt: number }
const DEFAULTS: Config = { place: null, units: 'c', tilt: 0 }

type Forecast = {
  at: number
  now: { temp: number; feels: number; code: number; wind: number; humidity: number; day: boolean }
  hours: { time: string; temp: number; code: number; day: boolean }[]
  days: { date: string; max: number; min: number; code: number }[]
}

// ---------------------------------------------------------------------------------------------
// WMO weather codes

type Sky = 'clear' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm'

function describe(code: number, day = true): { text: string; icon: string; sky: Sky } {
  if (code === 0) return { text: day ? 'Sunny' : 'Clear', icon: day ? '☀️' : '🌙', sky: 'clear' }
  if (code === 1) return { text: 'Mostly clear', icon: day ? '🌤️' : '🌙', sky: 'clear' }
  if (code === 2) return { text: 'Partly cloudy', icon: day ? '⛅' : '☁️', sky: 'cloudy' }
  if (code === 3) return { text: 'Overcast', icon: '☁️', sky: 'cloudy' }
  if (code === 45 || code === 48) return { text: 'Fog', icon: '🌫️', sky: 'fog' }
  if (code >= 51 && code <= 57) return { text: 'Drizzle', icon: '🌦️', sky: 'rain' }
  if (code >= 61 && code <= 67) return { text: code >= 65 ? 'Heavy rain' : 'Rain', icon: '🌧️', sky: 'rain' }
  if (code >= 71 && code <= 77) return { text: 'Snow', icon: '🌨️', sky: 'snow' }
  if (code >= 80 && code <= 82) return { text: 'Showers', icon: '🌦️', sky: 'rain' }
  if (code === 85 || code === 86) return { text: 'Snow showers', icon: '🌨️', sky: 'snow' }
  if (code >= 95) return { text: 'Thunderstorm', icon: '⛈️', sky: 'storm' }
  return { text: 'Weather', icon: '🌡️', sky: 'cloudy' }
}

/** The card's colours follow the sky: warm and bright for sun, deep blue at night, grey for cloud. */
const SKIES: Record<Sky | 'night', { bg: string; fg: string }> = {
  clear: { bg: 'linear-gradient(170deg, #8fd0ff 0%, #ffe9a8 100%)', fg: '#16324d' },
  night: { bg: 'linear-gradient(170deg, #1c2650 0%, #3b3f78 100%)', fg: '#e8ecff' },
  cloudy: { bg: 'linear-gradient(170deg, #c9d3df 0%, #eef1f5 100%)', fg: '#25313f' },
  fog: { bg: 'linear-gradient(170deg, #d9dcdf 0%, #f4f4f2 100%)', fg: '#30363d' },
  rain: { bg: 'linear-gradient(170deg, #7b93ad 0%, #b9c8d8 100%)', fg: '#0f2236' },
  snow: { bg: 'linear-gradient(170deg, #e4f1ff 0%, #ffffff 100%)', fg: '#1d3550' },
  storm: { bg: 'linear-gradient(170deg, #3f3a5f 0%, #6c6a8e 100%)', fg: '#f1efff' },
}

// ---------------------------------------------------------------------------------------------
// Data

const FORECAST_TTL = 10 * 60_000
const forecasts = new Map<string, Forecast>()

async function fetchForecast(lat: number, lon: number, units: Config['units']): Promise<Forecast> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${units}`
  const hit = forecasts.get(key)
  if (hit && Date.now() - hit.at < FORECAST_TTL) return hit
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day,relative_humidity_2m',
    hourly: 'temperature_2m,weather_code,is_day',
    daily: 'temperature_2m_max,temperature_2m_min,weather_code',
    timezone: 'auto',
    forecast_days: '4',
    forecast_hours: '7',
    ...(units === 'f' ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph' } : {}),
  })
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`)
  const d = await res.json()
  const f: Forecast = {
    at: Date.now(),
    now: { temp: d.current.temperature_2m, feels: d.current.apparent_temperature, code: d.current.weather_code, wind: d.current.wind_speed_10m, humidity: d.current.relative_humidity_2m, day: !!d.current.is_day },
    hours: (d.hourly.time as string[]).slice(1, 7).map((t, i) => ({ time: t.slice(11, 16), temp: d.hourly.temperature_2m[i + 1], code: d.hourly.weather_code[i + 1], day: !!d.hourly.is_day[i + 1] })),
    days: (d.daily.time as string[]).slice(1, 4).map((t, i) => ({ date: t, max: d.daily.temperature_2m_max[i + 1], min: d.daily.temperature_2m_min[i + 1], code: d.daily.weather_code[i + 1] })),
  }
  forecasts.set(key, f)
  return f
}

/** Places matching a name, for setting one by hand. */
async function searchPlaces(q: string): Promise<Place[]> {
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en`, { signal: AbortSignal.timeout(6000) })
  const d = await res.json()
  return ((d.results ?? []) as { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[]).map((r) => ({
    name: [r.name, r.admin1 && r.admin1 !== r.name ? r.admin1 : null, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }))
}

// The browser's location, remembered on this device only (not synced: it is where this device is).
const HERE_KEY = 'mvlos.weather.here'
function rememberedHere(): Place | null {
  try {
    return JSON.parse(localStorage.getItem(HERE_KEY) ?? 'null')
  } catch {
    return null
  }
}

function locate(): Promise<Place> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser has no location'))
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = Math.round(pos.coords.latitude * 100) / 100
        const lon = Math.round(pos.coords.longitude * 100) / 100
        let name = `${lat}, ${lon}`
        try {
          const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, { signal: AbortSignal.timeout(5000) })
          const d = await r.json()
          name = d.city || d.locality || d.principalSubdivision || name
        } catch {
          /* the coordinates will do */
        }
        const place = { name, lat, lon }
        try {
          localStorage.setItem(HERE_KEY, JSON.stringify(place))
        } catch {
          /* asked again next time */
        }
        resolve(place)
      },
      (err) => reject(new Error(err.code === err.PERMISSION_DENIED ? 'Location not allowed' : 'Location unavailable')),
      { timeout: 10_000, maximumAge: 30 * 60_000 },
    )
  })
}

// ---------------------------------------------------------------------------------------------
// The widget

function useWeather(id: string) {
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  const [here, setHere] = useState<Place | null>(rememberedHere)
  const [forecast, setForecast] = useState<Forecast | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const place = config.place ?? here

  // No place set: ask the browser (once a session per widget; it prompts the first time).
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

  // Fresh every 15 minutes.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15 * 60_000)
    return () => clearInterval(t)
  }, [])

  return { config, place, forecast, error, refresh: () => (forecasts.clear(), setTick((n) => n + 1)) }
}

const weekday = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short' })

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

export function Weather({ id }: { win: WinState; id: string }) {
  const { config, place, forecast, error, refresh } = useWeather(id)
  const [picking, setPicking] = useState(false)
  const windowMenu = useWindowMenu()
  const unit = config.units === 'f' ? '°F' : '°'
  const now = forecast?.now
  const sky = now ? describe(now.code, now.day) : null

  return (
    <div className="wx">
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
        <p className="wx-note">{error ?? 'Finding where you are…'} · <button className="link-btn" onClick={() => setPicking(true)}>pick a city</button></p>
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
                {unit} · {Math.round(now!.wind)} {config.units === 'f' ? 'mph' : 'km/h'} · {now!.humidity}%
              </span>
            </span>
          </div>
          <ol className="wx-hours" aria-label="Next hours">
            {forecast.hours.map((h) => (
              <li key={h.time}>
                <span>{h.time}</span>
                <span aria-hidden>{describe(h.code, h.day).icon}</span>
                <span>{Math.round(h.temp)}°</span>
              </li>
            ))}
          </ol>
          <ol className="wx-days" aria-label="Next days">
            {forecast.days.map((d) => (
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
  // Clear or cloudy nights are simply night; rain, snow and storms keep their own look.
  const look = now && !now.day && (sky === 'clear' || sky === 'cloudy') ? SKIES.night : SKIES[sky]
  return { ['--widget-bg' as string]: look.bg, ['--widget-fg' as string]: look.fg, ['--widget-tilt' as string]: `${config.tilt}deg` }
}

function useWeatherMenu(id: string): MenuItem[] {
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  return [
    ...(config.place ? [{ label: 'Use my location instead', onSelect: () => setWidgetConfig(id, { place: null }) }] : []),
    { label: 'Units', submenu: [{ label: 'Celsius, km/h', checked: config.units === 'c', onSelect: () => setWidgetConfig(id, { units: 'c' }) }, { label: 'Fahrenheit, mph', checked: config.units === 'f', onSelect: () => setWidgetConfig(id, { units: 'f' }) }] },
    {
      label: 'Tilt',
      submenu: [
        ...TILTS.map(([label, tilt]) => ({ label, checked: config.tilt === tilt, onSelect: () => setWidgetConfig(id, { tilt }) })),
        { separator: true as const },
        { label: 'Random', onSelect: () => setWidgetConfig(id, { tilt: randomTilt() }) },
      ],
    },
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
  create: () => {
    const id = crypto.randomUUID().slice(0, 8)
    setWidgetConfig(id, { tilt: randomTilt() })
    return id
  },
}
