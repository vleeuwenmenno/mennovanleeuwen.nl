import { newTab } from '../os/powerState'
import { synced } from '../os/synced'
import { rememberVisit } from './siteHistory'

// Where web links open: in a new browser tab (the default) or in this one. Loaded as the browser's
// new tab page (/?newtab), links can be made to always replace it, whatever the setting, so the
// page acts like an address bar, and it can start with Spotlight open for quick navigation. Kept in this browser; synced when signed in, like notes.

export type LinkTarget = 'new' | 'same'
export type LinkSettings = { target: LinkTarget; newTabPageSameTab: boolean; newTabPageSpotlight: boolean }
const DEFAULTS: LinkSettings = { target: 'new', newTabPageSameTab: true, newTabPageSpotlight: true }

const store = synced<LinkSettings>('links', DEFAULTS, {
  normalize: (v) => {
    const s = { ...DEFAULTS, ...(v as Partial<LinkSettings>) }
    return {
      target: s.target === 'same' ? 'same' : 'new',
      newTabPageSameTab: s.newTabPageSameTab !== false,
      newTabPageSpotlight: s.newTabPageSpotlight !== false,
    }
  },
})

export const useLinkSettings = store.use
export const linkSettings = store.get
export const setLinkSettings = (patch: Partial<LinkSettings>) => store.set((s) => ({ ...s, ...patch }))

/** Whether a web link opens in this tab right now. */
export const linksInThisTab = () => {
  const s = store.get()
  return (newTab && s.newTabPageSameTab) || s.target === 'same'
}

/**
 * Links that open inside MvL OS instead of a browser tab: an app registers a handler that answers
 * true when it took the link (Mail takes mailto: once an account is linked, and links to a message;
 * src/os/pimLinks.tsx). Answers a function that takes it away again.
 */
type LinkHandler = (url: string) => boolean
const handlers = new Set<LinkHandler>()
export function registerLinkHandler(fn: LinkHandler): () => void {
  handlers.add(fn)
  return () => void handlers.delete(fn)
}
/** Whether an app inside MvL OS took this link. */
export const openInOs = (url: string) => [...handlers].some((h) => h(url))

/** A mailto: link: Mail's composer when Mail is linked, otherwise the browser's mail program. */
export const openMailto = (href: string) => openInOs(href) || void window.open(href, '_blank', 'noopener')

/**
 * Opens a web page, in this tab or a new one as the link settings say, and remembers it for
 * Spotlight's "Recently visited" (with `title` when known) unless `remember` is false. Links an
 * app inside MvL OS takes (registerLinkHandler) open there.
 */
export const openLink = (url: string, opts: { title?: string; remember?: boolean } = {}) => {
  if (openInOs(url)) return
  if (opts.remember !== false) rememberVisit(url, opts.title)
  if (linksInThisTab()) location.assign(url)
  else window.open(url, '_blank', 'noopener')
}

/**
 * Plain `<a target="_blank">` links follow the setting too, and are remembered like openLink's.
 * Modified and middle clicks are left to the browser, so Ctrl-click still opens a new tab. A
 * mailto: link (any target) or a link an app takes opens inside MvL OS.
 */
export function followLinkSettings() {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null
    if (!a) return
    // mailto: and message: links anywhere, and web links to something an app shows (a message):
    // inside MvL OS when an app takes them.
    if ((!/^https?:/i.test(a.href) || a.target === '_blank') && !e.ctrlKey && !e.metaKey && !e.shiftKey && openInOs(a.href)) return e.preventDefault()
    if (a.target !== '_blank' || !/^https?:/.test(a.href)) return
    rememberVisit(a.href, a.title || undefined)
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || !linksInThisTab()) return
    e.preventDefault()
    location.assign(a.href)
  }
  document.addEventListener('click', onClick)
  return () => document.removeEventListener('click', onClick)
}
