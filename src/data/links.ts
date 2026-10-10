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
 * Opens a web page, in this tab or a new one as the link settings say, and remembers it for
 * Spotlight's "Recently visited" (with `title` when known) unless `remember` is false.
 */
export const openLink = (url: string, opts: { title?: string; remember?: boolean } = {}) => {
  if (opts.remember !== false) rememberVisit(url, opts.title)
  if (linksInThisTab()) location.assign(url)
  else window.open(url, '_blank', 'noopener')
}

/**
 * Plain `<a target="_blank">` links follow the setting too, and are remembered like openLink's.
 * Modified and middle clicks are left to the browser, so Ctrl-click still opens a new tab.
 */
export function followLinkSettings() {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href][target="_blank"]') : null
    if (!a || !/^https?:/.test(a.href)) return
    rememberVisit(a.href, a.title || undefined)
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || !linksInThisTab()) return
    e.preventDefault()
    location.assign(a.href)
  }
  document.addEventListener('click', onClick)
  return () => document.removeEventListener('click', onClick)
}
