// Build identity, stamped in by vite.config.ts: the release tag for release builds, `git describe`
// for local ones. The system menu shows it, so it is easy to see which build a site is running.

declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string
declare const __BUILD_TIME__: string

export const VERSION = __APP_VERSION__
export const COMMIT = __APP_COMMIT__
export const BUILT = __BUILD_TIME__
/** "1.1" from "1.1.0", for places that read like a product name ("MvL OS 1.1"). */
export const SHORT_VERSION = VERSION.split(/[.-]/).slice(0, 2).join('.')
export const REPO = 'vleeuwenmenno/mennovanleeuwen.nl'
