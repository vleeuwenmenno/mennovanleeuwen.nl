import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount } from '../../os/account'
import { startAgentWatch } from '../../os/agentWatch'
import { threadInPath } from '../../os/agentsPageMode'
import { ContextMenuHost } from '../../os/ContextMenu'
import { Dialogs, tell } from '../../os/Dialogs'
import { FolderPicker } from '../../os/FolderPicker'
import { Notifications } from '../../os/Notifications'
import { notify } from '../../os/notify'
import { startNotifyStream } from '../../os/notifyStream'
import { REFUSED } from '../../os/Shell'
import { SignInButtons } from '../../os/SignInButtons'
import { SoloWindowProvider, type AppId, type WinState } from '../../os/wm'
import { Agents } from '../Agents'

// The Agents page (/agents and /agents/<thread>, src/os/agentsPageMode.ts): the Agents app on a page
// of its own, laid out like a chat website (Agents.tsx with `page`, agentsPage/PageLayout.tsx). The
// app runs in a window manager of one window, as a game does on its direct link (Play.tsx); that
// window's props are this page's state, so what asks the app to open a thread or a tab works the
// same here (notifications, a subagent's link, Settings → Agents). Other apps open MvL OS in a new
// tab, at that app. Signed out, the page is a sign-in screen; what an account may use stays
// decided by the server, as in the window.

/** The props an app may take from an address (/?open=…, src/os/openUrl.ts): anything else is not carried to the new tab. */
const CARRIED: Partial<Record<AppId, string[]>> = {
  videostudio: ['project'],
  tasks: ['task'],
  mail: ['account', 'email', 'message'],
  calendar: ['date', 'event'],
  contacts: ['contact'],
  settings: ['section'],
}

/** Another app, asked for from the page: MvL OS at that app, in a new tab. */
function openInOs(app: AppId, props?: WinState['props']) {
  // A picture's Preview: the picture itself, which the browser shows on its own.
  if (app === 'preview' && props?.src) return void window.open(props.src, '_blank', 'noopener')
  const q = new URLSearchParams({ open: app })
  for (const k of CARRIED[app] ?? []) if (props?.[k]) q.set(k, props[k])
  window.open(`/?${q}`, '_blank', 'noopener')
}

/** Back from the sign-in page: /agents?auth=ok|error|off|full|closed|banned. */
const SIGNED_IN: Record<string, { title: string; body?: string }> = {
  ok: { title: 'Signed in' },
  error: { title: 'Sign-in failed', body: 'The sign-in did not complete. Try again.' },
  off: { title: 'Sign-in is not set up', body: 'This server has no sign-in configured for that.' },
  denied: { title: 'Not signed in', body: 'Access was not granted.' },
}
function useSignInResult() {
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const auth = params.get('auth')
    if (auth === null) return
    const refused = REFUSED[auth]
    // Not cancelled on unmount: React's development mode mounts twice, and the address is clean by the second.
    setTimeout(() => (refused ? void tell(refused(params.get('reason'))) : SIGNED_IN[auth] && notify(SIGNED_IN[auth])), 600)
    history.replaceState(null, '', location.pathname)
  }, [])
}

export function AgentsPage() {
  useSignInResult()
  const account = useAccount()
  useEffect(() => {
    document.title = 'Agents · MvL OS'
  }, [])
  // Answers that land while the page is in view pop up here (and open their thread here when
  // clicked); with no page in view they come as push notifications, as from the desktop.
  const signedIn = account.status === 'user'
  useEffect(() => {
    if (signedIn) startNotifyStream(), startAgentWatch()
  }, [signedIn])
  return (
    <>
      {account.status === 'loading' ? <div className="agp-blank" aria-busy /> : account.status === 'user' ? <AgentsOnPage /> : <SignInScreen off={account.status !== 'anon'} />}
      <ContextMenuHost />
      <Notifications />
      <Dialogs />
      <FolderPicker />
    </>
  )
}

function SignInScreen({ off }: { off: boolean }) {
  return (
    <div className="agp-signin">
      <div className="agp-signin-card">
        <h1>Agents</h1>
        <p className="muted">A research assistant that searches the web, reads what it finds and works in your files, with a memory of its own.</p>
        {off ? (
          <p className="muted">Signing in is not available on this server right now.</p>
        ) : (
          <div className="agp-signin-buttons">
            <SignInButtons className="btn btn-primary agp-signin-btn" />
          </div>
        )}
        <p className="agp-signin-foot muted">
          Part of <a href="/">MvL OS</a>.
        </p>
      </div>
    </div>
  )
}

function AgentsOnPage() {
  // The thread in the address opens first; later the app keeps the address up to date itself.
  const [props, setPropsState] = useState<WinState['props']>(() => {
    const thread = threadInPath()
    return thread ? { thread, t: String(Date.now()) } : {}
  })
  const setProps = useCallback((p: WinState['props']) => setPropsState((was) => ({ ...was, ...p })), [])
  const open = useCallback(
    (app: AppId, p?: WinState['props']) => {
      if (app === 'agents') return setProps({ ...p, t: p?.t ?? String(Date.now()) })
      // Settings → Agents is part of the app here.
      if (app === 'settings' && p?.section === 'agents') return setProps({ tab: 'settings', t: String(Date.now()) })
      openInOs(app, p)
    },
    [setProps],
  )
  // Notifications and links outside React ask for an app with mvlos:open, as on the desktop (Shell.tsx).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<AppId | { app: AppId; props?: WinState['props'] }>).detail
      if (typeof d === 'string') open(d)
      else if (d) open(d.app, d.props)
    }
    window.addEventListener('mvlos:open', onOpen)
    return () => window.removeEventListener('mvlos:open', onOpen)
  }, [open])
  const win = useMemo<WinState>(() => ({ pid: 1, app: 'agents', x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, z: 1, minimized: false, maximized: true, props, openedAt: 0 }), [props])
  return (
    <SoloWindowProvider win={win} open={open} setProps={setProps}>
      <div className="agp-root">
        <Agents win={win} page />
      </div>
    </SoloWindowProvider>
  )
}
