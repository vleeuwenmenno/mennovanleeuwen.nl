import { useEffect, useState, type CSSProperties } from 'react'
import type { IssueHit } from '../data/code'
import { timeAgo } from '../data/recents'
import { api, signIn, useAccount } from '../os/account'
import type { MenuItem } from '../os/ContextMenu'
import { useWindowMenu } from '../os/windowMenu'
import type { WinState } from '../os/wm'
import { createWithTilt, setWidgetConfig, tiltMenu, useWidgetConfig } from './config'
import type { WidgetDef } from './types'

// The Code inbox widget: pull requests waiting for your review, your own open pull requests and
// issues assigned to you, on GitHub and every linked Gitea/Forgejo instance (server/inbox.ts).

type Inbox = { review: IssueHit[]; mine: IssueHit[]; assigned: IssueHit[]; errors: string[] }
type Section = 'review' | 'mine' | 'assigned'
type Config = { tilt: number; hidden: Section[] }
const DEFAULTS: Config = { tilt: 0, hidden: [] }

const SECTIONS: [Section, string, string][] = [
  ['review', 'Waiting for your review', 'Nobody is waiting on you'],
  ['mine', 'Your pull requests', 'No open pull requests'],
  ['assigned', 'Assigned to you', 'Nothing assigned'],
]
const SHOWN = 5

// One request for every inbox widget on the page.
let shared: { at: number; value: Promise<Inbox> } | null = null
function load(fresh = false) {
  if (!fresh && shared && Date.now() - shared.at < 60_000) return shared.value
  const value = api<Inbox>(`/api/inbox${fresh ? '?fresh' : ''}`)
  shared = { at: Date.now(), value }
  value.catch(() => (shared = null))
  return value
}

function Item({ h }: { h: IssueHit }) {
  const label = h.draft && h.state === 'open' ? 'draft' : null
  return (
    <a className="ib-item" href={h.url} target="_blank" rel="noopener noreferrer" title={`${h.repo}#${h.number} · ${h.sourceLabel}`}>
      <span className="ib-kind" aria-hidden>
        {h.kind === 'pr' ? '⇄' : '●'}
      </span>
      <span className="ib-text">
        <span className="ib-title">{h.title}</span>
        <span className="ib-meta">
          {h.repo.split('/').pop()}#{h.number}
          {label && ` · ${label}`} · {timeAgo(h.updatedAt)}
        </span>
      </span>
    </a>
  )
}

export function CodeInbox({ id }: { win: WinState; id: string }) {
  const account = useAccount()
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  const windowMenu = useWindowMenu()
  const [box, setBox] = useState<Inbox | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const signedIn = account.status === 'user'

  const refresh = (fresh = false) => {
    setBusy(true)
    load(fresh)
      .then((b) => (setBox(b), setError(null)), (e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }
  useEffect(() => {
    if (!signedIn) return
    refresh()
    const again = () => document.visibilityState === 'visible' && refresh()
    const t = setInterval(again, 2 * 60_000)
    document.addEventListener('visibilitychange', again)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', again)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn])

  return (
    <div className="ib">
      <div className="ib-head">
        <strong>Code inbox</strong>
        {box && <span className="ib-count">{box.review.length + box.assigned.length}</span>}
        <button className="sticky-btn" onClick={() => refresh(true)} title="Refresh" aria-label="Refresh" disabled={busy || !signedIn}>
          ⟳
        </button>
        <button className="sticky-btn" onClick={windowMenu} title="More" aria-label="Inbox menu">
          ⋯
        </button>
      </div>
      {!signedIn ? (
        <p className="ib-note">
          Your pull requests and issues show here once you sign in.{' '}
          {account.status === 'anon' && (
            <button className="link-btn" onClick={signIn}>
              Sign in with GitHub
            </button>
          )}
        </p>
      ) : !box ? (
        <p className="ib-note">{error ?? 'Checking GitHub…'}</p>
      ) : (
        <>
          {SECTIONS.filter(([key]) => !config.hidden.includes(key)).map(([key, title, empty]) => (
            <section key={key} className="ib-section">
              <h4>
                {title} <span>{box[key].length || ''}</span>
              </h4>
              {box[key].length === 0 && <p className="ib-empty">{empty}</p>}
              {box[key].slice(0, SHOWN).map((h) => (
                <Item key={`${h.source}|${h.repo}|${h.number}`} h={h} />
              ))}
              {box[key].length > SHOWN && <p className="ib-empty">and {box[key].length - SHOWN} more</p>}
            </section>
          ))}
          {box.errors.length > 0 && <p className="ib-note t-red">{box.errors.join(' · ')}</p>}
        </>
      )}
    </div>
  )
}

function useInboxFrame(id: string): CSSProperties {
  const { tilt } = useWidgetConfig<Config>(id, DEFAULTS)
  return { ['--widget-bg' as string]: 'linear-gradient(175deg, #e6ecf5 0%, #cfd9e8 100%)', ['--widget-fg' as string]: '#1b2638', ['--widget-tilt' as string]: `${tilt}deg` }
}

function useInboxMenu(id: string): MenuItem[] {
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  return [
    {
      label: 'Show',
      submenu: SECTIONS.map(([key, title]) => ({
        label: title,
        checked: !config.hidden.includes(key),
        onSelect: () => setWidgetConfig(id, { hidden: config.hidden.includes(key) ? config.hidden.filter((k) => k !== key) : [...config.hidden, key] }),
      })),
    },
    { label: 'Open GitHub notifications ↗', onSelect: () => window.open('https://github.com/notifications', '_blank', 'noopener') },
    tiltMenu(id, config.tilt),
  ]
}

export const inboxWidget: WidgetDef = {
  kind: 'inbox',
  name: 'Code inbox',
  blurb: 'Reviews waiting for you, your pull requests and assigned issues',
  glyph: '📬',
  size: [320, 340],
  resizable: true,
  Component: CodeInbox,
  useFrame: useInboxFrame,
  useMenu: useInboxMenu,
  create: createWithTilt,
}
