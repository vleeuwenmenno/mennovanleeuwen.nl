import type { AppId } from './wm'

// mennovanleeuwen.nl/cv is Menno's CV: the portfolio apps (CV, Projects, Activity, Contact,
// Minecraft), their desktop icons, Spotlight results and terminal commands. Everywhere else the
// site is a plain web desktop that anyone can sign in to. Signed in at /cv, you get your own
// desktop with the CV apps added. Decided once per page load: the path doesn't change after it.
//
// Away from /cv the CV apps are left out of what you launch apps from (dock, Launchpad, Spotlight,
// the terminal, launchers), but something that asks for one (the Minecraft widget, a notification,
// the Activity button) opens its window right there, without leaving the page (src/os/wm.tsx).

export const cvMode = (): boolean => /^\/cv\/?$/.test(location.pathname)

/** Apps that are only launched from /cv (opened elsewhere on request: see above). */
export const CV_APPS: ReadonlySet<AppId> = new Set<AppId>(['projects', 'recents', 'cv', 'contact', 'mcserver'])

/** Whether this app is one to launch on this page (in the dock, Launchpad, Spotlight...). */
export const appHere = (app: AppId): boolean => cvMode() || !CV_APPS.has(app)
