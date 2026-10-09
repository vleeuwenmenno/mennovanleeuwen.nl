import type { CSSProperties, ReactNode } from 'react'
import type { MenuItem } from '../os/ContextMenu'
import type { useWM, WinState } from '../os/wm'

// A desktop widget: something that sits on the desktop like a sticky note (no title bar, tape on
// top, sways when dragged), opened as a "widget" window with props { kind, id }. Each kind is one
// definition; the framework (src/widgets) gives it the frame, dragging, a right-click menu, a
// place in "Add widget" menus and per-instance settings that sync like notes.

export type WM = ReturnType<typeof useWM>

export type WidgetDef = {
  kind: string
  /** "Sticky note", "Weather" */
  name: string
  /** One line for menus and Spotlight */
  blurb: string
  /** For menus */
  glyph: string
  /** Width and starting height; widgets grow with their content */
  size: [number, number]
  /** Whether its width can be dragged */
  resizable?: boolean
  /** Menu label for closing it ("Take off the desktop" for a sticky, whose note stays) */
  closeLabel?: string
  /** The widget itself */
  Component: (props: { win: WinState; id: string }) => ReactNode
  /** Its frame's look: CSS variables --widget-bg, --widget-fg and --widget-tilt (a hook) */
  useFrame?: (id: string) => CSSProperties | undefined
  /** Its own right-click items, shown above the window items (a hook, so it can read state) */
  useMenu?: (id: string, wm: WM) => MenuItem[]
  /** Makes a new instance and returns its id (a sticky makes a note); default: a random id */
  create?: () => string
}
