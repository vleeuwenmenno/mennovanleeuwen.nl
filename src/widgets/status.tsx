import { useEffect, useState, type CSSProperties } from 'react'
import { timeAgo } from '../data/recents'
import { api, signIn, useAccount } from '../os/account'
import type { MenuItem } from '../os/ContextMenu'
import { useWindowMenu } from '../os/windowMenu'
import { useWM } from '../os/wm'
import { createWithTilt, tiltMenu, useWidgetConfig } from './config'
import type { WidgetDef } from './types'

// The Status widget: your updown.io checks (server/updown.ts), up or down, with uptime, response
// time and certificates that expire soon. Owner only: it needs updown.io's read-only API key in
// Settings → Integrations.

type Check = {
  token: string
  name: string
  url: string
  down: boolean
  enabled: boolean
  error: string | null
  downSince: string | null
  uptime: number | null
  responseTime: number | null
  lastCheckAt: string | null
  sslExpiresAt: string | null
  sslValid: boolean | null
}
type Config = { tilt: number }
const DEFAULTS: Config = { tilt: 0 }
const SSL_WARN_DAYS = 14

// One request for every Status widget on the page.
let shared: { at: number; value: Promise<Check[]> } | null = null
function load() {
  if (shared && Date.now() - shared.at < 55_000) return shared.value
  const value = api<Check[]>('/api/updown')
  shared = { at: Date.now(), value }
  value.catch(() => (shared = null))
  return value
}

const daysUntil = (iso: string) => Math.floor((new Date(iso).getTime() - Date.now()) / 864e5)

function useChecks(enabled: boolean) {
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    const refresh = () => load().then((c) => (setChecks(c), setError(null)), (e: Error) => setError(e.message))
    refresh()
    const again = () => document.visibilityState === 'visible' && refresh()
    const t = setInterval(again, 60_000)
    document.addEventListener('visibilitychange', again)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', again)
    }
  }, [enabled])
  return { checks, error }
}

export function Status() {
  const account = useAccount()
  const wm = useWM()
  const windowMenu = useWindowMenu()
  const ready = account.status === 'user' && !!account.integrations.updown
  const { checks, error } = useChecks(ready)
  const down = checks?.filter((c) => c.enabled && c.down) ?? []
  const summary = !checks ? '' : down.length ? `${down.length} down` : 'All up'

  return (
    <div className="st">
      <div className="st-head">
        <strong>Status</strong>
        {checks && <span className={`st-badge ${down.length ? 'is-down' : 'is-up'}`}>{summary}</span>}
        <button className="sticky-btn" onClick={windowMenu} title="More" aria-label="Status menu">
          ⋯
        </button>
      </div>
      {account.status !== 'user' ? (
        <p className="st-note">
          Your uptime checks show here once you sign in.{' '}
          {account.status === 'anon' && (
            <button className="link-btn" onClick={signIn}>
              Sign in with GitHub
            </button>
          )}
        </p>
      ) : !account.integrations.updown ? (
        <p className="st-note">
          Connect updown.io to see your checks.{' '}
          <button className="link-btn" onClick={() => wm.open('settings', { section: 'integrations', t: String(Date.now()) })}>
            Settings → Integrations
          </button>
        </p>
      ) : !checks ? (
        <p className="st-note">{error ?? 'Asking updown.io…'}</p>
      ) : (
        <ul className="st-list">
          {checks.map((c) => {
            const sslDays = c.sslExpiresAt ? daysUntil(c.sslExpiresAt) : null
            const sslWarn = c.sslValid === false || (sslDays !== null && sslDays < SSL_WARN_DAYS)
            const state = !c.enabled ? 'is-paused' : c.down ? 'is-down' : 'is-up'
            return (
              <li key={c.token}>
                <a className={`st-check ${state}`} href={`https://updown.io/checks/${c.token}`} target="_blank" rel="noopener noreferrer" title={c.url}>
                  <span className="st-dot" aria-label={state === 'is-up' ? 'up' : state === 'is-down' ? 'down' : 'paused'} />
                  <span className="st-name">{c.name}</span>
                  <span className="st-nums">
                    {c.responseTime !== null && <span>{c.responseTime} ms</span>}
                    {c.uptime !== null && <span>{c.uptime >= 99.995 ? '100' : c.uptime.toFixed(2)}%</span>}
                  </span>
                  {c.down && c.enabled && (
                    <span className="st-detail">
                      down{c.downSince ? ` ${timeAgo(c.downSince).replace(/ ago$/, '')}` : ''}
                      {c.error ? ` · ${c.error}` : ''}
                    </span>
                  )}
                  {sslWarn && (
                    <span className="st-detail st-warn">
                      {c.sslValid === false ? 'certificate invalid' : sslDays! < 0 ? 'certificate expired' : `certificate expires in ${sslDays} day${sslDays === 1 ? '' : 's'}`}
                    </span>
                  )}
                </a>
              </li>
            )
          })}
          {checks.length === 0 && <li className="st-note">No checks on updown.io yet.</li>}
        </ul>
      )}
    </div>
  )
}

function useStatusFrame(id: string): CSSProperties {
  const { tilt } = useWidgetConfig<Config>(id, DEFAULTS)
  return { ['--widget-bg' as string]: 'linear-gradient(175deg, #f4f7f2 0%, #e2eadc 100%)', ['--widget-fg' as string]: '#1f2a1c', ['--widget-tilt' as string]: `${tilt}deg` }
}

function useStatusMenu(id: string): MenuItem[] {
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  return [{ label: 'Open updown.io ↗', onSelect: () => window.open('https://updown.io/checks', '_blank', 'noopener') }, tiltMenu(id, config.tilt)]
}

export const statusWidget: WidgetDef = {
  kind: 'status',
  name: 'Status',
  blurb: 'Your updown.io uptime checks: up or down, uptime and response time',
  glyph: '🟢',
  size: [300, 220],
  resizable: true,
  Component: Status,
  useFrame: useStatusFrame,
  useMenu: useStatusMenu,
  create: createWithTilt,
}
