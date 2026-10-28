import { fromMailto, queueCompose } from '../data/mail'
import { APP_META } from './apps'
import type { AppId } from './wm'

// The site's own addresses that open something in MvL OS: /?open=<app> (the installed app's
// shortcuts), with what a notification or a link back points at (/?open=tasks&task=…,
// /?open=mail&message=…), and /?mailto=<a mailto: link> (mailto: links in HTML mail). Read when
// the page loads (src/os/Shell.tsx) and when the service worker passes on a tapped push while the
// page is open (src/os/agentWatch.ts).

/** What an address may say for each app: anything else in it is ignored (a link can't make the terminal run a command). */
const PROPS: Partial<Record<AppId, string[]>> = {
  agents: ['thread', 'tab', 'task', 'run'],
  tasks: ['task'],
  mail: ['account', 'email', 'message'],
  calendar: ['date', 'event'],
  contacts: ['contact'],
}

/** Opens what the address asks for with `open` (wm.open); answers whether it asked for anything. */
export function openFromParams(params: URLSearchParams, open: (app: AppId, props?: Record<string, string>) => void): boolean {
  const mailto = params.get('mailto')
  const req = mailto ? fromMailto(mailto) : null
  if (req) {
    open('mail', { compose: queueCompose(req), t: String(Date.now()) })
    return true
  }
  const app = params.get('open') as AppId | null
  if (!app || !(app in APP_META) || app === 'trash') return false
  const props: Record<string, string> = {}
  for (const k of PROPS[app] ?? []) {
    const v = params.get(k)
    if (v && v.length <= 1000) props[k] = v
  }
  if (props.thread && !/^[0-9a-f-]{36}$/.test(props.thread)) delete props.thread
  // The Agents app's Tasks tab, at a task or run (an agent task's notification): ids only.
  for (const k of ['task', 'run'] as const) if (props[k] && !/^[0-9a-f-]{36}$/.test(props[k])) delete props[k]
  if (props.tab && !/^[a-z]{1,20}$/.test(props.tab)) delete props.tab
  open(app, Object.keys(props).length ? { ...props, t: String(Date.now()) } : undefined)
  return true
}
