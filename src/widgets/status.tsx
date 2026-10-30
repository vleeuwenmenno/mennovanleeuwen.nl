import type { CSSProperties } from 'react'
import { openLink } from '../data/links'
import type { MenuItem } from '../os/ContextMenu'
import { createWithTilt, tiltMenu, useWidgetConfig } from './config'
import type { WidgetDef } from './types'
import { PackageHost } from './platform/Host'

// The Status widget: your updown.io checks (server/updown.ts), up or down, with uptime, response
// time and certificates that expire soon. Signed-in users only: it needs updown.io's read-only API key in
// Settings → Integrations.

type Config = { tilt: number }
const DEFAULTS: Config = { tilt: 0 }

function useStatusFrame(id: string): CSSProperties {
  const { tilt } = useWidgetConfig<Config>(id, DEFAULTS)
  return { ['--widget-bg' as string]: 'var(--panel)', ['--widget-fg' as string]: 'var(--fg)', ['--widget-tilt' as string]: `${tilt}deg` }
}

function useStatusMenu(id: string): MenuItem[] {
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  return [{ label: 'Open updown.io ↗', onSelect: () => openLink('https://updown.io/checks') }, tiltMenu(id, config.tilt)]
}

export const statusWidget: WidgetDef = {
  kind: 'status',
  name: 'Status',
  blurb: 'Your updown.io uptime checks: up or down, uptime and response time',
  glyph: '🟢',
  size: [300, 220],
  resizable: true,
  Component: PackageHost,
  useFrame: useStatusFrame,
  useMenu: useStatusMenu,
  create: createWithTilt,
}
