import { useEffect, useState, type FormEvent } from 'react'
import { getImageCatalog, getImageSettings, resetImageSettings, saveImageSettings, type ImageCatalog, type ImagePreset, type ImageSettings } from '../data/agentImages'
import { SecretInput } from '../os/SecretInput'
import { Select } from '../os/Select'

export function AgentsImageSettings() {
  const [settings, setSettings] = useState<ImageSettings | null>(null)
  const [token, setToken] = useState('')
  const [clearToken, setClearToken] = useState(false)
  const [catalog, setCatalog] = useState<ImageCatalog | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { getImageSettings().then(setSettings, (e: Error) => setError(e.message)) }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const save = (e: FormEvent) => {
    e.preventDefault()
    if (settings) void run(async () => {
      setSettings(await saveImageSettings({ ...settings, token, clearToken }))
      setToken(''); setClearToken(false); setNotice('Saved')
      setCatalog(await getImageCatalog())
      setNotice('Saved. Installed models refreshed.')
    })
  }
  const pick = (key: 'model' | 'clip' | 'vae', label: string, values: string[]) => settings && (
    <div className="ws-field">
      <span>{label}</span>
      <Select className="set-select" aria-label={label} value={settings[key]} disabled={busy} onChange={(value) => setSettings({ ...settings, [key]: value })} options={[{ value: '', label: 'Select installed model' }, ...[...new Set([settings[key], ...values].filter(Boolean))].map((value) => ({ value, label: value }))]} />
    </div>
  )
  return <>
    <p className="muted set-help">Connect directly to your ComfyUI server. Save the connection to discover installed models, select a matching preset and model, then save again. Ask Agents to generate an image in the app or terminal.</p>
    {!settings && !error && <p className="muted">Loading…</p>}
    {settings && <form className="set-form ws-form" onSubmit={save}>
      <label><span>ComfyUI URL</span><input value={settings.url} onChange={(e) => { setSettings({ ...settings, url: e.target.value }); setCatalog(null) }} placeholder="https://comfy.example.com" spellCheck={false} autoComplete="off" disabled={busy} /></label>
      <label><span>Bearer token</span><SecretInput value={token} onChange={(e) => setToken(e.target.value)} placeholder={settings.token ? 'Saved; leave empty to keep' : 'Optional'} disabled={busy} /></label>
      {settings.token && <label><span>Remove saved token</span><input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} disabled={busy} /></label>}
      <div className="ws-field"><span>Workflow preset</span><Select className="set-select" aria-label="Image workflow preset" value={settings.preset} disabled={busy} onChange={(preset: ImagePreset) => setSettings({ ...settings, preset, model: '' })} options={[
        { value: 'sd15', label: 'SD 1.5 checkpoint · 512 px' }, { value: 'sdxl', label: 'SDXL checkpoint · 1024 px' }, { value: 'z_image', label: 'Z-Image · separate encoder/VAE' }, { value: 'z_image_turbo', label: 'Z-Image Turbo · 8 steps' },
      ]} /></div>
      {pick('model', settings.preset.startsWith('z_image') ? 'Diffusion model' : 'Checkpoint', (settings.preset.startsWith('z_image') ? catalog?.diffusionModels : catalog?.checkpoints) ?? [])}
      {settings.preset.startsWith('z_image') && <>{pick('clip', 'Text encoder (lumina2)', catalog?.clips ?? [])}{pick('vae', 'VAE', catalog?.vaes ?? [])}</>}
      <div className="set-actions">
        <button className="btn btn-small btn-primary" disabled={busy || !settings.url}>{busy ? 'Working…' : 'Save & discover models'}</button>
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(async () => { setSettings(await resetImageSettings()); setToken(''); setClearToken(false); setCatalog(null); setNotice('Disconnected') })}>Disconnect</button>
      </div>
    </form>}
    {notice && <p className="muted" role="status">{notice}</p>}
    {error && <p className="t-red copyable" role="alert">{error}</p>}
    <p className="muted set-help">Credentials stay encrypted on the server. Internal network addresses require an admin account. Generated PNGs count toward your storage quota and remain private to the thread owner. Stop cancels waiting and removes your queued job; a job already running on ComfyUI may still finish. No shared-server interrupt is sent.</p>
  </>
}
