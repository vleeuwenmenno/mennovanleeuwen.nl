// What a terminal sends for keys, the mouse and pastes, the way xterm does: the bytes a program
// on the other end of the stream (SSH, the replay demo) reads. The modes come from the emulator
// (application cursor and keypad keys, mouse tracking, bracketed paste).

export type KeyInput = { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }
export type KeyModes = { appCursor: boolean; appKeypad: boolean }

// Letters after CSI 1;mod or SS3 for the cursor keys, Home, End and F1–F4.
const LETTER: Record<string, string> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' }
const SS3_FKEY: Record<string, string> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' }
// Numbers before ~ for the editing keys and F5–F12.
const TILDE: Record<string, number> = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 }
// The keypad in application mode (DECKPAM), by KeyboardEvent.code.
const KEYPAD: Record<string, string> = {
  Numpad0: 'p', Numpad1: 'q', Numpad2: 'r', Numpad3: 's', Numpad4: 't', Numpad5: 'u', Numpad6: 'v', Numpad7: 'w', Numpad8: 'x', Numpad9: 'y',
  NumpadDecimal: 'n', NumpadEnter: 'M', NumpadAdd: 'k', NumpadSubtract: 'm', NumpadMultiply: 'j', NumpadDivide: 'o',
}

/** Ctrl with a character: the control code a terminal sends, or null when there is none. */
export function ctrlChar(ch: string): string | null {
  if (/^[a-z]$/i.test(ch)) return String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f)
  switch (ch) {
    case '@':
    case ' ':
    case '2':
      return '\x00'
    case '[':
    case '3':
      return '\x1b'
    case '\\':
    case '4':
      return '\x1c'
    case ']':
    case '5':
      return '\x1d'
    case '^':
    case '~':
    case '6':
      return '\x1e'
    case '_':
    case '/':
    case '-':
    case '7':
      return '\x1f'
    case '?':
    case '8':
      return '\x7f'
  }
  return null
}

/**
 * The bytes for one key press, or null when a terminal sends nothing for it (Shift alone, Meta
 * combinations, which belong to the browser and the desktop).
 */
export function encodeKey(e: KeyInput, modes: KeyModes): string | null {
  if (e.metaKey) return null
  const { key } = e
  const mod = (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0)
  const param = mod ? mod + 1 : 0
  const esc = e.altKey ? '\x1b' : ''

  if (modes.appKeypad && e.code && KEYPAD[e.code] && !e.ctrlKey && !e.altKey && (key.length === 1 || key === 'Enter')) return `\x1bO${KEYPAD[e.code]}`
  if (LETTER[key]) return param ? `\x1b[1;${param}${LETTER[key]}` : `${modes.appCursor ? '\x1bO' : '\x1b['}${LETTER[key]}`
  if (SS3_FKEY[key]) return param ? `\x1b[1;${param}${SS3_FKEY[key]}` : `\x1bO${SS3_FKEY[key]}`
  if (TILDE[key]) return `\x1b[${TILDE[key]}${param ? `;${param}` : ''}~`
  switch (key) {
    case 'Enter':
      return `${esc}\r`
    case 'Tab':
      return e.shiftKey ? '\x1b[Z' : `${esc}\t`
    case 'Backspace':
      return `${esc}${e.ctrlKey ? '\x08' : '\x7f'}`
    case 'Escape':
      return `${esc}\x1b`
  }
  // One character (a code point, which may be two UTF-16 units).
  if ([...key].length !== 1) return null
  if (e.ctrlKey) {
    const c = ctrlChar(key)
    if (c !== null) return esc + c
  }
  return esc + key
}

export type MouseEventKind = 'down' | 'up' | 'move' | 'wheel'

/**
 * A mouse report, or null when the mode does not report this event. `button` is 0 left, 1
 * middle, 2 right (for wheel: 0 up, 1 down); `x` and `y` are cells from 0. `held` is whether a
 * button is down during a move.
 */
export function encodeMouse(
  kind: MouseEventKind,
  button: number,
  x: number,
  y: number,
  mods: { shift: boolean; alt: boolean; ctrl: boolean },
  modes: { mouse: number; mouseSgr: boolean },
  held = false,
): string | null {
  const mode = modes.mouse
  if (!mode) return null
  if (mode === 9 && kind !== 'down') return null
  if (kind === 'move' && !(mode === 1003 || (mode === 1002 && held))) return null
  let b = kind === 'wheel' ? 64 + button : kind === 'move' ? 32 + (held ? button : 3) : button
  if (mode !== 9) b += (mods.shift ? 4 : 0) + (mods.alt ? 8 : 0) + (mods.ctrl ? 16 : 0)
  if (modes.mouseSgr) return `\x1b[<${b};${x + 1};${y + 1}${kind === 'up' ? 'm' : 'M'}`
  // The old encoding has no release per button, and positions stop at 223.
  if (kind === 'up') b = 3 + (b & ~3)
  const byte = (v: number) => String.fromCharCode(Math.min(255, 32 + v))
  return `\x1b[M${byte(b)}${byte(x + 1)}${byte(y + 1)}`
}

/** A paste: newlines become Enter, and with bracketed paste the program can tell it from typing. */
export function encodePaste(text: string, bracketed: boolean): string {
  const body = text.replace(/\r?\n/g, '\r')
  // eslint-disable-next-line no-control-regex
  return bracketed ? `\x1b[200~${body.replace(/\x1b\[20[01]~/g, '')}\x1b[201~` : body
}
