import type { CSSProperties } from 'react'
import type { MenuItem } from '../os/ContextMenu'
import { setWidgetConfig, useWidgetConfig } from './config'
import { CLOCK_DEFAULTS, clockConfig, type ClockConfig } from './platform/clock'
import { PackageHost } from './platform/Host'
import type { WidgetDef } from './types'

// The Clock widget: a big digital time with the date under it, drawn straight on the wallpaper
// (appearance "bare": no card, border, tape or shadow). It scales with its width, so it fills a
// wide widget and a phone's full-width column alike. Settings (24/12-hour, seconds, how much date,
// accent colour) live in its menu and sync with the widget's other settings.

const useClockSettings = (id: string) => clockConfig(useWidgetConfig<Record<string, unknown>>(id, CLOCK_DEFAULTS))

/** No background of its own; Shell.tsx turns --widget-bare into the frameless look (home.css). */
export function bareFrame(): CSSProperties {
  return { ['--widget-bg' as string]: 'transparent', ['--widget-fg' as string]: 'var(--fg)', ['--widget-tilt' as string]: '0deg', ['--widget-bare' as string]: '1' }
}

function useClockMenu(id: string): MenuItem[] {
  const config = useClockSettings(id)
  const set = (patch: Partial<ClockConfig>) => setWidgetConfig(id, patch)
  const choice = <K extends 'hours' | 'show'>(key: K, label: string, value: ClockConfig[K]): MenuItem => ({ label, checked: config[key] === value, onSelect: () => set({ [key]: value }) })
  return [
    { label: 'Hours', submenu: [choice('hours', 'Follow my language', 'auto'), choice('hours', '24-hour', '24'), choice('hours', '12-hour', '12')] },
    { label: 'Show seconds', checked: config.seconds, onSelect: () => set({ seconds: !config.seconds }) },
    { label: 'Date', submenu: [choice('show', 'Weekday and date', 'full'), choice('show', 'Short', 'short'), choice('show', 'No date', 'none')] },
    { label: 'Accent colour', checked: config.accent, onSelect: () => set({ accent: !config.accent }) },
  ]
}

export const clockWidget: WidgetDef = {
  kind: 'clock',
  name: 'Clock',
  blurb: 'A big clock on the wallpaper: time and date, scales with its size, works on a phone',
  glyph: '🕒',
  size: [420, 160],
  resizable: true,
  Component: PackageHost,
  useFrame: bareFrame,
  useMenu: useClockMenu,
}
