import { useEffect } from 'react'
import { stickyWidget } from '../apps/Sticky'
import type { MenuItem } from '../os/ContextMenu'
import { useWM, type WinState } from '../os/wm'
import type { WidgetDef, WM } from './types'
import { customEntries, customWidget } from './custom'
import { agendaWidget } from './agenda'
import { clockWidget } from './clock'
import { inboxWidget } from './inbox'
import { minecraftWidget } from './minecraft'
import { statusWidget } from './status'
import { weatherWidget } from './weather'
import { openWidget } from './windows'
import { builtinRunsOnPhone, widgetRunsOnPhone } from './platform/phone'
import { isMobile } from '../os/useIsMobile'

// Every kind of desktop widget. Adding one: write its WidgetDef (see types.ts) and list it here;
// it then shows up in "Add widget" (desktop, All apps, Spotlight) and gets the note-style frame,
// dragging, its menu and synced settings.

export function widgetDefs(): WidgetDef[] {
  return [stickyWidget, weatherWidget, agendaWidget, inboxWidget, statusWidget, minecraftWidget, clockWidget, ...customEntries()]
}

/** The definition a placed widget window uses. Custom instances share one definition (the entries in widgetDefs only add them). */
export const widgetDef = (kind: string | undefined) => kind === customWidget.kind ? customWidget : widgetDefs().find((d) => d.kind === kind)

/** Makes a new widget of `kind` and puts it on the desktop. */
export function addWidget(wm: WM, kind: string, instance?: string) {
  const def = instance ? customWidget : widgetDefs().find((d) => d.kind === kind)
  if (!def) return
  if (def.onAdd) return def.onAdd(wm)
  openWidget(wm, kind, instance ?? def.create?.() ?? crypto.randomUUID().slice(0, 8))
}

/** Whether a widget works on a phone: its (active) manifest says `phone: true`. "New custom widget…" opens the Workshop, which is no phone tool. */
export const phoneCompatible = (d: WidgetDef) => (d.instance ? widgetRunsOnPhone(d.kind, d.instance) : !d.onAdd && builtinRunsOnPhone(d.kind))

/** The widgets "Add widget" offers on this screen: everything on a big screen, only the phone-compatible ones on a phone (the others would not show there). */
export const widgetDefsHere = (): WidgetDef[] => (isMobile() ? widgetDefs().filter(phoneCompatible) : widgetDefs())

/** What menus say above the list on a phone, so a short list is not a mystery. */
export const PHONE_WIDGET_NOTE = 'Only widgets that work on a phone'

/** "Add widget ›" entries, for menus. */
export const addWidgetItems = (wm: WM): MenuItem[] => [
  ...(isMobile() ? [{ label: PHONE_WIDGET_NOTE, disabled: true }, { separator: true as const }] : []),
  ...widgetDefsHere().map((d) => ({ label: `${d.glyph}  ${d.name}`, onSelect: () => addWidget(wm, d.kind, d.instance) })),
]

/** Missing runtime kinds stay placed: unavailable is not a user removal. */
export function WidgetHost({ win }: { win: WinState }) {
  const wm = useWM()
  const def = widgetDef(win.props.kind)
  useEffect(() => {
    if (!win.props.id) wm.close(win.pid)
  }, [def, win.pid, win.props.id, wm])
  if (!def || !win.props.id) return null
  return <def.Component win={win} id={win.props.id} />
}
