import { useEffect } from 'react'
import { useBackLayer } from './backLayers'
import type { MenuItem } from './ContextMenu'
import { addHomePage, goToPage, homeScroller, homeUi, itemsOnPage, pageAtScroll, removeHomePage, useHomeUi } from './homePager'
import { MAX_PAGES } from './homePages'

/** "Move to page" for an icon's or widget's menu: every page, and a new one. `move` gets the page index (the count for a new page). */
export function pageMenu(current: number, move: (page: number) => void): MenuItem {
  const count = homeUi.get().count
  return {
    label: 'Move to page',
    submenu: [
      ...Array.from({ length: count }, (_, i) => ({ label: `Page ${i + 1}`, checked: i === current, disabled: i === current, onSelect: () => move(i) })),
      ...(count < MAX_PAGES ? [{ label: 'New page', onSelect: () => move(count) }] : []),
    ],
  }
}

/**
 * The phone's page dots, and the home editor behind the pencil (or a long press on the empty
 * home screen). Dots are small but their buttons are 44px tall. Editing adds and removes pages; an
 * empty page can go, one with something on it can't (move its items first, with their menu or
 * by dragging them to the screen's edge).
 */
export function HomePager() {
  const ui = useHomeUi()
  useBackLayer(ui.editing, () => homeUi.set({ editing: false }))

  useEffect(() => {
    const el = homeScroller()
    if (!el) return
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => homeUi.set({ page: pageAtScroll() }))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('scroll', onScroll)
    }
  }, [])

  const empty = itemsOnPage(ui.page, ui) === 0
  return (
    <nav className={`home-pages ${ui.editing ? 'is-editing' : ''}`} aria-label="Home screens">
      <div className="home-dots">
        {Array.from({ length: ui.count }, (_, i) => (
          <button key={i} type="button" className="home-dot" aria-label={`Page ${i + 1} of ${ui.count}`} aria-current={i === ui.page ? 'page' : undefined} onClick={() => goToPage(i)}>
            <span />
          </button>
        ))}
        {!ui.editing && (
          <button type="button" className="home-edit" aria-label="Edit home screen" onClick={() => homeUi.set({ editing: true })}>
            ✎
          </button>
        )}
      </div>
      {ui.editing && (
        <div className="home-edit-bar" role="group" aria-label="Edit home screen">
          <button type="button" disabled={ui.count >= MAX_PAGES} onClick={() => { const at = addHomePage(); if (at !== null) requestAnimationFrame(() => requestAnimationFrame(() => goToPage(at))) }}>
            Add page
          </button>
          <button type="button" disabled={ui.count <= 1 || !empty} title={empty ? undefined : 'Only an empty page can be removed'} aria-label={`Remove page ${ui.page + 1}`} onClick={() => removeHomePage(ui.page)}>
            Remove page
          </button>
          <button type="button" className="is-done" onClick={() => homeUi.set({ editing: false })}>
            Done
          </button>
          <span className="home-hint" role="status">
            {empty ? `Page ${ui.page + 1} is empty` : 'Hold an icon or widget, then drag it to the screen edge for another page'}
          </span>
        </div>
      )}
    </nav>
  )
}
