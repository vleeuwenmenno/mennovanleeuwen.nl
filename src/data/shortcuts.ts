// Every keyboard and mouse shortcut on the site, for the shortcuts sticky note and `keys`.
// Keep this in step with the handlers when adding one. " / " separates alternatives; within one,
// spaces separate keys pressed together. Alternatives mentioning click, drag or hover are mouse hints.
// Ctrl+K and Ctrl+Space follow Settings → Spotlight (default: Space is Spotlight, K is All apps).

import { spotlightPrefs, type CtrlSpace } from './spotlightPrefs'

export type ShortcutGroup = { area: string; keys: [string, string][] }

export function shortcuts(ctrlSpace: CtrlSpace = spotlightPrefs().ctrlSpace): ShortcutGroup[] {
  const spaceOpensSpotlight = ctrlSpace !== 'launchpad'
  return [
  {
    area: 'Everywhere',
    keys: [
      ['Ctrl K', spaceOpensSpotlight ? 'All apps' : 'Spotlight: search, maths, units, currencies'],
      ['Ctrl Space', spaceOpensSpotlight ? 'Spotlight: search, maths, units, currencies (best-effort; some OSes take it)' : 'All apps (best-effort; some OSes take it)'],
      ['Esc', 'close menus, Spotlight, launcher'],
      ['Right-click', 'a menu almost anywhere: windows, notes, dock, bar'],
      ['Shift right-click', "the browser's own menu"],
      ['Click a window', 'focus it and bring it forward'],
    ],
  },
  {
    area: 'Windows & dock',
    keys: [
      ['Ctrl Q', 'close the focused window (best-effort; some browsers keep the key and quit)'],
      ['Double-click title', 'maximize / restore'],
      ['Drag title / Drag edge', 'move / resize'],
      ['Ctrl drag / Ctrl right-drag', 'move the window / resize it from the nearest corner (Alt or off in Settings)'],
      ['Drag to a side edge', 'snap to half the screen'],
      ['Drag to a corner', 'snap to a quarter'],
      ['Drag to top edge', 'maximize'],
      ['Drag a snapped window', 'back to its old size'],
      ['Hover bottom edge', 'show a hidden dock'],
      ['Click dock icon', 'open, focus or minimize; again for its next window'],
      ['Right-click dock', 'dock settings; on an icon, its windows'],
      ['Drag dock icon', 'reorder the dock; drag an open app in to pin it'],
    ],
  },
  {
    area: 'Workspaces',
    keys: [
      ['Alt 1–9 / Click a number', 'go to that workspace'],
      ['Alt Shift 1–9', 'move the focused window there'],
      ['Ctrl Alt ← → / Scroll the numbers', 'previous, next workspace'],
      ['Drag a window onto a number', 'move it to that workspace'],
    ],
  },
  {
    area: 'Desktop',
    keys: [
      ['Double-click / ↵', 'open'],
      ['Ctrl click / Shift click', 'add to selection'],
      ['Drag on empty space', 'select with a box'],
      ['Ctrl A', 'select all icons'],
      ['F2', 'rename'],
      ['Del', 'move to Trash'],
    ],
  },
  {
    area: 'Boot screen',
    keys: [
      ['P', 'boot to a shell instead (exit starts the desktop)'],
      ['Space / Click', 'skip the boot (any other key works too)'],
    ],
  },
  {
    area: 'Terminal',
    keys: [
      ['Ctrl F', 'search this tab’s scrollback (a program that has the keys still gets Ctrl+F)'],
      ['Tab', 'complete commands, paths and go links; again to cycle'],
      ['→ / ↵', 'put the picked completion on the line'],
      ['↑ ↓', 'history'],
      ['Ctrl C', 'cancel the line or stop ping'],
      ['Ctrl L', 'clear the screen'],
      ['Ctrl U', 'clear the line'],
      ['Ctrl Shift C / Ctrl Shift V', 'copy the selection / paste'],
      ['Ctrl + / Ctrl − / Ctrl 0', 'zoom this tab in, out, back'],
      ['Ctrl scroll / Pinch', 'zoom this tab'],
      ['Ctrl Shift T / Ctrl Shift W', 'new tab / close tab'],
      ['Ctrl Tab / Ctrl Shift Tab', 'next / previous tab'],
      ['Ctrl PgDn / Ctrl PgUp', 'next / previous tab'],
      ['Ctrl Shift 1–9', 'go to that tab (9: the last)'],
      ['Middle-click a tab / Drag a tab', 'close it / move it'],
      ['Double-click the tab bar', 'new tab'],
    ],
  },
  { area: 'Agents', keys: [['Ctrl F', 'search threads']] },
  {
    area: 'Files',
    keys: [
      ['Ctrl 1–4', 'list, grid, compact, gallery'],
      ['Ctrl + / Ctrl −', 'zoom in / out'],
      ['Ctrl H', 'hidden files'],
      ['Ctrl L', 'type a path'],
      ['Ctrl F', 'search'],
      ['Alt ← → ↑', 'back, forward, up'],
      ['Backspace', 'up one folder'],
      ['Alt ↵', 'properties'],
      ['Arrows / Shift', 'move / extend selection'],
      ['Shift drag on empty space', 'add to the selection with a box'],
    ],
  },
  {
    area: 'Xed',
    keys: [
      ['Ctrl P', 'go to file'],
      ['Ctrl F', 'find in the file (↵ next, Shift ↵ previous)'],
      ['Ctrl Shift F', 'search the whole project'],
      ['Ctrl Shift V', 'Markdown preview (Alt-click the eye: split)'],
      ['Ctrl S', 'save (~, Seafile and /tmp are writable)'],
      ['Ctrl O / Click project name', 'open another folder'],
      ['Ctrl B', 'project panel'],
      ['Alt W / Middle-click tab', 'close the tab'],
    ],
  },
  {
    area: 'Spotlight & launcher',
    keys: [
      ['↑ ↓', 'move'],
      ['↵', 'open, or copy a result'],
      ['Ctrl ↵', 'new window / second action'],
      ['Ctrl K', 'in Spotlight: all actions for the result (or right-click it)'],
      ['Ctrl D', 'in Spotlight: add to or remove from favourites'],
      ['Tab', 'in Spotlight: complete the search box'],
    ],
  },
  {
    area: 'Games',
    keys: [
      ['Arrows / WASD', 'move or steer'],
      ['Space', 'pause; drop in Tetris'],
      ['↑ / X / Z', 'rotate in Tetris'],
      ['C / Shift', 'hold in Tetris'],
      ['↵', 'start again'],
      ['Right-click', 'flag in Minesweeper'],
    ],
  },
  ]
}
