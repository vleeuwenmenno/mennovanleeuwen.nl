import { useSyncExternalStore } from 'react'
import { browserMountPoint, subscribeMounts } from '../data/mounts'
import { HOME } from '../terminal/vfs'
import { getAccount, subscribeAccount } from './account'
import { notify, type NoticeAction } from './notify'
import { pendingUpdate, restartIntoUpdate, subscribeUpdate } from './pwa'
import { getSyncStatus, subscribeSyncStatus } from './synced'

// Things that need you, the way macOS lists "Finish setting up" and updates at the top of System
// Settings: worked out from the state of things (never stored), and gone as soon as they are
// dealt with. Settings shows them under your name and badges the pane to go to, the dock badges
// Settings, and the notification center keeps them at the top under "Needs attention".

export type Alert = {
  id: 'storage' | 'update' | 'sync'
  title: string
  body: string
  /** The Settings pane it is about (badged in the sidebar), if any */
  pane?: 'integrations' | 'about' | 'sync'
  /** What opening it does */
  action?: NoticeAction
  run?: () => void
}

function compute(): Alert[] {
  const out: Alert[] = []
  const account = getAccount()
  // Signed in, with home kept in this browser (data/browserfs.ts): files are not safe yet.
  if (account.status === 'user' && browserMountPoint() === HOME)
    out.push({
      id: 'storage',
      title: account.seafile ? 'Use Seafile as home' : 'Set up file storage',
      body: account.seafile
        ? "Files you make are saved in this browser only. Make your Seafile library home to keep them for good."
        : "Files you make are saved in this browser only: clearing the site's data deletes them. Link Seafile to keep them for good.",
      pane: 'integrations',
      action: { app: 'settings', props: { section: 'integrations', sub: 'seafile' } },
    })
  if (pendingUpdate()) out.push({ id: 'update', title: 'MvL OS has an update', body: 'Restart into the new version.', pane: 'about', run: restartIntoUpdate })
  const sync = getSyncStatus()
  if (account.status === 'user' && sync.state === 'error')
    out.push({ id: 'sync', title: 'Sync is failing', body: sync.error ? `Changes stay in this browser until it works again: ${sync.error}` : 'Changes stay in this browser until it works again.', pane: 'sync', action: { app: 'settings', props: { section: 'sync' } } })
  return out
}

let alerts: Alert[] = []
const listeners = new Set<() => void>()
let wired = false

function refresh() {
  const next = compute()
  if (JSON.stringify(next.map((a) => [a.id, a.title, a.body])) === JSON.stringify(alerts.map((a) => [a.id, a.title, a.body]))) return
  const before = new Set(alerts.map((a) => a.id))
  alerts = next
  listeners.forEach((l) => l())
  // A new one pops up once per visit (the update brings its own pop-up, src/os/pwa.ts).
  for (const a of next) if (!before.has(a.id) && a.id === 'storage') announce(a)
}

const announced = new Set<string>()
function announce(a: Alert) {
  if (announced.has(a.id)) return
  announced.add(a.id)
  // A beat after the desktop comes up, so it slides in rather than being there already.
  setTimeout(() => {
    if (alerts.some((x) => x.id === a.id)) notify({ title: a.title, body: a.body, action: a.action, source: 'system.storage', transient: true })
  }, 2500)
}

function wire() {
  if (wired) return
  wired = true
  subscribeAccount(refresh)
  subscribeMounts(refresh)
  subscribeUpdate(refresh)
  subscribeSyncStatus(refresh)
  alerts = compute()
}

/** Starts watching; call once the desktop is up. */
export function startAlerts() {
  wire()
  for (const a of alerts) if (a.id === 'storage') announce(a)
}

export const getAlerts = () => (wire(), alerts)
export const useAlerts = () =>
  useSyncExternalStore(
    (l) => {
      wire()
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => (wire(), alerts),
  )

/** Opens what an alert is about. */
export function openAlert(a: Alert) {
  if (a.run) a.run()
  else if (a.action) window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: a.action.app, props: { ...a.action.props, t: String(Date.now()) } } }))
}
