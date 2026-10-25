import { useEffect, useState } from 'react'
import { ask } from '../os/Dialogs'
import { Select } from '../os/Select'
import { SecretInput } from '../os/SecretInput'
import { loadAccount } from '../os/account'
import { forgetAgentModels } from '../data/agents'
import { cancelChatGPTSignIn, deleteIcon, finishChatGPTSignIn, getOpenAIImages, iconSrc, listIcons, regenerateIcon, removeOpenAIKey, saveOpenAIImages, setOpenAIKey, signOutChatGPT, startChatGPTSignIn, type IconInfo, type OpenAIImagesView, type OpenAIProvider } from '../data/openaiImages'

// Settings → Agents → Images, the OpenAI part: where the GPT images tool gets its pictures (an
// OpenAI API key, or Sign in with ChatGPT after a plain warning), the model, today's count, and
// the icon library the agent draws diagram icons into (server/agentOpenAI.ts).

const PROVIDERS: { value: OpenAIProvider; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'apikey', label: 'OpenAI API key' },
  { value: 'chatgpt', label: 'Sign in with ChatGPT' },
]

const RISK =
  'This uses an unofficial sign-in: the one the Codex command-line tool uses. OpenAI does not permit it for hosted apps like this one, and OpenAI could restrict or ban your ChatGPT account for it. Pictures count against your ChatGPT plan’s image limits. An OpenAI API key is the safe option.'

export function AgentsOpenAISettings() {
  const [view, setView] = useState<OpenAIImagesView | null>(null)
  const [key, setKey] = useState('')
  const [signIn, setSignIn] = useState<{ url: string } | null>(null)
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    getOpenAIImages().then(setView, (e: Error) => setError(e.message))
  }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      // Signed in or out, a key added or gone: the Agents app's models and its start screen follow.
      forgetAgentModels()
      void loadAccount()
      setBusy(false)
    }
  }
  if (!view) return <section className="set-section image-group">{error ? <p className="t-red copyable" role="alert">{error}</p> : <p className="muted">Loading…</p>}</section>

  const beginSignIn = async () => {
    const ok = await ask({ title: 'Sign in with ChatGPT?', body: <p>{RISK}</p>, confirm: 'I understand, sign in', cancel: 'Cancel', danger: true })
    if (!ok) return
    await run(async () => {
      const started = await startChatGPTSignIn()
      setSignIn({ url: started.url })
      setPasted('')
      window.open(started.url, '_blank', 'noopener')
    })
  }
  const finish = () =>
    run(async () => {
      setView(await finishChatGPTSignIn(pasted))
      setSignIn(null)
      setPasted('')
      setNotice('Signed in')
    })

  return (
    <div className="set-form ws-form image-settings-form">
      <section className="set-section image-group" aria-labelledby="openai-images">
        <h4 className="set-subhead" id="openai-images">OpenAI pictures and icons</h4>
        <p className="muted set-help">For the GPT images tool: a picture when you ask for one, and small icons for diagrams and recipes. The agents run on Ollama Cloud, which makes no pictures, so these come from OpenAI’s gpt-image.</p>
        <ul className="set-list">
          <li className="set-row">
            <span className="set-row-text">
              <strong>Pictures from</strong>
              <span className="muted">{view.ready ? `Ready: ${view.usage.today} of ${view.usage.limit} pictures in the last 24 hours` : view.provider === 'off' ? 'Off: the agent cannot make pictures with OpenAI' : 'Not set up yet: add a key or sign in below'}</span>
            </span>
            <Select className="set-select" aria-label="Where pictures come from" value={view.provider} disabled={busy} options={PROVIDERS} onChange={(provider) => void run(async () => setView(await saveOpenAIImages({ provider })))} />
          </li>
          <li className={`set-row ${view.provider === 'off' ? 'is-off' : ''}`}>
            <span className="set-row-text">
              <strong>Model</strong>
              <span className="muted">The gpt-image model for both ways in. Icons are always drawn at low quality, which is cheapest</span>
            </span>
            <Select className="set-select" aria-label="Image model" value={view.model} disabled={busy} options={view.models.map((m) => ({ value: m, label: m }))} onChange={(model) => void run(async () => setView(await saveOpenAIImages({ model })))} />
          </li>
        </ul>

        <h4 className="set-subhead">OpenAI API key</h4>
        <p className="muted set-help">
          {view.apiKey === 'server' ? 'Using OPENAI_API_KEY from the server. ' : view.apiKey ? 'A key is saved. ' : ''}
          Pictures are billed to that OpenAI account. The key is checked with OpenAI, stored encrypted, and never shown again or sent to the agent.
        </p>
        <label>
          <span>API key</span>
          <SecretInput value={key} onChange={(e) => setKey(e.target.value)} placeholder={view.apiKey === 'settings' ? 'Saved; paste a new one to replace it' : 'sk-…'} disabled={busy} />
        </label>
        <div className="set-actions">
          <button type="button" className="btn btn-small btn-primary" disabled={busy || !key.trim()} onClick={() => void run(async () => (setView(await setOpenAIKey(key.trim())), setKey(''), setNotice('Key saved')))}>
            Save key
          </button>
          {view.apiKey === 'settings' && (
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(async () => (setView(await removeOpenAIKey()), setNotice('Key removed')))}>
              Remove key
            </button>
          )}
        </div>

        <h4 className="set-subhead">Sign in with ChatGPT</h4>
        <p className="openai-risk" role="note">
          <strong>Unofficial.</strong> Uses your ChatGPT plan instead of a key, through the Codex sign-in. OpenAI does not permit it for hosted apps and could restrict or ban the account. An API key is the safe option.
        </p>
        {view.chatgpt ? (
          <ul className="set-list">
            <li className="set-row">
              <span className="set-row-text">
                <strong>Signed in{view.chatgpt.email ? ` as ${view.chatgpt.email}` : ''}</strong>
                <span className="muted">{view.chatgpt.plan ? `ChatGPT ${view.chatgpt.plan} plan. ` : ''}The tokens stay on the server and are refreshed there</span>
              </span>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(async () => (setView(await signOutChatGPT()), setNotice('Signed out')))}>
                Sign out
              </button>
            </li>
          </ul>
        ) : signIn || view.signingIn ? (
          <div className="openai-signin">
            <ol className="openai-steps">
              <li>
                Sign in to ChatGPT in the tab that opened.{' '}
                {signIn && (
                  <a href={signIn.url} target="_blank" rel="noopener noreferrer">
                    Open it again
                  </a>
                )}
              </li>
              <li>
                It ends on a page that does not load, at <code>localhost:1455</code>. That is expected: copy the whole address from the address bar.
              </li>
              <li>Paste it here, within 15 minutes.</li>
            </ol>
            <input className="openai-paste" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://localhost:1455/auth/callback?code=…" spellCheck={false} autoComplete="off" aria-label="The address the sign-in ended on" disabled={busy} onKeyDown={(e) => e.key === 'Enter' && pasted.trim() && void finish()} />
            <div className="set-actions">
              <button type="button" className="btn btn-small btn-primary" disabled={busy || !pasted.trim()} onClick={() => void finish()}>
                {busy ? 'Signing in…' : 'Finish signing in'}
              </button>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(async () => (setView(await cancelChatGPTSignIn()), setSignIn(null), setPasted('')))}>
                Cancel
              </button>
              {!signIn && (
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => void beginSignIn()}>
                  Start again…
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="set-actions">
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void beginSignIn()}>
              Sign in with ChatGPT…
            </button>
          </div>
        )}
        {notice && <p className="muted image-notice" role="status">{notice}</p>}
        {error && <p className="t-red copyable" role="alert">{error}</p>}
      </section>
      <section className="set-section image-group" aria-labelledby="icon-library">
        <h4 className="set-subhead" id="icon-library">Icon library</h4>
        <p className="muted set-help">Icons the agent drew for diagrams, by name. It reuses them instead of drawing them again; diagrams refer to them as icon:name. Drawing one again uses its saved description and counts as a picture.</p>
        <IconLibrary ready={view.ready} />
      </section>
    </div>
  )
}

