import { useEffect, useState } from 'react'
import { synced } from '../os/synced'

// Weather from Open-Meteo (free, no key, called from the browser): current conditions, hourly and
// daily forecasts, plus air quality from their separate API. Shared by the Weather app and the
// desktop weather widget.

export type Place = { name: string; lat: number; lon: number }
export type Units = 'c' | 'f'

export type Sky = 'clear' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm'

export type Forecast = {
  at: number
  units: Units
  now: {
    temp: number
    feels: number
    code: number
    wind: number
    windDir: number
    gusts: number
    humidity: number
    dewPoint: number
    pressure: number
    visibility: number
    precip: number
    uv: number
    cloud: number
    day: boolean
  }
  hours: {
    time: string
    iso: string
    temp: number
    feels: number
    code: number
    day: boolean
    precipProb: number
    precip: number
    wind: number
    windDir: number
    uv: number
    humidity: number
    pressure: number
    visibility: number
  }[]
  /** Precipitation over the next hour, in 15-minute steps. */
  minutes: { label: string; precip: number }[]
  days: {
    date: string
    max: number
    min: number
    code: number
    sunrise: string
    sunset: string
    precipSum: number
    precipProb: number
    uvMax: number
    windMax: number
  }[]
}

export type AirQuality = {
  at: number
  /** European AQI 0–100+ (Open-Meteo). */
  aqi: number
  label: string
}

export type WeatherPrefs = {
  units: Units
  /** Saved cities for the Weather app (synced). Device "here" is never stored here. */
  places: Place[]
  /** Index into `places`, or -1 for the device's own location. */
  selected: number
}

const PREFS_DEFAULT: WeatherPrefs = { units: 'c', places: [], selected: -1 }

function normalizePrefs(v: unknown): WeatherPrefs {
  const o = v && typeof v === 'object' ? (v as Partial<WeatherPrefs>) : {}
  const units: Units = o.units === 'f' ? 'f' : 'c'
  const places = Array.isArray(o.places)
    ? o.places.filter((p): p is Place => !!p && typeof p === 'object' && typeof (p as Place).name === 'string' && typeof (p as Place).lat === 'number' && typeof (p as Place).lon === 'number')
    : []
  const selected = typeof o.selected === 'number' && Number.isFinite(o.selected) ? Math.max(-1, Math.min(places.length - 1, Math.trunc(o.selected))) : -1
  return { units, places, selected }
}

export const weatherPrefs = synced<WeatherPrefs>('weather', PREFS_DEFAULT, { normalize: normalizePrefs })

