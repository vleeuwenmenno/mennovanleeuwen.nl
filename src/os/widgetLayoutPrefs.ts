import { flagPref, localPref } from './localPref'

/** Local display layout, deliberately separate from the account's widget placements. */
export const avoidWidgetOverlap = flagPref('mvlos.widgets.avoidOverlap', true)

/** Last manually placed item, local to this browser and account. Widget entry keys survive
 * reloads but change when a removed widget is added again. Missing entries are ignored by wm.
 * localPref deduplicates identical strings, so a drag writes once, not on every pointer move.
 * Blocked storage keeps the priority in memory for the current page.
 */
export const desktopLayoutPriority = localPref<string | null>(
  'mvlos.widgets.layoutPriority',
  (raw) => raw && /^(widget:[^\s]{1,80}|note:(notes|keys))$/.test(raw) ? raw : null,
  (value) => value ?? '',
  { account: true },
)
