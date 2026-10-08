import { subscribeRecents, type Activity } from '../data/recents'
import { notify } from './notify'

// Notifications for fresh activity: anything from the last 15 minutes, as soon as the desktop is
// up (and anything newer that arrives while the page stays open). Each item notifies once per
// page load.

const FRESH_MS = 15 * 60 * 1000

const where = (a: Activity) => (a.source === 'github' ? 'GitHub' : 'git.mvl.sh')

let started = false

/** Starts watching; call when the desktop is up. */
export function startActivityAlerts() {
  if (started) return
  started = true
  const seen = new Set<string>()
  // A beat after the desktop appears, so the notification slides in rather than being there already.
  setTimeout(() => {
    subscribeRecents((s) => {
      const fresh = s.items.filter((a) => !seen.has(a.id) && Date.now() - new Date(a.date).getTime() < FRESH_MS)
      if (!fresh.length) return
      fresh.forEach((a) => seen.add(a.id))
      const open = () => window.dispatchEvent(new CustomEvent('mvlos:open', { detail: 'recents' }))
      if (fresh.length > 3) {
        notify({ title: `Menno has been busy: ${fresh.length} new updates`, body: 'Open Activity to see them', onClick: open })
        return
      }
      for (const a of fresh.reverse()) {
        notify({ title: `New on ${where(a)}: ${a.title}`, body: [a.detail, a.repo].filter(Boolean).join(' · '), onClick: open })
      }
    })
  }, 800)
}
