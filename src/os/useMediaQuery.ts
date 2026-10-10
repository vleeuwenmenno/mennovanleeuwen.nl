import { useSyncExternalStore } from 'react'

/** Whether a CSS media query matches, kept in step as it changes (a rotated phone, a resized window). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (l) => {
      const m = matchMedia(query)
      m.addEventListener('change', l)
      return () => m.removeEventListener('change', l)
    },
    () => matchMedia(query).matches,
  )
}
