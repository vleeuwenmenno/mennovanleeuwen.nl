import { useSyncExternalStore } from 'react'
import { cvMode } from './cvMode'
import { loginCookie, setLoginCookie } from './identity'

// Who is signed in (GitHub, see server/auth.ts) and which Gitea/Forgejo instances they linked.
// Visitors are "anon"; "off" means this server has no sign-in configured (or no server at all,
// on a static host).

export type ForgeInfo = { id: number; label: string; baseUrl: string; username: string }
export type CaldavInfo = { id: number; label: string; url: string; username: string }
/** The linked Seafile account (one), and the OnlyOffice server it uses if added. Never the token or secret. */
export type SeafileInfo = { url: string; username: string; name: string | null; version: string | null; office: { url: string } | null }
export type AccountUser = { id: number; login: string; name: string | null; avatar: string | null; admin: boolean; githubScopes: string[] }
/** Whether a new GitHub account could sign up now (null: sign-in is off). */
export type Registration = { open: boolean; full: boolean }
export type Account = {
  status: 'loading' | 'off' | 'anon' | 'user'
  user: AccountUser | null
  registration: Registration | null
  forges: ForgeInfo[]
  /** Whether this server can link Google Calendar, and the linked account if any */
  googleEnabled: boolean
  google: { email: string; canWrite?: boolean } | null
  /** CalDAV accounts (Fastmail, Nextcloud...) for calendars */
  caldav: CaldavInfo[]
  /** Third-party services with a key on the server: saved in Settings, set on the server, or none */
  integrations: { updown: 'settings' | 'server' | null; ollama: 'settings' | 'server' | null }
  seafile: SeafileInfo | null
}

let account: Account = { status: 'loading', user: null, registration: null, forges: [], googleEnabled: false, google: null, caldav: [], integrations: { updown: null, ollama: null }, seafile: null }
const listeners = new Set<() => void>()

/** Whose saved state this browser holds: their user id, so another account never inherits it. */
const ACCOUNT_KEY = 'mvlos.account'
/** The older "the owner was signed in here" flag, from before anyone could sign up. */
const LEGACY_HINT = 'mvlos.owner'
/**
 * What belongs to whoever is signed in rather than to this device: their synced state, the
 * notification history, terminal history, Files' places, the Agents window layout and push.
 * Themes, games and the like stay.
 */
const PER_ACCOUNT = [/^mvlos\.sync\./, /^mvlos\.notify\.history$/, /^mvlos\.history$/, /^mvlos\.files\.v1$/, /^mvlos\.desktop\.v1$/, /^mvlos\.dock\.v1$/, /^mvlos\.agents\./, /^mvlos\.push$/, /^mvlos\.browser\./]

function storedAccount(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_KEY) ?? (localStorage.getItem(LEGACY_HINT) ? 'legacy' : null)
  } catch {
    return null
  }
}

/** Clears what the last account left in this browser, and stops its push messages arriving here. */
async function forgetBrowserAccount() {
  // First: synced stores stop saving (src/os/synced.ts), so nothing writes the old state back
  // between here and the page starting again.
  window.dispatchEvent(new Event('mvlos:forget'))
  const clear = () => {
    try {
      for (const k of Object.keys(localStorage)) if (PER_ACCOUNT.some((r) => r.test(k))) localStorage.removeItem(k)
      localStorage.removeItem(ACCOUNT_KEY)
      localStorage.removeItem(LEGACY_HINT)
    } catch {
      /* no storage: nothing was kept either */
    }
  }
  clear()
  try {
    const sub = await (await navigator.serviceWorker?.getRegistration())?.pushManager?.getSubscription()
    await sub?.unsubscribe()
  } catch {
    /* no push here */
  }
  // Anything else that wrote meanwhile (the notification history, say) goes too.
  clear()
}

/**
 * Whether this browser holds another account's state: someone else signed in, or the last
 * account's session ran out and a guest is here now. A browser from before sign-up was open
 * (LEGACY_HINT) belongs to whoever signs in first.
 */
function heldByAnother(next: Account): boolean {
  if (next.status !== 'user' && next.status !== 'anon') return false // unknown (offline, no sign-in): leave it
  const was = storedAccount()
  if (!was) return false
  if (was === 'legacy') return next.status === 'anon'
  return was !== String(next.user?.id ?? '')
}

function set(next: Account) {
  account = next
  // Remembered so the next visit knows who this browser's state belongs to (and boots quicker).
  try {
    if (next.status === 'user') {
      localStorage.setItem(ACCOUNT_KEY, String(next.user!.id))
      localStorage.removeItem(LEGACY_HINT)
    } else if (next.status === 'anon') localStorage.removeItem(ACCOUNT_KEY)
  } catch {
    /* no storage: the quick boot just starts once /api/me answers */
  }
  listeners.forEach((l) => l())
}

