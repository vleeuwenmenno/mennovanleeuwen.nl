import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import {
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
  type AirQuality,
  type Forecast,
  type Hour,
  type Place,
  type Units,
} from '../data/weather'
import { Seg } from './AppSettings'
import type { WinState } from '../os/wm'
import { InteractiveChart, Readout, Sparkline, type ChartSeries, type ChartZone } from './weather/Chart'
import { RadarCard, RadarExplorer } from './weather/Radar'
import { CountUp, Sky, WxIcon } from './weather/Sky'

// Forecast dashboard. Wide windows use a tile grid, tablets put the 10-day list beside the map,
// and a phone stacks the same cards. The top strip switches place and refreshes. Each card opens
// a detail with an interactive chart (weather/Chart.tsx) built from the Open-Meteo forecast
// (src/data/weather.ts): drag or hover along it and every reading follows that hour. The map is
// an animated RainViewer radar (weather/Radar.tsx). Behind the cards the sky moves with the
// current conditions (weather/Sky.tsx).

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
  const skyClass = now && !now.day && (skyKey === 'clear' || skyKey === 'cloudy') ? 'night' : skyKey
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
    <div ref={rootRef} className={`wa is-${layout} sky-${skyClass} ${listOpen ? 'is-list' : ''}`}>
      {now && <Sky sky={skyKey} day={now.day} code={now.code} />}
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
        <DetailPanel
          detail={detail}
          place={place}
          forecast={forecast}
          air={air}
          units={prefs.units}
          hourMode={hourMode}
          onHourMode={setHourMode}
          onOpen={setDetail}
          onClose={closeDetail}
          phone={layout === 'phone'}
        />
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
  air: AirQuality | null
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
  const hours = forecast.hours
  const trend = pressureTrend(hours.map((h) => h.pressure), 0)

  return (
    <div className="wa-board">
      <header className="wa-hero">
        {isMine && <p className="wa-kicker">My location</p>}
        <h1>{shortPlaceName(place.name)}</h1>
        <div className="wa-hero-row">
          <WxIcon icon={sky.icon} sky={sky.sky} className="wa-hero-icon" />
          <p className="wa-hero-temp">
            <CountUp value={Math.round(now.temp)} />°
          </p>
        </div>
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
          <ol className="wa-hours" key={hourMode}>
            {hours.map((h, i) => {
              const d = describe(h.code, h.day)
              const value = hourMode === 'temp' ? `${Math.round(h.temp)}°` : hourMode === 'precip' ? `${Math.round(h.precipProb)}%` : `${Math.round(h.wind)}`
              return (
                <li key={h.iso} style={{ ['--i' as string]: Math.min(i, 12) }}>
                  <span>{i === 0 ? 'Now' : String(Number(h.time.slice(0, 2)))}</span>
                  <span className="wa-h-icon" aria-hidden>
                    {hourMode === 'precip' && h.precipProb >= 20 ? (
                      '💧'
                    ) : hourMode === 'wind' ? (
                      <span className="wa-h-arrow" style={{ transform: `rotate(${h.windDir}deg)` }}>
                        ↑
                      </span>
                    ) : (
                      d.icon
                    )}
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
              <li key={d.date} style={{ ['--i' as string]: i }}>
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
          <CountUp value={Math.round(now.uv)} /> <span>{uvLabel(now.uv)}</span>
        </p>
        <Scale value={now.uv / 11} kind="uv" />
        <Sparkline values={hours.slice(0, 16).map((h) => h.uv)} floor={0} />
        <p className="wa-tile-foot">{uvRest(forecast)}</p>
      </Tile>
      <Tile className="wa-sun" label={now.day ? 'Sunset' : 'Sunrise'} onClick={() => onOpen({ kind: 'sun' })}>
        <p className="wa-tile-big">{now.day ? today?.sunset || '—' : today?.sunrise || '—'}</p>
        <SunPath sunrise={today?.sunrise ?? ''} sunset={today?.sunset ?? ''} mini />
        <p className="wa-tile-foot">{now.day ? `Sunrise ${today?.sunrise || '—'}` : `Sunset ${today?.sunset || '—'}`}</p>
      </Tile>
      <Tile className="wa-wind" label="Wind" onClick={() => onOpen({ kind: 'wind' })}>
        <WindCompass deg={now.windDir} bft={beaufort(now.wind, units === 'c')} speed={now.wind} units={units} sway={Math.min(10, 2 + now.gusts / 8)} />
        <p className="wa-tile-foot">
          Gusts {Math.round(now.gusts)} {windUnit(units)} {compass(now.windDir)}
        </p>
      </Tile>
      <Tile className="wa-precip" label="Precipitation" onClick={() => onOpen({ kind: 'precip' })}>
        <p className="wa-tile-big">
          {formatPrecip(today?.precipSum ?? now.precip, units)} <span>today</span>
        </p>
        <Sparkline values={hours.map((h) => h.precip)} kind="bars" floor={0} />
        <p className="wa-tile-foot">{forecast.days[1] ? `${formatPrecip(forecast.days[1].precipSum, units)} expected tomorrow.` : 'No further days.'}</p>
      </Tile>
      <Tile className="wa-feels" label="Feels like" onClick={() => onOpen({ kind: 'feels' })}>
        <p className="wa-tile-big">
          <CountUp value={Math.round(now.feels)} />°
        </p>
        <Sparkline values={hours.map((h) => h.feels)} />
        <p className="wa-tile-foot">{feelsHint(now.temp, now.feels)}</p>
      </Tile>
      <Tile className="wa-humidity" label="Humidity" onClick={() => onOpen({ kind: 'humidity' })}>
        <p className="wa-tile-big">
          <CountUp value={Math.round(now.humidity)} />%
        </p>
        <Sparkline values={hours.map((h) => h.humidity)} floor={0} />
        <p className="wa-tile-foot">The dew point is {Math.round(now.dewPoint)}° right now.</p>
      </Tile>
      <Tile className="wa-pressure" label="Pressure" onClick={() => onOpen({ kind: 'pressure' })}>
        <PressureGauge hpa={now.pressure} />
        <p className="wa-tile-foot wa-center">{trend}</p>
      </Tile>
      <Tile className="wa-vis" label="Visibility" onClick={() => onOpen({ kind: 'visibility' })}>
        <p className="wa-tile-big">{formatVis(now.visibility, units)}</p>
        <Sparkline values={hours.map((h) => h.visibility)} floor={0} />
        <p className="wa-tile-foot">{visibilityLabel(now.visibility)}</p>
      </Tile>
      <Tile className="wa-moon" label={moon.name} onClick={() => onOpen({ kind: 'moon' })}>
        <MoonDisc age={moon.age} />
        <p className="wa-tile-foot">Illumination {Math.round(moon.illumination * 100)}%</p>
      </Tile>

      <RadarCard place={place} onOpen={() => onOpen({ kind: 'map' })} />

      <Tile className="wa-aqi" label="Air quality" onClick={() => onOpen({ kind: 'air' })}>
        <p className="wa-tile-big">
          {air ? <CountUp value={Math.round(air.aqi)} /> : '—'} <span>{air ? air.label : 'Checking'}</span>
        </p>
        {air && <Scale value={Math.min(1, air.aqi / 100)} kind="aqi" />}
        {air && air.hours.length > 1 && <Sparkline values={air.hours.slice(0, 25).map((h) => h.aqi)} floor={0} />}
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
  onHourMode,
  onOpen,
  onClose,
  phone,
}: {
  detail: Detail
  place: Place
  forecast: Forecast
  air: AirQuality | null
  units: Units
  hourMode: HourMode
  onHourMode: (m: HourMode) => void
  onOpen: (d: Detail) => void
  onClose: () => void
  phone: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
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
    <div className={`wa-shade${phone ? ' is-phone' : ''}`} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`wa-detail is-${detail.kind}`} role="dialog" aria-modal="true" aria-labelledby="wa-detail-title">
        {phone && <i className="wa-detail-grip" aria-hidden />}
        <header className="wa-detail-head">
          <h2 id="wa-detail-title">{title}</h2>
          <button type="button" className="btn" data-autofocus onClick={onClose}>
            Done
          </button>
        </header>
        <div className="wa-detail-body" key={detail.kind === 'day' ? `day${detail.index}` : detail.kind}>
          <DetailBody detail={detail} place={place} forecast={forecast} air={air} units={units} hourMode={hourMode} onHourMode={onHourMode} onOpen={onOpen} />
        </div>
      </div>
    </div>
  )
}

type BodyProps = {
  forecast: Forecast
  units: Units
}

function DetailBody({
  detail,
  place,
  forecast,
  air,
  units,
  hourMode,
  onHourMode,
  onOpen,
}: {
  detail: Detail
  place: Place
  forecast: Forecast
  air: AirQuality | null
  units: Units
  hourMode: HourMode
  onHourMode: (m: HourMode) => void
  onOpen: (d: Detail) => void
}) {
  const p = { forecast, units }
  switch (detail.kind) {
    case 'hourly':
      return <HourlyDetail {...p} mode={hourMode} onMode={onHourMode} />
    case 'days':
      return <DaysDetail {...p} onOpen={onOpen} />
    case 'day':
      return <DayDetail {...p} index={detail.index} onOpen={onOpen} />
    case 'next':
      return <NextDetail {...p} />
    case 'uv':
      return <UvDetail {...p} />
    case 'sun':
      return <SunDetail {...p} />
    case 'wind':
      return <WindDetail {...p} />
    case 'precip':
      return <PrecipDetail {...p} />
    case 'feels':
      return <FeelsDetail {...p} />
    case 'humidity':
      return <HumidityDetail {...p} />
    case 'pressure':
      return <PressureDetail {...p} />
    case 'visibility':
      return <VisibilityDetail {...p} />
    case 'moon':
      return <MoonDetail />
    case 'air':
      return <AirDetail air={air} />
    case 'map': {
      const today = forecast.days[0]
      return (
        <>
          <RadarExplorer place={place} />
          <p className="wa-prose">
            {shortPlaceName(place.name)}. {today ? `${formatPrecip(today.precipSum, units)} of precipitation expected today.` : ''} Drag the map to look around; drag the timeline to scrub through the
            scans.
          </p>
        </>
      )
    }
  }
}

// --- Detail views --------------------------------------------------------------------------------

const deg = (n: number) => `${Math.round(n)}°`
const pct = (n: number) => `${Math.round(n)}%`

/** "Now", "14:00", or "Tue 03:00" once the hours cross into another day. */
function hourLabels(hours: Hour[]): string[] {
  const first = hours[0]?.date
  return hours.map((h, i) => (i === 0 ? 'Now' : h.date === first ? h.time : `${weekday(h.date)} ${h.time}`))
}

function hourTick(hours: Hour[]) {
  return (i: number) => {
    const h = hours[i]
    if (!h) return null
    if (i === 0) return 'Now'
    return h.time === '00:00' ? weekday(h.date) : String(Number(h.time.slice(0, 2)))
  }
}

function useIndex(start = 0): [number, (i: number) => void] {
  const [i, setI] = useState(start)
  return [i, setI]
}

function precipFmt(units: Units) {
  return (n: number) => (units === 'f' ? `${n.toFixed(2)} ${precipUnit(units)}` : `${n < 10 ? n.toFixed(1) : Math.round(n)} ${precipUnit(units)}`)
}

function HourlyDetail({ forecast, units, mode, onMode }: BodyProps & { mode: HourMode; onMode: (m: HourMode) => void }) {
  const hours = forecast.hours
  const [i, setI] = useIndex()
  const labels = hourLabels(hours)
  const wu = windUnit(units)
  const h = hours[Math.min(i, hours.length - 1)]
  let series: ChartSeries[]
  let axis: (n: number) => string = deg
  if (mode === 'temp') {
    series = [
      { name: 'Temperature', values: hours.map((x) => x.temp), kind: 'area', color: 'var(--accent)', fmt: deg },
      { name: 'Feels like', values: hours.map((x) => x.feels), faint: true, color: 'var(--magenta)', fmt: deg },
    ]
  } else if (mode === 'precip') {
    series = [
      { name: 'Amount', values: hours.map((x) => x.precip), kind: 'bars', color: 'var(--blue)', fmt: precipFmt(units) },
      { name: 'Chance', values: hours.map((x) => x.precipProb), kind: 'area', color: 'var(--cyan)', domain: [0, 100], fmt: pct },
    ]
    axis = (n) => (units === 'f' ? n.toFixed(2) : n.toFixed(n < 1 ? 1 : 0))
  } else {
    series = [
      { name: 'Wind', values: hours.map((x) => x.wind), kind: 'area', color: 'var(--accent)', fmt: (n) => `${Math.round(n)} ${wu}` },
      { name: 'Gusts', values: hours.map((x) => x.gusts), faint: true, color: 'var(--yellow)', fmt: (n) => `${Math.round(n)} ${wu}` },
    ]
    axis = (n) => String(Math.round(n))
  }
  const d = h ? describe(h.code, h.day) : null
  const main = series.find((s) => s.kind !== 'bars') ?? series[0]
  return (
    <>
      <Seg
        value={mode}
        options={[
          ['temp', 'Temperature'],
          ['precip', 'Precipitation'],
          ['wind', 'Wind'],
        ]}
        onChange={onMode}
        label="Metric"
      />
      {h && d && (
        <Readout
          title={labels[i]}
          big={
            <>
              <WxIcon icon={d.icon} sky={d.sky} /> {mode === 'precip' ? `${pct(h.precipProb)} · ${precipFmt(units)(h.precip)}` : mode === 'wind' ? `${Math.round(h.wind)} ${wu} ${compass(h.windDir)}` : deg(h.temp)}
            </>
          }
          sub={mode === 'temp' ? `${d.text}, feels like ${deg(h.feels)}` : mode === 'wind' ? `Gusts ${Math.round(h.gusts)} ${wu}, force ${beaufort(h.wind, units === 'c')}` : d.text}
        />
      )}
      <InteractiveChart
        key={mode}
        label={`${main.name} by hour`}
        series={series}
        labels={labels}
        tick={hourTick(hours)}
        index={i}
        onIndex={setI}
        axis={axis}
        floor={mode === 'temp' ? undefined : 0}
        icons={mode === 'temp' ? hours.map((x) => describe(x.code, x.day).icon) : undefined}
        arrows={mode === 'wind' ? hours.map((x) => x.windDir) : undefined}
      />
      <p className="wa-prose">
        {rangeText(main.name, main.values, main.fmt).replace(/\.$/, '')} over the next {hours.length} hours.
      </p>
    </>
  )
}

function DaysDetail({ forecast, units, onOpen }: BodyProps & { onOpen: (d: Detail) => void }) {
  const days = forecast.days
  const [i, setI] = useIndex()
  const d = days[Math.min(i, days.length - 1)]
  const first = days[0]?.date
  if (!d) return <p className="wa-prose">No days in the forecast.</p>
  const desc = describe(d.code)
  return (
    <>
      <Readout
        title={new Date(`${d.date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
        big={
          <>
            <WxIcon icon={desc.icon} sky={desc.sky} /> {deg(d.max)} <small>/ {deg(d.min)}</small>
          </>
        }
        sub={`${desc.text}. ${Math.round(d.precipProb)}% chance, ${formatPrecip(d.precipSum, units)}.`}
        extra={
          <button type="button" className="btn btn-small wa-readout-go" onClick={() => onOpen({ kind: 'day', index: i })}>
            Hour by hour
          </button>
        }
      />
      <InteractiveChart
        label="Daily highs and lows"
        series={[
          { name: 'Chance', values: days.map((x) => x.precipProb), kind: 'bars', color: 'var(--cyan)', faint: true, domain: [0, 260], fmt: pct },
          { name: 'High', values: days.map((x) => x.max), color: 'var(--orange)', fmt: deg },
          { name: 'Low', values: days.map((x) => x.min), color: 'var(--blue)', fmt: deg },
        ]}
        band={{ lo: days.map((x) => x.min), hi: days.map((x) => x.max), color: 'var(--accent)' }}
        labels={days.map((x) => weekday(x.date, first))}
        tick={(k) => (days[k] ? weekday(days[k].date, first) : null)}
        icons={days.map((x) => describe(x.code).icon)}
        index={i}
        onIndex={setI}
        axis={deg}
        height={220}
      />
      <p className="wa-prose">
        Highs from {deg(Math.min(...days.map((x) => x.max)))} to {deg(Math.max(...days.map((x) => x.max)))}. The shaded band runs from each night&apos;s low to the day&apos;s high; the bars are the
        chance of precipitation.
      </p>
    </>
  )
}

function DayDetail({ forecast, units, index, onOpen }: BodyProps & { index: number; onOpen: (d: Detail) => void }) {
  const d = forecast.days[index]
  const hours = d ? forecast.timeline.filter((h) => h.date === d.date) : []
  const nowIso = forecast.hours[0]?.iso
  const nowAt = hours.findIndex((h) => h.iso === nowIso)
  const [i, setI] = useIndex(nowAt >= 0 ? nowAt : Math.min(12, Math.max(0, hours.length - 1)))
  if (!d) return <p className="wa-prose">That day is no longer in the forecast.</p>
  const light = daylight(d.sunrise, d.sunset)
  const h = hours[Math.min(i, hours.length - 1)]
  const desc = describe(d.code)
  const hd = h ? describe(h.code, h.day) : null
  return (
    <>
      <div className="wa-daynav">
        <button type="button" className="btn btn-small" disabled={index <= 0} onClick={() => onOpen({ kind: 'day', index: index - 1 })} aria-label="Previous day">
          ‹
        </button>
        <p className="wa-lead">
          <WxIcon icon={desc.icon} sky={desc.sky} /> {desc.text} · {deg(d.max)} / {deg(d.min)}
        </p>
        <button type="button" className="btn btn-small" disabled={index >= forecast.days.length - 1} onClick={() => onOpen({ kind: 'day', index: index + 1 })} aria-label="Next day">
          ›
        </button>
      </div>
      {h && hd && hours.length > 1 && (
        <>
          <Readout
            title={h.time}
            big={
              <>
                <WxIcon icon={hd.icon} sky={hd.sky} /> {deg(h.temp)}
              </>
            }
            sub={`${hd.text}. ${pct(h.precipProb)} chance, wind ${Math.round(h.wind)} ${windUnit(units)} ${compass(h.windDir)}.`}
          />
          <InteractiveChart
            label="Temperature through the day"
            series={[
              { name: 'Chance', values: hours.map((x) => x.precipProb), kind: 'bars', color: 'var(--cyan)', faint: true, domain: [0, 260], fmt: pct },
              { name: 'Temperature', values: hours.map((x) => x.temp), kind: 'area', color: 'var(--accent)', fmt: deg },
            ]}
            labels={hours.map((x) => x.time)}
            tick={(k) => (hours[k] ? String(Number(hours[k].time.slice(0, 2))) : null)}
            icons={hours.map((x) => describe(x.code, x.day).icon)}
            marker={nowAt >= 0 ? { index: nowAt, label: 'Now' } : undefined}
            index={i}
            onIndex={setI}
            axis={deg}
          />
        </>
      )}
      <dl className="wa-facts">
        <Fact k="High" v={deg(d.max)} />
        <Fact k="Low" v={deg(d.min)} />
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

function NextDetail({ forecast, units }: BodyProps) {
  const q = forecast.quarters
  const [i, setI] = useIndex()
  const copy = nextHourCopy(forecast.now.code, forecast.minutes, units)
  const fmt = precipFmt(units)
  if (q.length < 2) {
    const hours = forecast.hours.slice(0, 6)
    return (
      <>
        <p className="wa-prose">{copy.sub}</p>
        <InteractiveChart
          label="Precipitation for the next hours"
          series={[{ name: 'Amount', values: hours.map((h) => h.precip), kind: 'bars', color: 'var(--blue)', fmt }]}
          labels={hourLabels(hours)}
          tick={hourTick(hours)}
          index={i}
          onIndex={setI}
          axis={(n) => n.toFixed(1)}
          floor={0}
        />
      </>
    )
  }
  const cur = q[Math.min(i, q.length - 1)]
  const sum = forecast.minutes.reduce((a, m) => a + m.precip, 0)
  return (
    <>
      <Readout title={`${cur.time} · ${cur.label}`} big={cur.precip > 0 ? fmt(cur.precip) : 'Dry'} sub={cur.precip > 0 ? 'in these 15 minutes' : 'No precipitation in these 15 minutes'} />
      <InteractiveChart
        label="Precipitation in 15-minute steps"
        series={[{ name: 'Precipitation', values: q.map((x) => x.precip), kind: 'bars', color: 'var(--blue)', fmt }]}
        labels={q.map((x) => `${x.time} · ${x.label}`)}
        tick={(k) => (k === 0 ? 'Now' : k % 4 === 0 ? `+${k / 4} h` : null)}
        index={i}
        onIndex={setI}
        axis={(n) => (units === 'f' ? n.toFixed(2) : n.toFixed(1))}
        floor={0}
        ceil={units === 'f' ? 0.02 : 0.5}
      />
      <p className="wa-prose">
        {copy.sub} {forecast.minutes.length ? `${formatPrecip(sum, units)} in the next hour.` : ''} Each bar is 15 minutes, three hours ahead.
      </p>
    </>
  )
}

const UV_ZONES: ChartZone[] = [
  { from: 0, to: 3, color: 'var(--green)' },
  { from: 3, to: 6, color: 'var(--yellow)' },
  { from: 6, to: 8, color: 'var(--orange)' },
  { from: 8, to: 11, color: 'var(--red)' },
  { from: 11, to: 30, color: 'var(--magenta)' },
]

function uvAdvice(uv: number): string {
  if (uv < 3) return 'No protection needed.'
  if (uv < 6) return 'Sunscreen and sunglasses around midday.'
  if (uv < 8) return 'Cover up and seek shade around midday.'
  if (uv < 11) return 'Avoid the midday sun; sunscreen and a hat.'
  return 'Stay out of the sun around midday.'
}

function UvDetail({ forecast }: BodyProps) {
  const hours = forecast.hours
  const [i, setI] = useIndex()
  const h = hours[Math.min(i, hours.length - 1)]
  const peak = Math.max(...hours.map((x) => x.uv), 0)
  if (!h) return null
  return (
    <>
      <Readout
        title={hourLabels(hours)[i]}
        big={
          <>
            {Math.round(h.uv)} <small>{uvLabel(h.uv)}</small>
          </>
        }
        sub={uvAdvice(h.uv)}
      />
      <Scale value={h.uv / 11} kind="uv" />
      <InteractiveChart
        label="UV index by hour"
        series={[{ name: 'UV index', values: hours.map((x) => x.uv), kind: 'area', color: 'var(--yellow)', fmt: (n) => `${n.toFixed(1)} ${uvLabel(n)}` }]}
        zones={UV_ZONES}
        labels={hourLabels(hours)}
        tick={hourTick(hours)}
        index={i}
        onIndex={setI}
        axis={(n) => String(Math.round(n))}
        floor={0}
        ceil={Math.max(6, Math.ceil(peak))}
      />
      <p className="wa-prose">{uvRest(forecast)}</p>
    </>
  )
}

function SunDetail({ forecast }: BodyProps) {
  const days = forecast.days
  const [i, setI] = useIndex()
  const d = days[Math.min(i, days.length - 1)]
  const first = days[0]?.date
  const minutes = days.map((x) => {
    const a = clockMinutes(x.sunrise)
    const b = clockMinutes(x.sunset)
    return a !== null && b !== null && b > a ? b - a : 0
  })
  if (!d) return null
  const light = daylight(d.sunrise, d.sunset)
  const diff = i > 0 ? minutes[i] - minutes[i - 1] : minutes[1] !== undefined ? minutes[1] - minutes[0] : 0
  return (
    <>
      <SunPath key={d.date} sunrise={d.sunrise} sunset={d.sunset} today={i === 0} />
      <InteractiveChart
        label="Daylight over the coming days"
        series={[{ name: 'Daylight', values: minutes, kind: 'area', color: 'var(--yellow)', fmt: (n) => `${Math.floor(n / 60)}h ${Math.round(n % 60)}m` }]}
        labels={days.map((x) => `${weekday(x.date, first)} · ${x.sunrise}–${x.sunset}`)}
        tick={(k) => (days[k] ? weekday(days[k].date, first) : null)}
        index={i}
        onIndex={setI}
        axis={(n) => `${Math.floor(n / 60)}h ${String(Math.round(n % 60)).padStart(2, '0')}m`}
        height={170}
      />
      <dl className="wa-facts">
        <Fact k="Sunrise" v={d.sunrise || '—'} />
        <Fact k="Sunset" v={d.sunset || '—'} />
        {light && <Fact k="Daylight" v={light} />}
        <Fact k={i > 0 ? 'Than the day before' : 'Tomorrow'} v={`${diff >= 0 ? '+' : '−'}${Math.abs(Math.round(diff))} min`} />
      </dl>
    </>
  )
}

function WindDetail({ forecast, units }: BodyProps) {
  const hours = forecast.hours
  const [i, setI] = useIndex()
  const wu = windUnit(units)
  const h = hours[Math.min(i, hours.length - 1)]
  if (!h) return null
  const fmt = (n: number) => `${Math.round(n)} ${wu}`
  return (
    <>
      <div className="wa-detail-split">
        <WindCompass deg={h.windDir} bft={beaufort(h.wind, units === 'c')} speed={h.wind} units={units} />
        <Readout title={hourLabels(hours)[i]} big={fmt(h.wind)} sub={`From the ${compass(h.windDir)} · gusts ${fmt(h.gusts)}`} extra={<span className="wa-readout-sub">{beaufortName(beaufort(h.wind, units === 'c'))}</span>} />
      </div>
      <InteractiveChart
        label="Wind by hour"
        series={[
          { name: 'Wind', values: hours.map((x) => x.wind), kind: 'area', color: 'var(--accent)', fmt },
          { name: 'Gusts', values: hours.map((x) => x.gusts), faint: true, color: 'var(--yellow)', fmt },
        ]}
        arrows={hours.map((x) => x.windDir)}
        labels={hourLabels(hours)}
        tick={hourTick(hours)}
        index={i}
        onIndex={setI}
        axis={(n) => String(Math.round(n))}
        floor={0}
      />
      <p className="wa-prose">
        {rangeText('Wind', hours.map((x) => x.wind), fmt)}. The arrows show where it blows from, hour by hour; drag along the chart and the compass follows.
      </p>
    </>
  )
}

function PrecipDetail({ forecast, units }: BodyProps) {
  const [range, setRange] = useState<'hours' | 'days'>('hours')
  const [i, setI] = useIndex()
  const fmt = precipFmt(units)
  const today = forecast.days[0]
  const hours = forecast.hours
  const days = forecast.days
  const first = days[0]?.date
  const axis = (n: number) => (units === 'f' ? n.toFixed(2) : n.toFixed(n < 1 ? 1 : 0))
  const k = Math.min(i, (range === 'hours' ? hours.length : days.length) - 1)
  return (
    <>
      <Seg
        value={range}
        options={[
          ['hours', 'Next 24 hours'],
          ['days', '10 days'],
        ]}
        onChange={(r) => {
          setRange(r)
          setI(0)
        }}
        label="Range"
      />
      {range === 'hours' && hours[k] && (
        <Readout title={hourLabels(hours)[k]} big={fmt(hours[k].precip)} sub={`${pct(hours[k].precipProb)} chance · ${describe(hours[k].code, hours[k].day).text}`} />
      )}
      {range === 'days' && days[k] && <Readout title={weekday(days[k].date, first)} big={fmt(days[k].precipSum)} sub={`${pct(days[k].precipProb)} chance · ${describe(days[k].code).text}`} />}
      <InteractiveChart
        key={range}
        label={range === 'hours' ? 'Precipitation by hour' : 'Precipitation by day'}
        series={
          range === 'hours'
            ? [
                { name: 'Amount', values: hours.map((h) => h.precip), kind: 'bars', color: 'var(--blue)', fmt },
                { name: 'Chance', values: hours.map((h) => h.precipProb), kind: 'area', color: 'var(--cyan)', faint: true, domain: [0, 100], fmt: pct },
              ]
            : [
                { name: 'Total', values: days.map((d) => d.precipSum), kind: 'bars', color: 'var(--blue)', fmt },
                { name: 'Chance', values: days.map((d) => d.precipProb), kind: 'area', color: 'var(--cyan)', faint: true, domain: [0, 100], fmt: pct },
              ]
        }
        labels={range === 'hours' ? hourLabels(hours) : days.map((d) => weekday(d.date, first))}
        tick={range === 'hours' ? hourTick(hours) : (j) => (days[j] ? weekday(days[j].date, first) : null)}
        index={k}
        onIndex={setI}
        axis={axis}
        floor={0}
        ceil={units === 'f' ? 0.04 : 1}
      />
      <p className="wa-prose">
        {formatPrecip(today?.precipSum ?? forecast.now.precip, units)} expected today.
        {forecast.days[1] ? ` ${formatPrecip(forecast.days[1].precipSum, units)} tomorrow.` : ''} Bars are amounts; the line is the chance.
      </p>
    </>
  )
}

function FeelsDetail({ forecast }: BodyProps) {
  const hours = forecast.hours
  const [i, setI] = useIndex()
  const h = hours[Math.min(i, hours.length - 1)]
  if (!h) return null
  return (
    <>
      <Readout
        title={hourLabels(hours)[i]}
        big={
          <>
            {deg(h.feels)} <small>air {deg(h.temp)}</small>
          </>
        }
        sub={feelsHint(h.temp, h.feels)}
      />
      <InteractiveChart
        label="Feels like by hour"
        series={[
          { name: 'Feels like', values: hours.map((x) => x.feels), kind: 'area', color: 'var(--orange)', fmt: deg },
          { name: 'Air', values: hours.map((x) => x.temp), faint: true, color: 'var(--accent)', fmt: deg },
        ]}
        labels={hourLabels(hours)}
        tick={hourTick(hours)}
        index={i}
        onIndex={setI}
        axis={deg}
      />
      <p className="wa-prose">
        {rangeText('Feels like', hours.map((x) => x.feels), deg)}. The dashed line is the air temperature.
      </p>
    </>
  )
}

function comfort(dew: number, units: Units): string {
  const c = units === 'f' ? ((dew - 32) * 5) / 9 : dew
  if (c < 10) return 'Dry air.'
  if (c < 16) return 'Comfortable.'
  if (c < 20) return 'A little humid.'
  if (c < 24) return 'Humid and sticky.'
  return 'Oppressive.'
}

function HumidityDetail({ forecast, units }: BodyProps) {
  const hours = forecast.hours
  const [i, setI] = useIndex()
  const h = hours[Math.min(i, hours.length - 1)]
  if (!h) return null
  const dews = hours.map((x) => x.dewPoint)
  const dLo = Math.min(...dews)
  const dHi = Math.max(...dews)
  return (
    <>
      <Readout title={hourLabels(hours)[i]} big={pct(h.humidity)} sub={`Dew point ${deg(h.dewPoint)}. ${comfort(h.dewPoint, units)}`} />
      <InteractiveChart
        label="Humidity by hour"
        series={[
          { name: 'Humidity', values: hours.map((x) => x.humidity), kind: 'area', color: 'var(--cyan)', fmt: pct },
          { name: 'Dew point', values: dews, faint: true, color: 'var(--green)', domain: [dLo - (dHi - dLo + 2), dHi + 2], fmt: deg },
        ]}
        labels={hourLabels(hours)}
        tick={hourTick(hours)}
        index={i}
        onIndex={setI}
        axis={pct}
        floor={0}
        ceil={100}
      />
      <p className="wa-prose">
        {rangeText('Humidity', hours.map((x) => x.humidity), pct)}. The dew point (dashed) says more about how muggy it feels.
      </p>
    </>
  )
}

function pressureTrend(values: number[], i: number): string {
  const a = values[i]
  const b = values[Math.min(values.length - 1, i + 3)]
  if (a === undefined || b === undefined) return 'Steady.'
  const d = b - a
  if (d > 1) return 'Rising.'
  if (d < -1) return 'Falling.'
  return 'Steady.'
}

function PressureDetail({ forecast }: BodyProps) {
  const hours = forecast.hours
  const [i, setI] = useIndex()
  const values = hours.map((x) => x.pressure)
  const h = hours[Math.min(i, hours.length - 1)]
  if (!h) return null
  const fmt = (n: number) => `${Math.round(n)} hPa`
  return (
    <>
      <div className="wa-detail-split">
        <PressureGauge hpa={h.pressure} />
        <Readout title={hourLabels(hours)[i]} big={fmt(h.pressure)} sub={`${pressureTrend(values, i)} ${h.pressure < 1000 ? 'Low pressure: unsettled.' : h.pressure > 1022 ? 'High pressure: settled.' : ''}`} />
      </div>
      <InteractiveChart label="Pressure by hour" series={[{ name: 'Pressure', values, kind: 'area', color: 'var(--magenta)', fmt }]} labels={hourLabels(hours)} tick={hourTick(hours)} index={i} onIndex={setI} axis={(n) => String(Math.round(n))} />
      <p className="wa-prose">{rangeText('Pressure', values, fmt)}.</p>
    </>
  )
}

function VisibilityDetail({ forecast, units }: BodyProps) {
  const hours = forecast.hours
  const [i, setI] = useIndex()
  const h = hours[Math.min(i, hours.length - 1)]
  if (!h) return null
  const per = units === 'f' ? 1609.344 : 1000
  const fmt = (n: number) => formatVis(n * per, units)
  return (
    <>
      <Readout title={hourLabels(hours)[i]} big={formatVis(h.visibility, units)} sub={`${visibilityLabel(h.visibility)} Cloud cover ${pct(h.cloud)}.`} />
      <InteractiveChart
        label="Visibility by hour"
        series={[
          { name: 'Visibility', values: hours.map((x) => x.visibility / per), kind: 'area', color: 'var(--accent)', fmt },
          { name: 'Cloud', values: hours.map((x) => x.cloud), faint: true, color: 'var(--muted)', domain: [0, 100], fmt: pct },
        ]}
        labels={hourLabels(hours)}
        tick={hourTick(hours)}
        index={i}
        onIndex={setI}
        axis={(n) => String(Math.round(n))}
        floor={0}
      />
      <p className="wa-prose">
        {rangeText('Visibility', hours.map((x) => x.visibility), (n) => formatVis(n, units))}. The dashed line is cloud cover.
      </p>
    </>
  )
}

function MoonDetail() {
  const [i, setI] = useIndex()
  const days = Array.from({ length: 30 }, (_, k) => {
    const date = new Date()
    date.setDate(date.getDate() + k)
    return { date, ...moonPhase(date) }
  })
  const d = days[i]
  const nextOf = (name: string) => days.find((x, k) => k > 0 && x.name === name && days[k - 1].name !== name)
  const full = nextOf('Full Moon')
  const fresh = nextOf('New Moon')
  const short = (x: Date) => x.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  return (
    <>
      <div className="wa-detail-split">
        <MoonDisc age={d.age} />
        <Readout title={i === 0 ? 'Tonight' : short(d.date)} big={d.name} sub={`Illumination ${Math.round(d.illumination * 100)}%, ${d.age.toFixed(1)} days since the new moon.`} />
      </div>
      <InteractiveChart
        label="Moon illumination over 30 days"
        series={[{ name: 'Illumination', values: days.map((x) => x.illumination * 100), kind: 'area', color: 'var(--fg-bright)', fmt: pct }]}
        labels={days.map((x, k) => (k === 0 ? 'Tonight' : short(x.date)))}
        tick={(k) => (k === 0 ? 'Now' : k % 7 === 0 ? days[k].date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null)}
        index={i}
        onIndex={setI}
        axis={pct}
        floor={0}
        ceil={100}
        height={160}
      />
      <div className="wa-moon-cal" role="group" aria-label="Moon phase calendar">
        {days.map((x, k) => (
          <button key={k} type="button" className={k === i ? 'is-on' : ''} onClick={() => setI(k)} aria-label={`${short(x.date)}: ${x.name}`} aria-pressed={k === i}>
            <MoonDisc age={x.age} />
            <span>{x.date.getDate()}</span>
          </button>
        ))}
      </div>
      <dl className="wa-facts">
        {full && <Fact k="Next full moon" v={short(full.date)} />}
        {fresh && <Fact k="Next new moon" v={short(fresh.date)} />}
      </dl>
    </>
  )
}

const AQI_ZONES: ChartZone[] = [
  { from: 0, to: 20, color: 'var(--cyan)' },
  { from: 20, to: 40, color: 'var(--green)' },
  { from: 40, to: 60, color: 'var(--yellow)' },
  { from: 60, to: 80, color: 'var(--orange)' },
  { from: 80, to: 100, color: 'var(--red)' },
  { from: 100, to: 500, color: 'var(--magenta)' },
]

function AirDetail({ air }: { air: AirQuality | null }) {
  const [i, setI] = useIndex()
  if (!air) return <p className="wa-prose">Air quality didn&apos;t come back for this place.</p>
  const hours = air.hours
  const h = hours[Math.min(i, hours.length - 1)]
  const ug = (n: number) => `${Math.round(n)} µg/m³`
  const cur = h ?? { time: 'Now', aqi: air.aqi, pm25: air.pm25, pm10: air.pm10, ozone: air.ozone, no2: air.no2 }
  return (
    <>
      <Readout
        title={i === 0 || !h ? 'Now' : `${hours[0] && h.iso.slice(0, 10) !== hours[0].iso.slice(0, 10) ? `${weekday(h.iso.slice(0, 10))} ` : ''}${h.time}`}
        big={
          <>
            {Math.round(cur.aqi)} <small>{aqiLabel(cur.aqi)}</small>
          </>
        }
        sub="European AQI"
      />
      <Scale value={Math.min(1, cur.aqi / 100)} kind="aqi" />
      {hours.length > 1 && (
        <InteractiveChart
          label="Air quality by hour"
          series={[{ name: 'AQI', values: hours.map((x) => x.aqi), kind: 'area', color: 'var(--accent)', fmt: (n) => `${Math.round(n)} ${aqiLabel(n)}` }]}
          zones={AQI_ZONES}
          labels={hours.map((x, k) => (k === 0 ? 'Now' : `${weekday(x.iso.slice(0, 10), hours[0].iso.slice(0, 10)) === 'Today' ? '' : `${weekday(x.iso.slice(0, 10))} `}${x.time}`))}
          tick={(k) => {
            const x = hours[k]
            if (!x) return null
            if (k === 0) return 'Now'
            return x.time === '00:00' ? weekday(x.iso.slice(0, 10)) : String(Number(x.time.slice(0, 2)))
          }}
          index={i}
          onIndex={setI}
          axis={(n) => String(Math.round(n))}
          floor={0}
          ceil={60}
        />
      )}
      <dl className="wa-facts">
        <Fact k="PM2.5" v={ug(cur.pm25)} />
        <Fact k="PM10" v={ug(cur.pm10)} />
        <Fact k="Ozone" v={ug(cur.ozone)} />
        <Fact k="NO₂" v={ug(cur.no2)} />
      </dl>
      <p className="wa-prose">The scale runs from good, through fair and moderate, into poor. Drag along the chart for the forecast pollutants at that hour.</p>
    </>
  )
}

function beaufortName(b: number): string {
  return ['Calm', 'Light air', 'Light breeze', 'Gentle breeze', 'Moderate breeze', 'Fresh breeze', 'Strong breeze', 'Near gale', 'Gale', 'Strong gale', 'Storm', 'Violent storm', 'Hurricane force'][b] ?? ''
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
      return 'Radar'
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

function PrecipBars({ minutes }: { minutes: Forecast['minutes'] }) {
  if (!minutes.length) return <p className="wa-tile-foot">15-minute precipitation is unavailable.</p>
  const max = Math.max(...minutes.map((m) => m.precip), 0)
  return (
    <div className="wa-bars-wrap">
      <div className="wa-bars" aria-hidden>
        {minutes.map((m, i) => (
          <i key={m.label} style={{ height: `${max <= 0 ? 8 : Math.max(8, (m.precip / max) * 100)}%`, animationDelay: `${i * 60}ms` }} />
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
  const p = Math.min(100, Math.max(0, value * 100))
  return (
    <div className={`wa-scale is-${kind}`} aria-hidden>
      <i style={{ left: `${p}%` }} />
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
          <path className="wa-pressure-arc" d="M10 70 A50 50 0 0 1 110 70" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="square" pathLength={1} strokeDasharray={`${t} 1`} />
          {/* Rim only. A needle through the hub crosses the reading at every pressure. */}
          <line className="wa-pressure-needle" x1="60" y1="30" x2="60" y2="22" stroke="currentColor" strokeWidth="3" strokeLinecap="square" style={{ transform: `rotate(${angle}deg)` }} />
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

function WindCompass({ deg: dir, bft, speed, units, sway }: { deg: number; bft: number; speed: number; units: Units; sway?: number }) {
  return (
    <div className="wa-wind-dial">
      <svg viewBox="0 0 100 100" aria-hidden>
        <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
        {Array.from({ length: 36 }, (_, k) => {
          const a = (k * Math.PI) / 18
          const r1 = k % 9 === 0 ? 38 : 40
          return <line key={k} x1={50 + Math.cos(a) * r1} y1={50 + Math.sin(a) * r1} x2={50 + Math.cos(a) * 42} y2={50 + Math.sin(a) * 42} stroke="currentColor" strokeOpacity="0.3" strokeWidth="1" />
        })}
        {['N', 'E', 'S', 'W'].map((d, i) => {
          const a = (i * Math.PI) / 2 - Math.PI / 2
          return (
            <text key={d} x={50 + Math.cos(a) * 26} y={50 + Math.sin(a) * 26} textAnchor="middle" dominantBaseline="middle" fill="currentColor" opacity="0.55" fontSize="9">
              {d}
            </text>
          )
        })}
        <g className="wa-wind-needle" style={{ transform: `rotate(${dir}deg)` }}>
          <g className={sway ? 'wa-wind-sway' : undefined} style={sway ? { ['--sway' as string]: `${sway}deg` } : undefined}>
            <path d="M50 8 L55.5 21 L50 18.5 L44.5 21 Z" fill="var(--accent)" />
            <path d="M50 92 L53 81 L50 83 L47 81 Z" fill="currentColor" opacity="0.35" />
          </g>
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

/**
 * The sun's path over 24 hours: above the horizon from sunrise to sunset, below it at night.
 * The full version is draggable (pointer, touch, arrow keys) and says the time and what is next.
 */
function SunPath({ sunrise, sunset, mini, today = true }: { sunrise: string; sunset: string; mini?: boolean; today?: boolean }) {
  const rise = clockMinutes(sunrise) ?? 360
  const set = clockMinutes(sunset) ?? 1080
  const nowD = new Date()
  const nowM = nowD.getHours() * 60 + nowD.getMinutes()
  const [m, setM] = useState(today ? nowM : Math.round((rise + set) / 2))
  const svgRef = useRef<SVGSVGElement>(null)
  const held = useRef<number | null>(null)
  const W = 360
  const H = mini ? 70 : 150
  const horizon = mini ? 46 : 96
  const amp = mini ? 36 : 78
  const dayLen = Math.max(1, set - rise)
  const elev = (t: number) => {
    if (t >= rise && t <= set) return Math.sin((Math.PI * (t - rise)) / dayLen)
    const since = (((t - set) % 1440) + 1440) % 1440
    return -0.32 * Math.sin((Math.PI * since) / Math.max(1, 1440 - dayLen))
  }
  const x = (t: number) => 8 + (t / 1440) * (W - 16)
  const y = (t: number) => horizon - elev(t) * amp
  let d = ''
  for (let t = 0; t <= 1440; t += 10) d += `${t ? ' L' : 'M'} ${x(t).toFixed(1)} ${y(t).toFixed(1)}`
  const cur = mini ? nowM : m
  const up = elev(cur) >= 0
  const fromClient = (clientX: number) => {
    const el = svgRef.current
    if (!el) return cur
    const r = el.getBoundingClientRect()
    const vx = ((clientX - r.left) / Math.max(1, r.width)) * W
    return Math.min(1439, Math.max(0, Math.round(((vx - 8) / (W - 16)) * 1440)))
  }
  const down = (e: PointerEvent<SVGSVGElement>) => {
    if (mini || e.button !== 0) return
    held.current = e.pointerId
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setM(fromClient(e.clientX))
  }
  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (mini) return
    if (held.current === e.pointerId || e.pointerType === 'mouse') setM(fromClient(e.clientX))
  }
  const release = () => {
    held.current = null
  }
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    const by = e.key === 'ArrowRight' ? 10 : e.key === 'ArrowLeft' ? -10 : e.key === 'PageUp' ? 60 : e.key === 'PageDown' ? -60 : 0
    if (!by) return
    e.preventDefault()
    e.stopPropagation()
    setM((v) => Math.min(1439, Math.max(0, v + by)))
  }
  const clock = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
  const span = (mins: number) => (mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`)
  const status = up ? `${span(set - cur)} until sunset` : cur < rise ? `Sunrise in ${span(rise - cur)}` : `Sunrise in ${span(1440 - cur + rise)}`
  const clipId = mini ? 'wa-sunclip-mini' : 'wa-sunclip'
  const svg = (
    <svg
      ref={svgRef}
      className={`wa-sunpath${mini ? ' is-mini' : ''}`}
      viewBox={`0 0 ${W} ${H}`}
      role={mini ? undefined : 'slider'}
      tabIndex={mini ? undefined : 0}
      aria-hidden={mini ? true : undefined}
      aria-label={mini ? undefined : 'Time of day'}
      aria-valuemin={mini ? undefined : 0}
      aria-valuemax={mini ? undefined : 1439}
      aria-valuenow={mini ? undefined : cur}
      aria-valuetext={mini ? undefined : `${clock(cur)}, ${status}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={release}
      onKeyDown={key}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width={W} height={horizon} />
        </clipPath>
      </defs>
      <path d={`${d} L ${x(1440)} ${horizon} L ${x(0)} ${horizon} Z`} clipPath={`url(#${clipId})`} className="wa-sunpath-day" />
      <path d={d} className="wa-sunpath-curve" />
      <line x1="0" x2={W} y1={horizon} y2={horizon} className="wa-sunpath-horizon" />
      {!mini &&
        [0, 6, 12, 18].map((hh) => (
          <text key={hh} x={x(hh * 60)} y={H - 6} className="wa-sunpath-tick" textAnchor="start">
            {String(hh).padStart(2, '0')}:00
          </text>
        ))}
      {!mini && (
        <>
          <circle cx={x(rise)} cy={horizon} r="3" className="wa-sunpath-mark" />
          <circle cx={x(set)} cy={horizon} r="3" className="wa-sunpath-mark" />
        </>
      )}
      <g className={`wa-sunpath-sun${up ? '' : ' is-down'}`} style={{ transform: `translate(${x(cur)}px, ${y(cur)}px)` }}>
        <circle r={mini ? 11 : 18} className="wa-sunpath-glow" />
        <circle r={mini ? 5 : 8} className="wa-sunpath-core" />
      </g>
    </svg>
  )
  if (mini) return svg
  return (
    <div className="wa-sunwrap">
      <Readout title={clock(cur)} big={up ? 'Sun up' : 'Sun down'} sub={status} />
      {svg}
      <p className="wa-sunwrap-hint">Drag the sun through the day.</p>
    </div>
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
