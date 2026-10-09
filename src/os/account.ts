import { useSyncExternalStore } from 'react'

// Who is signed in (GitHub, see server/auth.ts) and which Gitea/Forgejo instances they linked.
// Visitors are "anon"; "off" means this server has no sign-in configured (or no server at all,
// on a static host).

export type ForgeInfo = { id: number; label: string; baseUrl: string; username: string }
export type CaldavInfo = { id: number; label: string; url: string; username: string }
export type AccountUser = { login: string; name: string | null; avatar: string | null }
export type Account = {
  status: 'loading' | 'off' | 'anon' | 'user'
  user: AccountUser | null
  forges: ForgeInfo[]
  /** Whether this server can link Google Calendar, and the linked account if any */
  googleEnabled: boolean
  google: { email: string; canWrite?: boolean } | null
  /** CalDAV accounts (Fastmail, Nextcloud...) for calendars */
  caldav: CaldavInfo[]
  /** Third-party services with a key on the server: updown.io's saved in Settings, set on the server, or none */
  integrations: { updown: 'settings' | 'server' | null }
}

let account: Account = { status: 'loading', user: null, forges: [], googleEnabled: false, google: null, caldav: [], integrations: { updown: null } }
const listeners = new Set<() => void>()

const OWNER_HINT = 'mvlos.owner'

function set(next: Account) {
  account = next
  // Remembered so the next visit knows before /api/me answers (the boot is quicker for the owner).
  try {
    if (next.status === 'user') localStorage.setItem(OWNER_HINT, '1')
    else if (next.status === 'anon' || next.status === 'off') localStorage.removeItem(OWNER_HINT)
  } catch {
    /* no storage: the quick boot just starts once /api/me answers */
  }
  listeners.forEach((l) => l())
}

/** Signed in, or (while that is still being checked) signed in on the last visit. */
export function useLikelyOwner() {
  const { status } = useAccount()
  if (status === 'user') return true
  if (status !== 'loading') return false
  try {
    return localStorage.getItem(OWNER_HINT) === '1'
  } catch {
    return false
  }
}

export const getAccount = () => account
export const signedIn = () => account.status === 'user'

export function subscribeAccount(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useAccount() {
  return useSyncExternalStore(subscribeAccount, () => account)
}

/** JSON request to the site's own API; throws with the server's message on failure. */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  const res = await fetch(path, {
    ...rest,
    credentials: 'same-origin',
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body as T
}

export async function loadAccount() {
  try {
    const me = await api<{ authEnabled: boolean; user: AccountUser | null; forges: ForgeInfo[]; googleEnabled?: boolean; google?: { email: string; canWrite?: boolean } | null; caldav?: CaldavInfo[]; integrations?: { updown: 'settings' | 'server' | null } }>('/api/me')
    set({ status: me.user ? 'user' : me.authEnabled ? 'anon' : 'off', user: me.user, forges: me.forges, googleEnabled: !!me.googleEnabled, google: me.google ?? null, caldav: me.caldav ?? [], integrations: { updown: me.integrations?.updown ?? null } })
  } catch {
    set({ status: 'off', user: null, forges: [], googleEnabled: false, google: null, caldav: [], integrations: { updown: null } })
  }
}

export const signIn = () => location.assign('/api/auth/github/login')

export async function signOut() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
  set({ status: 'anon', user: null, forges: [], googleEnabled: account.googleEnabled, google: null, caldav: [], integrations: { updown: null } })
}

/** updown.io's read-only API key, for the Status widget: checked by the server, then stored encrypted. */
export async function setUpdownKey(key: string) {
  await api('/api/integrations/updown', { method: 'PUT', json: { key } })
  set({ ...account, integrations: { ...account.integrations, updown: 'settings' } })
}

export async function removeUpdownKey() {
  await api('/api/integrations/updown', { method: 'DELETE' })
  await loadAccount() // a key set on the server, if there is one, takes over again
}

/** Whether any calendar is connected (Google or CalDAV), for the Agenda widget and the clock. */
export const hasCalendar = (a: Account) => a.status === 'user' && (!!a.google || a.caldav.length > 0)

/** A CalDAV account: the server finds its calendars first, then stores the app password encrypted. */
export async function addCaldav(input: { url: string; username: string; password: string; label?: string }) {
  const info = await api<CaldavInfo>('/api/caldav', { method: 'POST', json: input })
  set({ ...account, caldav: [...account.caldav, info] })
}

export async function removeCaldav(id: number) {
  await api(`/api/caldav/${id}`, { method: 'DELETE' })
  set({ ...account, caldav: account.caldav.filter((c) => c.id !== id) })
}

/** Google Calendar, attached to the signed-in owner: off to Google's consent page and back. */
export const connectGoogle = () => location.assign('/api/google/connect')

export async function disconnectGoogle() {
  await api('/api/google', { method: 'DELETE' })
  set({ ...account, google: null })
}

export async function linkForge(input: { baseUrl: string; token: string; label?: string }) {
  const forge = await api<ForgeInfo>('/api/forges', { method: 'POST', json: input })
  set({ ...account, forges: [...account.forges.filter((f) => f.id !== forge.id), forge] })
  return forge
}

export async function unlinkForge(id: number) {
  await api(`/api/forges/${id}`, { method: 'DELETE' })
  set({ ...account, forges: account.forges.filter((f) => f.id !== id) })
}
