import type { AppId } from './wm'

/** Props that only make sense once: commands to run, "open this now" stamps, placement hints. */
export const TRANSIENT_PROPS = new Set(['run', 't', 'under', 'create', 'unsaved'])

/** One-shot requests per app: an event, task or contact to open, a day to show, files to import, a
 * message to write. Kept while the window lives, but never saved: a reload (or another device)
 * would otherwise open that editor again. */
const ONE_SHOT_PROPS: Partial<Record<AppId, string[]>> = {
  calendar: ['event', 'occurrence', 'compose', 'import', 'date', 'view'],
  tasks: ['task'],
  contacts: ['contact', 'email', 'name', 'import'],
  mail: ['compose', 'email', 'search'],
}
/** The props of a window worth saving: no undefined, transient or one-shot ones. */
export function persistentProps(app: AppId, props: Record<string, string | undefined>): Record<string, string | undefined> {
  const once = ONE_SHOT_PROPS[app]
  return Object.fromEntries(Object.entries(props).filter(([k, v]) => v !== undefined && !TRANSIENT_PROPS.has(k) && !once?.includes(k)))
}
