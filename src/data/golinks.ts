import { useEffect, useState } from 'react'
import { synced } from '../os/synced'
import { openLink } from './links'
import { rememberVisit } from './siteHistory'

// The visitor's go-links account (https://git.mvl.sh/vleeuwenmenno/golinks), for the terminal's
// `go` command and Spotlight's `go <alias>`. Stored as the browser-search URL golinks hands out, `https://mvl.sh/r/%s?token=…`,
// with %s where the alias goes. Kept in this browser; synced when signed in, like notes.

export const GOLINKS_HOME = 'https://mvl.sh'

const store = synced<string | null>('golinks', null, {
  normalize: (v) => (typeof v === 'string' && v.includes('%s') ? v : null),
})

export const golinksTemplate = store.get
export const useGolinksTemplate = store.use

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

/** Opens a go link; it is remembered by its alias, so the token stays out of the history. */
export function followGoLink(template: string, alias: string) {
  openLink(golinksUrl(template, alias), { remember: false })
  rememberVisit(`go:${alias}`, `go/${alias}`)
}

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

const golinksToken = (template: string) => {
  try {
    return new URL(template.replace('%s', 'x')).searchParams.get('token') ?? ''
  } catch {
    return ''
  }
}

export type GoSuggestion = { name: string; target: string }

const cache = new Map<string, GoSuggestion[]>()

/**
 * Aliases matching what is typed, from the golinks server's /suggest (OpenSearch suggestions:
 * `[query, names, targets, urls]`). Asked straight from the browser: the endpoint allows any
 * origin, and the token never passes through this site's server. Empty `q` lists the most used.
 */
export function useGoSuggestions(template: string | null, q: string, enabled: boolean): GoSuggestion[] {
  return useGoSuggestionState(template, q, enabled).list
}

/** The same, plus whether the list is the answer for this `q` yet (not the previous one's). */
export function useGoSuggestionState(template: string | null, q: string, enabled: boolean): { list: GoSuggestion[]; ready: boolean } {
  const query = q.trim()
  const on = enabled && !!template
  const key = `${template}|${query.toLowerCase()}`
  const [result, setResult] = useState<{ key: string; list: GoSuggestion[] }>({ key: '', list: [] })

  useEffect(() => {
    if (!on || !template) return
    if (cache.has(key)) return setResult({ key, list: cache.get(key)! })
    const token = golinksToken(template)
    const url = `${golinksSite(template)}/suggest?q=${encodeURIComponent(query)}&token=${encodeURIComponent(token)}`
    const ctl = new AbortController()
    const t = setTimeout(() => {
      fetch(url, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : []))
        .then((body: unknown) => {
          const [, names, targets] = Array.isArray(body) ? (body as [unknown, unknown, unknown]) : []
          const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string').map((name, i) => ({ name, target: Array.isArray(targets) && typeof targets[i] === 'string' ? targets[i] : '' })) : []
          cache.set(key, list)
          if (cache.size > 200) cache.delete(cache.keys().next().value!)
          setResult({ key, list })
        })
        .catch(() => {})
    }, 120)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [on, key, template, query])

  // The previous query's aliases stay until the new ones land, so the list doesn't flicker.
  return on ? { list: result.list, ready: result.key === key } : { list: [], ready: false }
}
