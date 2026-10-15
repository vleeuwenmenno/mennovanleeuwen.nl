import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  APP_SKIES,
  aqiLabel,
  beaufort,
  compass,
  describe,
  feelsHint,
  formatPressure,
  formatVis,
  locate,
  moonPhase,
  precipUnit,
  rememberedHere,
  samePlace,
  searchPlaces,
  shortPlaceName,
  uvLabel,
  visibilityLabel,
  weatherPrefs,
  weekday,
  windUnit,
  useForecast,
  type Forecast,
  type Place,
  type Units,
} from '../data/weather'
import { Seg } from './AppSettings'
import type { WinState } from '../os/wm'

// Full Weather app: Apple Weather–inspired report for a place (device location or saved cities),
// with hourly and 10-day forecasts and detail tiles. Data from src/data/weather.ts (Open-Meteo).

type HourMode = 'temp' | 'precip' | 'wind'

function placeFromProps(props: WinState['props']): Place | null {
  const lat = Number(props.lat)
  const lon = Number(props.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !props.name) return null
  return { name: props.name, lat, lon }
}

export function Weather({ win }: { win: WinState }) {
  const prefs = weatherPrefs.use()
  const rootRef = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  const [here, setHere] = useState<Place | null>(rememberedHere)
  const [listOpen, setListOpen] = useState(false)
  const [hourMode, setHourMode] = useState<HourMode>('temp')
  const seeded = useRef(false)

  // Sidebar vs sheet follows this window's width, not the viewport (a narrow pane on a big screen stays stacked).
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const sync = () => setWide(el.clientWidth >= 720)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // A place handed in from the widget (or Spotlight) is selected / saved once.
  useEffect(() => {
    if (seeded.current) return
    const handed = placeFromProps(win.props)
    if (handed) {
      seeded.current = true
      weatherPrefs.set((p) => {
        const i = p.places.findIndex((x) => samePlace(x, handed))
        if (i >= 0) return { ...p, selected: i, units: win.props.units === 'f' || win.props.units === 'c' ? (win.props.units as Units) : p.units }
        return { ...p, places: [...p.places, handed], selected: p.places.length, units: win.props.units === 'f' || win.props.units === 'c' ? (win.props.units as Units) : p.units }
      })
    } else if (win.props.units === 'f' || win.props.units === 'c') {
      seeded.current = true
      weatherPrefs.set((p) => ({ ...p, units: win.props.units as Units }))
    }
  }, [win.props.lat, win.props.lon, win.props.name, win.props.units, win.props.t])

  useEffect(() => {
    if (prefs.selected >= 0) return
    locate().then(setHere, () => {})
  }, [prefs.selected])

  const place: Place | null = prefs.selected >= 0 ? (prefs.places[prefs.selected] ?? null) : here
  const { forecast, air, error, refresh } = useForecast(place, prefs.units)
  const now = forecast?.now
  const skyKey = now ? describe(now.code, now.day).sky : 'cloudy'
  const bg = now && !now.day && (skyKey === 'clear' || skyKey === 'cloudy') ? APP_SKIES.night : APP_SKIES[skyKey]
  const isMine = prefs.selected < 0

  const selectHere = () => weatherPrefs.set((p) => ({ ...p, selected: -1 }))
  const selectPlace = (i: number) => weatherPrefs.set((p) => ({ ...p, selected: i }))
  const removePlace = (i: number) =>
    weatherPrefs.set((p) => {
      const places = p.places.filter((_, j) => j !== i)
      let selected = p.selected
      if (selected === i) selected = -1
      else if (selected > i) selected -= 1
      return { ...p, places, selected }
    })
  const addPlace = (place: Place) =>
    weatherPrefs.set((p) => {
      const i = p.places.findIndex((x) => samePlace(x, place))
      if (i >= 0) return { ...p, selected: i }
      return { ...p, places: [...p.places, place], selected: p.places.length }
    })
  const setUnits = (units: Units) => weatherPrefs.set((p) => ({ ...p, units }))

  // On wide windows, the city list is a sidebar; on phones / narrow panes, a sheet.
  const showSidebar = wide && listOpen

  return (
    <div ref={rootRef} className={`wa ${wide ? 'is-wide' : ''} ${listOpen ? 'is-list' : ''}`} style={{ ['--wa-sky' as string]: bg }}>
      {showSidebar && (
        <aside className="wa-side" aria-label="Saved locations">
          <LocationList
            here={here}
            places={prefs.places}
            selected={prefs.selected}
            units={prefs.units}
            onHere={selectHere}
            onSelect={selectPlace}
            onRemove={removePlace}
            onAdd={addPlace}
            onClose={() => setListOpen(false)}
            embedded
          />
        </aside>
      )}

      <div className="wa-main">
        <div className="wa-scroll">
          {!place ? (
            <div className="wa-empty">
              <p>{error ?? 'Finding where you are…'}</p>
              <button type="button" className="wa-btn" onClick={() => setListOpen(true)}>
                Pick a city
              </button>
            </div>
          ) : !forecast ? (
            <div className="wa-empty">
              <p>{error ?? 'Looking at the sky…'}</p>
            </div>
          ) : (
            <Report
              place={place}
              isMine={isMine}
              forecast={forecast}
              air={air}
              units={prefs.units}
              hourMode={hourMode}
              onHourMode={setHourMode}
            />
          )}
        </div>

        <footer className="wa-bar">
          <a
            className="wa-bar-btn"
            href={place ? `https://www.openstreetmap.org/#map=10/${place.lat}/${place.lon}` : undefined}
            target="_blank"
            rel="noreferrer"
            title="Open in OpenStreetMap"
            aria-label="Open map"
            onClick={(e) => !place && e.preventDefault()}
          >
            <MapGlyph />
          </a>
          <div className="wa-dots" role="tablist" aria-label="Locations">
            <button type="button" role="tab" aria-selected={isMine} className={isMine ? 'is-on' : ''} onClick={selectHere} title={here?.name ?? 'My location'} aria-label="My location">
              <LocDot mine />
            </button>
            {prefs.places.map((p, i) => (
              <button key={`${p.lat},${p.lon}`} type="button" role="tab" aria-selected={prefs.selected === i} className={prefs.selected === i ? 'is-on' : ''} onClick={() => selectPlace(i)} title={p.name} aria-label={p.name} />
            ))}
          </div>
          <div className="wa-bar-right">
            <button type="button" className="wa-bar-btn" onClick={refresh} title="Refresh" aria-label="Refresh">
              ⟳
            </button>
            <button type="button" className="wa-bar-btn" onClick={() => setListOpen((o) => !o)} title="Locations" aria-label="Locations" aria-pressed={listOpen}>
              <ListGlyph />
            </button>
          </div>
        </footer>
      </div>

      {listOpen && !wide && (
        <div className="wa-sheet" role="dialog" aria-label="Locations">
          <LocationList
            here={here}
            places={prefs.places}
            selected={prefs.selected}
            units={prefs.units}
            onHere={() => {
              selectHere()
              setListOpen(false)
            }}
            onSelect={(i) => {
              selectPlace(i)
              setListOpen(false)
            }}
            onRemove={removePlace}
            onAdd={(p) => {
              addPlace(p)
              setListOpen(false)
            }}
            onClose={() => setListOpen(false)}
            onUnits={setUnits}
          />
        </div>
      )}
    </div>
  )
}

