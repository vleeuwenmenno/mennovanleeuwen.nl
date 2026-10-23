import { useEffect, useState, type FormEvent } from 'react'
import { getImageCatalog, getImageSettings, resetImageSettings, saveImageSettings, type ImageCatalog, type ImageSettings } from '../data/agentImages'
import { SecretInput } from '../os/SecretInput'
import { ImageModelFields } from './AgentsModelBrowser'

export function AgentsImageSettings() {
  const [settings, setSettings] = useState<ImageSettings | null>(null)
  const [token, setToken] = useState('')
  const [clearToken, setClearToken] = useState(false)
  const [catalog, setCatalog] = useState<ImageCatalog | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const discover = async () => {
    setDiscovering(true); setCatalogError('')
    try { setCatalog(await getImageCatalog()) } catch (e) { setCatalogError((e as Error).message) } finally { setDiscovering(false) }
  }
  useEffect(() => { getImageSettings().then((s) => { setSettings(s); if (s.url) void discover() }, (e: Error) => setError(e.message)) }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const save = (e: FormEvent) => {
    e.preventDefault()
    if (settings) void run(async () => {
      setSettings(await saveImageSettings({ ...settings, token, clearToken }))
      setToken(''); setClearToken(false); setNotice('Saved')
      await discover()
    })
  }
  return <>
    <p className="muted set-help">Connect directly to your ComfyUI server. Save the connection to discover installed models, select a matching preset and model, then save again. Ask Agents to generate an image in the app or terminal.</p>
    {!settings && !error && <p className="muted">Loading…</p>}
    {settings && <form className="set-form ws-form" onSubmit={save}>
      <label><span>ComfyUI URL</span><input value={settings.url} onChange={(e) => { setSettings({ ...settings, url: e.target.value }); setCatalog(null) }} placeholder="https://comfy.example.com" spellCheck={false} autoComplete="off" disabled={busy} /></label>
      <label><span>Bearer token</span><SecretInput value={token} onChange={(e) => setToken(e.target.value)} placeholder={settings.token ? 'Saved; leave empty to keep' : 'Optional'} disabled={busy} /></label>
      {settings.token && <label><span>Remove saved token</span><input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} disabled={busy} /></label>}
      <ImageModelFields value={settings} catalog={catalog} onChange={(patch) => setSettings({ ...settings, ...patch })} disabled={busy} loading={discovering} error={catalogError} onRefresh={() => void discover()} />
      <div className="set-actions">
        <button className="btn btn-small btn-primary" disabled={busy || !settings.url}>{busy ? 'Working…' : 'Save & discover models'}</button>
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(async () => { setSettings(await resetImageSettings()); setToken(''); setClearToken(false); setCatalog(null); setNotice('Disconnected') })}>Disconnect</button>
      </div>
    </form>}
    {catalogError && <p className="t-red copyable" role="alert">{catalogError}</p>}
    {notice && <p className="muted" role="status">{notice}</p>}
    {error && <p className="t-red copyable" role="alert">{error}</p>}
    <p className="muted set-help">Credentials stay encrypted on the server. Internal network addresses require an admin account. Generated PNGs count toward your storage quota and remain private to the thread owner. Stop cancels waiting and removes your queued job; a job already running on ComfyUI may still finish. No shared-server interrupt is sent.</p>
  </>
}