/** Signed in, or (while that is still being checked) signed in on the last visit. */
export function useLikelySignedIn() {
  const { status } = useAccount()
  if (status === 'user') return true
  if (status !== 'loading') return false
  try {
    return !!storedAccount()
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
    const me = await api<{ authEnabled: boolean; registration?: Registration | null; user: AccountUser | null; forges: ForgeInfo[]; googleEnabled?: boolean; google?: { email: string; canWrite?: boolean } | null; caldav?: CaldavInfo[]; integrations?: { updown: 'settings' | 'server' | null; ollama?: 'settings' | 'server' | null }; seafile?: SeafileInfo | null }>('/api/me')
    const next: Account = { status: me.user ? 'user' : me.authEnabled ? 'anon' : 'off', user: me.user, registration: me.registration ?? null, forges: me.forges, googleEnabled: !!me.googleEnabled, google: me.google ?? null, caldav: me.caldav ?? [], integrations: { updown: me.integrations?.updown ?? null, ollama: me.integrations?.ollama ?? null }, seafile: me.seafile ?? null }
    // Another account's notes, history and layouts are still here: clear them and start clean.
    const stale = heldByAnother(next)
    if (stale) await forgetBrowserAccount()
    // The desktop booted as someone else (src/os/identity.ts read an old or missing login cookie):
    // fix the cookie and boot again, once. Only when the cookie took, or this would loop.
    const login = next.status === 'user' ? next.user!.login : null
    let rename = false
    if ((next.status === 'user' || next.status === 'anon') && loginCookie() !== login) {
      setLoginCookie(login)
      rename = loginCookie() === login
    }
    if (stale || rename) {
      location.reload()
      return
    }
    set(next)
  } catch {
    set({ status: 'off', user: null, registration: null, forges: [], googleEnabled: false, google: null, caldav: [], integrations: { updown: null, ollama: null }, seafile: null })
  }
}

/** Off to GitHub, and back to this page (the CV page, or the desktop). */
export const signIn = () => location.assign(`/api/auth/github/login${cvMode() ? '?back=/cv' : ''}`)

/** Signs in again, asking GitHub for private repositories too (remembered for later sign-ins), or no longer asking. */
export const signInWithRepos = (repo: boolean) => location.assign(`/api/auth/github/login?repo=${repo ? 1 : 0}${cvMode() ? '&back=/cv' : ''}`)

/** Whether GitHub gave this account's token access to private repositories. */
export const hasRepoScope = (u: AccountUser | null) => !!u?.githubScopes.includes('repo')

export async function signOut() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
  await forgetBrowserAccount()
  setLoginCookie(null)
  set({ status: 'anon', user: null, registration: account.registration, forges: [], googleEnabled: account.googleEnabled, google: null, caldav: [], integrations: { updown: null, ollama: null }, seafile: null })
  // The terminal, home folder and boot screen were that account's (src/os/identity.ts): start again as a guest.
  location.reload()
}

/** Deletes the account and everything the server keeps for it, then forgets it in this browser too. */
export async function deleteAccount() {
  await api('/api/me', { method: 'DELETE' })
  await forgetBrowserAccount()
  setLoginCookie(null)
  set({ status: 'anon', user: null, registration: account.registration, forges: [], googleEnabled: account.googleEnabled, google: null, caldav: [], integrations: { updown: null, ollama: null }, seafile: null })
  // The terminal, home folder and boot screen were that account's (src/os/identity.ts): start again as a guest.
  location.reload()
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

/** Ollama Cloud's API key, for the Agents app: checked by the server, then stored encrypted. */
export async function setOllamaKey(key: string) {
  await api('/api/integrations/ollama', { method: 'PUT', json: { key } })
  set({ ...account, integrations: { ...account.integrations, ollama: 'settings' } })
}

export async function removeOllamaKey() {
  await api('/api/integrations/ollama', { method: 'DELETE' })
  await loadAccount()
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

/** Google Calendar, attached to the signed-in user: off to Google's consent page and back. */
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

/**
 * Links Seafile: the server signs in for a token and keeps only that. Resolves 'otp' when the
 * account has two-factor sign-in on: ask for a code and call again with it.
 */
export async function linkSeafile(input: { url: string; username: string; password: string; otp?: string }): Promise<'linked' | 'otp'> {
  const info = await api<SeafileInfo | { otp: true }>('/api/integrations/seafile', { method: 'POST', json: input })
  if ('otp' in info) return 'otp'
  set({ ...account, seafile: info })
  return 'linked'
}

export async function unlinkSeafile() {
  await api('/api/integrations/seafile', { method: 'DELETE' })
  set({ ...account, seafile: null })
}

/** The OnlyOffice document server Seafile uses: its URL and JWT secret, checked and stored encrypted. */
export async function setOffice(input: { url: string; secret: string }) {
  set({ ...account, seafile: await api<SeafileInfo>('/api/integrations/onlyoffice', { method: 'PUT', json: input }) })
}

export async function removeOffice() {
  set({ ...account, seafile: await api<SeafileInfo>('/api/integrations/onlyoffice', { method: 'DELETE' }) })
}