function Report({
  place,
  isMine,
  forecast,
  air,
  units,
  hourMode,
  onHourMode,
}: {
  place: Place
  isMine: boolean
  forecast: Forecast
  air: { aqi: number; label: string } | null
  units: Units
  hourMode: HourMode
  onHourMode: (m: HourMode) => void
}) {
  const now = forecast.now
  const sky = describe(now.code, now.day)
  const today = forecast.days[0]
  const moon = moonPhase()
  const unit = units === 'f' ? '°' : '°'
  const weekMin = Math.min(...forecast.days.map((d) => d.min))
  const weekMax = Math.max(...forecast.days.map((d) => d.max))

  return (
    <>
      <header className="wa-hero">
        {isMine && <p className="wa-eyebrow">My Location</p>}
        <h1>{shortPlaceName(place.name)}</h1>
        <p className="wa-hero-temp">
          {Math.round(now.temp)}
          {unit}
        </p>
        <p className="wa-hero-sum">
          {sky.text}
          {today && (
            <>
              {' '}
              · H:{Math.round(today.max)}° L:{Math.round(today.min)}°
            </>
          )}
        </p>
      </header>

      <section className="wa-card wa-hourly" aria-label="Hourly forecast">
        <div className="wa-card-head">
          <span>
            <small>Conditions</small>
            <strong>{hourMode === 'temp' ? 'Temperature' : hourMode === 'precip' ? 'Precipitation' : 'Wind'}</strong>
          </span>
          <div className="wa-hour-modes" role="radiogroup" aria-label="Hourly metric">
            {(
              [
                ['temp', '🌡'],
                ['precip', '💧'],
                ['wind', '🌬'],
              ] as const
            ).map(([m, icon]) => (
              <button key={m} type="button" role="radio" aria-checked={hourMode === m} className={hourMode === m ? 'is-on' : ''} onClick={() => onHourMode(m)} title={m} aria-label={m}>
                {icon}
              </button>
            ))}
          </div>
        </div>
        <ol className="wa-hours">
          {forecast.hours.map((h, i) => {
            const d = describe(h.code, h.day)
            const label = i === 0 ? 'Now' : h.time.slice(0, 2)
            const value =
              hourMode === 'temp' ? `${Math.round(h.temp)}°` : hourMode === 'precip' ? `${Math.round(h.precipProb)}%` : `${Math.round(h.wind)}`
            return (
              <li key={h.iso}>
                <span>{label}</span>
                <span className="wa-h-icon" aria-hidden>
                  {hourMode === 'precip' && h.precipProb >= 20 ? '💧' : d.icon}
                </span>
                {hourMode === 'precip' && h.precipProb >= 20 && <span className="wa-h-pop">{Math.round(h.precipProb)}%</span>}
                <span className="wa-h-val">{value}{hourMode === 'wind' ? '' : ''}</span>
              </li>
            )
          })}
        </ol>
      </section>

      <section className="wa-card wa-daily" aria-label="10-day forecast">
        <div className="wa-card-head">
          <span>
            <small>Forecast</small>
            <strong>10 days</strong>
          </span>
        </div>
        <ol className="wa-days">
          {forecast.days.map((d, i) => {
            const desc = describe(d.code)
            const span = Math.max(1, weekMax - weekMin)
            const left = ((d.min - weekMin) / span) * 100
            const width = ((d.max - d.min) / span) * 100
            const cur = i === 0 ? ((now.temp - weekMin) / span) * 100 : null
            return (
              <li key={d.date}>
                <span className="wa-d-day">{weekday(d.date, forecast.days[0]?.date)}</span>
                <span className="wa-d-cond">
                  <span aria-hidden>{desc.icon}</span>
                  {d.precipProb >= 20 && <span className="wa-d-pop">{Math.round(d.precipProb)}%</span>}
                </span>
                <span className="wa-d-lo">{Math.round(d.min)}°</span>
                <span className="wa-d-bar" aria-hidden>
                  <i style={{ left: `${left}%`, width: `${Math.max(width, 4)}%` }} />
                  {cur !== null && <b style={{ left: `${Math.min(100, Math.max(0, cur))}%` }} />}
                </span>
                <span className="wa-d-hi">{Math.round(d.max)}°</span>
              </li>
            )
          })}
        </ol>
      </section>

      <div className="wa-grid">
        <Tile icon="☾" label={moon.name}>
          <MoonDisc illumination={moon.illumination} />
          <p className="wa-tile-foot">Illumination {Math.round(moon.illumination * 100)}%</p>
        </Tile>
        <Tile icon="☀" label={now.day ? 'Sunset' : 'Sunrise'}>
          <p className="wa-tile-big">{now.day ? today?.sunset : today?.sunrise}</p>
          <SunArc sunrise={today?.sunrise ?? '06:00'} sunset={today?.sunset ?? '18:00'} day={now.day} />
          <p className="wa-tile-foot">{now.day ? `Sunrise: ${today?.sunrise}` : `Sunset: ${today?.sunset}`}</p>
        </Tile>

        <Tile icon="☀" label="UV Index">
          <p className="wa-tile-big">
            {Math.round(now.uv)} <span>{uvLabel(now.uv)}</span>
          </p>
          <GradientBar value={now.uv / 11} colors="linear-gradient(90deg,#3ddc84,#f5e04a,#f5a623,#e74c3c,#9b59b6)" />
          <p className="wa-tile-foot">{uvLabel(now.uv)} for the rest of the day.</p>
        </Tile>
        <Tile icon="🌡" label="Feels Like">
          <p className="wa-tile-big">
            {Math.round(now.feels)}
            {unit}
          </p>
          <p className="wa-tile-foot">{feelsHint(now.temp, now.feels)}</p>
        </Tile>

        <Tile icon="💧" label="Precipitation">
          <p className="wa-tile-big">
            {formatPrecip(today?.precipSum ?? now.precip, units)} <span>Today</span>
          </p>
          <p className="wa-tile-foot">
            {forecast.days[1] ? `${formatPrecip(forecast.days[1].precipSum, units)} expected tomorrow.` : 'No further days.'}
          </p>
        </Tile>
        <Tile icon="👁" label="Visibility">
          <p className="wa-tile-big">{formatVis(now.visibility, units)}</p>
          <p className="wa-tile-foot">{visibilityLabel(now.visibility)}</p>
        </Tile>

        <Tile icon="💦" label="Humidity">
          <p className="wa-tile-big">{Math.round(now.humidity)}%</p>
          <p className="wa-tile-foot">
            The dew point is {Math.round(now.dewPoint)}
            {unit} right now.
          </p>
        </Tile>
        <Tile icon="◎" label="Pressure">
          <PressureGauge hpa={now.pressure} />
        </Tile>

        <Tile icon="🌬" label="Wind">
          <WindCompass deg={now.windDir} bft={beaufort(now.wind, units === 'c')} speed={now.wind} units={units} />
          <p className="wa-tile-foot">
            Gusts: {Math.round(now.gusts)} {windUnit(units)} {compass(now.windDir)}
          </p>
        </Tile>
        {air && (
          <Tile icon="◉" label="Air Quality" wide>
            <p className="wa-tile-big">
              {Math.round(air.aqi)} <span>{air.label}</span>
            </p>
            <GradientBar value={Math.min(1, air.aqi / 100)} colors="linear-gradient(90deg,#50f0e6,#50ccaa,#f0e641,#f0a91e,#e63e11,#a01f7a)" />
            <p className="wa-tile-foot">
              European AQI is {Math.round(air.aqi)} ({aqiLabel(air.aqi)}).
            </p>
          </Tile>
        )}
      </div>

      <p className="wa-credit">
        Data from{' '}
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
          Open-Meteo
        </a>
      </p>
    </>
  )
}

