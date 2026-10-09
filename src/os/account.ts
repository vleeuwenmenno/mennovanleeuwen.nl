import { useSyncExternalStore } from 'react'

// Who is signed in (GitHub, see server/auth.ts) and which Gitea/Forgejo instances they linked.
// Visitors are "anon"; "off" means this server has no sign-in configured (or no server at all,
// on a static host).

export type ForgeInfo = { id: number; label: string; baseUrl: string; username: string }
export type AccountUser = { login: string; name: string | null; avatar: string | null }
export type Account = { status: 'loading' | 'off' | 'anon' | 'user'; user: AccountUser | null; forges: ForgeInfo[] }

let account: Account = { status: 'loading', user: null, forges: [] }
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
    const me = await api<{ authEnabled: boolean; user: AccountUser | null; forges: ForgeInfo[] }>('/api/me')
    set({ status: me.user ? 'user' : me.authEnabled ? 'anon' : 'off', user: me.user, forges: me.forges })
  } catch {
    set({ status: 'off', user: null, forges: [] })
  }
}

export const signIn = () => location.assign('/api/auth/github/login')

export async function signOut() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
  set({ status: 'anon', user: null, forges: [] })
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
