import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { APP_META } from './os/apps'
import { loadAccount } from './os/account'
import { installContextMenuFallback, installTouchContextMenu } from './os/ContextMenu'
import { appHere } from './os/cvMode'
import { initialLayout, placement, Shell } from './os/Shell'
import { applyDockReserve } from './os/dockPrefs'
import { registerServiceWorker } from './os/pwa'
import { trackVisualViewport } from './os/viewport'
import { startSync } from './os/synced'
import { startBrowserFiles } from './data/browserfs'
import { initTheme } from './os/theme'
import { WindowManagerProvider, type AppId } from './os/wm'
import './styles.css'
import './home.css'
import './mobile.css'

initTheme()
applyDockReserve()
registerServiceWorker()
trackVisualViewport()
startSync()
startBrowserFiles()
installContextMenuFallback()
installTouchContextMenu()
void loadAccount()

// Saved windows of apps that don't exist on this page (the CV apps away from /cv) are dropped.
const isApp = (app: string) => app in APP_META && app !== 'trash' && appHere(app as AppId)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WindowManagerProvider initial={initialLayout} placement={placement} isApp={isApp}>
      <Shell />
    </WindowManagerProvider>
  </StrictMode>,
)
