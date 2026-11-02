import { useEffect, useId, useState, type FormEvent } from 'react'
import { getImageCatalog, getImageHostStatus, getImageSettings, IMAGE_HOSTS_MAX, resetImageSettings, saveImageApproval, saveImageIntelSettings, saveImageObservationApproval, saveImageLearningPreference, saveImageSettings, type ImageCatalog, type ImageHostStatus, type ImageSettings } from '../data/agentImages'
import { SecretInput } from '../os/SecretInput'
import { ImageModelFields } from './AgentsModelBrowser'
import { ImageProfileManager } from './AgentsImageProfiles'
import { ObservationsDialog } from './AgentsObservations'
import { useWM } from '../os/wm'

/** One host in the form: `id` once saved; `token` is a new token to save (empty keeps the saved one). */
type HostRow = { key: string; id?: string; name: string; url: string; token: string; savedToken: boolean; clearToken: boolean }
const rowsOf = (s: ImageSettings): HostRow[] => (s.hosts ?? []).map((h) => ({ key: h.id, id: h.id, name: h.name, url: h.url, token: '', savedToken: h.token, clearToken: false }))
let added = 0
const statusLine = (status: ImageHostStatus | undefined, row: HostRow) => {
  if (!row.id) return { text: 'Not saved yet', bad: false }
  if (!status) return { text: '', bad: false }
  if (!status.reachable) return { text: status.error ?? 'Did not answer', bad: true }
  const c = status.counts ?? {}
  return { text: `Connected · ${c.checkpoints ?? 0} checkpoints · ${c.diffusionModels ?? 0} diffusion models · ${c.loras ?? 0} LoRAs`, bad: false }
}

