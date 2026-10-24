import { useEffect, useId, useState, type FormEvent } from 'react'
import { getImageCatalog, getImageSettings, resetImageSettings, saveImageApproval, saveImageObservationApproval, saveImageLearningPreference, saveImageSettings, type ImageCatalog, type ImageSettings } from '../data/agentImages'
import { SecretInput } from '../os/SecretInput'
import { ImageModelFields } from './AgentsModelBrowser'
import { ImageProfileManager } from './AgentsImageProfiles'
import { ObservationsDialog } from './AgentsObservations'

export function AgentsImageSettings() {
  const observationApprovalHint = useId()
  const [settings, setSettings] = useState<ImageSettings | null>(null)
  const [token, setToken] = useState('')
  const [clearToken, setClearToken] = useState(false)
  const [catalog, setCatalog] = useState<ImageCatalog | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [observations, setObservations] = useState(false)
  // Deletes in the overview change the profile counts: remount the list to read them again.
  const [profilesRead, setProfilesRead] = useState(0)
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
        <ul className="set-list">
          <li className="set-row">
            <span className="set-row-text">
              <strong>Ask before generating images</strong>
              <span className="muted">Off: agents generate images straight away in every mode except Plan. On: each image waits for your approval, showing its settings.</span>
            </span>
            <button type="button" role="switch" aria-checked={settings.askBeforeGenerate} aria-label="Ask before generating images" className={`set-toggle ${settings.askBeforeGenerate ? 'is-on' : ''}`} disabled={busy} onClick={() => void run(async () => { setSettings({ ...settings, askBeforeGenerate: (await saveImageApproval(!settings.askBeforeGenerate)).askBeforeGenerate }); setNotice('Saved') })} />
          </li>
          <li className="set-row">
            <span className="set-row-text">
              <strong>Save image observations</strong>
              <span className="muted set-row-wrap">An observation is a short, cautious note after an image or your feedback: what you asked for, what the model and sampling produced, what you said was wrong, and sometimes what a vision model saw. Notes stay with your account on this server under Memory → Images/Learnings; they are not published or sent to another service for storage, but your configured agent can read them for later generations with the same backend and components. They may be wrong, are never a ranking or a “best settings” list, and switching saving off keeps existing notes readable.</span>
            </span>
            <button type="button" role="switch" aria-checked={settings.saveImageLearnings} aria-label="Save image observations" className={`set-toggle ${settings.saveImageLearnings ? 'is-on' : ''}`} disabled={busy} onClick={() => void run(async () => { setSettings({ ...settings, saveImageLearnings: (await saveImageLearningPreference(!settings.saveImageLearnings)).saveImageLearnings }); setNotice('Saved') })} />
          </li>
          <li className="set-row">
            <span className="set-row-text">
              <strong>Ask before saving an observation</strong>
              <span className="muted set-row-wrap" id={observationApprovalHint}>Off: observations save without asking. On: each write waits for approval, except in Bypass; Plan never writes observations.{!settings.saveImageLearnings && ' Saving is off, so this setting has no effect until Save image observations is on.'}</span>
            </span>
            <button type="button" role="switch" aria-checked={settings.askBeforeSavingObservations} aria-label="Ask before saving an observation" aria-describedby={observationApprovalHint} className={`set-toggle ${settings.askBeforeSavingObservations ? 'is-on' : ''}`} disabled={busy} onClick={() => void run(async () => { setSettings({ ...settings, askBeforeSavingObservations: (await saveImageObservationApproval(!settings.askBeforeSavingObservations)).askBeforeSavingObservations }); setNotice('Saved') })} />
          </li>
          <li className="set-row">
            <span className="set-row-text">
              <strong>Observations</strong>
              <span className="muted set-row-wrap">Every saved observation with its picture, source and settings, next to the style profiles they belong to. Search, filter and delete them there.</span>
            </span>
            <button type="button" className="btn btn-small" onClick={() => setObservations(true)}>Open…</button>
          </li>
        </ul>
        <ImageModelFields value={settings} catalog={catalog} onChange={(patch) => setSettings({ ...settings, ...patch })} disabled={busy} loading={discovering} error={catalogError} onRefresh={() => void discover()} />
        {catalogError && <p className="t-red copyable" role="alert">{catalogError}</p>}
        <div className="set-actions"><button className="btn btn-small btn-primary" disabled={busy || !settings.url}>{busy ? 'Saving…' : 'Save defaults'}</button></div>
      </section>
    </form>}
    <section className="set-section image-group" aria-labelledby="image-profiles">
      <h4 className="set-subhead" id="image-profiles">Style profiles</h4>
      <p className="muted set-help">Remembered style preferences. Pin one per thread from its Images dialog; inspect their observations under Observations above.</p>
      <ImageProfileManager key={profilesRead} />
    </section>
    {observations && <ObservationsDialog onClose={() => setObservations(false)} onChanged={() => setProfilesRead((n) => n + 1)} />}
    <p className="muted set-help image-about">Credentials are stored encrypted; internal addresses need an admin. Images count toward your storage quota and stay private to you. Stop drops your queued job, but one already running on ComfyUI may finish.</p>
  </>
}
