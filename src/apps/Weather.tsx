import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  APP_SKIES,
  aqiLabel,
  beaufort,
  compass,
  describe,
  feelsHint,
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

// Forecast dashboard. Wide windows use a tile grid, tablets put the 10-day list beside the map,
// and a phone stacks the same cards. The top strip switches place and refreshes. Each card opens
// a detail built from the Open-Meteo forecast (src/data/weather.ts). The map is a RainViewer
// precipitation radar on a quiet canvas, centred on the selected place.

type HourMode = 'temp' | 'precip' | 'wind'
type Layout = 'phone' | 'tablet' | 'wide'
type Detail =
  | { kind: 'hourly' }
  | { kind: 'days' }
  | { kind: 'day'; index: number }
  | { kind: 'next' }
  | { kind: 'uv' }
  | { kind: 'sun' }
  | { kind: 'wind' }
  | { kind: 'precip' }
  | { kind: 'feels' }
  | { kind: 'humidity' }
  | { kind: 'pressure' }
  | { kind: 'visibility' }
  | { kind: 'moon' }
  | { kind: 'air' }
  | { kind: 'map' }

function placeFromProps(props: WinState['props']): Place | null {
  const lat = Number(props.lat)
  const lon = Number(props.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !props.name) return null
  return { name: props.name, lat, lon }
}