export function AgentsImageSettings() {
  const wm = useWM()
  const observationApprovalHint = useId()
  const hostGroup = useId()
  const [settings, setSettings] = useState<ImageSettings | null>(null)
  const [hosts, setHosts] = useState<HostRow[]>([])
  const [defaultKey, setDefaultKey] = useState('')
  const [statuses, setStatuses] = useState<ImageHostStatus[]>([])
  const [civitaiKey, setCivitaiKey] = useState('')
  const civitaiHint = useId(), qualityHint = useId()
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
  // Each host is checked on its own, so one offline host shows its error while the others answer.
  const check = () => void getImageHostStatus().then((r) => setStatuses(r.hosts), () => setStatuses([]))
  // No host yet: one empty row, so the first connection is a URL away as before.
  const load = (s: ImageSettings) => {
    setSettings(s)
    const rows = rowsOf(s)
    if (!rows.length) rows.push({ key: `new-${++added}`, name: 'ComfyUI', url: '', token: '', savedToken: false, clearToken: false })
    setHosts(rows); setDefaultKey(s.defaultHost || rows[0].key)
  }
  useEffect(() => { getImageSettings().then((s) => { load(s); if (s.url) { void discover(); check() } }, (e: Error) => setError(e.message)) }, [])
  const setHost = (key: string, patch: Partial<HostRow>) => { setHosts((list) => list.map((h) => (h.key === key ? { ...h, ...patch } : h))); if ('url' in patch) setCatalog(null) }
  const addHost = () => {
    const key = `new-${++added}`
    const names = new Set(hosts.map((h) => h.name.trim().toLowerCase()))
    let n = hosts.length + 1
    while (names.has((n === 1 ? 'ComfyUI' : `ComfyUI ${n}`).toLowerCase())) n++
    setHosts([...hosts, { key, name: n === 1 ? 'ComfyUI' : `ComfyUI ${n}`, url: '', token: '', savedToken: false, clearToken: false }])
    if (!hosts.length) setDefaultKey(key)
  }
  // Removing the default makes the first remaining host the default (the server does the same).
  const removeHost = (key: string) => {
    const rest = hosts.filter((h) => h.key !== key)
    setHosts(rest)
    if (defaultKey === key) setDefaultKey(rest[0]?.key ?? '')
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const save = (e: FormEvent) => {
    e.preventDefault()
    if (settings) void run(async () => {
      const saved = await saveImageSettings({
        hosts: hosts.map((h) => ({ ...(h.id ? { id: h.id } : {}), name: h.name.trim(), url: h.url.trim(), ...(h.token.trim() ? { token: h.token.trim() } : {}), ...(h.clearToken ? { clearToken: true } : {}), ...(h.key === defaultKey ? { default: true } : {}) })),
        preset: settings.preset, model: settings.model, clip: settings.clip, vae: settings.vae,
      })
      load(saved); setNotice('Saved')
      if (saved.url) { check(); await discover() } else { setCatalog(null); setStatuses([]) }
    })
  }
  return <>
    {!settings && !error && <p className="muted">Loading…</p>}
    {settings && <form className="set-form ws-form image-settings-form" onSubmit={save}>
      <section className="set-section image-group" aria-labelledby="image-connection">
        <h4 className="set-subhead" id="image-connection">ComfyUI hosts</h4>
        <p className="muted set-help">One or more ComfyUI servers. The default is tried first; agents may still pick another host, and use one when the default is offline or lacks the model asked for. Each host keeps its own models, LoRAs and observations.</p>
        {!hosts.length && <p className="muted">No ComfyUI host yet.</p>}
        <ul className="image-hosts">
          {hosts.map((h, i) => {
            const status = statusLine(statuses.find((x) => x.id === h.id), h)
            return <li key={h.key} className="image-host">
              <fieldset className="image-host-fields" disabled={busy}>
                <legend className="image-host-legend">{h.name.trim() || `Host ${i + 1}`}</legend>
                <div className="image-host-head">
                  <label className="image-host-default"><input type="radio" name={hostGroup} checked={defaultKey === h.key} onChange={() => setDefaultKey(h.key)} />Default</label>
                  <span className={`image-host-status copyable ${status.bad ? 't-red' : 'muted'}`} role={status.bad ? 'alert' : undefined}>{status.text}</span>
                  <button type="button" className="btn btn-small" onClick={() => removeHost(h.key)}>Remove</button>
                </div>
                <label><span>Name</span><input value={h.name} onChange={(e) => setHost(h.key, { name: e.target.value })} maxLength={60} placeholder="Desktop GPU" autoComplete="off" /></label>
                <label><span>ComfyUI URL</span><input value={h.url} onChange={(e) => setHost(h.key, { url: e.target.value })} placeholder="https://comfy.example.com" spellCheck={false} autoComplete="off" inputMode="url" /></label>
                <label><span>Bearer token</span><SecretInput value={h.token} onChange={(e) => setHost(h.key, { token: e.target.value })} placeholder={h.savedToken ? 'Saved; leave empty to keep' : 'Optional'} /></label>
                {h.savedToken && <label className="image-check"><span>Remove saved token</span><input type="checkbox" checked={h.clearToken} onChange={(e) => setHost(h.key, { clearToken: e.target.checked })} /></label>}
              </fieldset>
            </li>
          })}
        </ul>
        <div className="set-actions"><button type="button" className="btn btn-small" disabled={busy || hosts.length >= IMAGE_HOSTS_MAX} onClick={addHost}>Add host</button>{hosts.length >= IMAGE_HOSTS_MAX && <span className="muted image-notice">At most {IMAGE_HOSTS_MAX} hosts</span>}</div>
        <div className="set-actions">
          <button className="btn btn-small btn-primary" disabled={busy || (!hosts.length && !settings.url) || hosts.some((h) => !h.name.trim() || !h.url.trim())}>{busy ? 'Working…' : 'Save & discover models'}</button>
          <button type="button" className="btn btn-small" disabled={busy || !settings.url} onClick={() => void run(async () => { load(await resetImageSettings()); setCatalog(null); setStatuses([]); setNotice('Disconnected') })}>Disconnect all</button>
          {notice && <span className="muted image-notice" role="status">{notice}</span>}
        </div>
        {settings.url && <p className="muted image-studio-link">Generate by hand, without an agent: <button type="button" className="btn btn-small" onClick={() => wm.open('imagestudio', { t: String(Date.now()) })}>Open Image Studio</button></p>}
        {error && <p className="t-red copyable" role="alert">{error}</p>}
      </section>
      <section className="set-section image-group" aria-labelledby="image-defaults">
        <h4 className="set-subhead" id="image-defaults">Defaults</h4>
        {(settings.hosts?.length ?? 0) > 1 && <p className="muted set-help">The model lists below come from the default host{settings.hosts.find((h) => h.default) ? ` (${settings.hosts.find((h) => h.default)!.name})` : ''}. A default model that another host lacks makes a job go to a host that has it.</p>}
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
        <div className="set-actions"><button className="btn btn-small btn-primary" disabled={busy || !settings.url || hosts.some((h) => !h.name.trim() || !h.url.trim())}>{busy ? 'Saving…' : 'Save defaults'}</button></div>
      </section>
      <section className="set-section image-group" aria-labelledby="image-intel">
        <h4 className="set-subhead" id="image-intel">Model details and quality</h4>
        <ul className="set-list">
          <li className="set-row">
            <span className="set-row-text">
              <strong>Check images and retry once if clearly broken</strong>
              <span className="muted set-row-wrap" id={qualityHint}>After each generation the server checks the picture: black, white, flat or pure noise, and, when one of your models can see pictures, a short look by the cheapest of them. Only a clearly broken picture (melted faces, mush, noise, the wrong subject) gets one automatic retry with better settings, and the agent says what it changed. Fine or mediocre pictures end the turn as usual. The picture goes only to your configured model provider.</span>
            </span>
            <button type="button" role="switch" aria-checked={settings.qualityCheck} aria-label="Check images and retry once if clearly broken" aria-describedby={qualityHint} className={`set-toggle ${settings.qualityCheck ? 'is-on' : ''}`} disabled={busy} onClick={() => void run(async () => { setSettings({ ...settings, qualityCheck: (await saveImageIntelSettings({ qualityCheck: !settings.qualityCheck })).qualityCheck }); setNotice('Saved') })} />
          </li>
          <li className="set-row">
            <span className="set-row-text">
              <strong>Look up model details on Civitai</strong>
              <span className="muted set-row-wrap" id={civitaiHint}>Before using a model, the agent reads its Civitai page: base model, trained words, description and the settings its example pictures were made with. This sends the model’s Civitai ID or file hash to civitai.com, never your prompts, pictures or ComfyUI address. Answers are kept for a week.</span>
            </span>
            <button type="button" role="switch" aria-checked={settings.civitaiLookup} aria-label="Look up model details on Civitai" aria-describedby={civitaiHint} className={`set-toggle ${settings.civitaiLookup ? 'is-on' : ''}`} disabled={busy} onClick={() => void run(async () => { setSettings({ ...settings, civitaiLookup: (await saveImageIntelSettings({ civitaiLookup: !settings.civitaiLookup })).civitaiLookup }); setNotice('Saved') })} />
          </li>
        </ul>
        <label><span>Civitai API key</span><SecretInput value={civitaiKey} onChange={(e) => setCivitaiKey(e.target.value)} placeholder={settings.civitaiKey ? 'Saved; leave empty to keep' : 'Optional'} disabled={busy || !settings.civitaiLookup} /></label>
        <p className="muted set-help">Optional, stored encrypted and sent only to civitai.com. Without a key Civitai hides NSFW example pictures, so their settings are missing for some models. Create one under Account settings → API keys on civitai.com.</p>
        <div className="set-actions">
          <button type="button" className="btn btn-small" disabled={busy || !civitaiKey.trim()} onClick={() => void run(async () => { setSettings(await saveImageIntelSettings({ civitaiKey: civitaiKey.trim() })); setCivitaiKey(''); setNotice('Saved') })}>Save key</button>
          {settings.civitaiKey && <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(async () => { setSettings(await saveImageIntelSettings({ clearCivitaiKey: true })); setNotice('Key removed') })}>Remove key</button>}
        </div>
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
