import { profile } from '../data/profile'
import { cvMode } from './cvMode'

// Who this desktop belongs to, as the terminal, the boot screen and the home folder see it: the
// signed-in GitHub login, Menno on his CV page for visitors, else "guest". Read once at load from
// the mvlos_login cookie the server sets at sign-in (server/auth.ts), so it is right before
// /api/me answers; src/os/account.ts reloads the page when the cookie turns out to be stale.

/** The login in the mvlos_login cookie, if any. */
export function loginCookie(): string | null {
  const m = /(?:^|;\s*)mvlos_login=([^;]*)/.exec(typeof document === 'undefined' ? '' : document.cookie)
  return m?.[1] ? decodeURIComponent(m[1]) : null
}

/** Sets (or with null clears) the cookie from the page, for sessions from before it existed. */
export function setLoginCookie(login: string | null) {
  const secure = location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = login ? `mvlos_login=${encodeURIComponent(login)}; Path=/; Max-Age=${30 * 86400}; SameSite=Lax${secure}` : `mvlos_login=; Path=/; Max-Age=0; SameSite=Lax${secure}`
}

/** A GitHub login as a user name: lower case, letters, digits and dashes. */
const userName = (login: string) => login.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 39) || 'user'

const login = loginCookie()

/** The user name: the signed-in login, `menno` on the CV page, else `guest`. */
export const HANDLE: string = login ? userName(login) : cvMode() ? profile.handle : 'guest'

/** Whether HANDLE is a signed-in account (and not Menno's CV persona or a guest). */
export const SIGNED_IN_HANDLE = !!login

/** Whether the desktop is Menno's own persona: his CV page, for a visitor. */
export const MENNO_PERSONA = !login && cvMode()
