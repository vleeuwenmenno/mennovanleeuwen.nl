import { flagPref } from './localPref'
import { isMobile, useIsMobile } from './useIsMobile'
import { useMediaQuery } from './useMediaQuery'

// Settings → Windows → "Open new windows maximized": on a phone or a touch screen, every app
// window opened from then on fills the screen. Per device, since a phone and a desktop want
// different things; with storage blocked it still applies until the page closes.
export const openMaximizedPref = flagPref('mvlos.windows.openMaximized', false)

const COARSE = '(pointer: coarse)'

/** A phone-sized screen or a touch screen: where maximized windows cover the whole screen (styles.css). */
export const isTouchScreen = () => isMobile() || (typeof matchMedia === 'function' && matchMedia(COARSE).matches)

/** isTouchScreen, kept in step with the viewport and the pointer. */
export function useTouchScreen() {
  const mobile = useIsMobile()
  const coarse = useMediaQuery(COARSE)
  return mobile || coarse
}

/** Whether a window opened right now should open maximized. */
export const opensMaximized = () => openMaximizedPref.get() && isTouchScreen()
