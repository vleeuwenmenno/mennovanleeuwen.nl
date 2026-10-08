import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initialLayout, placement, Shell } from './os/Shell'
import { applyDockReserve } from './os/dockPrefs'
import { initTheme } from './os/theme'
import { WindowManagerProvider } from './os/wm'
import './styles.css'

initTheme()
applyDockReserve()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WindowManagerProvider initial={initialLayout} placement={placement}>
      <Shell />
    </WindowManagerProvider>
  </StrictMode>,
)