export function Weather({ win }: { win: WinState }) {
  const prefs = weatherPrefs.use()
  const rootRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<Layout>('phone')
  const [here, setHere] = useState<Place | null>(rememberedHere)
  const [listOpen, setListOpen] = useState(false)
  const [hourMode, setHourMode] = useState<HourMode>('temp')
  const [detail, setDetail] = useState<Detail | null>(null)
  const seeded = useRef(false)
  const closeDetail = useCallback(() => setDetail(null), [])

  // Sidebar vs sheet follows this window's width, not the viewport.
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const sync = () => {
      const w = el.clientWidth
      setLayout(w >= 960 ? 'wide' : w >= 640 ? 'tablet' : 'phone')
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (seeded.current) return
    const handed = placeFromProps(win.props)
    if (handed) {
      seeded.current = true
      weatherPrefs.set((p) => {
        const units = win.props.units === 'f' || win.props.units === 'c' ? (win.props.units as Units) : p.units
        const i = p.places.findIndex((x) => samePlace(x, handed))
        if (i >= 0) return { ...p, selected: i, units }
        return { ...p, places: [...p.places, handed], selected: p.places.length, units }
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
  const sky = now && !now.day && (skyKey === 'clear' || skyKey === 'cloudy') ? APP_SKIES.night : APP_SKIES[skyKey]
  const isMine = prefs.selected < 0

  useEffect(() => {
    setDetail(null)
  }, [place?.lat, place?.lon])

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
  const addPlace = (next: Place) =>
    weatherPrefs.set((p) => {
      const i = p.places.findIndex((x) => samePlace(x, next))
      if (i >= 0) return { ...p, selected: i }
      return { ...p, places: [...p.places, next], selected: p.places.length }
    })
  const setUnits = (units: Units) => weatherPrefs.set((p) => ({ ...p, units }))

  const placeLabel = !place ? 'Choose a place' : isMine ? 'My location' : shortPlaceName(place.name)
  const showSide = layout === 'wide' && listOpen

  return (
    <div ref={rootRef} className={`wa is-${layout} ${listOpen ? 'is-list' : ''}`} style={{ ['--wa-sky' as string]: sky }}>
      {showSide && (
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
            onUnits={setUnits}
            embedded
          />
        </aside>
      )}

      <div className="wa-main">
        <header className="wa-strip">
          <button type="button" className="wa-place" aria-expanded={listOpen} onClick={() => setListOpen((o) => !o)}>
            <span>Location</span>
            <strong>{placeLabel}</strong>
          </button>
          <button type="button" className="wa-refresh" onClick={refresh}>
            Refresh
          </button>
        </header>

        <div className="wa-scroll">
          {!place ? (
            <div className="wa-empty">
              <p>{error ?? 'Finding where you are…'}</p>
              <button type="button" className="btn" onClick={() => setListOpen(true)}>
                Pick a city
              </button>
            </div>
          ) : !forecast ? (
            <div className="wa-empty">
              <p>{error ?? 'Looking at the sky…'}</p>
            </div>
          ) : (
            <Report place={place} isMine={isMine} forecast={forecast} air={air} units={prefs.units} hourMode={hourMode} onHourMode={setHourMode} onOpen={setDetail} />
          )}
        </div>
      </div>

      {listOpen && layout !== 'wide' && (
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

      {detail && forecast && place && (
        <DetailPanel detail={detail} place={place} forecast={forecast} air={air} units={prefs.units} hourMode={hourMode} onClose={closeDetail} />
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
  onOpen,
}: {
  place: Place
  isMine: boolean
  forecast: Forecast
  air: { aqi: number; label: string } | null
  units: Units
  hourMode: HourMode
  onHourMode: (m: HourMode) => void
  onOpen: (d: Detail) => void
}) {
  const now = forecast.now
  const sky = describe(now.code, now.day)
  const today = forecast.days[0]
  const moon = moonPhase()
  const weekMin = Math.min(...forecast.days.map((d) => d.min))
  const weekMax = Math.max(...forecast.days.map((d) => d.max))
  const next = nextHourCopy(now.code, forecast.minutes, units)
  const hourTitle = hourMode === 'temp' ? 'Temperature' : hourMode === 'precip' ? 'Precipitation' : `Wind, ${windUnit(units)}`

  return (
    <div className="wa-board">
      <header className="wa-hero">
        {isMine && <p className="wa-kicker">My location</p>}
        <h1>{shortPlaceName(place.name)}</h1>
        <p className="wa-hero-temp">{Math.round(now.temp)}°</p>
        <p className="wa-hero-sum">
          {sky.text}
          {today && (
            <>
              {' '}
              · H:{Math.round(today.max)}° L:{Math.round(today.min)}°
            </>
          )}
        </p>
        <p className="wa-summary">{outlook(forecast)}</p>
      </header>

      <button type="button" className="wa-tile wa-next" onClick={() => onOpen({ kind: 'next' })}>
        <h3>Next hour</h3>
        <p className="wa-lead">{next.title}</p>
        <p className="wa-tile-foot">{next.sub}</p>
        <PrecipBars minutes={forecast.minutes} />
      </button>

      <section className="wa-card wa-hourly" aria-label="Hourly forecast">
        <button type="button" className="wa-open" onClick={() => onOpen({ kind: 'hourly' })}>
          <span className="wa-card-head">
            <small>Hourly</small>
            <strong>{hourTitle}</strong>
          </span>
          <ol className="wa-hours">
            {forecast.hours.map((h, i) => {
              const d = describe(h.code, h.day)
              const value = hourMode === 'temp' ? `${Math.round(h.temp)}°` : hourMode === 'precip' ? `${Math.round(h.precipProb)}%` : `${Math.round(h.wind)}`
              return (
                <li key={h.iso}>
                  <span>{i === 0 ? 'Now' : String(Number(h.time.slice(0, 2)))}</span>
                  <span className="wa-h-icon" aria-hidden>
                    {hourMode === 'precip' && h.precipProb >= 20 ? '💧' : d.icon}
                  </span>
                  <span className="wa-h-val">{value}</span>
                </li>
              )
            })}
          </ol>
        </button>
        <div className="wa-hour-modes" role="radiogroup" aria-label="Hourly metric">
          {(
            [
              ['temp', 'Temp'],
              ['precip', 'Rain'],
              ['wind', 'Wind'],
            ] as const
          ).map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={hourMode === m} className={hourMode === m ? 'is-on' : ''} onClick={() => onHourMode(m)}>
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="wa-card wa-daily" aria-label="10-day forecast">
        <button type="button" className="wa-card-hit" onClick={() => onOpen({ kind: 'days' })}>
          <small>Forecast</small>
          <strong>10 days</strong>
        </button>
        <ol className="wa-days">
          {forecast.days.map((d, i) => {
            const desc = describe(d.code)
            const span = Math.max(1, weekMax - weekMin)
            const left = ((d.min - weekMin) / span) * 100
            const width = ((d.max - d.min) / span) * 100
            const cur = i === 0 ? ((now.temp - weekMin) / span) * 100 : null
            return (
              <li key={d.date}>
                <button type="button" className="wa-day" onClick={() => onOpen({ kind: 'day', index: i })}>
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
                </button>
              </li>
            )
          })}
        </ol>
      </section>

      <Tile className="wa-uv" label="UV index" onClick={() => onOpen({ kind: 'uv' })}>
        <p className="wa-tile-big">
          {Math.round(now.uv)} <span>{uvLabel(now.uv)}</span>
        </p>
        <Scale value={now.uv / 11} kind="uv" />
        <p className="wa-tile-foot">{uvRest(forecast)}</p>
      </Tile>
      <Tile className="wa-sun" label={now.day ? 'Sunset' : 'Sunrise'} onClick={() => onOpen({ kind: 'sun' })}>
        <p className="wa-tile-big">{now.day ? today?.sunset || '—' : today?.sunrise || '—'}</p>
        <SunArc sunrise={today?.sunrise ?? ''} sunset={today?.sunset ?? ''} day={now.day} />
        <p className="wa-tile-foot">{now.day ? `Sunrise ${today?.sunrise || '—'}` : `Sunset ${today?.sunset || '—'}`}</p>
      </Tile>
      <Tile className="wa-wind" label="Wind" onClick={() => onOpen({ kind: 'wind' })}>
        <WindCompass deg={now.windDir} bft={beaufort(now.wind, units === 'c')} speed={now.wind} units={units} />
        <p className="wa-tile-foot">
          Gusts {Math.round(now.gusts)} {windUnit(units)} {compass(now.windDir)}
        </p>
      </Tile>
      <Tile className="wa-precip" label="Precipitation" onClick={() => onOpen({ kind: 'precip' })}>
        <p className="wa-tile-big">
          {formatPrecip(today?.precipSum ?? now.precip, units)} <span>today</span>
        </p>
        <p className="wa-tile-foot">{forecast.days[1] ? `${formatPrecip(forecast.days[1].precipSum, units)} expected tomorrow.` : 'No further days.'}</p>
      </Tile>
      <Tile className="wa-feels" label="Feels like" onClick={() => onOpen({ kind: 'feels' })}>
        <p className="wa-tile-big">{Math.round(now.feels)}°</p>
        <p className="wa-tile-foot">{feelsHint(now.temp, now.feels)}</p>
      </Tile>
      <Tile className="wa-humidity" label="Humidity" onClick={() => onOpen({ kind: 'humidity' })}>
        <p className="wa-tile-big">{Math.round(now.humidity)}%</p>
        <p className="wa-tile-foot">The dew point is {Math.round(now.dewPoint)}° right now.</p>
      </Tile>
      <Tile className="wa-pressure" label="Pressure" onClick={() => onOpen({ kind: 'pressure' })}>
        <PressureGauge hpa={now.pressure} />
      </Tile>
      <Tile className="wa-vis" label="Visibility" onClick={() => onOpen({ kind: 'visibility' })}>
        <p className="wa-tile-big">{formatVis(now.visibility, units)}</p>
        <p className="wa-tile-foot">{visibilityLabel(now.visibility)}</p>
      </Tile>
      <Tile className="wa-moon" label={moon.name} onClick={() => onOpen({ kind: 'moon' })}>
        <MoonDisc age={moon.age} />
        <p className="wa-tile-foot">Illumination {Math.round(moon.illumination * 100)}%</p>
      </Tile>

      <MapCard place={place} onOpen={() => onOpen({ kind: 'map' })} />

      <Tile className="wa-aqi" label="Air quality" onClick={() => onOpen({ kind: 'air' })}>
        <p className="wa-tile-big">
          {air ? Math.round(air.aqi) : '—'} <span>{air ? air.label : 'Checking'}</span>
        </p>
        {air && <Scale value={Math.min(1, air.aqi / 100)} kind="aqi" />}
        <p className="wa-tile-foot">{air ? `European AQI is ${Math.round(air.aqi)} (${aqiLabel(air.aqi)}).` : 'Checking the air.'}</p>
      </Tile>

      <p className="wa-credit">
        Forecast{' '}
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
          Open-Meteo
        </a>
        {' · '}
        Radar{' '}
        <a href="https://www.rainviewer.com/" target="_blank" rel="noreferrer">
          RainViewer
        </a>
        {' · '}
        Map ©{' '}
        <a href="https://www.esri.com/" target="_blank" rel="noreferrer">
          Esri
        </a>
        , HERE, Garmin, ©{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          OpenStreetMap
        </a>{' '}
        contributors
      </p>
    </div>
  )
}

function Tile({ className, label, onClick, children }: { className?: string; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`wa-tile ${className ?? ''}`} onClick={onClick}>
      <h3>{label}</h3>
      {children}
    </button>
  )
}

function DetailPanel({
  detail,
  place,
  forecast,
  air,
  units,
  hourMode,
  onClose,
}: {
  detail: Detail
  place: Place
  forecast: Forecast
  air: { aqi: number; label: string } | null
  units: Units
  hourMode: HourMode
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const title = detailTitle(detail, forecast, hourMode)
  return (
    <div className="wa-shade" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="wa-detail" role="dialog" aria-modal="true" aria-labelledby="wa-detail-title">
        <header className="wa-detail-head">
          <h2 id="wa-detail-title">{title}</h2>
          <button type="button" className="btn" data-autofocus onClick={onClose}>
            Done
          </button>
        </header>
        <DetailBody detail={detail} place={place} forecast={forecast} air={air} units={units} hourMode={hourMode} />
      </div>
    </div>
  )
}

function DetailBody({
  detail,
  place,
  forecast,
  air,
  units,
  hourMode,
}: {
  detail: Detail
  place: Place
  forecast: Forecast
  air: { aqi: number; label: string } | null
  units: Units
  hourMode: HourMode
}) {
  const now = forecast.now
  const today = forecast.days[0]
  const deg = (n: number) => `${Math.round(n)}°`
  const hours = forecast.hours

  if (detail.kind === 'hourly') {
    const values = hours.map((h) => (hourMode === 'temp' ? h.temp : hourMode === 'precip' ? h.precipProb : h.wind))
    const fmt = hourMode === 'precip' ? (n: number) => `${Math.round(n)}%` : hourMode === 'wind' ? (n: number) => `${Math.round(n)} ${windUnit(units)}` : deg
    const name = hourMode === 'temp' ? 'Temperature' : hourMode === 'precip' ? 'Chance of precipitation' : 'Wind'
    return (
      <>
        <LineChart series={[values]} />
        <p className="wa-prose">{rangeText(name, values, fmt)} over the next {hours.length} hours.</p>
      </>
    )
  }
  if (detail.kind === 'days') {
    return (
      <>
        <LineChart series={[forecast.days.map((d) => d.max), forecast.days.map((d) => d.min)]} />
        <p className="wa-prose">
          Highs from {deg(Math.min(...forecast.days.map((d) => d.max)))} to {deg(Math.max(...forecast.days.map((d) => d.max)))}. The lower line is the overnight low.
        </p>
      </>
    )
  }
  if (detail.kind === 'day') {
    const d = forecast.days[detail.index]
    if (!d) return <p className="wa-prose">That day is no longer in the forecast.</p>
    const light = daylight(d.sunrise, d.sunset)
    return (
      <>
        <p className="wa-lead">
          {describe(d.code).icon} {describe(d.code).text}
        </p>
        <dl className="wa-facts">
          <Fact k="High" v={`${Math.round(d.max)}°`} />
          <Fact k="Low" v={`${Math.round(d.min)}°`} />
          <Fact k="Precipitation" v={`${formatPrecip(d.precipSum, units)} · ${Math.round(d.precipProb)}%`} />
          <Fact k="Wind" v={`${Math.round(d.windMax)} ${windUnit(units)}`} />
          <Fact k="UV" v={`${Math.round(d.uvMax)} ${uvLabel(d.uvMax)}`} />
          <Fact k="Sunrise" v={d.sunrise || '—'} />
          <Fact k="Sunset" v={d.sunset || '—'} />
          {light && <Fact k="Daylight" v={light} />}
        </dl>
      </>
    )
  }
  if (detail.kind === 'next') {
    const copy = nextHourCopy(now.code, forecast.minutes, units)
    const sum = forecast.minutes.reduce((a, m) => a + m.precip, 0)
    return (
      <>
        <PrecipBars minutes={forecast.minutes} />
        <p className="wa-prose">
          {copy.sub} {forecast.minutes.length ? `${formatPrecip(sum, units)} across these slots.` : 'The hourly forecast is below.'}
        </p>
        <LineChart series={[hours.slice(0, 6).map((h) => h.precip)]} />
        <p className="wa-prose">Hourly amounts for the next few hours, in {precipUnit(units)}.</p>
      </>
    )
  }
  if (detail.kind === 'uv') {
    return (
      <>
        <p className="wa-tile-big">
          {Math.round(now.uv)} <span>{uvLabel(now.uv)}</span>
        </p>
        <Scale value={now.uv / 11} kind="uv" />
        <LineChart series={[hours.map((h) => h.uv)]} />
        <p className="wa-prose">{uvRest(forecast)}</p>
      </>
    )
  }
  if (detail.kind === 'sun') {
    const light = today ? daylight(today.sunrise, today.sunset) : null
    return (
      <>
        <p className="wa-tile-big">{now.day ? today?.sunset || '—' : today?.sunrise || '—'}</p>
        <SunArc sunrise={today?.sunrise ?? ''} sunset={today?.sunset ?? ''} day={now.day} />
        <dl className="wa-facts">
          <Fact k="Sunrise" v={today?.sunrise || '—'} />
          <Fact k="Sunset" v={today?.sunset || '—'} />
          {light && <Fact k="Daylight" v={light} />}
        </dl>
      </>
    )
  }
  if (detail.kind === 'wind') {
    return (
      <>
        <WindCompass deg={now.windDir} bft={beaufort(now.wind, units === 'c')} speed={now.wind} units={units} />
        <LineChart series={[hours.map((h) => h.wind)]} />
        <p className="wa-prose">
          {rangeText('Wind', hours.map((h) => h.wind), (n) => `${Math.round(n)} ${windUnit(units)}`)}. Gusts {Math.round(now.gusts)} {windUnit(units)}, from the {compass(now.windDir)}.
        </p>
      </>
    )
  }
  if (detail.kind === 'precip') {
    const fmt = (n: number) => (units === 'f' ? `${n.toFixed(2)} ${precipUnit(units)}` : `${n < 10 ? n.toFixed(1) : Math.round(n)} ${precipUnit(units)}`)
    return (
      <>
        <p className="wa-tile-big">
          {formatPrecip(today?.precipSum ?? now.precip, units)} <span>today</span>
        </p>
        <LineChart series={[hours.map((h) => h.precip)]} />
        <p className="wa-prose">
          {rangeText('Precipitation', hours.map((h) => h.precip), fmt)}. {rangeText('The chance', hours.map((h) => h.precipProb), (n) => `${Math.round(n)}%`)}.
          {forecast.days[1] ? ` ${formatPrecip(forecast.days[1].precipSum, units)} expected tomorrow.` : ''}
        </p>
      </>
    )
  }
  if (detail.kind === 'feels') {
    return (
      <>
        <p className="wa-tile-big">{Math.round(now.feels)}°</p>
        <LineChart series={[hours.map((h) => h.feels), hours.map((h) => h.temp)]} />
        <p className="wa-prose">
          {feelsHint(now.temp, now.feels)} {rangeText('Feels like', hours.map((h) => h.feels), deg)}. The faint line is the air temperature.
        </p>
      </>
    )
  }
  if (detail.kind === 'humidity') {
    return (
      <>
        <p className="wa-tile-big">{Math.round(now.humidity)}%</p>
        <LineChart series={[hours.map((h) => h.humidity)]} />
        <p className="wa-prose">
          {rangeText('Humidity', hours.map((h) => h.humidity), (n) => `${Math.round(n)}%`)}. The dew point is {Math.round(now.dewPoint)}° right now.
        </p>
      </>
    )
  }
  if (detail.kind === 'pressure') {
    return (
      <>
        <PressureGauge hpa={now.pressure} />
        <LineChart series={[hours.map((h) => h.pressure)]} />
        <p className="wa-prose">{rangeText('Pressure', hours.map((h) => h.pressure), (n) => `${Math.round(n)} hPa`)}.</p>
      </>
    )
  }
  if (detail.kind === 'visibility') {
    return (
      <>
        <p className="wa-tile-big">{formatVis(now.visibility, units)}</p>
        <LineChart series={[hours.map((h) => h.visibility)]} />
        <p className="wa-prose">
          {visibilityLabel(now.visibility)} {rangeText('Visibility', hours.map((h) => h.visibility), (n) => formatVis(n, units))}.
        </p>
      </>
    )
  }
  if (detail.kind === 'moon') {
    const moon = moonPhase()
    return (
      <>
        <MoonDisc age={moon.age} />
        <p className="wa-prose">
          {moon.name}. Illumination {Math.round(moon.illumination * 100)}%, about {moon.age.toFixed(1)} days since the new moon.
        </p>
      </>
    )
  }
  if (detail.kind === 'air') {
    if (!air) return <p className="wa-prose">Air quality didn't come back for this place.</p>
    return (
      <>
        <p className="wa-tile-big">
          {Math.round(air.aqi)} <span>{air.label}</span>
        </p>
        <Scale value={Math.min(1, air.aqi / 100)} kind="aqi" />
        <p className="wa-prose">European AQI is {Math.round(air.aqi)} ({aqiLabel(air.aqi)}). The scale runs from good, through fair and moderate, into poor.</p>
      </>
    )
  }
  return (
    <>
      <RadarMap place={place} zoom={RADAR_ZOOM} className="wa-detail-map" />
      <p className="wa-prose">
        {shortPlaceName(place.name)}. {today ? `${formatPrecip(today.precipSum, units)} of precipitation expected today.` : ''}
      </p>
    </>
  )
}

function detailTitle(detail: Detail, forecast: Forecast, hourMode: HourMode): string {
  switch (detail.kind) {
    case 'hourly':
      return hourMode === 'temp' ? 'Temperature' : hourMode === 'precip' ? 'Precipitation' : 'Wind'
    case 'days':
      return '10-day forecast'
    case 'day': {
      const d = forecast.days[detail.index]
      return d ? weekday(d.date, forecast.days[0]?.date) : 'Day'
    }
    case 'next':
      return 'Next hour'
    case 'uv':
      return 'UV index'
    case 'sun':
      return forecast.now.day ? 'Sunset' : 'Sunrise'
    case 'wind':
      return 'Wind'
    case 'precip':
      return 'Precipitation'
    case 'feels':
      return 'Feels like'
    case 'humidity':
      return 'Humidity'
    case 'pressure':
      return 'Pressure'
    case 'visibility':
      return 'Visibility'
    case 'moon':
      return 'Moon'
    case 'air':
      return 'Air quality'
    case 'map':
      return 'Map'
  }
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  )
}

function LineChart({ series }: { series: number[][] }) {
  const values = series.flat().filter((n) => Number.isFinite(n))
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const w = 360
  const h = 132
  const line = (nums: number[]) =>
    nums
      .map((v, i) => {
        const x = nums.length === 1 ? w / 2 : (i / (nums.length - 1)) * (w - 12) + 6
        const y = 8 + (1 - (v - min) / span) * (h - 20)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  return (
    <svg className="wa-chart" viewBox={`0 0 ${w} ${h}`} aria-hidden>
      {series.map((nums, i) => (
        <polyline key={i} points={line(nums)} fill="none" stroke="currentColor" strokeWidth={i === 0 ? 2 : 1.25} strokeOpacity={i === 0 ? 1 : 0.45} />
      ))}
    </svg>
  )
}

function PrecipBars({ minutes }: { minutes: Forecast['minutes'] }) {
  if (!minutes.length) return <p className="wa-tile-foot">15-minute precipitation is unavailable.</p>
  const max = Math.max(...minutes.map((m) => m.precip), 0)
  return (
    <div className="wa-bars-wrap">
      <div className="wa-bars" aria-hidden>
        {minutes.map((m) => (
          <i key={m.label} style={{ height: `${max <= 0 ? 8 : Math.max(8, (m.precip / max) * 100)}%` }} />
        ))}
      </div>
      <div className="wa-bars-labels">
        {minutes.map((m) => (
          <span key={m.label}>{m.label}</span>
        ))}
      </div>
    </div>
  )
}

function Scale({ value, kind }: { value: number; kind: 'uv' | 'aqi' }) {
  const pct = Math.min(100, Math.max(0, value * 100))
  return (
    <div className={`wa-scale is-${kind}`} aria-hidden>
      <i style={{ left: `${pct}%` }} />
    </div>
  )
}

function PressureGauge({ hpa }: { hpa: number }) {
  const t = Math.min(1, Math.max(0, (hpa - 980) / 60))
  const angle = -90 + t * 180
  return (
    <div className="wa-pressure-gauge">
      <div className="wa-pressure-face">
        <svg viewBox="0 0 120 78" aria-hidden>
          <path d="M10 70 A50 50 0 0 1 110 70" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="6" strokeLinecap="square" />
          <path d="M10 70 A50 50 0 0 1 110 70" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="square" strokeDasharray={`${t * 157} 157`} />
          {/* Rim only. A needle through the hub crosses the reading at every pressure. */}
          <line x1="60" y1="30" x2="60" y2="22" stroke="currentColor" strokeWidth="3" strokeLinecap="square" transform={`rotate(${angle} 60 70)`} />
          <circle cx="60" cy="70" r="3.5" fill="currentColor" />
        </svg>
        <p className="wa-pressure-val">
          <span className="wa-pressure-num">{Math.round(hpa)}</span>
          <span className="wa-pressure-unit">hPa</span>
        </p>
      </div>
      <div className="wa-pressure-labels">
        <span>Low</span>
        <span>High</span>
      </div>
    </div>
  )
}

function WindCompass({ deg, bft, speed, units }: { deg: number; bft: number; speed: number; units: Units }) {
  return (
    <div className="wa-wind-dial">
      <svg viewBox="0 0 100 100" aria-hidden>
        <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
        {['N', 'E', 'S', 'W'].map((d, i) => {
          const a = (i * Math.PI) / 2 - Math.PI / 2
          return (
            <text key={d} x={50 + Math.cos(a) * 34} y={50 + Math.sin(a) * 34} textAnchor="middle" dominantBaseline="middle" fill="currentColor" opacity="0.55" fontSize="9">
              {d}
            </text>
          )
        })}
        <g transform={`rotate(${deg} 50 50)`}>
          <path d="M50 18 L56 48 L50 44 L44 48 Z" fill="currentColor" />
          <path d="M50 82 L54 52 L50 56 L46 52 Z" fill="currentColor" opacity="0.35" />
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
  const a = clockMinutes(sunrise)
  const b = clockMinutes(sunset)
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const t = a !== null && b !== null && b > a ? Math.min(1, Math.max(0, (cur - a) / (b - a))) : 0.5
  const x = 10 + t * 100
  const y = 40 - Math.sin(t * Math.PI) * 28
  return (
    <svg className="wa-sunarc" viewBox="0 0 120 48" aria-hidden>
      <path d="M10 40 Q60 0 110 40" fill="none" stroke="currentColor" strokeOpacity="0.45" strokeWidth="2" />
      <line x1="10" y1="40" x2="110" y2="40" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" />
      <circle cx={x} cy={day ? y : 44} r="4" fill="currentColor" />
    </svg>
  )
}

function MoonDisc({ age }: { age: number }) {
  // Age runs 0–29.5 days from new moon to new moon. Illumination is not linear with that,
  // so a 27% crescent is wider and more curved than half of 27%.
  const phase = ((age % 29.53058867) + 29.53058867) % 29.53058867 / 29.53058867
  const lit = moonLitPath(phase)
  return (
    <svg className="wa-moon-disc" viewBox="0 0 100 100" aria-hidden>
      <circle className="wa-moon-night" cx="50" cy="50" r="46" />
      {lit && <path className="wa-moon-lit" d={lit} />}
      <circle className="wa-moon-limb" cx="50" cy="50" r="46" />
    </svg>
  )
}

/** Lit region of a phase in 0–1 (0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter). */
function moonLitPath(phase: number): string {
  if (phase < 0.02 || phase > 0.98) return ''
  const R = 46
  const cx = 50
  const top = 50 - R
  const bot = 50 + R
  const c = Math.cos(2 * Math.PI * phase)
  const rx = Math.max(0.6, Math.abs(c) * R)
  // Waxing keeps the right limb; the terminator crosses to the left once it is past half.
  // Waning keeps the left limb, and the shadow eats in from the right.
  if (phase <= 0.5) {
    const back = c >= 0 ? 0 : 1
    return `M ${cx} ${top} A ${R} ${R} 0 0 1 ${cx} ${bot} A ${rx} ${R} 0 0 ${back} ${cx} ${top} Z`
  }
  const back = c >= 0 ? 1 : 0
  return `M ${cx} ${top} A ${R} ${R} 0 0 0 ${cx} ${bot} A ${rx} ${R} 0 0 ${back} ${cx} ${top} Z`
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
  onUnits: (u: Units) => void
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
        <button type="button" className="btn btn-small" onClick={onClose}>
          Close
        </button>
      </div>
      <input ref={input} className="wa-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a city…" aria-label="Search a city" spellCheck={false} />
      {results.length > 0 && (
        <ul className="wa-results">
          {results.map((r) => (
            <li key={`${r.lat},${r.lon}`}>
              <button
                type="button"
                onClick={() => {
                  onAdd(r)
                  setQ('')
                  setResults([])
                }}
              >
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
            <strong>My location</strong>
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
          onChange={onUnits}
          label="Units"
        />
      </div>
    </div>
  )
}

// Regional radar: one 256px tile at this zoom is a few hundred kilometres, so the card shows the
// weather around the place and the detail (same zoom, bigger box) shows more of it.
const RADAR_ZOOM = 7
const TILE = 256

// CARTO Dark Matter raster tiles have required an API key since September 2026: without one the
// CDN returns a blank tile that only says the key is required. Esri's gray canvas is the quiet
// dark/light basemap that still serves plain tiles, and it follows :root[data-mode].
const BASE_DARK = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile'
const BASE_LIGHT = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile'

type RadarFrame = { host: string; path: string }
type RadarSnap = { frame: RadarFrame | null; failed: boolean }

let radarSnap: RadarSnap | null = null
let radarFlight: Promise<void> | null = null
const radarWaiters = new Set<() => void>()

function ensureRadar() {
  if (radarSnap || radarFlight) return
  radarFlight = fetch('https://api.rainviewer.com/public/weather-maps.json')
    .then((res) => {
      if (!res.ok) throw new Error('radar')
      return res.json() as Promise<{ host?: unknown; radar?: { past?: { path?: unknown }[] } }>
    })
    .then((data) => {
      const past = data.radar?.past
      const latest = Array.isArray(past) ? past[past.length - 1] : undefined
      const host = typeof data.host === 'string' ? data.host.replace(/\/$/, '') : ''
      const path = latest && typeof latest.path === 'string' ? latest.path : ''
      if (!host || !path) throw new Error('radar')
      radarSnap = { frame: { host, path: path.startsWith('/') ? path : `/${path}` }, failed: false }
    })
    .catch(() => {
      radarSnap = { frame: null, failed: true }
    })
    .finally(() => {
      radarFlight = null
      radarWaiters.forEach((fn) => fn())
    })
}

function useRadar(): RadarSnap {
  const [snap, setSnap] = useState<RadarSnap>(() => radarSnap ?? { frame: null, failed: false })
  useEffect(() => {
    const pull = () => {
      if (radarSnap) setSnap(radarSnap)
    }
    radarWaiters.add(pull)
    ensureRadar()
    pull()
    return () => {
      radarWaiters.delete(pull)
    }
  }, [])
  return snap
}

function useLightMap(): boolean {
  const [light, setLight] = useState(() => document.documentElement.dataset.mode === 'light')
  useEffect(() => {
    const root = document.documentElement
    const sync = () => setLight(root.dataset.mode === 'light')
    const mo = new MutationObserver(sync)
    mo.observe(root, { attributes: true, attributeFilter: ['data-mode'] })
    sync()
    return () => mo.disconnect()
  }, [])
  return light
}

function wrapTile(n: number, size: number) {
  return ((n % size) + size) % size
}

function tileX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z
}

function tileY(lat: number, z: number) {
  const clamped = Math.min(85.05112878, Math.max(-85.05112878, lat))
  const r = (clamped * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}

function visibleTiles(lat: number, lon: number, z: number, w: number, h: number) {
  const n = 2 ** z
  const leftWorld = tileX(lon, z) * TILE - w / 2
  const topWorld = tileY(lat, z) * TILE - h / 2
  const x0 = Math.floor(leftWorld / TILE)
  const y0 = Math.floor(topWorld / TILE)
  const x1 = Math.floor((leftWorld + Math.max(w, 1) - 1) / TILE)
  const y1 = Math.floor((topWorld + Math.max(h, 1) - 1) / TILE)
  const tiles: { key: string; x: number; y: number; left: number; top: number }[] = []
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= n) continue
      tiles.push({
        key: `${x},${y}`,
        x: wrapTile(x, n),
        y,
        left: Math.round(x * TILE - leftWorld),
        top: Math.round(y * TILE - topWorld),
      })
    }
  }
  return tiles
}

function hideBrokenTile(e: { currentTarget: HTMLImageElement }) {
  e.currentTarget.hidden = true
}

function MapCard({ place, onOpen }: { place: Place; onOpen: () => void }) {
  const { failed } = useRadar()
  const name = shortPlaceName(place.name)
  return (
    <article className="wa-card wa-map">
      <h3>Map</h3>
      <div className="wa-map-view" aria-hidden>
        <RadarMap place={place} zoom={RADAR_ZOOM} />
      </div>
      <button type="button" className="wa-cover" aria-label={failed ? `Precipitation radar for ${name}, radar unavailable` : `Precipitation radar for ${name}`} onClick={onOpen} />
    </article>
  )
}

function RadarMap({ place, zoom, className }: { place: Place; zoom: number; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const light = useLightMap()
  const { frame, failed } = useRadar()

  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const sync = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const tiles = size.w > 0 && size.h > 0 ? visibleTiles(place.lat, place.lon, zoom, size.w, size.h) : []
  const base = light ? BASE_LIGHT : BASE_DARK

  return (
    <div ref={box} className={`wa-radar${className ? ` ${className}` : ''}`}>
      {tiles.map((t) => (
        <img key={`b${t.key}`} className="wa-radar-tile" alt="" draggable={false} decoding="async" src={`${base}/${zoom}/${t.y}/${t.x}`} style={{ left: t.left, top: t.top }} onError={hideBrokenTile} />
      ))}
      {frame &&
        tiles.map((t) => (
          <img
            key={`r${t.key}`}
            className="wa-radar-tile is-radar"
            alt=""
            draggable={false}
            decoding="async"
            src={`${frame.host}${frame.path}/256/${zoom}/${t.x}/${t.y}/2/1_1.png`}
            style={{ left: t.left, top: t.top }}
            onError={hideBrokenTile}
          />
        ))}
      {failed && <p className="wa-radar-miss">Radar unavailable</p>}
    </div>
  )
}

function outlook(forecast: Forecast): string {
  const now = describe(forecast.now.code, forecast.now.day)
  const next = forecast.hours.find((h, i) => i > 1 && describe(h.code, h.day).text !== now.text)
  if (!next) return `${now.text} for the next hours.`
  return `${now.text} now, ${describe(next.code, next.day).text.toLowerCase()} around ${next.time}.`
}

function nextHourCopy(code: number, minutes: Forecast['minutes'], units: Units): { title: string; sub: string } {
  const snow = (code >= 71 && code <= 77) || code === 85 || code === 86
  const noun = snow ? 'snow' : 'precipitation'
  if (!minutes.length) return { title: 'Precipitation', sub: '15-minute precipitation is unavailable.' }
  const sum = minutes.reduce((a, m) => a + m.precip, 0)
  if (sum <= 0) return { title: snow ? 'Snow' : 'Precipitation', sub: `No ${noun} for the next hour.` }
  const heavy = units === 'f' ? sum >= 0.15 : sum >= 4
  const word = snow ? (heavy ? 'Heavy snow' : 'Snow') : heavy ? 'Heavy rain' : 'Rain'
  return { title: word, sub: `${word} for the next hour.` }
}

function uvRest(forecast: Forecast): string {
  const ahead = forecast.hours.filter((h) => h.day).map((h) => h.uv)
  const peak = Math.max(forecast.now.uv, ...(ahead.length ? ahead : [0]))
  if (peak < 3) return 'Low for the rest of the day.'
  return `${uvLabel(forecast.now.uv)} now, up to ${uvLabel(peak)} later today.`
}

function rangeText(name: string, values: number[], fmt: (n: number) => string): string {
  if (!values.length) return `No ${name.toLowerCase()} readings.`
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (Math.abs(max - min) < 0.05) return `${name} stays near ${fmt(min)}.`
  return `${name} runs from ${fmt(min)} to ${fmt(max)}.`
}

function formatPrecip(amount: number, units: Units): string {
  if (units === 'f') return `${amount < 0.1 && amount > 0 ? amount.toFixed(2) : amount.toFixed(1)} ${precipUnit(units)}`
  return `${Math.round(amount)} ${precipUnit(units)}`
}

function clockMinutes(hhmm: string): number | null {
  const [h, m] = hhmm.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

function daylight(sunrise: string, sunset: string): string | null {
  const a = clockMinutes(sunrise)
  const b = clockMinutes(sunset)
  if (a === null || b === null || b <= a) return null
  const span = b - a
  return `${Math.floor(span / 60)}h ${span % 60}m`
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
