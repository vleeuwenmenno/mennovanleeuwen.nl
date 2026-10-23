// Whose browser storage this tab uses, and the guard that keeps one account's state out of
// another's.
//
// Tabs of one browser share its storage and its sign-in cookie, so one tab can still hold account
// A's state while another tab signs out or in as B. The server sets a readable cookie next to the
// sign-in cookie, `mvlos_uid` (the account's id; none for a visitor; server/auth.ts), so a page
// knows at once, and in step with the sign-in cookie, which account the browser is signed in as.
//
// - Each tab takes that account as its own when it loads (TAB_UID), and keeps everything that
//   belongs to the account under a space of its own in localStorage: `mvlos.u.<id>.…`, or
//   `mvlos.visitor.…` (accountKey). A tab of A's only ever reads and writes A's space, which B's
//   pages never read.
// - accountGuard() checks the cookie still says this tab's account before every write to the
//   space and every request to the site's API (installApiGuard). When it doesn't, the tab freezes
//   (writes and sends nothing more) and reloads at once, as the account the browser has now.
// - Every API request says whose state its tab holds (`X-MvL-Account`); the server refuses one
//   that doesn't match the session (server/api.ts), and requires it where state is written.
// - The first time a space is used, what the release before spaces kept for that account in plain
//   keys moves into it, if the browser's old marker says it was this account's (and that is done
//   once: later writes to the old keys, by a tab still running the old release, are never read).
//   A visitor signing in brings their synced state along, once, into a new account space.
//
// What belongs to the browser rather than to an account (the theme, motion, sound, the dock's
// look, a game's settings, the browser's own location) stays in plain keys (src/os/localPref.ts).

const UID_COOKIE = /(?:^|;\s*)mvlos_uid=([^;]*)/

/** The account the browser's cookies are signed in as now (its id), or null for none. */
export function cookieUid(): string | null {
  if (typeof document === 'undefined') return null
  const m = UID_COOKIE.exec(document.cookie)
  const v = m?.[1] ? decodeURIComponent(m[1]) : ''
  return /^\d+$/.test(v) ? v : null
}

/** This tab's account, taken as it loads (null: a visitor). */
export const TAB_UID: string | null = cookieUid()
/** The header value saying whose state this tab holds. */
export const TAB_ACCOUNT = TAB_UID ?? 'visitor'
/** Where this tab's account keeps its things in localStorage. */
export const SPACE = TAB_UID ? `mvlos.u.${TAB_UID}.` : 'mvlos.visitor.'

/** The key in this tab's account space for an account-owned key, written as before spaces (`mvlos.history`). */
export const accountKey = (key: string) => SPACE + key.replace(/^mvlos\./, '')

let frozen = false
/** Whether this tab stopped: the browser is signed in as another account now (or this one is being cleared). */
export const accountFrozen = () => frozen

/**
 * Stops this tab: nothing more is written or sent, and (unless `reload` is false: the account is
 * being cleared by this tab, which reloads itself) the page starts again at once, as the account
 * the browser has now, so nothing of this tab's account stays on screen either.
 */
export function freezeAccount(reload = true) {
  if (frozen) return
  frozen = true
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('mvlos:account-changed'))
  if (reload)
    try {
      location.reload()
    } catch {
      /* not in a page */
    }
}

/** Whether this tab may still write its account's state and talk to the API: the cookie still says its account. */
export function accountGuard(): boolean {
  if (frozen) return false
  if (cookieUid() === TAB_UID) return true
  freezeAccount()
  return false
}

/** This tab's account space in localStorage: reads anywhere, writes only while accountGuard() holds. */
export const accountStorage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(accountKey(key))
    } catch {
      return null
    }
  },
  /** False when it wasn't written (the guard failed, or storage refused it). */
  set(key: string, value: string): boolean {
    if (!accountGuard()) return false
    try {
      localStorage.setItem(accountKey(key), value)
      return true
    } catch {
      return false
    }
  },
  remove(key: string) {
    if (!accountGuard()) return
    try {
      localStorage.removeItem(accountKey(key))
    } catch {
      /* nothing kept */
    }
  },
}