function formatPrecip(amount: number, units: Units): string {
  if (units === 'f') return `${amount < 0.1 && amount > 0 ? amount.toFixed(2) : amount.toFixed(1)} ${precipUnit(units)}`
  return `${Math.round(amount)} ${precipUnit(units)}`
}

function Tile({ icon, label, children, wide }: { icon: string; label: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`wa-tile ${wide ? 'is-wide' : ''}`}>
      <h3>
        <span aria-hidden>{icon}</span> {label}
      </h3>
      {children}
    </section>
  )
}

function GradientBar({ value, colors }: { value: number; colors: string }) {
  const pct = Math.min(100, Math.max(0, value * 100))
  return (
    <div className="wa-gbar" style={{ background: colors }} aria-hidden>
      <i style={{ left: `${pct}%` }} />
    </div>
  )
}

function PressureGauge({ hpa }: { hpa: number }) {
  // Typical surface pressure ~980–1040 hPa; map to a 180° arc.
  const t = Math.min(1, Math.max(0, (hpa - 980) / 60))
  const angle = -90 + t * 180
  return (
    <div className="wa-pressure">
      <svg viewBox="0 0 120 78" aria-hidden>
        <path d="M10 70 A50 50 0 0 1 110 70" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="6" strokeLinecap="round" />
        <path
          d="M10 70 A50 50 0 0 1 110 70"
          fill="none"
          stroke="rgba(255,255,255,0.9)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${t * 157} 157`}
        />
        <line x1="60" y1="70" x2="60" y2="28" stroke="white" strokeWidth="2.5" strokeLinecap="round" transform={`rotate(${angle} 60 70)`} />
        <circle cx="60" cy="70" r="3.5" fill="white" />
      </svg>
      <p className="wa-tile-big wa-pressure-val">{formatPressure(hpa)} <span>hPa</span></p>
      <div className="wa-pressure-labels">
        <span>Low</span>
        <span>High</span>
      </div>
    </div>
  )
}

