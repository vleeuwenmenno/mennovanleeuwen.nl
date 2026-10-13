import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { APP_META } from './os/apps'
import { loadAccount } from './os/account'
import { installContextMenuFallback, installTouchContextMenu } from './os/ContextMenu'
import { appHere } from './os/cvMode'
import { playMode } from './os/playMode'
import { PlayPage } from './apps/games/Play'
import { initialLayout, placement, Shell, winTitle } from './os/Shell'
import { applyDockReserve } from './os/dockPrefs'
import { startPimLinks } from './os/pimLinks'
import { registerServiceWorker } from './os/pwa'
import { trackVisualViewport } from './os/viewport'
import { startSync } from './os/synced'
import { startBrowserFiles } from './data/browserfs'
import { initTheme } from './os/theme'
import { WindowManagerProvider, type AppId } from './os/wm'
import './styles.css'
import './home.css'
import './mobile.css'

// A game's direct link (/play/<game>, src/os/playMode.ts) is the game alone: the theme, the
// installed app, menus and long presses, and the account and syncing (high scores and saves follow
// a signed-in player), but no desktop, dock or browser files.
const play = playMode()

initTheme()
if (!play) applyDockReserve()
registerServiceWorker()
trackVisualViewport()
startSync()
if (!play) startBrowserFiles()
// Mail, Contacts, Calendar and Tasks plugged into each other (src/os/pimLinks.tsx).
if (!play) startPimLinks()
installContextMenuFallback()
installTouchContextMenu()
void loadAccount()

// Saved windows of apps that don't exist on this page (the CV apps away from /cv) are dropped.
const isApp = (app: string) => app in APP_META && app !== 'trash' && appHere(app as AppId)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {play ? (
      <PlayPage />
    ) : (
      <WindowManagerProvider initial={initialLayout} placement={placement} isApp={isApp} nameOf={winTitle}>
        <Shell />
      </WindowManagerProvider>
    )}
  </StrictMode>,
)
