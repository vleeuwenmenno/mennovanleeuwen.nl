import { useEffect, useState } from 'react'
import { listThreads, type Thread } from '../data/agents'
import { signIn, useAccount } from '../os/account'
import { useWM, type WinState } from '../os/wm'
import { ImageStudio } from './ImageStudio'

// The Image Studio in its own window (it used to be a view of Agents). It runs on the account's
// own ComfyUI (Settings → Image & Video Studio), so no chat model is needed; with one, "Send to
// chat" offers the account's threads and opens the picked one in Agents.

export function ImageStudioApp({ win: _win }: { win: WinState }) {
  const account = useAccount()
  const wm = useWM()
  const canChat = account.status === 'user' && (!!account.integrations.ollama || !!account.integrations.openai)
  const [threads, setThreads] = useState<Thread[]>([])
  useEffect(() => {
    if (!canChat) return
    const load = () => void listThreads(false).then(setThreads, () => {})
    load()
    // Threads started or renamed elsewhere since: read again when the tab comes back.
    const onVisible = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [canChat])
  if (account.status === 'loading') return <div className="nb-blank muted">Loading…</div>
  if (account.status !== 'user')
    return (
      <div className="nb-blank">
        <p className="muted">The Image Studio generates pictures with your own ComfyUI server, for signed-in users.</p>
        {account.status === 'anon' && (
          <button className="btn btn-primary" onClick={signIn}>
            Sign in with GitHub
          </button>
        )}
      </div>
    )
  return (
    <div className="studio-alone">
      <ImageStudio
        threads={canChat ? threads : null}
        // A new thread picks up the draft the picture was added to (key 'new').
        onOpenThread={(id) => wm.open('agents', { thread: id ?? 'new', t: String(Date.now()) })}
        onSettings={() => wm.open('settings', { section: 'studio', t: String(Date.now()) })}
      />
    </div>
  )
}
