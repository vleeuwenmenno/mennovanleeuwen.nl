import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { dimension, MC_ADDRESS, useMinecraft, vitals, worldLine, type McStatus } from '../data/minecraft'
import type { MenuItem } from '../os/ContextMenu'
import { useWindowMenu } from '../os/windowMenu'
import { useWM } from '../os/wm'
import { createWithTilt, tiltMenu, useWidgetConfig } from './config'
import type { WidgetDef, WM } from './types'

// The Minecraft widget: Menno's server at a glance (up or not, who is on, the world's clock when
// the site's server has RCON), from the page's one shared poller (src/data/minecraft.ts), so it
// works for guests too. Clicking it opens the Minecraft server window, right on this page; tapping
// a player's head says who that is (and, over RCON, where they are and how they are doing).

type Config = { tilt: number }
const DEFAULTS: Config = { tilt: 0 }
const HEADS = 12
const HEAD_PX = 24

// Twice the size it is shown at, so it stays sharp on HiDPI screens (drawn pixelated).
const head = (name: string) => `https://mc-heads.net/avatar/${encodeURIComponent(name)}/${HEAD_PX * 2}`
const openServer = (wm: WM) => wm.open('mcserver', { t: String(Date.now()) })
const copyAddress = () => navigator.clipboard?.writeText(MC_ADDRESS)

/** "Paper 1.21.4 · Hard · 42 ms": only the parts the server told. */
function metaLine(s: McStatus) {
  const build = [s.settings?.software ?? (s.version ? 'Java' : undefined), s.version].filter(Boolean).join(' ')
  return [build, s.settings?.difficulty, s.latency !== undefined && `${s.latency} ms`].filter(Boolean).join(' · ')
}

export function McWidget() {
  const wm = useWM()
  const windowMenu = useWindowMenu()
  const { status, error } = useMinecraft()
  const [copied, setCopied] = useState(false)
  // The player whose bubble is open: tapped (stays) or under the mouse (while it is there).
  const [picked, setPicked] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  // A tap that closed the bubble is just that: it doesn't also open the server window.
  const closedAt = useRef(0)
  const online = !!status?.online
  const names = status?.players.list ?? []
  const shown = [picked, hovered].find((n) => n && names.includes(n)) ?? null

  // Tapping anywhere else, or Esc, closes a tapped bubble.
  useEffect(() => {
    if (!picked) return
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('.mcw-face, .mcw-bubble')) return
      closedAt.current = Date.now()
      setPicked(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setPicked(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [picked])

  const copy = (e: MouseEvent) => {
    e.stopPropagation()
    copyAddress()
      ?.then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  const meta = online ? metaLine(status) : ''
  // The server's own line, when it says more than the default; long ones are left to the window.
  const motd = online && status.motd && status.motd !== 'A Minecraft Server' && status.motd.length <= 80 ? status.motd : ''
  return (
    <div
      className="mcw"
      onClick={() => {
        if (Date.now() - closedAt.current < 400) return
        openServer(wm)
      }}
      title="Open the Minecraft server window"
    >
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
      {motd && <div className="mcw-motd">{motd}</div>}
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
                <button
                  key={n}
                  data-name={n}
                  className={`mcw-face ${shown === n ? 'is-shown' : ''}`}
                  title={n}
                  aria-label={`${n}: who this is`}
                  aria-expanded={picked === n}
                  onClick={(e) => {
                    e.stopPropagation()
                    setPicked((p) => (p === n ? null : n))
                  }}
                  onPointerEnter={(e) => e.pointerType === 'mouse' && setHovered(n)}
                  onPointerLeave={() => setHovered((h) => (h === n ? null : h))}
                >
                  <img src={head(n)} alt="" width={HEAD_PX} height={HEAD_PX} draggable={false} />
                </button>
              ))}
              {names.length > HEADS && <span className="mcw-more">+{names.length - HEADS}</span>}
            </span>
          ) : (
            <span className="mcw-muted">{status.players.online ? 'names hidden' : 'nobody on'}</span>
          )}
          {shown && <Bubble name={shown} status={status} />}
        </div>
      )}
      {online && (status.world || meta) && (
        <div className="mcw-foot">
          {status.world && <div className="mcw-world">{worldLine(status.world)}</div>}
          {meta && <div className="mcw-meta">{meta}</div>}
        </div>
      )}
    </div>
  )
}

/** Who a head is: the name, and where they are and how they are doing when RCON tells. Just above
 * that head (across the players' row), its arrow pointing at it. */
function Bubble({ name, status }: { name: string; status: McStatus }) {
  const ref = useRef<HTMLDivElement>(null)
  const info = status.playerInfo?.[name]
  const v = vitals(info)
  const d = info?.dimension ? dimension(info.dimension) : null
  useLayoutEffect(() => {
    const el = ref.current
    const row = el?.parentElement
    const face = row && [...row.querySelectorAll<HTMLElement>('.mcw-face')].find((b) => b.dataset.name === name)
    // Offsets, not screen boxes: the widget may be tilted. The row is the heads' offset parent.
    if (!el || !face) return
    el.style.setProperty('--arrow', `${face.offsetLeft + face.offsetWidth / 2}px`)
    el.style.setProperty('--face-top', `${face.offsetTop}px`)
  })
  return (
    <div className="mcw-bubble" ref={ref} role="status" onClick={(e) => e.stopPropagation()}>
      <strong>{name}</strong>
      {(d || v) && (
        <span className="mcw-bubble-info">
          {d && <span className={`mcw-dim is-${d.kind}`}>{d.label}</span>}
          {v && <span className="mcw-vitals">{v}</span>}
        </span>
      )}
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
