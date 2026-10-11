import { useEffect, useState } from 'react'

/** Below the phone breakpoint, where app windows become full-screen sheets (styles.css). */
export const isMobile = () => window.innerWidth < 720

/** True below the phone breakpoint, kept in step with the viewport. */
export function useIsMobile() {
  const [mobile, setMobile] = useState(isMobile)
  useEffect(() => {
    const sync = () => setMobile(isMobile())
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])
  return mobile
}
