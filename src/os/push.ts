import { api, getAccount, signedIn, subscribeAccount } from './account'
import { accountStorage } from './accountSpace'

// Web Push on this device (server/webpush.ts): Agents answers and questions arrive as system
// notifications even when MvL OS is closed. It needs the service worker (production builds) and,
// on iPhone and iPad, MvL OS added to the Home Screen and opened from there (iOS 16.4 and later).

const FLAG = 'mvlos.push'

export type PushState = 'on' | 'off' | 'denied' | 'install' | 'unsupported'

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const installed = () => matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

/** The service worker, when there is one (none in development, or where it was blocked). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  return (await navigator.serviceWorker.getRegistration().catch(() => undefined)) ?? null
}

/** Whether push is on here, could be, or why not. */
export async function pushState(): Promise<PushState> {
  if (!('PushManager' in window) || !('Notification' in window)) return isIos() && !installed() ? 'install' : 'unsupported'
  const reg = await registration()
  if (!reg) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return (await reg.pushManager.getSubscription()) && Notification.permission === 'granted' ? 'on' : 'off'
}

const keyBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
/** A name to tell devices apart, from the browser. */
const deviceName = () => `${isIos() ? 'iOS' : /Android/.test(navigator.userAgent) ? 'Android' : navigator.platform || 'Browser'}${installed() ? ' app' : ''}`

/**
 * Why the browser could not subscribe, in words to act on. "Registration failed - push service
 * error" (an AbortError) is Chromium failing to reach its push service: Brave has it off until
 * its "Use Google services for push messaging" setting is on, and Chromium builds without
 * Google's services (ungoogled-chromium and the like) have none at all.
 */
async function whyNoPush(e: Error): Promise<string> {
  if (e.name !== 'AbortError' && !/push service/i.test(e.message)) return e.message
  const brave = (navigator as Navigator & { brave?: { isBrave: () => Promise<boolean> } }).brave
  if (brave && (await brave.isBrave().catch(() => false)))
    return 'Brave has push turned off: open brave://settings/privacy, turn on "Use Google services for push messaging", restart Brave and try again'
  return "This browser could not reach its push service (Chromium builds without Google's services have none). Chrome, Edge, Firefox and the installed phone app can"
}

/** Subscribes this browser and tells the server (again). */
async function register(reg: ServiceWorkerRegistration) {
  const { publicKey } = await api<{ publicKey: string }>('/api/push/key')
  let sub = await reg.pushManager.getSubscription()
  // Made with another server key (the server's keys were replaced): start again.
  const current = sub?.options.applicationServerKey ? btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null
  if (sub && current && current !== publicKey) {
    await sub.unsubscribe().catch(() => {})
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }).catch(async (e: Error) => {
    throw new Error(await whyNoPush(e))
  })
  await api('/api/push/subscription', { method: 'POST', json: { subscription: sub.toJSON(), device: deviceName() } })
}

/** Turns push on: asks for permission (call it from a click), subscribes, tells the server. */
export async function enablePush(): Promise<PushState> {
  const reg = await registration()
  if (!reg || !('PushManager' in window)) return pushState()
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (permission !== 'granted') return pushState()
  await register(reg)
  try {
    accountStorage.set(FLAG, 'on')
  } catch {
    /* only the refresh on the next visit needs it */
  }
  return 'on'
}

export async function disablePush(): Promise<PushState> {
  try {
    accountStorage.remove(FLAG)
  } catch {
    /* nothing to forget */
  }
  const sub = await (await registration())?.pushManager.getSubscription()
  if (sub) {
    await api('/api/push/subscription', { method: 'DELETE', json: { endpoint: sub.endpoint } }).catch(() => {})
    await sub.unsubscribe().catch(() => {})
  }
  return pushState()
}

export const sendTestPush = () => api<{ sent: number; failed: number }>('/api/push/test', { method: 'POST', json: {} })

let started = false

/** Once signed in: the subscription is sent again on every visit, so the server always has it. */
export function startPush() {
  if (started) return
  started = true
  const refresh = async () => {
    const status = getAccount().status
    if (status !== 'user' && status !== 'anon') return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    let on = false
    try {
      on = signedIn() && accountStorage.get(FLAG) === 'on'
    } catch {
      /* treated as off */
    }
    const reg = await registration()
    if (!reg || !('PushManager' in window)) return
    if (on) return void (await register(reg).catch(() => {}))
    // A browser has one subscription. Push is off for whoever is here now (a visitor, or an account
    // that didn't turn it on in this browser): one still here is another account's (signed out, or
    // another tab signed in as someone else), and its messages must stop arriving here.
    const sub = await reg.pushManager.getSubscription().catch(() => null)
    await sub?.unsubscribe().catch(() => {})
  }
  void refresh()
  subscribeAccount(() => void refresh())
}
