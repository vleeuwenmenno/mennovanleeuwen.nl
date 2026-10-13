import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { APP_META } from './os/apps'
import { loadAccount } from './os/account'
import { installContextMenuFallback, installTouchContextMenu } from './os/ContextMenu'
import { playMode } from './os/playMode'
import { PlayPage } from './apps/games/Play'
import { initialLayout, placement, Shell, winTitle } from './os/Shell'
import { applyDockReserve } from './os/dockPrefs'
import { startNoteEventLinks } from './os/noteEventLinks'
import { startPimLinks } from './os/pimLinks'
import { registerServiceWorker } from './os/pwa'
import { installSelectionRules } from './os/selection'
import { trackVisualViewport } from './os/viewport'
import { startSync } from './os/synced'
import { startBrowserFiles } from './data/browserfs'
import { initTheme } from './os/theme'
import { WindowManagerProvider } from './os/wm'
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
// Notes linked to calendar events: meeting notes (src/os/noteEventLinks.tsx).
if (!play) startNoteEventLinks()
installContextMenuFallback()
installTouchContextMenu()
// Only text meant to be read can be selected; Ctrl+A and dragged pictures follow (src/os/selection.ts).
installSelectionRules()
void loadAccount()

// Saved windows of apps that no longer exist are dropped. (The CV apps' windows from /cv are kept
// aside on the plain desktop by the window manager: see WinState.anywhere in src/os/wm.tsx.)
const isApp = (app: string) => app in APP_META && app !== 'trash'

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
