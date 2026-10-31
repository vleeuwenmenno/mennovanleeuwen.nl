import type { CSSProperties } from 'react'
import { MC_ADDRESS } from '../data/minecraft'
import type { MenuItem } from '../os/ContextMenu'
import { createWithTilt, tiltMenu, useWidgetConfig } from './config'
import type { WidgetDef, WM } from './types'
import { PackageHost } from './platform/Host'

// The Minecraft widget: Menno's server at a glance (up or not, who is on, the world's clock when
// the site's server has RCON), from the cancellable shared broker (src/data/minecraft.ts), so it
// works for guests too. Clicking it opens the Minecraft server window, right on this page; tapping
// a player's head says who that is (and, over RCON, where they are and how they are doing).

type Config = { tilt: number }
const DEFAULTS: Config = { tilt: 0 }
const openServer = (wm: WM) => wm.open('mcserver', { t: String(Date.now()) })
const copyAddress = () => navigator.clipboard?.writeText(MC_ADDRESS)

function useMcFrame(id: string): CSSProperties {
  const { tilt } = useWidgetConfig<Config>(id, DEFAULTS)
  return { ['--widget-bg' as string]: 'var(--panel)', ['--widget-fg' as string]: 'var(--fg)', ['--widget-tilt' as string]: `${tilt}deg` }
}

function useMcMenu(id: string, wm: WM): MenuItem[] {
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  return [
    { label: 'Open server window', onSelect: () => openServer(wm) },
    { label: `Copy address (${MC_ADDRESS})`, onSelect: () => void copyAddress()?.catch(() => {}) },
    tiltMenu(id, config.tilt),
  ]
}

export const minecraftWidget: WidgetDef = {
  kind: 'minecraft',
  name: 'Minecraft server',
  blurb: "Menno's Minecraft server: up or not, who is on, the in-game time",
  glyph: '⛏',
  size: [250, 150],
  Component: PackageHost,
  useFrame: useMcFrame,
  useMenu: useMcMenu,
  create: createWithTilt,
}
