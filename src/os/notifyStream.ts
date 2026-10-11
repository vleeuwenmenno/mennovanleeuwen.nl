import { signedIn, subscribeAccount } from './account'
import { applyChange, receive, setAccountList } from './notify'
import { calendarChangedElsewhere } from '../data/calendar'

// The live line to the server's notification hub (server/notifier.ts) while signed in: new
// notifications for the account (a pop-up when this page is in view), and other pages reading or
// clearing them. The page also tells the hub whether it is in view, with a heartbeat: when no page
// is, the hub pushes to the account's devices instead (server/webpush.ts).

const PAGE = crypto.randomUUID()
const HEARTBEAT_MS = 30_000
let stream: EventSource | null = null
let beat: ReturnType<typeof setInterval> | null = null

const inView = () => document.visibilityState === 'visible'

/** Whether this page is in view. keepalive, so going out of view still arrives as the page sleeps. */
function presence() {
  if (!stream) return
  void fetch('/api/notifications/presence', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: PAGE, visible: inView() }) }).catch(() => {})
}
const onVisibility = () => presence()

function connect() {
  if (stream) return
  stream = new EventSource(`/api/notifications/stream?page=${PAGE}`, { withCredentials: true })
  // Each (re)connection: the list again, for anything missed while away, and where this page stands.
  stream.addEventListener('hello', () => {
    void setAccountList(true)
    presence()
  })
  stream.addEventListener('notice', (e) => {
    const { entry, popup } = JSON.parse((e as MessageEvent).data)
    receive(entry, popup)
  })
  for (const kind of ['read', 'remove', 'clear'] as const) stream.addEventListener(kind, (e) => applyChange(kind, JSON.parse((e as MessageEvent).data)))
  // An event added, changed or deleted anywhere (an agent did it, or another device): views of
  // the calendar fetch again.
  stream.addEventListener('calendar', () => calendarChangedElsewhere())
  document.addEventListener('visibilitychange', onVisibility)
  beat = setInterval(() => inView() && presence(), HEARTBEAT_MS)
}

function disconnect() {
  stream?.close()
  stream = null
  if (beat) clearInterval(beat)
  beat = null
  document.removeEventListener('visibilitychange', onVisibility)
}

let started = false

/** Follows sign-in: the account's list and stream when signed in, this browser's list otherwise. */
export function startNotifyStream() {
  if (started) return
  started = true
  let was: boolean | null = null
  const sync = () => {
    const now = signedIn()
    if (now === was) return
    was = now
    if (now) connect()
    else (disconnect(), void setAccountList(false))
  }
  sync()
  subscribeAccount(sync)
}
