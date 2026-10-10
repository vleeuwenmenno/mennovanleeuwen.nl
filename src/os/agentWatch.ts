import { getThread, listThreads, type Thread } from '../data/agents'
import { subscribeAccount, signedIn } from './account'
import { notify } from './notify'

// Agents threads answering in the background (the window closed, another thread on screen, the
// tab hidden): watched from here, outside any window, and announced when their answer is in. The
// desktop gets one of its own notifications; while the tab is hidden or the window behind other
// apps, the browser (or the installed app) gets a system notification too, when allowed.
//
// The turn itself runs on the server and goes on without any page: a tab opened again later finds
// the threads still answering here (start()) and keeps watching them.

const POLL_MS = 4000
const watched = new Map<string, string>() // id → title
let timer: ReturnType<typeof setTimeout> | null = null
/** The thread a focused Agents window shows: its answer is on screen, no need to announce it. */
let onScreen: string | null = null

export function setOnScreen(id: string | null) {
  onScreen = id
}

/** Watches these threads (the ones running) until they finish. */
export function watchThreads(threads: Pick<Thread, 'id' | 'title' | 'running'>[]) {
  for (const t of threads) if (t.running) watched.set(t.id, t.title)
  if (watched.size && !timer) timer = setTimeout(poll, POLL_MS)
}

async function poll() {
  timer = null
  if (!signedIn()) return void watched.clear()
  await Promise.all(
    [...watched].map(async ([id, title]) => {
      const r = await getThread(id).catch((e: Error) => (/no such thread/i.test(e.message) ? null : undefined))
      if (r === undefined) return // the network: try again next time
      if (r === null) return void watched.delete(id) // deleted
      if (r.thread.running) return void watched.set(id, r.thread.title)
      watched.delete(id)
      const answer = [...r.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content ?? ''
      announce(id, r.thread.title || title, answer)
    }),
  )
  if (watched.size) timer = setTimeout(poll, POLL_MS)
}

const openThread = (id: string) => window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'agents', props: { thread: id, t: String(Date.now()) } } }))

/** One line of the answer, without Markdown's marks. */
const firstLine = (s: string) =>
  s
    .replace(/[#*_`>[\]]/g, '')
    .replace(/\(https?:[^)]*\)/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 140) ?? 'The answer is in.'

function announce(id: string, title: string, answer: string) {
  const away = document.visibilityState !== 'visible' || !document.hasFocus()
  if (!away && onScreen === id) return
  const body = firstLine(answer)
  // Sticky while away, so it is still there when coming back to the tab.
  notify({ title: `Agents answered: ${title}`, body, sticky: away, source: 'agents.answer', action: { app: 'agents', props: { thread: id } } })
  if (away) void systemNotification(id, `Agents answered: ${title}`, body)
}

/** The browser's own notification, through the service worker when there is one (installed apps need that). */
async function systemNotification(id: string, title: string, body: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const options: NotificationOptions = { body, tag: `agents-${id}`, icon: '/icons/app-192.png', data: { thread: id } }
  const reg = navigator.serviceWorker?.controller ? await navigator.serviceWorker.ready.catch(() => null) : null
  if (reg) return void reg.showNotification(title, options).catch(() => {})
  const n = new Notification(title, options)
  n.onclick = () => {
    window.focus()
    openThread(id)
    n.close()
  }
}

/** Whether system notifications can be asked for, are allowed, or were refused in the browser. */
export const notificationState = (): NotificationPermission | 'unsupported' => ('Notification' in window ? Notification.permission : 'unsupported')

/** Asks the browser once (it only shows its prompt after a click). */
export async function allowNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (!('Notification' in window)) return 'unsupported'
  if (Notification.permission !== 'default') return Notification.permission
  return Notification.requestPermission().catch(() => Notification.permission)
}

let started = false

/** Called when the desktop is up: picks up threads that were answering when this tab opened. */
export function startAgentWatch() {
  if (started) return
  started = true
  // A notification clicked while the tab was in the background: the service worker passes it on.
  navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
    const thread = (e.data as { openThread?: unknown } | null)?.openThread
    if (typeof thread === 'string') openThread(thread)
  })
  let checked = false
  const check = () => {
    if (checked || !signedIn()) return
    checked = true
    listThreads(false).then(watchThreads, () => {})
  }
  check()
  subscribeAccount(check)
}