/** Whether a storage event's key is this tab's `key` (written as before spaces). */
export const isAccountKey = (storageKey: string | null, key: string) => storageKey === accountKey(key)

/** Removes this tab's whole account space (signing out: the account's state leaves this browser). */
export function clearAccountSpace() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(SPACE)) localStorage.removeItem(k)
  } catch {
    /* nothing kept */
  }
}

// ---------------------------------------------------------------------------------------------
// Moving in, once per space: the release before spaces, and a visitor signing in

/** What the release before spaces kept per account, in plain keys. */
const LEGACY = [
  /^mvlos\.sync\./,
  /^mvlos\.notify\.(history|seen)$/,
  /^mvlos\.history$/,
  /^mvlos\.files\.v1$/,
  /^mvlos\.desktop\.v1$/,
  /^mvlos\.dock\.v1$/,
  /^mvlos\.agents\./,
  /^mvlos\.push$/,
  /^mvlos\.browser\./,
  /^mvlos\.git\.lastRepo$/,
  /^mvlos\.launchers\.files$/,
]
/** The old marker of whose state the plain keys were, and the one from before sign-up was open. */
const OLD_MARKER = 'mvlos.account'
const OLDER_MARKER = 'mvlos.owner'

function moveIn() {
  if (typeof localStorage === 'undefined') return
  try {
    const flag = `${SPACE}moved`
    if (localStorage.getItem(flag)) return
    const keys = Object.keys(localStorage)
    const marker = localStorage.getItem(OLD_MARKER)
    // The plain keys were this account's (or a visitor's, for a visitor), by the old marker; the
    // older "owner" flag belonged to whoever signed in first.
    const theirs = TAB_UID ? marker === TAB_UID || (!marker && !!localStorage.getItem(OLDER_MARKER)) : !marker && !localStorage.getItem(OLDER_MARKER)
    if (theirs) {
      for (const k of keys)
        if (LEGACY.some((r) => r.test(k))) {
          const to = accountKey(k)
          const v = localStorage.getItem(k)
          if (v !== null && localStorage.getItem(to) === null) localStorage.setItem(to, v)
          localStorage.removeItem(k)
        }
      localStorage.removeItem(OLD_MARKER)
      localStorage.removeItem(OLDER_MARKER)
    }
    // A visitor signing in: what they did as a visitor (their synced state) joins the account,
    // once, as the account's space starts.
    if (TAB_UID)
      for (const k of keys)
        if (k.startsWith('mvlos.visitor.sync.')) {
          const to = SPACE + k.slice('mvlos.visitor.'.length)
          const v = localStorage.getItem(k)
          if (v !== null && localStorage.getItem(to) === null) localStorage.setItem(to, v)
          localStorage.removeItem(k)
        }
    localStorage.setItem(flag, '1')
  } catch {
    /* storage can't be used: nothing to move */
  }
}
moveIn()

// ---------------------------------------------------------------------------------------------
// The API

const isApi = (url: string | URL) => {
  try {
    const u = new URL(String(url), location.href)
    return u.origin === location.origin && u.pathname.startsWith('/api/')
  } catch {
    return false
  }
}

/**
 * Every request to the site's API from this page, by fetch or XMLHttpRequest: checked against
 * accountGuard() first (a tab of another account sends nothing: the request fails), and saying
 * whose state this tab holds (X-MvL-Account).
 */
export function installApiGuard() {
  if (typeof window === 'undefined') return
  const fetch0 = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input
    if (!isApi(url)) return fetch0(input, init)
    if (!accountGuard()) return Promise.reject(new Error('Signed in as another account'))
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set('X-MvL-Account', TAB_ACCOUNT)
    return fetch0(input, { ...init, headers })
  }
  const open0 = XMLHttpRequest.prototype.open
  const send0 = XMLHttpRequest.prototype.send
  const api = new WeakSet<XMLHttpRequest>()
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    if (isApi(url)) api.add(this)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (open0 as any).call(this, method, url, ...rest)
  } as typeof XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    if (api.has(this)) {
      if (!accountGuard()) return this.abort()
      this.setRequestHeader('X-MvL-Account', TAB_ACCOUNT)
    }
    return send0.call(this, body)
  }
}
