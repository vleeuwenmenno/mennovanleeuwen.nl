import { localPref } from './localPref'

// Notes and widgets put away (the MvL OS menu's "Hide notes and widgets"), to see the desktop
// itself: on a phone, where the notes fill the screen, that shows the desktop icons as a grid
// (Desktop.tsx). Per browser, since a phone and a desktop want different things.
export const notesHidden = localPref<boolean>('mvlos.desk.notesHidden', (raw) => raw === 'true', String)

/** The apps whose windows are notes on the desktop (the note chrome: stickies, Shortcuts, widgets). */
export const NOTE_APPS = new Set(['notes', 'keys', 'widget'])
