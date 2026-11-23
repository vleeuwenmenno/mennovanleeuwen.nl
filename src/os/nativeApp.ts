// The Android app (mobile/, Capacitor): its on-device mode runs this same frontend from
// https://localhost inside the app, without a server. The app exposes one small native plugin,
// MvlosApp, to that bundled page only: `info()` and `openChooser()` (back to the app's
// on-device / cloud server screen). Nothing else crosses: no tokens, no URLs, no storage.
// In a browser or the PWA none of this exists.
//
// The app's cloud mode is different: there the server's own desktop runs in a plain WebView with no
// native plugin at all (mobile/, CloudActivity). It only adds " MvLOSApp/<version>" to the user
// agent, so the page can show hints (`inCloudApp`) and link to `mvlosapp://chooser`, which the app
// turns into its mode chooser. Neither grants anything: a page can claim the user agent too.

type MvlosAppPlugin = { info(): Promise<{ mode: 'local'; savedServer: string | null; version: string }>; openChooser(): Promise<void> }
type CapacitorGlobal = { isNativePlatform?: () => boolean; Plugins?: { MvlosApp?: MvlosAppPlugin } }

const plugin = (): MvlosAppPlugin | null => {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  return cap?.isNativePlatform?.() && cap.Plugins?.MvlosApp ? cap.Plugins.MvlosApp : null
}

/** Whether this page is the Android app's on-device desktop. */
export const inNativeApp = () => plugin() !== null

/** Back to the app's screen for choosing on-device or a cloud server. */
export const openAppChooser = () => plugin()?.openChooser().catch(() => {})

/** Whether this page is a server's desktop inside the Android app's cloud mode (hints only, see above). */
export const inCloudApp = () => typeof navigator !== 'undefined' && / MvLOSApp\/[\w.-]+( MvLOSPush\/1)?$/.test(navigator.userAgent)

/** In the cloud app of a build that can show push notifications for this server (a hint, like the above: the app decides). */
export const appPushOffered = () => typeof navigator !== 'undefined' && / MvLOSApp\/[\w.-]+ MvLOSPush\/1$/.test(navigator.userAgent)

/** In the app's cloud mode: the app's own screen for turning push notifications on (the app asks and decides, not this page). */
export const APP_PUSH_SETTINGS = 'mvlosapp://push'

/** In the app's cloud mode: back to its on-device / cloud chooser. */
export const CLOUD_APP_CHOOSER = 'mvlosapp://chooser'
