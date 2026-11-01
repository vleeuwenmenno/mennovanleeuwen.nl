// The Android app (mobile/, Capacitor): its on-device mode runs this same frontend from
// https://localhost inside the app, without a server. The app exposes one small native plugin,
// MvlosApp, to that bundled page only: `info()` and `openChooser()` (back to the app's
// on-device / cloud server screen). Nothing else crosses: no tokens, no URLs, no storage.
// In a browser, the PWA or the app's cloud mode (a browser tab) none of this exists.

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
