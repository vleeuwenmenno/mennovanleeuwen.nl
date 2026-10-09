import { useEffect } from 'react'
import { stickyWidget } from '../apps/Sticky'
import type { MenuItem } from '../os/ContextMenu'
import { useWM, type WinState } from '../os/wm'
import type { WidgetDef, WM } from './types'
import { agendaWidget } from './agenda'
import { inboxWidget } from './inbox'
import { weatherWidget } from './weather'
import { openWidget } from './windows'

// Every kind of desktop widget. Adding one: write its WidgetDef (see types.ts) and list it here;
// it then shows up in "Add widget" (desktop, All apps, Spotlight) and gets the note-style frame,
// dragging, its menu and synced settings.

export function widgetDefs(): WidgetDef[] {
  return [stickyWidget, weatherWidget, agendaWidget, inboxWidget]
}

export const widgetDef = (kind: string | undefined) => widgetDefs().find((d) => d.kind === kind)

/** Makes a new widget of `kind` and puts it on the desktop. */
export function addWidget(wm: WM, kind: string) {
  const def = widgetDef(kind)
  if (!def) return
  openWidget(wm, kind, def.create?.() ?? crypto.randomUUID().slice(0, 8))
}

/** "Add widget ›" entries, for menus. */
export const addWidgetItems = (wm: WM): MenuItem[] => widgetDefs().map((d) => ({ label: `${d.glyph}  ${d.name}`, onSelect: () => addWidget(wm, d.kind) }))

/** A widget window's contents. An unknown kind (removed in a later release) closes itself. */
export function WidgetHost({ win }: { win: WinState }) {
  const wm = useWM()
  const def = widgetDef(win.props.kind)
  useEffect(() => {
    if (!def || !win.props.id) wm.close(win.pid)
  }, [def, win.pid, win.props.id, wm])
  if (!def || !win.props.id) return null
  return <def.Component win={win} id={win.props.id} />
}