function WindCompass({ deg, bft, speed, units }: { deg: number; bft: number; speed: number; units: Units }) {
  return (
    <div className="wa-wind">
      <svg viewBox="0 0 100 100" aria-hidden>
        <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
        {['N', 'E', 'S', 'W'].map((d, i) => {
          const a = (i * Math.PI) / 2 - Math.PI / 2
          const x = 50 + Math.cos(a) * 34
          const y = 50 + Math.sin(a) * 34
          return (
            <text key={d} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fill="rgba(255,255,255,0.55)" fontSize="9">
              {d}
            </text>
          )
        })}
        <g transform={`rotate(${deg} 50 50)`}>
          <path d="M50 18 L56 48 L50 44 L44 48 Z" fill="white" />
          <path d="M50 82 L54 52 L50 56 L46 52 Z" fill="rgba(255,255,255,0.35)" />
        </g>
      </svg>
      <div className="wa-wind-read">
        <strong>{bft}</strong>
        <span>bft</span>
        <em>
          {Math.round(speed)} {windUnit(units)}
        </em>
      </div>
    </div>
  )
}

function SunArc({ sunrise, sunset, day }: { sunrise: string; sunset: string; day: boolean }) {
  // Position on the arc from sunrise→sunset using local clock vs those times.
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    return h * 60 + m
  }
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const a = toMin(sunrise)
  const b = toMin(sunset)
  const t = b > a ? Math.min(1, Math.max(0, (cur - a) / (b - a))) : 0.5
  const x = 10 + t * 100
  const y = 40 - Math.sin(t * Math.PI) * 28
  return (
    <svg className="wa-sunarc" viewBox="0 0 120 48" aria-hidden>
      <path d="M10 40 Q60 0 110 40" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeDasharray="4 4" />
      <line x1="10" y1="40" x2="110" y2="40" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
      <circle cx={x} cy={day ? y : 44} r="4" fill="#ffd56a" stroke="white" strokeWidth="1.5" />
    </svg>
  )
}

