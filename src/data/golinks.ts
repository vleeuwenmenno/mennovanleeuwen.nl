import { synced } from '../os/synced'

// The visitor's go-links account (https://git.mvl.sh/vleeuwenmenno/golinks), for the terminal's
// `go` command. Stored as the browser-search URL golinks hands out, `https://mvl.sh/r/%s?token=…`,
// with %s where the alias goes. Kept in this browser; synced when signed in, like notes.

export const GOLINKS_HOME = 'https://mvl.sh'

const store = synced<string | null>('golinks', null, {
  normalize: (v) => (typeof v === 'string' && v.includes('%s') ? v : null),
})

export const golinksTemplate = store.get

export const setGolinks = (template: string | null) => store.set(template)

/**
 * Turns what the user pasted into a search-URL template, or null if it isn't one. Accepts the
 * template itself, a redirect URL for any alias (`…/r/gh?token=…`), a site and a token
 * (`https://go.example.com abc123`), or just a token for mvl.sh.
 */
export function parseGolinks(args: string[]): string | null {
  const [first, token] = args
  if (!first) return null
  if (!/^https?:\/\//i.test(first)) return args.length === 1 && /^[\w.~-]+$/.test(first) ? `${GOLINKS_HOME}/r/%s?token=${encodeURIComponent(first)}` : null
  let url: URL
  try {
    url = new URL(first.replace('%s', '__alias__'))
  } catch {
    return null
  }
  if (token) url.searchParams.set('token', token)
  if (!url.searchParams.get('token')) return null
  url.pathname = /\/r\/[^/]+\/?$/.test(url.pathname) ? url.pathname.replace(/\/r\/[^/]+\/?$/, '/r/__alias__') : `${url.pathname.replace(/\/+$/, '')}/r/__alias__`
  // Only the token is needed: anything else golinks put in the query is dropped.
  return `${url.origin}${url.pathname.replace('__alias__', '%s')}?token=${encodeURIComponent(url.searchParams.get('token')!)}`
}

/** Where `alias` goes, through the saved account. */
export const golinksUrl = (template: string, alias: string) => template.replace('%s', encodeURIComponent(alias))

/** The template with most of the token hidden, for printing. */
export const maskGolinks = (template: string) => template.replace(/token=([^&]{4})[^&]*/, (_, head: string) => `token=${head}…`)

/** The golinks site behind the template (its dashboard, where tokens and aliases live). */
export const golinksSite = (template: string) => {
  try {
    const u = new URL(template.replace('%s', 'x'))
    return u.origin + u.pathname.replace(/\/r\/x$/, '')
  } catch {
    return GOLINKS_HOME
  }
}
