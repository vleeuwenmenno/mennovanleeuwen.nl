import { useState } from 'react'
import { useMediaQuery } from '../../../os/useMediaQuery'
import { useCoarse } from './Touch'
import './touch-menus.css'

// A phone held upright leaves the battle and the galaxy map very little width: a small banner
// suggests turning it, until it's dismissed (remembered in this browser).

const KEY = 'mvlos.empires.rotateHint'

function dismissed() {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function RotateHint() {
  const coarse = useCoarse()
  const upright = useMediaQuery('(orientation: portrait) and (max-width: 719px)')
  const [gone, setGone] = useState(dismissed)
  if (!coarse || !upright || gone) return null
  const dismiss = () => {
    setGone(true)
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      // Private mode: it shows again next time.
    }
  }
  return (
    <div className="ew-rotatehint" role="status" data-nodrag>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="7" y="3" width="10" height="18" rx="2" />
        <path d="M20 9a8 8 0 0 1 0 6M20 15l-2.2-.4M20 15l.6-2.1" />
      </svg>
      <span>Turn your phone sideways for more room.</span>
      <button onClick={dismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  )
}
