import { enablePush } from './push'

// The page's side of system notifications. Agents answers, calendar reminders and the rest are told
// by the server's notification hub (server/notifier.ts): a pop-up while a page is in view, push
// when none is. What is left here: asking for the browser's permission, and opening what a push
// notification is about when it is clicked while this page is open.

const openThread = (id: string) => window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'agents', props: { thread: id, t: String(Date.now()) } } }))

/** Whether system notifications can be asked for, are allowed, or were refused in the browser. */
export const notificationState = (): NotificationPermission | 'unsupported' => ('Notification' in window ? Notification.permission : 'unsupported')

/** Asks the browser once (it only shows its prompt after a click), and turns push on with it. */
export async function allowNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (!('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  // Push too, where there is a service worker: then answers also arrive with MvL OS closed.
  await enablePush().catch(() => null)
  if (Notification.permission !== 'default') return Notification.permission
  return Notification.requestPermission().catch(() => Notification.permission)
}

let started = false

/** Called when the desktop is up. */
export function startAgentWatch() {
  if (started) return
  started = true
  // A notification clicked while the tab was in the background: the service worker passes on the
  // thread, or the address it would have opened (/?open=calendar), and the app opens here.
  navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { openThread?: unknown; openUrl?: unknown } | null
    if (typeof data?.openThread === 'string') return openThread(data.openThread)
    if (typeof data?.openUrl !== 'string') return
    const params = new URL(data.openUrl, location.origin).searchParams
    const app = params.get('open')
    const thread = params.get('thread')
    if (app === 'agents' && thread) openThread(thread)
    else if (app && /^[a-z]{2,20}$/.test(app)) window.dispatchEvent(new CustomEvent('mvlos:open', { detail: app }))
  })
}
