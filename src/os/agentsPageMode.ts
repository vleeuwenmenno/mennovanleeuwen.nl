// mennovanleeuwen.nl/agents is the Agents app on a page of its own, laid out like a chat website:
// a sidebar of threads and a centred conversation, without the boot screen, desktop, top bar or
// dock. /agents/<thread id> opens a thread, like a chat site's link to a conversation. Like the game
// links (playMode.ts) it is decided once per page load; after that only the thread in the address
// changes (history.pushState), and Back and Forward move between threads. The page is
// src/apps/agentsPage/AgentsPage.tsx; the app itself is src/apps/Agents.tsx, shared with the window.

const THREAD = /^[0-9a-f-]{36}$/

const PATH = /^\/agents(?:\/([^/]+))?\/?$/

const match = typeof location !== 'undefined' ? PATH.exec(location.pathname) : null

/** Whether this page is the Agents page rather than MvL OS. */
export const agentsPageMode = (): boolean => match !== null

/** The thread an /agents address names, or null for a new chat (also for anything that isn't a thread id). */
export function threadInPath(pathname: string = location.pathname): string | null {
  const id = PATH.exec(pathname)?.[1]
  return id && THREAD.test(id) ? id : null
}

/** The page's address for a thread (null: a new chat). */
export const agentsPagePath = (thread: string | null) => (thread ? `/agents/${thread}` : '/agents')

/** The full address, to open in a new tab from the window ("Open in full page"). */
export const agentsPageUrl = (thread: string | null) => `${location.origin}${agentsPagePath(thread)}`
