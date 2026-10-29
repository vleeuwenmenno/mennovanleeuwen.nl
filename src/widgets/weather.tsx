import { type CSSProperties } from 'react'
import { PackageHost } from './platform/Host'
import { rememberedHere, type Place, type Units } from '../data/weather'
import type { MenuItem } from '../os/ContextMenu'
import { createWithTilt, setWidgetConfig, tiltMenu, useWidgetConfig } from './config'
import type { WidgetDef } from './types'

// The weather widget: now, the next hours and the next days for one place, from the shared Open-Meteo
// fetch (src/data/weather.ts). The place is the browser's own location unless you set one; a place
// you set syncs with the widget's other settings, the browser's location stays on this device.
// Double-click (or the menu) opens the full Weather app.

type Config = { place: Place | null; units: Units; tilt: number }
const DEFAULTS: Config = { place: null, units: 'c', tilt: 0 }

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

function useWeatherFrame(id: string): CSSProperties {
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  return { ['--widget-bg' as string]: 'var(--bg)', ['--widget-fg' as string]: 'var(--fg)', ['--widget-tilt' as string]: `${config.tilt}deg` }
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
  Component: PackageHost,
  useFrame: useWeatherFrame,
  useMenu: useWeatherMenu,
  create: createWithTilt,
}