function IconLibrary({ ready }: { ready: boolean }) {
  const [icons, setIcons] = useState<IconInfo[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    listIcons().then(setIcons, (e: Error) => setError(e.message))
  }, [])
  const act = async (slug: string, action: () => Promise<IconInfo[]>) => {
    setBusy(slug)
    setError('')
    try {
      setIcons(await action())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  if (!icons) return error ? <p className="t-red copyable" role="alert">{error}</p> : <p className="muted">Loading…</p>
  return (
    <>
      {!icons.length && <p className="muted">No icons yet. They appear here when the agent draws one, for example for a crafting recipe or a flow diagram.</p>}
      {icons.length > 0 && (
        <ul className="icon-library">
          {icons.map((i) => (
            <li key={i.slug} className={busy === i.slug ? 'is-busy' : ''}>
              <img src={iconSrc(i)} alt={i.prompt} width={64} height={64} loading="lazy" draggable={false} />
              <span className="icon-library-text">
                <strong title={`icon:${i.slug}`}>{i.slug}</strong>
                <span className="muted" title={i.prompt}>
                  {i.prompt}
                </span>
              </span>
              <span className="icon-library-actions">
                <button type="button" className="btn btn-small" disabled={!!busy || !ready} title={ready ? 'Draw it again from its description' : 'Set up OpenAI pictures above first'} onClick={() => void act(i.slug, () => regenerateIcon(i.slug))}>
                  {busy === i.slug ? 'Drawing…' : 'Redraw'}
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={!!busy}
                  onClick={async () => {
                    if (await ask({ title: `Delete the icon ${i.slug}?`, body: 'Diagrams that use it can no longer show it. The agent can draw it again later.', confirm: 'Delete', danger: true })) void act(i.slug, () => deleteIcon(i.slug))
                  }}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="t-red copyable" role="alert">{error}</p>}
    </>
  )
}
