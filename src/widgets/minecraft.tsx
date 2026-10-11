import { useState, type CSSProperties, type MouseEvent } from 'react'
import { MC_ADDRESS, useMinecraft, worldLine } from '../data/minecraft'
import type { MenuItem } from '../os/ContextMenu'
import { useWindowMenu } from '../os/windowMenu'
import { useWM } from '../os/wm'
import { createWithTilt, tiltMenu, useWidgetConfig } from './config'
import type { WidgetDef, WM } from './types'

// The Minecraft widget: Menno's server at a glance (up or not, who is on, the world's clock when
// the site's server has RCON), from the page's one shared poller (src/data/minecraft.ts), so it
// works for guests too. Clicking it opens the Minecraft server window.

type Config = { tilt: number }
const DEFAULTS: Config = { tilt: 0 }
const HEADS = 8

const head = (name: string) => `https://mc-heads.net/avatar/${encodeURIComponent(name)}/16`
const openServer = (wm: WM) => wm.open('mcserver', { t: String(Date.now()) })
const copyAddress = () => navigator.clipboard?.writeText(MC_ADDRESS)

export function McWidget() {
  const wm = useWM()
  const windowMenu = useWindowMenu()
  const { status, error } = useMinecraft()
  const [copied, setCopied] = useState(false)
  const online = !!status?.online
  const names = status?.players.list ?? []
  const copy = (e: MouseEvent) => {
    e.stopPropagation()
    copyAddress()
      ?.then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <div className="mcw" onClick={() => openServer(wm)} title="Open the Minecraft server window">
      <div className="mcw-head">
        <span className={`mcw-dot ${online ? 'is-up' : status ? 'is-down' : ''}`} aria-hidden />
        <strong>Minecraft</strong>
        <span className="mcw-state">{status ? (online ? 'Online' : 'Offline') : error ? 'Unknown' : 'Checking…'}</span>
        <button
          className="sticky-btn"
          onClick={(e) => {
            e.stopPropagation()
            windowMenu(e)
          }}
          title="More"
          aria-label="Minecraft widget menu"
        >
          ⋯
        </button>
      </div>
      <button className="mcw-addr" onClick={copy} title="Copy the address">
        <code>{MC_ADDRESS}</code>
        <span>{copied ? 'Copied ✓' : 'Copy'}</span>
      </button>
      {online && (
        <div className="mcw-players">
          <span className="mcw-count">
            {status.players.online}
            <span>/{status.players.max}</span>
          </span>
          {names.length > 0 ? (
            <span className="mcw-heads">
              {names.slice(0, HEADS).map((n) => (
                <img key={n} src={head(n)} alt={n} title={n} width={16} height={16} />
              ))}
              {names.length > HEADS && <span className="mcw-more">+{names.length - HEADS}</span>}
            </span>
          ) : (
            <span className="mcw-muted">{status.players.online ? 'names hidden' : 'nobody on'}</span>
          )}
        </div>
      )}
      {online && status.world && <div className="mcw-world">{worldLine(status.world)}</div>}
    </div>
  )
}

function useMcFrame(id: string): CSSProperties {
  const { tilt } = useWidgetConfig<Config>(id, DEFAULTS)
  // Grass on top of dirt, washed out enough to read on.
  return { ['--widget-bg' as string]: 'linear-gradient(180deg, #e3efd2 0%, #e3efd2 22%, #efe4d3 100%)', ['--widget-fg' as string]: '#2b2418', ['--widget-tilt' as string]: `${tilt}deg` }
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
  Component: McWidget,
  useFrame: useMcFrame,
  useMenu: useMcMenu,
  create: createWithTilt,
}
