import { subscribeRecents, type Activity } from '../data/recents'
import { notify } from './notify'

// Notifications for fresh activity: anything from the last 15 minutes, once the desktop has been
// up for 15 seconds (so they don't pile onto the boot). Each item notifies once per browser tab.

const FRESH_MS = 15 * 60 * 1000
const SEEN_KEY = 'mvlos.activity.notified'

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]'))
  } catch {
    return new Set()
  }
}

const where = (a: Activity) => (a.source === 'github' ? 'GitHub' : 'git.mvl.sh')

let started = false

/** Starts watching; call when the desktop is up. */
export function startActivityAlerts() {
  if (started) return
  started = true
  const seen = loadSeen()
  setTimeout(() => {
    subscribeRecents((s) => {
      const fresh = s.items.filter((a) => !seen.has(a.id) && Date.now() - new Date(a.date).getTime() < FRESH_MS)
      if (!fresh.length) return
      fresh.forEach((a) => seen.add(a.id))
      try {
        sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)))
      } catch {
        /* may notify again after a reload */
      }
      const open = () => window.dispatchEvent(new CustomEvent('mvlos:open', { detail: 'recents' }))
      if (fresh.length > 3) {
        notify({ title: `Menno has been busy: ${fresh.length} new updates`, body: 'Open Activity to see them', onClick: open })
        return
      }
      for (const a of fresh.reverse()) {
        notify({ title: `New on ${where(a)}: ${a.title}`, body: [a.detail, a.repo].filter(Boolean).join(' · '), onClick: open })
      }
    })
  }, 15_000)
}
