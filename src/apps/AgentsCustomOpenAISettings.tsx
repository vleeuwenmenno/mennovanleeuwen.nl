import { useEffect, useState, type FormEvent } from 'react'
import { ask } from '../os/Dialogs'
import { SecretInput } from '../os/SecretInput'
import { loadAccount, useAccount } from '../os/account'
import { forgetAgentModels } from '../data/agents'
import { addCustomOpenAI, deleteCustomOpenAI, listCustomOpenAI, testCustomOpenAI, updateCustomOpenAI, type CustomOpenAIEndpoint } from '../data/customOpenAI'

// Custom OpenAI-compatible API endpoints (Strata API over NetBird, vLLM, llama.cpp, LM Studio,
// LiteLLM, OpenRouter, etc.): shown in Settings → Integrations → OpenAI-compatible APIs and
// Settings → Apps → Agents → General.

type FormState = {
  name: string
  url: string
  apiKey: string
  clearKey: boolean
  manualModels: string
}

const EMPTY_FORM: FormState = { name: '', url: '', apiKey: '', clearKey: false, manualModels: '' }

const parseManual = (raw: string) =>
  raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)

export function AgentsCustomOpenAISettings({ heading = false }: { heading?: boolean }) {
  const account = useAccount()
  const [endpoints, setEndpoints] = useState<CustomOpenAIEndpoint[] | null>(null)
  const [editing, setEditing] = useState<'new' | string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let alive = true
    listCustomOpenAI().then(
      (list) => alive && setEndpoints(list),
      (e: Error) => alive && setError(e.message),
    )
    return () => {
      alive = false
    }
  }, [])

  const openAdd = () => {
    setError('')
    setNotice('')
    setForm(EMPTY_FORM)
    setEditing('new')
  }

  const openEdit = (ep: CustomOpenAIEndpoint) => {
    setError('')
    setNotice('')
    setForm({
      name: ep.name,
      url: ep.url,
      apiKey: '',
      clearKey: false,
      manualModels: ep.manualModels.join(', '),
    })
    setEditing(ep.id)
  }

  const cancel = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setError('')
  }

  const refreshModels = () => {
    forgetAgentModels()
    void loadAccount()
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!editing) return
    setBusy('save')
    setError('')
    setNotice('')
    try {
      const payload = {
        name: form.name.trim(),
        url: form.url.trim(),
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        ...(editing !== 'new' && form.clearKey ? { clearKey: true } : {}),
        manualModels: parseManual(form.manualModels),
      }
      const res = editing === 'new' ? await addCustomOpenAI(payload) : await updateCustomOpenAI(editing, payload)
      setEndpoints(res.endpoints)
      setEditing(null)
      setForm(EMPTY_FORM)
      const n = res.discovered.length
      setNotice(`${res.endpoint.name} saved · ${n} ${n === 1 ? 'model' : 'models'} available`)
      refreshModels()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const test = async (ep: CustomOpenAIEndpoint) => {
    setBusy(`test:${ep.id}`)
    setError('')
    setNotice('')
    try {
      const res = await testCustomOpenAI(ep.id)
      if (res.ok) {
        const n = res.models.length
        setNotice(`${ep.name} answered · ${n} ${n === 1 ? 'model' : 'models'} ready`)
        refreshModels()
      } else {
        setError(`${ep.name}: ${res.error || 'Could not reach the endpoint'}`)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (ep: CustomOpenAIEndpoint) => {
    const ok = await ask({
      title: `Remove ${ep.name}?`,
      body: 'Its models will disappear from the Agents model picker. Existing threads keep their history.',
      confirm: 'Remove',
      danger: true,
    })
    if (!ok) return
    setBusy(`del:${ep.id}`)
    setError('')
    setNotice('')
    try {
      const next = await deleteCustomOpenAI(ep.id)
      setEndpoints(next)
      if (editing === ep.id) cancel()
      setNotice(`${ep.name} removed`)
      refreshModels()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const editingEndpoint = editing && editing !== 'new' ? endpoints?.find((e) => e.id === editing) ?? null : null

  return (
    <>
      {heading && <h4 className="set-subhead">OpenAI-compatible APIs</h4>}
      {!endpoints ? (
        error ? (
          <p className="t-red copyable" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )
      ) : (
        <>
          <ul className="set-list">
            {endpoints.map((ep) => (
              <li key={ep.id} className="set-row">
                <span className="set-row-text">
                  <strong>
                    {ep.name}{' '}
                    {ep.hasKey && <span className="set-badge">API key</span>}
                  </strong>
                  <span className="muted">
                    {ep.url}
                    {ep.manualModels.length > 0 ? ` · ${ep.manualModels.length} manual ${ep.manualModels.length === 1 ? 'model' : 'models'}` : ''}
                  </span>
                </span>
                <div className="set-actions">
                  <button type="button" className="btn btn-small" disabled={!!busy} onClick={() => void test(ep)}>
                    {busy === `test:${ep.id}` ? 'Testing…' : 'Test'}
                  </button>
                  <button type="button" className="btn btn-small" disabled={!!busy} onClick={() => openEdit(ep)}>
                    Edit
                  </button>
                  <button type="button" className="btn btn-small" disabled={!!busy} onClick={() => void remove(ep)}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
            {!endpoints.length && !editing && (
              <li className="set-row">
                <span className="set-row-text">
                  <strong>No endpoints added</strong>
                  <span className="muted">Connect Strata API, vLLM, llama.cpp, LM Studio, LiteLLM, OpenRouter, or any OpenAI-compatible server</span>
                </span>
                <button type="button" className="btn btn-small btn-primary" disabled={!!busy} onClick={openAdd}>
                  Add endpoint
                </button>
              </li>
            )}
          </ul>

          {endpoints.length > 0 && !editing && endpoints.length < 8 && (
            <div className="set-actions" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-small" disabled={!!busy} onClick={openAdd}>
                Add endpoint
              </button>
            </div>
          )}

          {editing && (
            <form className="set-form" style={{ marginTop: 12 }} onSubmit={(e) => void submit(e)}>
              <label>
                <span>Name</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Strata API"
                  maxLength={60}
                  required
                  disabled={!!busy}
                />
              </label>
              <label>
                <span>Base URL</span>
                <input
                  type="url"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="http://strata.netbird.cloud:8000/v1"
                  spellCheck={false}
                  autoComplete="off"
                  required
                  disabled={!!busy}
                />
              </label>
              <label>
                <span>API key (optional)</span>
                <SecretInput
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value, clearKey: false })}
                  placeholder={editingEndpoint?.hasKey ? 'Saved; leave blank to keep it' : 'Leave blank if no key is needed'}
                  disabled={!!busy || form.clearKey}
                />
              </label>
              {editingEndpoint?.hasKey && (
                <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={form.clearKey}
                    onChange={(e) => setForm({ ...form, clearKey: e.target.checked, ...(e.target.checked ? { apiKey: '' } : {}) })}
                    disabled={!!busy}
                  />
                  <span>Remove saved API key</span>
                </label>
              )}
              <label>
                <span>Manual model IDs (optional, comma-separated)</span>
                <input
                  value={form.manualModels}
                  onChange={(e) => setForm({ ...form, manualModels: e.target.value })}
                  placeholder="Only needed if the server does not expose /models"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={!!busy}
                />
              </label>
              <div className="set-actions">
                <button type="submit" className="btn btn-small btn-primary" disabled={!!busy || !form.name.trim() || !form.url.trim()}>
                  {busy === 'save' ? 'Checking…' : editing === 'new' ? 'Add endpoint' : 'Save changes'}
                </button>
                <button type="button" className="btn btn-small" disabled={!!busy} onClick={cancel}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {notice && (
            <p className="muted set-help" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="t-red copyable" role="alert">
              {error}
            </p>
          )}
          <p className="muted set-help">
            <code>/v1</code> is detected automatically when omitted. API keys are optional, stored encrypted on the server, and never sent back to the browser.
            {account.user?.admin ? ' As an admin, you can connect to private, LAN, or NetBird addresses.' : ' Only public web addresses are allowed for non-admin accounts.'}
          </p>
        </>
      )}
    </>
  )
}
