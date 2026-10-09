import type { WinState } from '../os/wm'
import type { WM } from './types'

// Opening and finding widget windows. Kept apart from the registry so widget definitions can use
// these without importing each other.

export const isWidget = (w: WinState, kind?: string, id?: string) => w.app === 'widget' && (!kind || w.props.kind === kind) && (!id || w.props.id === id)

export const widgetWindows = (wm: WM, kind?: string, id?: string) => wm.windows.filter((w) => isWidget(w, kind, id))

/** Shows a widget: focuses it if it is on the desktop already, otherwise puts it there. */
export function openWidget(wm: WM, kind: string, id: string) {
  const open = widgetWindows(wm, kind, id)[0]
  if (open) wm.focus(open.pid)
  else wm.openNew('widget', { kind, id })
}

export const closeWidget = (wm: WM, kind: string, id: string) => widgetWindows(wm, kind, id).forEach((w) => wm.close(w.pid))
