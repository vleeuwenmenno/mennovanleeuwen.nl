import { localPref } from './localPref'

// Moving and resizing a window by holding a key and dragging anywhere on it, as in Hyprland: the
// key plus the left button moves it, the key plus the right button resizes it from the corner
// nearest the pointer. Which key (or none) is a per-browser choice, in Settings → Windows.

export type DragKey = 'ctrl' | 'alt' | 'off'

export const DRAG_KEYS: [DragKey, string][] = [
  ['ctrl', 'Ctrl'],
  ['alt', 'Alt'],
  ['off', 'Off'],
]

export const dragKeyPref = localPref<DragKey>('mvlos.windows.dragKey', (raw) => (raw === 'alt' || raw === 'off' ? raw : 'ctrl'), (v) => v)

/** Whether the chosen key is held, and only it (Shift may join; Alt with Ctrl or Meta may not). */
export function dragKeyHeld(e: { ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  const key = dragKeyPref.get()
  if (key === 'off' || e.metaKey) return false
  return key === 'ctrl' ? e.ctrlKey && !e.altKey : e.altKey && !e.ctrlKey
}
