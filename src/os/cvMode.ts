import type { AppId } from './wm'

// mennovanleeuwen.nl/cv is Menno's CV: the portfolio apps (CV, Projects, Activity, Contact,
// Minecraft), their desktop icons, Spotlight results and terminal commands. Everywhere else the
// site is a plain web desktop that anyone can sign in to. Signed in at /cv, you get your own
// desktop with the CV apps added. Decided once per page load: the path doesn't change after it.

export const cvMode = (): boolean => /^\/cv\/?$/.test(location.pathname)

/** Apps that only exist at /cv. */
export const CV_APPS: ReadonlySet<AppId> = new Set<AppId>(['projects', 'recents', 'cv', 'contact', 'mcserver'])

/** Whether this app exists on this page. */
export const appHere = (app: AppId): boolean => cvMode() || !CV_APPS.has(app)
