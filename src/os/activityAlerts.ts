import { subscribeRecents, type Activity } from '../data/recents'
import { notify } from './notify'
import { ACTIVITY_KIND, activityWindowMs, notifyPrefs, sourceOn, type SourceId } from './notifyPrefs'

// Notifications for fresh activity: anything newer than the cutoff in Settings → Notifications
// (15 minutes unless changed), as soon as the desktop is up, and anything newer that arrives while
// the page stays open. Each item notifies once on this device, also across reloads, and only for
// the kinds of activity Settings leaves on.

const where = (a: Activity) => (a.source === 'github' ? 'GitHub' : 'git.mvl.sh')
const sourceId = (a: Activity): SourceId => `activity.${ACTIVITY_KIND[a.kind] ?? a.kind}`

let started = false

/** Starts watching; call when the desktop is up. */
export function startActivityAlerts() {
  if (started) return
  started = true
  const seen = new Set<string>()
  // A beat after the desktop appears, so the notification slides in rather than being there already.
  setTimeout(() => {
    subscribeRecents((s) => {
      const cutoff = Date.now() - activityWindowMs(notifyPrefs().activityWindow)
      const fresh = s.items.filter((a) => !seen.has(a.id) && new Date(a.date).getTime() > cutoff)
      fresh.forEach((a) => seen.add(a.id))
      const shown = fresh.filter((a) => sourceOn(sourceId(a)))
      if (!shown.length) return
      const action = { app: 'recents' as const }
      if (shown.length > 3) {
        const ids = shown.map((a) => a.id).sort().join(',')
        notify({ title: `Menno has been busy: ${shown.length} new updates`, body: 'Open Activity to see them', source: sourceId(shown[0]), action, once: `activity:${ids}` })
        return
      }
      for (const a of shown.reverse()) {
        notify({ title: `New on ${where(a)}: ${a.title}`, body: [a.detail, a.repo].filter(Boolean).join(' · '), source: sourceId(a), action, once: `activity:${a.id}` })
      }
    })
  }, 800)
}
