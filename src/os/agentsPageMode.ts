// mennovanleeuwen.nl/agents is the Agents app on a page of its own, laid out like a chat website:
// a sidebar of threads and a centred conversation, without the boot screen, desktop, top bar or
// dock. Like the game links (playMode.ts) it is decided once per page load; after that only the
// place in the address changes (history.pushState), and Back and Forward move between places:
//
//   /agents                       a new chat
//   /agents/<thread id>           a thread (thread ids are UUIDs, so never one of the words below)
//   /agents/settings[/<section>]  Agents settings, at a section (overview when there is none)
//   /agents/tasks                 background tasks
//   /agents/memory[/<project>]    what the agent remembers (a project's memory by its number)
//
// The page is src/apps/agentsPage/AgentsPage.tsx; the app itself is src/apps/Agents.tsx, shared
// with the window. The server serves these paths and lets sign-in come back to them
// (server/index.ts, server/auth.ts backTo).

const THREAD = /^[0-9a-f-]{36}$/
const SECTION = /^[a-z]{1,20}$/
const PROJECT = /^[1-9]\d{0,8}$/

/** Any address under /agents (at most two parts): the server gives them all the app. */
const PATH = /^\/agents(?:\/[^/]+){0,2}\/?$/

const match = typeof location !== 'undefined' ? PATH.test(location.pathname) : false

/** Whether this page is the Agents page rather than MvL OS. */
export const agentsPageMode = (): boolean => match

/** Where on the Agents page an address points. */
export type PageRoute =
  | { kind: 'thread'; thread: string | null }
  | { kind: 'settings'; section: string | null }
  | { kind: 'tasks' }
  | { kind: 'memory'; scope: number | null }

/** The place an /agents address names. Anything it doesn't know is a new chat. */
export function routeOf(pathname: string = location.pathname): PageRoute {
  if (!PATH.test(pathname)) return { kind: 'thread', thread: null }
  const [a, b] = pathname.replace(/\/+$/, '').split('/').slice(2)
  if (!a) return { kind: 'thread', thread: null }
  if (THREAD.test(a) && !b) return { kind: 'thread', thread: a }
  if (a === 'settings') return { kind: 'settings', section: b && SECTION.test(b) && b !== 'overview' ? b : null }
  if (a === 'tasks' && !b) return { kind: 'tasks' }
  if (a === 'memory') return { kind: 'memory', scope: b && PROJECT.test(b) ? Number(b) : null }
  return { kind: 'thread', thread: null }
}

/** The address of a place on the page. */
export function pathOf(r: PageRoute): string {
  if (r.kind === 'thread') return r.thread && THREAD.test(r.thread) ? `/agents/${r.thread}` : '/agents'
  if (r.kind === 'settings') return r.section && SECTION.test(r.section) && r.section !== 'overview' ? `/agents/settings/${r.section}` : '/agents/settings'
  if (r.kind === 'tasks') return '/agents/tasks'
  return r.scope !== null && PROJECT.test(String(r.scope)) ? `/agents/memory/${r.scope}` : '/agents/memory'
}

/** The thread an /agents address names, or null for a new chat or another place. */
export function threadInPath(pathname: string = location.pathname): string | null {
  const r = routeOf(pathname)
  return r.kind === 'thread' ? r.thread : null
}

/** The page's address for a thread (null: a new chat). */
export const agentsPagePath = (thread: string | null) => pathOf({ kind: 'thread', thread })

/** The full address, to open in a new tab from the window ("Open in full page"). */
export const agentsPageUrl = (thread: string | null) => `${location.origin}${agentsPagePath(thread)}`
