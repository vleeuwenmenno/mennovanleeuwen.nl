import { useEffect, useRef, useState } from 'react'
import { timeAgo } from '../data/recents'
import { openContextMenu, type MenuItem } from './ContextMenu'
import { AppIcon } from './icons'
import { clearEntries, markAllRead, openEntry, pruneEntries, removeEntry, useEntries, type Entry } from './notify'
import { setNotifyPrefs, setOn, sourceOf, useNotifyPrefs } from './notifyPrefs'
import { useWM, type AppId } from './wm'
import { openAlert, useAlerts } from './alerts'

/**
 * The notification center: a bell in the top bar with the unread count, and a list of what came
 * in on this device, newest first and by day. Opening one does what its pop-up did; the list
 * forgets them after the time set in Settings → Notifications.
 */
export function NotificationCenter() {
  const wm = useWM()
  const entries = useEntries()
  const prefs = useNotifyPrefs()
  const alerts = useAlerts()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // What needs you counts until it is dealt with (src/os/alerts.ts), on top of what is unread.
  const unread = entries.filter((e) => !e.read).length + alerts.length

  useEffect(() => {
    if (!open) return
    pruneEntries()
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.('.ctx-menu') && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    // What was on show counts as read once the list closes again (so it stands out while open).
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      markAllRead()
    }
  }, [open])

  const settings = () => (setOpen(false), wm.open('settings', { section: 'notifications', t: String(Date.now()) }))
  const kindLabel = (e: Entry) => {
    const s = sourceOf(e.source)
    const kind = s?.kinds.find((k) => `${s.app}.${k.id}` === e.source)
    return s && kind ? (s.kinds.length > 1 ? `${s.label}: ${kind.label}` : s.label) : null
  }
  const entryMenu = (e: Entry): MenuItem[] => [
    ...(e.action ? [{ label: 'Open', onSelect: () => (setOpen(false), openEntry(e)) }] : []),
    { label: 'Remove', onSelect: () => removeEntry(e.id) },
    { separator: true },
    ...(e.source && kindLabel(e) ? [{ label: `Turn off ${kindLabel(e)}`, onSelect: () => setOn(e.source!, false) }] : []),
    { label: 'Notification settings…', onSelect: settings },
  ]
  const barMenu = (): MenuItem[] => [
    { label: 'Pop-ups', checked: prefs.popups, onSelect: () => setNotifyPrefs({ popups: !prefs.popups }) },
    { label: 'Mark all as read', disabled: !unread, onSelect: markAllRead },
    { label: 'Clear all', disabled: !entries.length, danger: true, onSelect: clearEntries },
    { separator: true },
    { label: 'Notification settings…', onSelect: settings },
  ]

  return (
    <div className="tb-pop nc" ref={ref}>
      <button
        className={`tb-icon ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(e) => openContextMenu(e, barMenu())}
        title={`Notifications${unread ? ` · ${unread} new` : ''}${prefs.popups ? '' : ' · pop-ups off'}`}
        aria-label={`Notifications${unread ? `, ${unread} new` : ''}`}
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" />
          <path d="M10 21h4" />
          {!prefs.popups && <path d="M3 3l18 18" />}
        </svg>
        {unread > 0 && <span className="nc-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="tb-panel nc-panel" role="dialog" aria-label="Notifications">
          <div className="nc-head">
            <strong>Notifications</strong>
            <button className={`nc-dnd ${prefs.popups ? '' : 'is-on'}`} onClick={() => setNotifyPrefs({ popups: !prefs.popups })} title={prefs.popups ? 'Hold back pop-ups; they still collect here' : 'Show pop-ups again'}>
              {prefs.popups ? 'Do not disturb' : 'Do not disturb: on'}
            </button>
            <button className="nc-link" onClick={clearEntries} disabled={!entries.length}>
              Clear all
            </button>
          </div>
          {/* Not notifications that come and go: they stay until dealt with, and cannot be cleared. */}
          {alerts.length > 0 && (
            <section className="nc-attention">
              <h4 className="nc-day">Needs attention</h4>
              {alerts.map((a) => (
                <div key={a.id} className="nc-item is-unread is-alert">
                  <button className="nc-main" onClick={() => (setOpen(false), openAlert(a))}>
                    <span className="nc-icon nc-glyph nc-alert-glyph" aria-hidden>
                      !
                    </span>
                    <span className="nc-text">
                      <strong>{a.title}</strong>
                      <span className="muted">{a.body}</span>
                    </span>
                  </button>
                </div>
              ))}
            </section>
          )}
          {entries.length ? (
            <div className="nc-list">
              {byDay(entries).map(([day, list]) => (
                <section key={day}>
                  <h4 className="nc-day">{day}</h4>
                  {list.map((e) => (
                    <div key={e.id} className={`nc-item ${e.read ? '' : 'is-unread'}`} onContextMenu={(ev) => (ev.stopPropagation(), openContextMenu(ev, entryMenu(e)))}>
                      <button className="nc-main" onClick={() => (e.action && setOpen(false), openEntry(e))} disabled={!e.action && e.read}>
                        <EntryIcon e={e} />
                        <span className="nc-text">
                          <strong>{e.title}</strong>
                          {e.body && <span className="muted">{e.body}</span>}
                          <span className="nc-meta">
                            {timeAgo(new Date(e.at).toISOString())}
                            {kindLabel(e) && ` · ${kindLabel(e)}`}
                          </span>
                        </span>
                      </button>
                      <button className="nc-remove" onClick={() => removeEntry(e.id)} aria-label="Remove" title="Remove">
                        ×
                      </button>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          ) : alerts.length ? null : (
            <p className="nc-empty muted">Nothing here. Notifications stay here for {keepText(prefs.keep)}.</p>
          )}
          <button className="nc-foot" onClick={settings}>
            Notification settings…
          </button>
        </div>
      )}
    </div>
  )
}

function EntryIcon({ e }: { e: Entry }) {
  const app = sourceOf(e.source)?.icon
  if (e.icon) return <img className="nc-icon" src={e.icon} alt="" width={28} height={28} />
  if (app) return <AppIcon app={app as AppId} size={28} />
  return (
    <span className="nc-icon nc-glyph" aria-hidden>
      M
    </span>
  )
}

const keepText = (k: string) => ({ '1h': 'an hour', '1d': 'a day', '1w': 'a week', '30d': '30 days', forever: 'until you clear them' })[k] ?? 'a week'

/** Today, Yesterday, then dates. */
function byDay(list: Entry[]): [string, Entry[]][] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const label = (at: number) => {
    const d = new Date(at)
    d.setHours(0, 0, 0, 0)
    const days = Math.round((today.getTime() - d.getTime()) / 864e5)
    return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
  }
  const out: [string, Entry[]][] = []
  for (const e of list) {
    const day = label(e.at)
    const last = out[out.length - 1]
    if (last?.[0] === day) last[1].push(e)
    else out.push([day, [e]])
  }
  return out
}
