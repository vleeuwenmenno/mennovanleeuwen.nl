import { ImageProfiles } from './AgentsImageProfiles'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getImageCatalog, getThreadImageSettings, resetThreadImageSettings, saveThreadImageSettings, type ImageCatalog, type ImageConfig, type ImageOverrides, type ThreadImageSettings } from '../data/agentImages'
import { ImageDialog, ImageModelFields } from './AgentsModelBrowser'

/** Shared entry point for the Agents window and terminal /images; no account settings are edited. */
export function openSessionImages(threadId: string): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  return new Promise((resolve) => {
    const close = () => { root.unmount(); host.remove(); resolve() }
    root.render(<SessionImages threadId={threadId} onClose={close} />)
  })
}
export function SessionImages({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const catalogRequest = useRef(0)
  const [view, setView] = useState<ThreadImageSettings | null>(null)
  const [draft, setDraft] = useState<ImageOverrides>({})
  const [catalog, setCatalog] = useState<ImageCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [catalogError, setCatalogError] = useState('')
  const [notice, setNotice] = useState('')
  // The model lists are one host's: the thread's own host, else the default.
  const refresh = async (host?: string) => {
    const request = ++catalogRequest.current
    setLoading(true); setCatalogError('')
    try { const next = await getImageCatalog(host); if (request === catalogRequest.current) setCatalog(next) } catch (e) { if (request === catalogRequest.current) setCatalogError((e as Error).message) } finally { if (request === catalogRequest.current) setLoading(false) }
  }
  useEffect(() => {
    let alive = true
    getThreadImageSettings(threadId).then((v) => { if (alive) { setView(v); setDraft(v.overrides); void refresh(v.overrides.host) } }, (e: Error) => { if (alive) { setError(e.message); void refresh() } })
    return () => { alive = false; catalogRequest.current++ }
  }, [threadId])
  const hosts = view?.hosts ?? []
  const pickHost = (id: string) => {
    setDraft((d) => { const next = { ...d }; if (id) next.host = id; else delete next.host; return next })
    setNotice(''); setCatalog(null); void refresh(id || undefined)
  }
  const change = (patch: ImageOverrides) => { setDraft((d) => ({ ...d, ...patch })); setNotice('') }
  const inherit = (key: keyof ImageConfig) => { setDraft((d) => { const next = { ...d }; delete next[key]; return next }); setNotice('') }
  const source = (key: keyof ImageConfig) => key in draft ? <span className="image-source"><span className="image-source-tag">This thread</span><button type="button" className="btn btn-small" disabled={busy} onClick={() => inherit(key)}>Use default</button></span> : <span className="muted image-source">Default{key === 'width' || key === 'height' ? ' · preset size' : ''}</span>
  const save = async (reset = false) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const v = reset ? await resetThreadImageSettings(threadId) : await saveThreadImageSettings(threadId, draft)
      setView(v); setDraft(v.overrides); setCatalog(null); void refresh(v.overrides.host); setNotice(reset ? 'This session now follows account defaults.' : 'Session image settings saved.')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const preset = draft.preset ?? view?.defaults.preset ?? 'sdxl'
  const effective = view ? { ...view.defaults, ...draft, width: draft.width ?? (preset === 'sd15' ? 512 : 1024), height: draft.height ?? (preset === 'sd15' ? 512 : 1024) } : null
  return <ImageDialog title="Session image settings" onClose={onClose} wide>
    <div className="image-session-body">
      <ImageProfiles threadId={threadId} />
      <p className="muted set-help">Only this thread changes; untouched fields follow your account defaults. A size or seed asked for in a message applies to that image only.</p>
      {!view && !error && <p role="status">Loading session settings…</p>}
      {view && effective && <>
        {hosts.length > 1 && <div className="image-config-field">
          <div className="image-config-label"><label htmlFor="session-image-host">ComfyUI host</label>{draft.host ? <span className="image-source"><span className="image-source-tag">This thread</span></span> : <span className="muted image-source">Default</span>}</div>
          <select id="session-image-host" value={draft.host ?? ''} disabled={busy} onChange={(e) => pickHost(e.target.value)}>
            <option value="">Default host{hosts.find((h) => h.default) ? ` (${hosts.find((h) => h.default)!.name})` : ''}</option>
            {hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
          <p className="muted set-help">Tried first for this thread; when it is offline or lacks a model, the other hosts are tried. The lists below are this host's.</p>
        </div>}
        <ImageModelFields value={effective} catalog={catalog} onChange={change} disabled={busy} loading={loading} error={catalogError} onRefresh={() => void refresh(draft.host)} extra={source} />
        <div className="image-config-field">
          <div className="image-config-label"><span>LoRAs</span>{source('loras')}</div>
          <p className="muted set-help">Add installed LoRAs with # in a message. They run in this order; weights range from 0 to 2.</p>
          {!effective.loras.length && <p className="muted">No LoRAs selected.</p>}
          {effective.loras.map((lora, i) => <div className="image-lora-row" key={`${i}:${lora.name}`}>
            <label><span>{lora.name}</span><input aria-label={`Weight for ${lora.name}`} type="number" min={0} max={2} step={0.1} value={lora.weight} disabled={busy} onChange={(e) => change({ loras: effective.loras.map((l, at) => at === i ? { ...l, weight: Number(e.target.value) } : l) })} /></label>
            <button type="button" className="btn btn-small" aria-label={`Remove ${lora.name}`} disabled={busy} onClick={() => change({ loras: effective.loras.filter((_, at) => at !== i) })}>Remove</button>
          </div>)}
        </div>
        <div className="image-numbers">
          {(['width', 'height'] as const).map((key) => <div className="image-config-field" key={key}><div className="image-config-label"><label htmlFor={`session-image-${key}`}>{key === 'width' ? 'Width' : 'Height'} (px)</label>{source(key)}</div><input id={`session-image-${key}`} type="number" min={256} max={1536} step={64} value={effective[key]} disabled={busy} onChange={(e) => change({ [key]: Number(e.target.value) })} /></div>)}
          <div className="image-config-field"><div className="image-config-label"><label htmlFor="session-image-seed">Seed</label>{source('seed')}</div><input id="session-image-seed" type="number" min={0} step={1} placeholder="Random each time" value={effective.seed ?? ''} disabled={busy} onChange={(e) => change({ seed: e.target.value === '' ? null : Number(e.target.value) })} /></div>
        </div>
        <p className="muted set-help">Sizes in steps of 64 from 256 to 1536 px, at most 1536 × 1024 in area. Empty seed: random each time.</p>
      </>}
      {error && <p className="t-red copyable" role="alert">{error}</p>}
      {catalogError && <p className="t-red copyable" role="alert">{catalogError}</p>}
      {notice && <p role="status" className="muted">{notice}</p>}
    </div>
    <footer className="image-dialog-foot"><button type="button" className="btn btn-small" disabled={busy || !view} onClick={() => void save(true)}>Use all account defaults</button><span className="image-grow" /><button type="button" className="btn btn-small" onClick={onClose}>Close</button><button type="button" className="btn btn-small btn-primary" disabled={busy || !view} onClick={() => void save()}>{busy ? 'Saving…' : 'Save session settings'}</button></footer>
  </ImageDialog>
}
