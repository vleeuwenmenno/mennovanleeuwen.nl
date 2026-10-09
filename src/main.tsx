import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { APP_META } from './os/apps'
import { loadAccount } from './os/account'
import { installContextMenuFallback } from './os/ContextMenu'
import { initialLayout, placement, Shell } from './os/Shell'
import { applyDockReserve } from './os/dockPrefs'
import { registerServiceWorker } from './os/pwa'
import { trackVisualViewport } from './os/viewport'
import { startSync } from './os/synced'
import { initTheme } from './os/theme'
import { WindowManagerProvider } from './os/wm'
import './styles.css'
import './home.css'

initTheme()
applyDockReserve()
registerServiceWorker()
trackVisualViewport()
startSync()
installContextMenuFallback()
void loadAccount()

const isApp = (app: string) => app in APP_META && app !== 'trash'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WindowManagerProvider initial={initialLayout} placement={placement} isApp={isApp}>
      <Shell />
    </WindowManagerProvider>
  </StrictMode>,
)
