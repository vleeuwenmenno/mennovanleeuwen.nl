import type { CSSProperties } from 'react'
import type { MenuItem } from '../os/ContextMenu'
import { bareFrame } from './clock'
import { createWithTilt, tiltMenu, useWidgetConfig } from './config'
import { CUSTOM_KIND } from './platform/package'
import { PackageHost } from './platform/Host'
import { installations } from './platform/installations'
import { customInstallations } from './platform/records'
import type { WidgetDef, WM } from './types'

// Custom widgets: any number of instances, each made from its own package folder (Widget Workshop).
// They go through the same PackageHost as the six built-in widgets, only with a small capability
// set (custom.state). The registry lists each installed instance in "Add widget".

type Config = { tilt: number }
const DEFAULTS: Config = { tilt: 0 }

function useCustomFrame(id: string): CSSProperties {
  const { tilt } = useWidgetConfig<Config>(id, DEFAULTS)
  const appearance = installations.use()[id]?.active.snapshot.manifest.settings.appearance
  if (appearance === 'bare') return { ...bareFrame(), ['--widget-tilt' as string]: '0deg' }
  const sticky = appearance === 'sticky'
  return { ['--widget-bg' as string]: sticky ? 'color-mix(in srgb, var(--accent) 16%, var(--panel))' : 'var(--panel)', ['--widget-fg' as string]: 'var(--fg)', ['--widget-tilt' as string]: `${tilt}deg` }
}

const useCustomTitle = (id: string) => installations.use()[id]?.active.snapshot.manifest.name ?? 'Custom widget'

function useCustomMenu(id: string, wm: WM): MenuItem[] {
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  return [{ label: 'Edit in Widget Workshop', onSelect: () => wm.open('widgetworkshop', { id, kind: CUSTOM_KIND }) }, tiltMenu(id, config.tilt)]
}

/** Placed windows (props { kind: 'custom', id }) always resolve to this definition. */
export const customWidget: WidgetDef = {
  kind: CUSTOM_KIND,
  name: 'Custom widget',
  blurb: 'A widget made from a package folder',
  glyph: '🧩',
  size: [280, 220],
  resizable: true,
  closeLabel: 'Take off the desktop',
  Component: PackageHost,
  useFrame: useCustomFrame,
  useMenu: useCustomMenu,
  useTitle: useCustomTitle,
  create: createWithTilt,
}

/** "Add widget" rows: one per installed custom widget, then the way to make a new one. */
export function customEntries(): WidgetDef[] {
  const installed = customInstallations(installations.get()).map<WidgetDef>(item => ({
    ...customWidget,
    instance: item.instance,
    name: item.active.snapshot.manifest.name,
    blurb: `Custom widget · ${item.active.snapshot.manifest.id}`,
  }))
  return [...installed, { ...customWidget, kind: 'custom-new', name: 'New custom widget…', blurb: 'Create a widget from a package folder in the Widget Workshop', glyph: '＋', onAdd: wm => wm.open('widgetworkshop', { kind: CUSTOM_KIND }) }]
}