export function describe(code: number, day = true): { text: string; icon: string; sky: Sky } {
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

/** Card colours for the desktop widget (readable text on a light or tinted sky). */
export const WIDGET_SKIES: Record<Sky | 'night', { bg: string; fg: string }> = {
  clear: { bg: 'linear-gradient(170deg, #8fd0ff 0%, #ffe9a8 100%)', fg: '#16324d' },
  night: { bg: 'linear-gradient(170deg, #1c2650 0%, #3b3f78 100%)', fg: '#e8ecff' },
  cloudy: { bg: 'linear-gradient(170deg, #c9d3df 0%, #eef1f5 100%)', fg: '#25313f' },
  fog: { bg: 'linear-gradient(170deg, #d9dcdf 0%, #f4f4f2 100%)', fg: '#30363d' },
  rain: { bg: 'linear-gradient(170deg, #7b93ad 0%, #b9c8d8 100%)', fg: '#0f2236' },
  snow: { bg: 'linear-gradient(170deg, #e4f1ff 0%, #ffffff 100%)', fg: '#1d3550' },
  storm: { bg: 'linear-gradient(170deg, #3f3a5f 0%, #6c6a8e 100%)', fg: '#f1efff' },
}

/** Full-window skies. These stay atmospheric on purpose, dark enough for light type on top. */
export const APP_SKIES: Record<Sky | 'night', string> = {
  clear: 'linear-gradient(165deg, #2a6fb8 0%, #5aa0d8 42%, #c9dff5 78%, #f0c878 100%)',
  night: 'linear-gradient(165deg, #060a18 0%, #121833 45%, #1e2748 100%)',
  cloudy: 'linear-gradient(165deg, #2a3340 0%, #4a5564 40%, #6b7685 70%, #8a93a0 100%)',
  fog: 'linear-gradient(165deg, #3a4048 0%, #5c636c 50%, #828990 100%)',
  rain: 'linear-gradient(165deg, #1a2838 0%, #2f455c 45%, #4a6780 100%)',
  snow: 'linear-gradient(165deg, #3a4a5c 0%, #6a7d92 50%, #a8b8c8 100%)',
  storm: 'linear-gradient(165deg, #1a1528 0%, #2e2848 40%, #4a4068 100%)',
}

const FORECAST_TTL = 10 * 60_000
const forecasts = new Map<string, Forecast>()
const airCache = new Map<string, AirQuality>()

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** The next hour of 15-minute precipitation, labelled from the current slot. */
function minutePrecip(times: string[] | undefined, amounts: unknown[] | undefined, nowIso: string | undefined): { label: string; precip: number }[] {
  if (!times?.length) return []
  const now = (nowIso ?? '').slice(0, 16)
  const next = now ? times.findIndex((t) => t > now) : 0
  const start = next < 0 ? Math.max(0, times.length - 5) : next === 0 ? 0 : next - 1
  return times.slice(start, start + 5).map((_, i) => ({
    label: i === 0 ? 'Now' : `${i * 15}m`,
    precip: num(amounts?.[start + i]),
  }))
}

export async function fetchForecast(lat: number, lon: number, units: Units): Promise<Forecast> {
  const key = `v2:${lat.toFixed(2)},${lon.toFixed(2)},${units}`
  const hit = forecasts.get(key)
  if (hit && Date.now() - hit.at < FORECAST_TTL) return hit
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current:
      'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day,relative_humidity_2m,dew_point_2m,surface_pressure,visibility,precipitation,cloud_cover',
    hourly:
      'temperature_2m,apparent_temperature,weather_code,is_day,precipitation_probability,precipitation,wind_speed_10m,wind_direction_10m,uv_index,relative_humidity_2m,surface_pressure,visibility',
    minutely_15: 'precipitation',
    daily:
      'temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset,precipitation_sum,precipitation_probability_max,uv_index_max,wind_speed_10m_max',
    timezone: 'auto',
    forecast_days: '10',
    forecast_hours: '25',
    forecast_minutely_15: '8',
    ...(units === 'f' ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' } : {}),
  })
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`)
  const d = await res.json()
  const hoursRaw = d.hourly?.time as string[] | undefined
  const daysRaw = d.daily?.time as string[] | undefined
  // UV is hourly; take the current hour's value (or the next one) for the "now" tile.
  const nowIso = d.current?.time as string | undefined
  let uvNow = 0
  if (hoursRaw && nowIso) {
    const i = hoursRaw.indexOf(nowIso.slice(0, 13) + ':00')
    const idx = i >= 0 ? i : 0
    uvNow = num(d.hourly.uv_index?.[idx])
  }
  const f: Forecast = {
    at: Date.now(),
    units,
    now: {
      temp: num(d.current.temperature_2m),
      feels: num(d.current.apparent_temperature),
      code: num(d.current.weather_code),
      wind: num(d.current.wind_speed_10m),
      windDir: num(d.current.wind_direction_10m),
      gusts: num(d.current.wind_gusts_10m),
      humidity: num(d.current.relative_humidity_2m),
      dewPoint: num(d.current.dew_point_2m),
      pressure: num(d.current.surface_pressure),
      visibility: num(d.current.visibility),
      precip: num(d.current.precipitation),
      uv: uvNow,
      cloud: num(d.current.cloud_cover),
      day: !!d.current.is_day,
    },
    hours: (hoursRaw ?? []).slice(0, 25).map((t, i) => ({
      time: t.slice(11, 16),
      iso: t,
      temp: num(d.hourly.temperature_2m[i]),
      feels: num(d.hourly.apparent_temperature?.[i]),
      code: num(d.hourly.weather_code[i]),
      day: !!d.hourly.is_day[i],
      precipProb: num(d.hourly.precipitation_probability?.[i]),
      precip: num(d.hourly.precipitation?.[i]),
      wind: num(d.hourly.wind_speed_10m?.[i]),
      windDir: num(d.hourly.wind_direction_10m?.[i]),
      uv: num(d.hourly.uv_index?.[i]),
      humidity: num(d.hourly.relative_humidity_2m?.[i]),
      pressure: num(d.hourly.surface_pressure?.[i]),
      visibility: num(d.hourly.visibility?.[i]),
    })),
    minutes: minutePrecip(d.minutely_15?.time as string[] | undefined, d.minutely_15?.precipitation as unknown[] | undefined, nowIso),
    days: (daysRaw ?? []).slice(0, 10).map((t, i) => ({
      date: t,
      max: num(d.daily.temperature_2m_max[i]),
      min: num(d.daily.temperature_2m_min[i]),
      code: num(d.daily.weather_code[i]),
      sunrise: String(d.daily.sunrise?.[i] ?? '').slice(11, 16),
      sunset: String(d.daily.sunset?.[i] ?? '').slice(11, 16),
      precipSum: num(d.daily.precipitation_sum?.[i]),
      precipProb: num(d.daily.precipitation_probability_max?.[i]),
      uvMax: num(d.daily.uv_index_max?.[i]),
      windMax: num(d.daily.wind_speed_10m_max?.[i]),
    })),
  }
  forecasts.set(key, f)
  return f
}

export async function fetchAirQuality(lat: number, lon: number): Promise<AirQuality | null> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`
  const hit = airCache.get(key)
  if (hit && Date.now() - hit.at < FORECAST_TTL) return hit
  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: 'european_aqi',
      timezone: 'auto',
    })
    const res = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const d = await res.json()
    const aqi = num(d.current?.european_aqi)
    const aq: AirQuality = { at: Date.now(), aqi, label: aqiLabel(aqi) }
    airCache.set(key, aq)
    return aq
  } catch {
    return null
  }
}

