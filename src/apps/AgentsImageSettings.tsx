import { useEffect, useState, type FormEvent } from 'react'
import { getImageCatalog, getImageSettings, resetImageSettings, saveImageSettings, type ImageCatalog, type ImageSettings } from '../data/agentImages'
import { SecretInput } from '../os/SecretInput'
import { ImageModelFields } from './AgentsModelBrowser'
import { ImageProfileManager } from './AgentsImageProfiles'

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
    {!settings && !error && <p className="muted">Loading…</p>}
    {settings && <form className="set-form ws-form image-settings-form" onSubmit={save}>
      <section className="set-section image-group" aria-labelledby="image-connection">
        <h4 className="set-subhead" id="image-connection">Connection</h4>
        <label><span>ComfyUI URL</span><input value={settings.url} onChange={(e) => { setSettings({ ...settings, url: e.target.value }); setCatalog(null) }} placeholder="https://comfy.example.com" spellCheck={false} autoComplete="off" disabled={busy} /></label>
        <label><span>Bearer token</span><SecretInput value={token} onChange={(e) => setToken(e.target.value)} placeholder={settings.token ? 'Saved; leave empty to keep' : 'Optional'} disabled={busy} /></label>
        {settings.token && <label className="image-check"><span>Remove saved token</span><input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} disabled={busy} /></label>}
        <div className="set-actions">
          <button className="btn btn-small btn-primary" disabled={busy || !settings.url}>{busy ? 'Working…' : 'Save & discover models'}</button>
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(async () => { setSettings(await resetImageSettings()); setToken(''); setClearToken(false); setCatalog(null); setNotice('Disconnected') })}>Disconnect</button>
          {notice && <span className="muted image-notice" role="status">{notice}</span>}
        </div>
        {error && <p className="t-red copyable" role="alert">{error}</p>}
      </section>
      <section className="set-section image-group" aria-labelledby="image-defaults">
        <h4 className="set-subhead" id="image-defaults">Defaults</h4>
        <ImageModelFields value={settings} catalog={catalog} onChange={(patch) => setSettings({ ...settings, ...patch })} disabled={busy} loading={discovering} error={catalogError} onRefresh={() => void discover()} />
        {catalogError && <p className="t-red copyable" role="alert">{catalogError}</p>}
        <div className="set-actions"><button className="btn btn-small btn-primary" disabled={busy || !settings.url}>{busy ? 'Saving…' : 'Save defaults'}</button></div>
      </section>
    </form>}
    <section className="set-section image-group" aria-labelledby="image-profiles">
      <h4 className="set-subhead" id="image-profiles">Style profiles</h4>
      <p className="muted set-help">Remembered style preferences. Pin one per thread from its Images dialog; inspect observations in Memory → Images.</p>
      <ImageProfileManager />
    </section>
    <p className="muted set-help image-about">Credentials are stored encrypted; internal addresses need an admin. Images count toward your storage quota and stay private to you. Stop drops your queued job, but one already running on ComfyUI may finish.</p>
  </>
}
