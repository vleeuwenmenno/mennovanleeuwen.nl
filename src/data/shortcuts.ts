// Every keyboard and mouse shortcut on the site, for the shortcuts sticky note and `keys`.
// Keep this in step with the handlers when adding one. " / " separates alternatives; within one,
// spaces separate keys pressed together. Alternatives mentioning click, drag or hover are mouse hints.

export const SHORTCUTS: { area: string; keys: [string, string][] }[] = [
  {
    area: 'Everywhere',
    keys: [
      ['Ctrl K', 'Spotlight: search, maths, units, currencies'],
      ['Esc', 'close menus, Spotlight, launcher'],
      ['Right-click', 'menus on desktop, icons, dock, files'],
      ['Click a window', 'focus it and bring it forward'],
    ],
  },
  {
    area: 'Windows & dock',
    keys: [
      ['Double-click title', 'maximize / restore'],
      ['Drag title / Drag edge', 'move / resize'],
      ['Drag to a side edge', 'snap to half the screen'],
      ['Drag to a corner', 'snap to a quarter'],
      ['Drag to top edge', 'maximize'],
      ['Drag a snapped window', 'back to its old size'],
      ['Hover bottom edge', 'show a hidden dock'],
      ['Click dock icon', 'open, focus or minimize'],
      ['Right-click dock', 'new window, quit'],
      ['Drag dock icon', 'reorder the dock'],
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
    area: 'Terminal',
    keys: [
      ['Tab', 'complete commands and paths'],
      ['↑ ↓', 'history'],
      ['Ctrl C', 'cancel the line or stop ping'],
      ['Ctrl L', 'clear the screen'],
      ['Ctrl U', 'clear the line'],
    ],
  },
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
    ],
  },
  {
    area: 'Spotlight & launcher',
    keys: [
      ['↑ ↓', 'move'],
      ['↵', 'open, or copy a result'],
      ['Ctrl ↵', 'new window / second action'],
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