/** European AQI bands used by Open-Meteo. */
export function aqiLabel(aqi: number): string {
  if (aqi <= 20) return 'Good'
  if (aqi <= 40) return 'Fair'
  if (aqi <= 60) return 'Moderate'
  if (aqi <= 80) return 'Poor'
  if (aqi <= 100) return 'Very poor'
  return 'Extremely poor'
}

export async function searchPlaces(q: string): Promise<Place[]> {
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en`, { signal: AbortSignal.timeout(6000) })
  const d = await res.json()
  return ((d.results ?? []) as { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[]).map((r) => ({
    name: [r.name, r.admin1 && r.admin1 !== r.name ? r.admin1 : null, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }))
}

const HERE_KEY = 'mvlos.weather.here'

export function rememberedHere(): Place | null {
  try {
    return JSON.parse(localStorage.getItem(HERE_KEY) ?? 'null')
  } catch {
    return null
  }
}

export function locate(): Promise<Place> {
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
          /* coordinates will do */
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

export function clearForecastCache() {
  forecasts.clear()
  airCache.clear()
}

/** Hook: forecast (+ optional air quality) for a place, refreshed every 15 minutes. */
export function useForecast(place: Place | null, units: Units) {
  const [forecast, setForecast] = useState<Forecast | null>(null)
  const [air, setAir] = useState<AirQuality | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!place) return
    let live = true
    fetchForecast(place.lat, place.lon, units).then(
      (f) => live && (setForecast(f), setError(null)),
      (e: Error) => live && setError(e.message),
    )
    fetchAirQuality(place.lat, place.lon).then((a) => live && setAir(a))
    return () => {
      live = false
    }
  }, [place?.lat, place?.lon, units, tick])

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15 * 60_000)
    return () => clearInterval(t)
  }, [])

  return {
    forecast,
    air,
    error,
    refresh: () => {
      clearForecastCache()
      setTick((n) => n + 1)
    },
  }
}

// --- Helpers for tiles ---------------------------------------------------------------------------

export function weekday(iso: string, todayIso?: string): string {
  if (todayIso && iso === todayIso) return 'Today'
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short' })
}

export function compass(deg: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]
}

/** Beaufort force from wind speed. `metric` is km/h; otherwise mph. */
export function beaufort(speed: number, metric: boolean): number {
  const kmh = metric ? speed : speed * 1.60934
  if (kmh < 1) return 0
  if (kmh < 6) return 1
  if (kmh < 12) return 2
  if (kmh < 20) return 3
  if (kmh < 29) return 4
  if (kmh < 39) return 5
  if (kmh < 50) return 6
  if (kmh < 62) return 7
  if (kmh < 75) return 8
  if (kmh < 89) return 9
  if (kmh < 103) return 10
  if (kmh < 118) return 11
  return 12
}

export function uvLabel(uv: number): string {
  if (uv < 3) return 'Low'
  if (uv < 6) return 'Moderate'
  if (uv < 8) return 'High'
  if (uv < 11) return 'Very high'
  return 'Extreme'
}

export function visibilityLabel(metres: number): string {
  const km = metres / 1000
  if (km >= 10) return 'Perfectly clear view.'
  if (km >= 5) return 'Clear view.'
  if (km >= 2) return 'Somewhat hazy.'
  if (km >= 1) return 'Hazy.'
  return 'Foggy; limited view.'
}

export function feelsHint(temp: number, feels: number): string {
  const d = feels - temp
  if (d <= -2) return 'Wind is making it feel cooler.'
  if (d >= 2) return 'Humidity is making it feel warmer.'
  return 'Similar to the actual temperature.'
}

/** Synodic moon phase for a calendar day (local noon). */
export function moonPhase(date = new Date()): { name: string; illumination: number; age: number } {
  const synodic = 29.53058867
  const known = Date.UTC(2000, 0, 6, 18, 14) // known new moon
  const t = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12)
  const age = ((t - known) / 86_400_000) % synodic
  const a = age < 0 ? age + synodic : age
  const illumination = (1 - Math.cos((2 * Math.PI * a) / synodic)) / 2
  const names = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent']
  const i = Math.round((a / synodic) * 8) % 8
  return { name: names[i], illumination, age: a }
}

export function shortPlaceName(name: string): string {
  return name.split(',')[0]?.trim() || name
}

export function formatVis(metres: number, units: Units): string {
  if (units === 'f') {
    const miles = metres / 1609.344
    return `${miles >= 10 ? Math.round(miles) : miles.toFixed(1)} mi`
  }
  const km = metres / 1000
  return `${km >= 10 ? Math.round(km) : km.toFixed(1)} km`
}

export function precipUnit(units: Units): string {
  return units === 'f' ? 'in' : 'mm'
}

export function windUnit(units: Units): string {
  return units === 'f' ? 'mph' : 'km/h'
}

export function samePlace(a: Place, b: Place): boolean {
  return Math.abs(a.lat - b.lat) < 0.05 && Math.abs(a.lon - b.lon) < 0.05
}
