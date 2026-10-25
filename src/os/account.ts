import { useSyncExternalStore } from 'react'
import { cvMode } from './cvMode'
import { playMode } from './playMode'
import { loginCookie, setLoginCookie } from './identity'
import { accountGuard, clearAccountSpace, cookieUid, freezeAccount, TAB_ACCOUNT, TAB_UID } from './accountSpace'
import type { OrgsResponse } from '../data/code'

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
  /** `openai`: signed in with ChatGPT or an OpenAI API key, so Agents can run on OpenAI's models */
  integrations: { updown: 'settings' | 'server' | null; ollama: 'settings' | 'server' | null; openai?: boolean }
  seafile: SeafileInfo | null
}

let account: Account = { status: 'loading', user: null, registration: null, forges: [], googleEnabled: false, google: null, caldav: [], integrations: { updown: null, ollama: null }, seafile: null }
const listeners = new Set<() => void>()

/**
 * Clears this tab's account from the browser (signing out, or the account deleted): its space in
 * localStorage (src/os/accountSpace.ts) goes, and its push messages stop arriving here. Nothing of
 * this tab writes the account's state back meanwhile: it is frozen first.
 */
async function forgetBrowserAccount() {
  freezeAccount(false)
  window.dispatchEvent(new Event('mvlos:forget'))
  clearAccountSpace()
  try {
    const sub = await (await navigator.serviceWorker?.getRegistration())?.pushManager?.getSubscription()
    await sub?.unsubscribe()
  } catch {
    /* no push here */
  }
  // Anything else that wrote meanwhile goes too.
  clearAccountSpace()
}

function set(next: Account) {
  account = next
  listeners.forEach((l) => l())
}

/** Signed in, or (while that is still being checked) signed in as the browser's cookie says. */
export function useLikelySignedIn() {
  const { status } = useAccount()
  if (status === 'user') return true
  if (status !== 'loading') return false
  return TAB_UID !== null
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
  // A tab of another account than the browser's now sends nothing (src/os/accountSpace.ts).
  if (!accountGuard()) throw new Error('Signed in as another account')
  const res = await fetch(path, {
    ...rest,
    credentials: 'same-origin',
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...rest.headers, 'X-MvL-Account': TAB_ACCOUNT },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body as T
}

export async function loadAccount() {
  try {
    const me = await api<{ authEnabled: boolean; registration?: Registration | null; user: AccountUser | null; forges: ForgeInfo[]; googleEnabled?: boolean; google?: { email: string; canWrite?: boolean } | null; caldav?: CaldavInfo[]; integrations?: { updown: 'settings' | 'server' | null; ollama?: 'settings' | 'server' | null; openai?: boolean }; seafile?: SeafileInfo | null }>('/api/me')
    const next: Account = { status: me.user ? 'user' : me.authEnabled ? 'anon' : 'off', user: me.user, registration: me.registration ?? null, forges: me.forges, googleEnabled: !!me.googleEnabled, google: me.google ?? null, caldav: me.caldav ?? [], integrations: { updown: me.integrations?.updown ?? null, ollama: me.integrations?.ollama ?? null, openai: !!me.integrations?.openai }, seafile: me.seafile ?? null }
    // This tab took its account from the browser's cookie as it loaded (src/os/accountSpace.ts).
    // The server says otherwise (the session ran out, or the cookie was from before it was kept):
    // its answer has put the cookie right, so start again as that account, keeping this one's
    // space as it is (its unsynced changes come back when it signs in again). Only when the cookie
    // took, or this would loop; if it didn't, sync stays off rather than use the wrong space.
    const uid = next.status === 'user' ? String(next.user!.id) : null
    if ((next.status === 'user' || next.status === 'anon') && uid !== TAB_UID) {
      if (cookieUid() === uid) {
        freezeAccount()
        return
      }
      set({ ...next, status: 'off' })
      return
    }
    // The desktop booted as someone else (src/os/identity.ts read an old or missing login cookie):
    // fix the cookie and boot again, once. Only when the cookie took, or this would loop.
    const login = next.status === 'user' ? next.user!.login : null
    let rename = false
    if ((next.status === 'user' || next.status === 'anon') && loginCookie() !== login) {
      setLoginCookie(login)
      rename = loginCookie() === login
    }
    if (rename) {
      location.reload()
      return
    }
    set(next)
  } catch {
    set({ status: 'off', user: null, registration: null, forges: [], googleEnabled: false, google: null, caldav: [], integrations: { updown: null, ollama: null }, seafile: null })
  }
}

/** Where sign-in comes back to: this page when it's the CV or a game's direct link, else the desktop (server/auth.ts). */
const back = () => (cvMode() ? '/cv' : playMode() ? location.pathname.replace(/(.)\/$/, '$1') : null)

/** Off to GitHub, and back to this page (the CV page, a game's direct link, or the desktop). */
export const signIn = () => {
  const to = back()
  location.assign(`/api/auth/github/login${to ? `?back=${encodeURIComponent(to)}` : ''}`)
}

/** Signs in again, asking GitHub for private repositories too (remembered for later sign-ins), or no longer asking. */
export const signInWithRepos = (repo: boolean) => {
  const to = back()
  location.assign(`/api/auth/github/login?repo=${repo ? 1 : 0}${to ? `&back=${encodeURIComponent(to)}` : ''}`)
}

/** Whether GitHub gave this account's token access to private repositories. */
export const hasRepoScope = (u: AccountUser | null) => !!u?.githubScopes.includes('repo')

/** Whether the token may list the account's organisations (read:org, or the broader org and user scopes). Tokens from before "Allow private" asked for it lack it. */
export const hasOrgScope = (u: AccountUser | null) => !!u?.githubScopes.some((s) => s === 'read:org' || s === 'write:org' || s === 'admin:org' || s === 'user')

/** The GitHub organisations the account belongs to and whether this site's OAuth app reaches their repositories (Settings → Code hosts). `fresh` loads them again. */
export const orgAccess = (fresh = false) => api<OrgsResponse>(`/api/code/orgs${fresh ? '?fresh=1' : ''}`)

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