function MoonDisc({ illumination }: { illumination: number }) {
  // Simple lit disc: shadow covers (1 - illumination) from the left or right by phase.
  const phase = moonPhase()
  const waxing = phase.age < 14.765
  const style = { ['--moon-lit' as string]: `${Math.round(illumination * 100)}%` } as CSSProperties
  return <div className="wa-moon" data-side={waxing ? 'right' : 'left'} style={style} aria-hidden />
}

function LocationList({
  here,
  places,
  selected,
  units,
  onHere,
  onSelect,
  onRemove,
  onAdd,
  onClose,
  onUnits,
  embedded,
}: {
  here: Place | null
  places: Place[]
  selected: number
  units: Units
  onHere: () => void
  onSelect: (i: number) => void
  onRemove: (i: number) => void
  onAdd: (p: Place) => void
  onClose: () => void
  onUnits?: (u: Units) => void
  embedded?: boolean
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!embedded) input.current?.focus()
  }, [embedded])
  useEffect(() => {
    if (q.trim().length < 2) return setResults([])
    const t = setTimeout(() => searchPlaces(q.trim()).then(setResults, () => setResults([])), 250)
    return () => clearTimeout(t)
  }, [q])

  return (
    <div className={`wa-locs ${embedded ? 'is-embed' : ''}`}>
      <div className="wa-locs-head">
        <h2>Locations</h2>
        {!embedded && (
          <button type="button" className="wa-bar-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        )}
      </div>
      <input ref={input} className="wa-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a city…" aria-label="Search a city" spellCheck={false} />
      {results.length > 0 && (
        <ul className="wa-results">
          {results.map((r) => (
            <li key={`${r.lat},${r.lon}`}>
              <button type="button" onClick={() => (onAdd(r), setQ(''), setResults([]))}>
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul className="wa-saved">
        <li className={selected < 0 ? 'is-on' : ''}>
          <button
            type="button"
            onClick={() => {
              setBusy(true)
              locate().then(
                () => {
                  setBusy(false)
                  onHere()
                },
                () => setBusy(false),
              )
            }}
          >
            <strong>📍 My Location</strong>
            <span>{busy ? 'Finding…' : (here?.name ?? 'This device')}</span>
          </button>
        </li>
        {places.map((p, i) => (
          <li key={`${p.lat},${p.lon}`} className={selected === i ? 'is-on' : ''}>
            <button type="button" onClick={() => onSelect(i)}>
              <strong>{shortPlaceName(p.name)}</strong>
              <span>{p.name}</span>
            </button>
            <button type="button" className="wa-loc-del" onClick={() => onRemove(i)} aria-label={`Remove ${p.name}`}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="wa-units">
        <Seg
          value={units}
          options={[
            ['c', '°C, km/h'],
            ['f', '°F, mph'],
          ]}
          onChange={(u) => (onUnits ? onUnits(u) : weatherPrefs.set((p) => ({ ...p, units: u })))}
          label="Units"
        />
      </div>
    </div>
  )
}

function MapGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" />
      <line x1="9" y1="3" x2="9" y2="18" />
      <line x1="15" y1="6" x2="15" y2="21" />
    </svg>
  )
}

function ListGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  )
}

function LocDot({ mine }: { mine?: boolean }) {
  return mine ? (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <circle cx="5" cy="5" r="2" fill="currentColor" />
      <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  ) : null
}

/** Settings → Apps → Weather. */
export function WeatherPane() {
  const prefs = weatherPrefs.use()
  return (
    <>
      <Seg
        value={prefs.units}
        options={[
          ['c', 'Celsius, km/h'],
          ['f', 'Fahrenheit, mph'],
        ]}
        onChange={(units) => weatherPrefs.set((p) => ({ ...p, units }))}
        label="Units"
      />
      <p className="muted" style={{ marginTop: 10 }}>
        Saved cities follow your account. The browser&apos;s own location stays on this device.
      </p>
    </>
  )
}
