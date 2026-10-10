import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { AGENTS_MD } from '../data/agentsPrompt'
import { agentModels, agentSettings, getDefaults, getPrompt, listMemories, setAgentSettings, TOOL_GROUPS, tokenCount, useAgentSettings, type ModelInfo, type Mode, type PromptInfo } from '../data/agents'
import { useMounts, whereIs } from '../data/mounts'
import { getWebSearch, PROVIDERS, resetWebSearch, saveWebSearch, testWebSearch, type Provider, type ResultMap, type SearchResult, type WebSearchInput, type WebSearchView } from '../data/websearch'
import { getLibraries, parseSf, useLibraries } from '../data/seafile'
import { useAccount } from '../os/account'
import { Select } from '../os/Select'
import { useWM } from '../os/wm'
import { writeFile } from '../terminal/fs'
import { HOME } from '../terminal/vfs'

// The Agents app's settings, laid out like the rest of Settings: Ollama Cloud, the models, the web
// search provider, what a new thread starts with, and the system prompt in ~/AGENTS.md. Shown as
// the Agents pane in Settings and inside the Agents app (its ⚙), the same component in both.

const Toggle = ({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) => (
  <button role="switch" aria-checked={on} aria-label={label} className={`set-toggle ${on ? 'is-on' : ''}`} disabled={disabled} onClick={() => onChange(!on)} />
)

const MODE_LABEL: Record<Mode, string> = { quick: 'Quick', deep: 'Deep research' }

/**
 * Keeps the server told where ~/AGENTS.md is: in Seafile when Seafile is home (/etc/fstab says,
 * and only the browser has the mount table), or nowhere (the built-in one). Used wherever the
 * Agents settings or the app are open.
 */
export function usePromptLocation() {
  const mountsVersion = useMounts()
  const { libraries } = useLibraries()
  const { promptFile } = useAgentSettings()
  useEffect(() => {
    const w = whereIs(`${HOME}/AGENTS.md`)
    if (w.kind === 'missing' && w.loading) return
    const at = w.kind === 'sf' ? parseSf(w.sf) : null
    const next = at ? { repo: at.repo, path: at.p } : null
    if (JSON.stringify(next) !== JSON.stringify(agentSettings().promptFile)) setAgentSettings({ promptFile: next })
  }, [mountsVersion, libraries, promptFile])
}

/** The categories, in order: each a page of its own, picked from a sidebar or tabs. */
type SectionId = 'general' | 'models' | 'threads' | 'search' | 'prompt'
const icon = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
)
const SECTIONS: { id: SectionId; label: string; blurb: string; icon: ReactNode }[] = [
  { id: 'general', label: 'General', blurb: 'The Ollama Cloud connection Agents runs on, and what it remembers.', icon: icon(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" /></>) },
  { id: 'models', label: 'Models', blurb: 'Which model a new Quick or Deep thread gets, and which one names threads.', icon: icon(<><rect x="4" y="4" width="16" height="16" /><path d="M9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" /></>) },
  { id: 'threads', label: 'New threads', blurb: 'The mode and tools a new thread starts with.', icon: icon(<path d="M4 5h16v11H9l-5 4z" />) },
  { id: 'search', label: 'Web search', blurb: 'Where the agent searches the web. Reading pages always goes through Ollama.', icon: icon(<><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>) },
  { id: 'prompt', label: 'System prompt', blurb: 'The instructions every thread starts with, from ~/AGENTS.md.', icon: icon(<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5" />) },
]
const SECTION_KEY = 'mvlos.agents.settings'
const storedSection = (): SectionId => {
  try {
    const v = localStorage.getItem(SECTION_KEY)
    return SECTIONS.some((x) => x.id === v) ? (v as SectionId) : 'general'
  } catch {
    return 'general'
  }
}

/**
 * The settings, by category: a sidebar of their own in the Agents window, tabs inside Settings
 * (which has its sidebar already). A narrow window shows the sidebar as tabs too.
 */
export function AgentsSettings({ layout = 'tabs' }: { layout?: 'sidebar' | 'tabs' }) {
  const [section, setSection] = useState<SectionId>(storedSection)
  const pick = (id: SectionId) => {
    setSection(id)
    try {
      localStorage.setItem(SECTION_KEY, id)
    } catch {
      /* not remembered */
    }
  }
  const wm = useWM()
  const account = useAccount()
  const settings = useAgentSettings()
  const [models, setModels] = useState<ModelInfo[]>([])
  const [auto, setAuto] = useState<{ quick: string; deep: string; title: string } | null>(null)
  const [prompt, setPrompt] = useState<PromptInfo | null>(null)
  const [memories, setMemories] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  usePromptLocation()
  // Fresh each time the pane opens or the file is made, so an edit or upload shows at once.
  const load = useCallback(() => getPrompt(true).then(setPrompt, (e: Error) => setError(e.message)), [])
  useEffect(() => {
    if (!account.integrations.ollama) return
    agentModels().then(setModels, () => {})
    getDefaults().then(setAuto, () => {})
    listMemories().then((m) => setMemories(m.length), () => {})
  }, [account.integrations.ollama])
  useEffect(() => void load(), [load, settings.promptFile])

  if (account.status !== 'user') return <p className="muted">Sign in first: Agents is the owner's research assistant.</p>

  const inSeafile = whereIs(`${HOME}/AGENTS.md`).kind === 'sf'
  const library = prompt?.repo ? (getLibraries()?.find((l) => l.id === prompt.repo)?.name ?? 'Seafile') : null
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      await writeFile(HOME, `${HOME}/AGENTS.md`, AGENTS_MD, false)
      await new Promise((r) => setTimeout(r, 300))
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const open = (app: 'agents' | 'zed' | 'settings', props: Record<string, string>) => wm.open(app, { ...props, t: String(Date.now()) })

  /** A model picker: "Automatic" (with what that is now) or one of Ollama's models that can use tools. */
  const modelSelect = (value: string | null, fallback: string | undefined, onChange: (v: string | null) => void, label: string) => (
    <Select
      className="set-select"
      value={value ?? ''}
      onChange={(v) => onChange(v || null)}
      aria-label={label}
      disabled={!models.length}
      options={[
        { value: '', label: `Automatic${fallback ? ` (${fallback})` : ''}` },
        ...(value && !models.some((m) => m.name === value) ? [{ value, label: value, note: 'not offered now' }] : []),
        ...models.map((m) => ({ value: m.name, label: m.name, note: [m.contextLength ? tokenCount(m.contextLength) : '', m.vision ? 'sees pictures' : ''].filter(Boolean).join(' · ') || undefined })),
      ]}
    />
  )

  const status = !prompt
    ? 'Reading…'
    : prompt.source === 'seafile'
      ? `Yours, from Seafile: ${library} ${prompt.path}`
      : prompt.missing
        ? `Built in: your home folder (${library}) has no AGENTS.md yet`
        : prompt.error
          ? `Built in: ~/AGENTS.md could not be read (${prompt.error})`
          : 'Built in, read-only'

  const pages: Record<SectionId, ReactNode> = {
    general: (
      <>
      <h4 className="set-subhead">Ollama Cloud</h4>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>{account.integrations.ollama ? 'Connected' : 'Not connected'}</strong>
            <span className="muted">{account.integrations.ollama === 'server' ? 'With OLLAMA_API_KEY from the server' : account.integrations.ollama ? 'With a key saved in Integrations' : 'Agents needs an Ollama API key'}</span>
          </span>
          <button className="btn btn-small" onClick={() => open('settings', { section: 'integrations' })}>
            {account.integrations.ollama ? 'Integrations…' : 'Add a key…'}
          </button>
        </li>
      </ul>

      <h4 className="set-subhead">Memory</h4>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>{memories === null ? 'Remembered things' : `${memories} ${memories === 1 ? 'thing' : 'things'} remembered`}</strong>
            <span className="muted">Saved when you ask the agent to remember something; every thread starts with them</span>
          </span>
          <button className="btn btn-small" onClick={() => open('agents', { tab: 'memory' })}>
            Show
          </button>
        </li>
      </ul>
      </>
    ),
    models: (
      <>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>Quick</strong>
            <span className="muted">Fast answers: a small, quick model</span>
          </span>
          {modelSelect(settings.quickModel, auto?.quick, (quickModel) => setAgentSettings({ quickModel }), 'Model for Quick threads')}
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Deep research</strong>
            <span className="muted">Many rounds of searching and reading: a strong reasoner</span>
          </span>
          {modelSelect(settings.deepModel, auto?.deep, (deepModel) => setAgentSettings({ deepModel }), 'Model for Deep threads')}
        </li>
        <li className="set-row">
          <span className="set-row-text">
            <strong>Thread titles</strong>
            <span className="muted">Names new threads and suggests names when renaming</span>
          </span>
          {modelSelect(settings.titleModel, auto?.title, (titleModel) => setAgentSettings({ titleModel }), 'Model for thread titles')}
        </li>
      </ul>
      <p className="muted set-help">Ollama Cloud's models that can use tools, with their context window. A thread keeps the model it started with; change it in the thread's composer.</p>

      </>
    ),
    threads: (
      <>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>Mode</strong>
            <span className="muted">{settings.mode === 'deep' ? 'Researches first, then writes; takes minutes' : 'Answers straight away; takes seconds'}</span>
          </span>
          <Select
            className="set-select"
            value={settings.mode}
            onChange={(mode) => setAgentSettings({ mode })}
            aria-label="Mode for new threads"
            options={(['quick', 'deep'] as Mode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))}
          />
        </li>
        {TOOL_GROUPS.map((g) => (
          <li key={g.id} className={`set-row ${g.seafile && !account.seafile ? 'is-off' : ''}`}>
            <span className="set-row-text">
              <strong>{g.name}</strong>
              <span className="muted">{g.detail}</span>
            </span>
            <Toggle
              on={settings.tools.includes(g.id)}
              disabled={g.seafile && !account.seafile}
              onChange={(on) => setAgentSettings({ tools: on ? [...settings.tools, g.id] : settings.tools.filter((t) => t !== g.id) })}
              label={g.name}
            />
          </li>
        ))}
      </ul>
      <p className="muted set-help">Each thread can switch its own mode and tools in the composer; the last choice there becomes the default here.</p>

      </>
    ),
    search: <WebSearchSettings />,
    prompt: (
      <>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>{prompt?.source === 'seafile' ? 'Your own' : 'Built in'}</strong>
            <span className="muted">{status}</span>
          </span>
          {prompt?.missing ? (
            <button className="btn btn-small btn-primary" onClick={create} disabled={busy}>
              {busy ? 'Writing…' : 'Create it'}
            </button>
          ) : (
            <button className="btn btn-small" onClick={() => open('zed', { path: `${HOME}/AGENTS.md` })}>
              Open in Zed
            </button>
          )}
        </li>
      </ul>
      <p className="muted set-help">
        {inSeafile
          ? 'Edit it in Zed (Ctrl+S saves it to Seafile), or upload your own AGENTS.md to your home folder in Files or on Seafile. Changes apply from the next message.'
          : account.seafile
            ? 'Your home folder is the site’s own, so this file is read-only. Make Seafile your home (Integrations → Seafile) to write your own AGENTS.md there, then edit it in Zed or upload it on Seafile.'
            : 'This file is read-only here. Link Seafile and make it your home (Integrations) to write your own AGENTS.md, then edit it in Zed or upload it on Seafile.'}{' '}
        Today’s date, the mode and what the agent remembers are added after it; <code>{'{{owner}}'}</code> becomes your name.
      </p>
      {prompt && (
        <details className="agt-prompt-box">
          <summary className="muted">Show the prompt</summary>
          <pre className="agt-prompt">{prompt.text}</pre>
        </details>
      )}

      </>
    ),
  }
  const current = SECTIONS.find((x) => x.id === section)!

  return (
    <div className={`agt-set is-${layout}`}>
      <nav className="agt-set-nav" role="tablist" aria-label="Agents settings">
        {SECTIONS.map((x) => (
          <button key={x.id} role="tab" aria-selected={x.id === section} className={x.id === section ? 'is-on' : ''} onClick={() => pick(x.id)}>
            {x.icon}
            <span>{x.label}</span>
          </button>
        ))}
      </nav>
      <div className="agt-set-body" role="tabpanel">
        <h3 className="agt-set-title">{current.label}</h3>
        <p className="muted set-help">{current.blurb}</p>
        {pages[section]}
        {error && <p className="t-red">{error}</p>}
      </div>
    </div>
  )
}

// --- web search ----------------------------------------------------------------------------------

type KeyProvider = 'brave' | 'kagi' | 'tavily'
type HeaderDraft = { name: string; value: string; set: boolean }
/** The form: what the server sent, with every secret field empty until the owner types a new one. */
type Draft = { provider: Provider; searxngUrl: string; searxngAuth: string; keys: Record<KeyProvider, string>; url: string; method: 'GET' | 'POST'; body: string; headers: HeaderDraft[]; map: ResultMap }

const draftOf = (v: WebSearchView): Draft => ({
  provider: v.provider,
  searxngUrl: v.searxng.url,
  searxngAuth: '',
  keys: { brave: '', kagi: '', tavily: '' },
  url: v.custom.url,
  method: v.custom.method,
  body: v.custom.body,
  headers: v.custom.headers.map((h) => ({ name: h.name, value: '', set: h.set })),
  map: v.custom.map,
})

/** Only the chosen provider's part is sent: the server keeps the others as they were. */
function inputOf(d: Draft): WebSearchInput {
  switch (d.provider) {
    case 'searxng':
      return { provider: 'searxng', searxng: { url: d.searxngUrl, auth: d.searxngAuth } }
    case 'brave':
    case 'kagi':
    case 'tavily':
      return { provider: d.provider, [d.provider]: { key: d.keys[d.provider] } }
    case 'custom':
      return {
        provider: 'custom',
        custom: { url: d.url, method: d.method, body: d.body, headers: d.headers.filter((h) => h.name.trim() || h.value).map(({ name, value }) => ({ name, value })), map: d.map },
      }
    default:
      return { provider: 'ollama' }
  }
}

const providerLabel = (p: Provider) => PROVIDERS.find((o) => o.value === p)?.label ?? p
const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
const SAVED = 'saved; type to replace'

const KEY_HELP: Record<KeyProvider, { href: string; where: string }> = {
  brave: { href: 'https://api-dashboard.search.brave.com/app/keys', where: 'Brave Search API → API keys' },
  kagi: { href: 'https://kagi.com/api/keys', where: 'kagi.com → API keys' },
  tavily: { href: 'https://app.tavily.com/home', where: 'app.tavily.com' },
}

/** Which search engine the agent's web_search uses. Reading pages stays on Ollama either way. */
function WebSearchSettings() {
  const [view, setView] = useState<WebSearchView | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [testing, setTesting] = useState(false)
  const [found, setFound] = useState<{ provider: Provider; results: SearchResult[]; ms: number } | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  useEffect(() => {
    getWebSearch().then(
      (v) => (setView(v), setDraft(draftOf(v))),
      (e: Error) => setError(e.message),
    )
  }, [])

  if (!view || !draft) return error ? <p className="t-red">{error}</p> : null

  // A test result belongs to the provider it came from: switching clears it.
  const edit = (patch: Partial<Draft>) => {
    if (patch.provider && patch.provider !== draft.provider) setFound(null)
    setDraft({ ...draft, ...patch })
    setNotice(null)
  }
  const dirty = JSON.stringify(inputOf(draft)) !== JSON.stringify(inputOf(draftOf(view)))
  const run = async (fn: () => Promise<WebSearchView>, done: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const v = await fn()
      setView(v)
      setDraft(draftOf(v))
      setNotice(done)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(() => saveWebSearch(inputOf(draft)), 'Saved')
  }
  const test = async (e: FormEvent) => {
    e.preventDefault()
    setTesting(true)
    setTestError(null)
    setFound(null)
    try {
      setFound(await testWebSearch(query, inputOf(draft)))
    } catch (err) {
      setTestError((err as Error).message)
    } finally {
      setTesting(false)
    }
  }
  const header = (i: number, patch: Partial<HeaderDraft>) => edit({ headers: draft.headers.map((h, j) => (j === i ? { ...h, ...patch } : h)) })
  const p = draft.provider

  return (
    <>
      <ul className="set-list">
        <li className="set-row">
          <span className="set-row-text">
            <strong>Provider</strong>
            <span className="muted">
              In use: {providerLabel(view.provider)}
              {dirty ? ' · changes not saved yet' : ''}
            </span>
          </span>
          <Select className="set-select" value={p} onChange={(provider) => edit({ provider })} aria-label="Web search provider" options={PROVIDERS} />
        </li>
      </ul>

      <form className="set-form ws-form" onSubmit={save}>
        {p === 'searxng' && (
          <>
            <label>
              <span>Instance URL</span>
              <input value={draft.searxngUrl} onChange={(e) => edit({ searxngUrl: e.target.value })} placeholder="https://searx.example.com" spellCheck={false} autoComplete="off" required />
            </label>
            <label>
              <span>Authorization</span>
              <input type="password" value={draft.searxngAuth} onChange={(e) => edit({ searxngAuth: e.target.value })} placeholder={view.searxng.auth ? SAVED : 'optional, sent as the Authorization header'} autoComplete="off" />
            </label>
          </>
        )}
        {(p === 'brave' || p === 'kagi' || p === 'tavily') && (
          <label>
            <span>API key</span>
            <input
              type="password"
              value={draft.keys[p]}
              onChange={(e) => edit({ keys: { ...draft.keys, [p]: e.target.value } })}
              placeholder={view[p].key ? SAVED : `${providerLabel(p)} API key`}
              autoComplete="off"
              required={!view[p].key}
            />
          </label>
        )}
        {p === 'custom' && (
          <>
            <label>
              <span>URL template</span>
              <input value={draft.url} onChange={(e) => edit({ url: e.target.value })} placeholder="https://api.example.com/search?q={query}&n={count}" spellCheck={false} autoComplete="off" required />
            </label>
            <div className="ws-field">
              <span>Method</span>
              <Select className="ws-method" value={draft.method} onChange={(method) => edit({ method })} aria-label="Method" options={[{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }]} />
            </div>
            {draft.method === 'POST' && (
              <label>
                <span>Body template</span>
                <textarea value={draft.body} onChange={(e) => edit({ body: e.target.value })} placeholder={'{"query": "{query}", "limit": {count}}'} rows={3} spellCheck={false} />
              </label>
            )}
            <div className="ws-field">
              <span>Headers</span>
              <div className="ws-rows">
                {draft.headers.map((h, i) => (
                  <div key={i} className="ws-row">
                    <input value={h.name} onChange={(e) => header(i, { name: e.target.value })} placeholder="Header" aria-label="Header name" spellCheck={false} autoComplete="off" />
                    <input type="password" value={h.value} onChange={(e) => header(i, { value: e.target.value })} placeholder={h.set ? SAVED : 'value'} aria-label={`Value of ${h.name || 'the header'}`} autoComplete="off" />
                    <button type="button" className="btn btn-small" onClick={() => edit({ headers: draft.headers.filter((_, j) => j !== i) })} aria-label="Remove header">
                      ×
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn-small ws-add" onClick={() => edit({ headers: [...draft.headers, { name: '', value: '', set: false }] })} disabled={draft.headers.length >= 20}>
                  Add header
                </button>
              </div>
            </div>
            <label>
              <span>Results at</span>
              <input value={draft.map.results} onChange={(e) => edit({ map: { ...draft.map, results: e.target.value } })} placeholder="data.items" spellCheck={false} autoComplete="off" required />
            </label>
            <div className="ws-field">
              <span>Each result</span>
              <div className="ws-row">
                <input value={draft.map.title} onChange={(e) => edit({ map: { ...draft.map, title: e.target.value } })} placeholder="title" aria-label="Title path" spellCheck={false} autoComplete="off" required />
                <input value={draft.map.url} onChange={(e) => edit({ map: { ...draft.map, url: e.target.value } })} placeholder="url" aria-label="URL path" spellCheck={false} autoComplete="off" required />
                <input value={draft.map.snippet} onChange={(e) => edit({ map: { ...draft.map, snippet: e.target.value } })} placeholder="snippet" aria-label="Snippet path" spellCheck={false} autoComplete="off" />
              </div>
            </div>
          </>
        )}
        <div className="set-actions">
          <button className="btn btn-small btn-primary" disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {view.provider !== 'ollama' && (
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(resetWebSearch, 'Back on Ollama')}>
              Back to Ollama
            </button>
          )}
          {notice && <span className="muted ws-notice">{notice}</span>}
        </div>
      </form>
      <p className="muted set-help">
        {p === 'ollama' && 'Ollama’s own search, with the key from Integrations. '}
        {p === 'searxng' && (
          <>
            Your instance has to allow JSON: add <code>json</code> under <code>search.formats</code> in its settings.yml (most public instances turn it off).{' '}
          </>
        )}
        {(p === 'brave' || p === 'kagi' || p === 'tavily') && (
          <>
            Get a key at{' '}
            <a href={KEY_HELP[p].href} target="_blank" rel="noopener noreferrer">
              {KEY_HELP[p].where}
            </a>
            . Searches count against that plan.{' '}
          </>
        )}
        {p === 'custom' && (
          <>
            Any API that answers JSON. For example <code>{'https://api.example.com/search?q={query}&n={count}'}</code>, results at <code>data.items</code>, each result <code>name</code> · <code>link</code> ·{' '}
            <code>summary</code>. Paths are dot paths (<code>hits.0.doc</code>; <code>.</code> for an answer that is the list itself). <code>{'{query}'}</code> is URL-encoded in the URL and JSON-escaped in the body.{' '}
          </>
        )}
        Keys and header values are stored encrypted and never shown again. Reading pages always goes through Ollama.
      </p>
      {error && <p className="t-red">{error}</p>}

      <form className="set-form set-form-row ws-test" onSubmit={test}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Try a search with these settings" aria-label="Test search" />
        <button className="btn btn-small" disabled={testing || !query.trim()}>
          {testing ? 'Searching…' : 'Test'}
        </button>
      </form>
      {testError && <p className="t-red">{testError}</p>}
      {found && (
        <>
          <p className="muted set-help">
            {found.results.length ? `${found.results.length} ${found.results.length === 1 ? 'result' : 'results'}` : 'No results'} from {providerLabel(found.provider)} in {found.ms} ms
          </p>
          {found.results.length > 0 && (
            <ul className="set-list">
              {found.results.slice(0, 5).map((r) => (
                <li key={r.url} className="set-row">
                  <span className="set-row-text">
                    <a href={r.url} target="_blank" rel="noopener noreferrer">
                      {r.title}
                    </a>
                    <span className="muted">{hostOf(r.url)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  )
}
