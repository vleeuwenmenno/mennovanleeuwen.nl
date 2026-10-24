import { useEffect, useId, useState } from 'react'
import { getImageCatalog, getThreadImageSettings, type GeneratedImage, type ImageCatalog, type ImageConfig, type RefineImageInput } from '../data/agentImages'
import { IMAGE_SAMPLERS, IMAGE_SCHEDULERS, imagePresetSpec, recommendedImageSampling, resolveImageAssets, type ImageSampling } from '../data/imageModels'
import { Select } from '../os/Select'
import { ImageDialog, ImageModelFields, ModelPicker } from './AgentsModelBrowser'

type Components = Pick<ImageConfig, 'preset' | 'model' | 'clip' | 'vae'>
/** Explicit diffusion refinement: inherited settings stay absent from the request unless overridden. */
export function RefineDialog({ image, threadId, disabled, onClose, onRefine }: { image: GeneratedImage; threadId: string; disabled: boolean; onClose: () => void; onRefine: (input: RefineImageInput) => void }) {
  const recorded = image.settings?.operation !== 'upscale' && image.settings?.operation !== 'remove' ? image.settings : undefined
  const needsPrompt = !image.settings
  const [catalog, setCatalog] = useState<ImageCatalog | null>(null)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [components, setComponents] = useState<Components | null>(recorded ?? null)
  const [overrideComponents, setOverrideComponents] = useState(needsPrompt)
  const [overridePrompt, setOverridePrompt] = useState(needsPrompt)
  const [prompt, setPrompt] = useState(recorded?.prompt ?? '')
  const [negative, setNegative] = useState(recorded?.negative_prompt ?? '')
  const [sampling, setSampling] = useState<Partial<ImageSampling>>({})
  const [upscaler, setUpscaler] = useState('')
  const [scale, setScale] = useState(1.5)
  const [custom, setCustom] = useState(false)
  const [size, setSize] = useState({ width: Math.round(image.width * 1.5 / 64) * 64, height: Math.round(image.height * 1.5 / 64) * 64 })
  const [denoise, setDenoise] = useState(0.2)
  const id = useId()
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    Promise.all([getImageCatalog(), getThreadImageSettings(threadId)]).then(([models, settings]) => {
      if (!alive) return
      setCatalog(models); setComponents((current) => current ?? settings.effective)
    }, (e: Error) => { if (alive) setError(e.message) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [revision, threadId])
  const width = custom ? size.width : Math.round(image.width * scale / 64) * 64
  const height = custom ? size.height : Math.round(image.height * scale / 64) * 64
  const invalidSize = [width, height].some((v) => !Number.isInteger(v) || v < 256 || v > 2048 || v % 64 !== 0) || width * height > 4194304
  const invalidSampling = sampling.steps !== undefined && (!Number.isInteger(sampling.steps) || sampling.steps < 1 || sampling.steps > 80) || sampling.cfg !== undefined && (!Number.isFinite(sampling.cfg) || sampling.cfg < 0 || sampling.cfg > 20)
  const resolved = components && catalog ? resolveImageAssets(components, catalog) : null
  const componentError = overrideComponents ? resolved?.errors.join(' ') || (!components ? 'Loading configured components…' : '') : ''
  const upscalerError = upscaler && (!catalog?.upscale || !catalog.upscalers?.includes(upscaler)) ? catalog?.upscaleError || 'Choose an installed, supported upscale model or use resize only.' : ''
  const invalidStrength = !Number.isFinite(denoise) || denoise < 0.1 || denoise > 1
  const ready = !disabled && !loading && !error && !invalidSize && !invalidSampling && !componentError && !upscalerError && !invalidStrength && (!overridePrompt || !!prompt.trim())
  const submit = () => {
    if (!ready) return
    onRefine({ operation: 'refine', source_image_id: image.id, denoise, ...(custom ? { width, height } : { scale }), ...(upscaler ? { upscale_model: upscaler } : {}), ...(overridePrompt ? { prompt: prompt.trim(), negative_prompt: negative } : {}), ...(overrideComponents && resolved ? { preset: resolved.effective.preset, model: resolved.effective.model, clip: resolved.effective.clip, vae: resolved.effective.vae } : {}), ...sampling })
  }
  return <ImageDialog title="Refine image" onClose={onClose} wide>
    <div className="image-session-body">
      <p>Refine {image.name} with diffusion. This can change details and composition; lower strength keeps more of the source.</p>
      <p className="muted">{recorded ? 'The recorded prompt, components and sampling are inherited unless you override them below.' : needsPrompt ? 'This image has no recorded diffusion settings. Supply a prompt and configured components below.' : 'The backend inherits the nearest owned diffusion source’s settings. If none exists, supply a prompt and configured components below; no prompt is invented.'}</p>
      <div className="image-numbers">
        <div className="image-config-field"><span>Output size</span><Select aria-label="Refinement size" value={custom ? 'custom' : String(scale)} options={[{ value: '1', label: '1× (same size)' }, { value: '1.5', label: '1.5×' }, { value: '2', label: '2×' }, { value: 'custom', label: 'Custom dimensions' }]} onChange={(v) => { setCustom(v === 'custom'); if (v !== 'custom') setScale(Number(v)) }} /></div>
        <div className="image-config-field"><label htmlFor={`${id}-strength`}>Strength (denoise)</label><input id={`${id}-strength`} type="number" min={0.1} max={1} step={0.05} value={Number.isFinite(denoise) ? denoise : ''} onChange={(e) => setDenoise(e.target.value === '' ? NaN : Number(e.target.value))} /></div>
      </div>
      {custom && <div className="image-numbers">{(['width', 'height'] as const).map((key) => <div className="image-config-field" key={key}><label htmlFor={`${id}-${key}`}>{key === 'width' ? 'Width' : 'Height'} (px)</label><input id={`${id}-${key}`} type="number" min={256} max={2048} step={64} value={size[key]} onChange={(e) => setSize({ ...size, [key]: Number(e.target.value) })} /></div>)}</div>}
      <p role="status">{image.width} × {image.height} → {width} × {height} px. Scale rounds each side to the nearest 64 px, so the aspect ratio is approximate. Custom dimensions can crop the source.</p>
      {invalidSize && <p role="alert" className="t-red">Choose dimensions from 256 to 2048 px in multiples of 64, at most 4,194,304 pixels.</p>}
      {invalidStrength && <p role="alert" className="t-red">Strength must be between 0.1 and 1.</p>}
      <p className="muted">Strength ranges from 0.1 to 1; default 0.2. Higher values redraw more of the picture.</p>
      <div className="image-config-field"><strong>Optional upscale model</strong><ModelPicker category="upscale_models" label="Refinement upscaler" values={catalog?.upscalers ?? []} value={upscaler} onChange={setUpscaler} loading={loading} error={catalog?.upscaleError} onRefresh={() => setRevision((r) => r + 1)} />{upscaler ? <button type="button" className="btn btn-small" onClick={() => setUpscaler('')}>Use resize only</button> : <span className="muted">Resize only; no upscale model selected.</span>}</div>
      {upscaler && <p className="muted">The upscaler runs before diffusion. Its native intermediate size may exceed the requested output; output limits do not guarantee available memory.</p>}
      <label><input type="checkbox" checked={overridePrompt} disabled={needsPrompt} onChange={(e) => setOverridePrompt(e.target.checked)} /> Supply a prompt override</label>
      {overridePrompt && <><div className="image-config-field"><label htmlFor={`${id}-prompt`}>Prompt</label><textarea id={`${id}-prompt`} rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></div><div className="image-config-field"><label htmlFor={`${id}-negative`}>Negative prompt (supported workflows only)</label><textarea id={`${id}-negative`} rows={2} value={negative} onChange={(e) => setNegative(e.target.value)} /></div></>}
      <details open={needsPrompt || undefined}><summary>Advanced components and sampling</summary>
        <p className="muted">Overrides apply only to this refinement; saved session settings stay unchanged.</p>
        <label><input type="checkbox" checked={overrideComponents} disabled={needsPrompt} onChange={(e) => setOverrideComponents(e.target.checked)} /> Override configured components</label>
        {overrideComponents && components && <ImageModelFields value={components} catalog={catalog} onChange={(patch) => { const next = { ...components, ...patch }; setComponents(next); if (patch.preset) { setSampling(recommendedImageSampling(next.preset, next.model, catalog ?? undefined)); if (!imagePresetSpec(next.preset).negative) setNegative('') } }} loading={loading} error={error} onRefresh={() => setRevision((r) => r + 1)} />}
        <div className="image-numbers">{(['steps', 'cfg'] as const).map((key) => <div className="image-config-field" key={key}><label htmlFor={`${id}-${key}`}>{key === 'steps' ? 'Steps override' : 'CFG override'}</label><input id={`${id}-${key}`} type="number" min={key === 'steps' ? 1 : 0} max={key === 'steps' ? 80 : 20} step={key === 'steps' ? 1 : 0.1} placeholder="Inherit" value={sampling[key] ?? ''} onChange={(e) => setSampling({ ...sampling, [key]: e.target.value === '' ? undefined : Number(e.target.value) })} /></div>)}</div>
        {(['sampler', 'scheduler'] as const).map((key) => <div className="image-config-field" key={key}><span>{key === 'sampler' ? 'Sampler override' : 'Scheduler override'}</span><Select aria-label={`${key} override`} value={sampling[key] ?? ''} options={[{ value: '', label: 'Inherit' }, ...(key === 'sampler' ? IMAGE_SAMPLERS : IMAGE_SCHEDULERS).filter((v) => !(key === 'sampler' ? catalog?.samplers : catalog?.schedulers) || (key === 'sampler' ? catalog?.samplers : catalog?.schedulers)?.includes(v)).map((value) => ({ value, label: value }))]} onChange={(value) => setSampling({ ...sampling, [key]: value || undefined })} /></div>)}
      </details>
      {invalidSampling && <p role="alert" className="t-red">Steps must be 1–80; CFG must be 0–20.</p>}
      {(error || componentError || upscalerError) && <p role="alert" className="t-red copyable">{error || componentError || upscalerError}</p>}
    </div>
    <footer className="image-dialog-foot"><button type="button" className="btn btn-small" onClick={onClose}>Cancel</button><span className="image-grow" /><button type="button" className="btn btn-small btn-primary" disabled={!ready} onClick={submit}>Refine</button></footer>
  </ImageDialog>
}
