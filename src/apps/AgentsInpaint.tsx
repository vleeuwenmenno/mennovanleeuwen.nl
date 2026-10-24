import { useEffect, useRef, useState } from 'react'
import { getImageCatalog, saveImageMask, type GeneratedImage, type ImageCatalog, type InpaintImageInput } from '../data/agentImages'
import { ImageDialog } from './AgentsModelBrowser'
import { AgentsMaskEditor } from './AgentsMaskEditor'

/** Describe the edit first; Apply in the mask editor is the explicit generation action. */
export function InpaintDialog({ image, threadId, disabled, onClose, onInpaint }: { image: GeneratedImage; threadId: string; disabled: boolean; onClose: () => void; onInpaint: (input: InpaintImageInput) => void }) {
  const [catalog, setCatalog] = useState<ImageCatalog | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [prompt, setPrompt] = useState('')
  const [denoise, setDenoise] = useState(0.65)
  const [painting, setPainting] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let current = true
    setCatalog(null); setError('')
    getImageCatalog().then(v => { if (current) setCatalog(v) }, e => { if (current) setError((e as Error).message) })
    return () => { current = false }
  }, [revision])
  if (painting) return <AgentsMaskEditor sourceUrl={image.url} sourceName={image.name} width={image.width} height={image.height} onCancel={onClose} onApply={async ({ mask }) => {
    if (disabled) throw new Error('Wait for the current turn to finish before applying a mask.')
    const saved = await saveImageMask(threadId, image.id, mask)
    if (!alive.current) return
    const s = image.settings
    const settings = s && s.operation !== 'upscale' ? { preset: s.preset, model: s.model, clip: s.clip, vae: s.vae, loras: s.loras, steps: s.steps, cfg: s.cfg, sampler: s.sampler, scheduler: s.scheduler } : {}
    onInpaint({ ...settings, operation: 'inpaint', source_image_id: image.id, mask_id: saved.id, prompt: prompt.trim(), denoise })
  }} />
  const problem = error || (catalog && !catalog.inpaint ? catalog.inpaintError || 'This backend does not support masked editing.' : '')
  return <ImageDialog title="Edit selected area" onClose={onClose}>
    <div className="image-session-body">
      <p>Describe the replacement, then paint the area to change in {image.name}.</p>
      <label className="image-config-field">Edit instructions<textarea className="dlg-input" aria-label="Edit instructions" value={prompt} maxLength={6000} rows={4} onChange={e => setPrompt(e.target.value)} /></label>
      <label className="image-config-field">Denoise<input type="range" aria-label="Inpaint denoise" min="0.1" max="1" step="0.05" value={denoise} onChange={e => setDenoise(Number(e.target.value))} /><output>{denoise}</output></label>
      <p className="muted">Lower denoise preserves more structure. Source and mask resize together to the generation working size (up to 1536 px per side, 1536 × 1024 area). Black areas preserve that resized source; the original stays unchanged. Applying the mask starts generation.</p>
      {!catalog && !error && <p role="status">Checking masked editing support…</p>}
      {problem && <p className="t-red" role="alert">{problem}</p>}
      {problem && <button type="button" className="btn btn-small" onClick={() => setRevision(x => x + 1)}>Refresh capability</button>}
    </div>
    <footer className="image-dialog-foot"><button type="button" className="btn btn-small" onClick={onClose}>Cancel</button><span className="image-grow" /><button type="button" className="btn btn-small btn-primary" disabled={disabled || !catalog?.inpaint || !!problem || !prompt.trim()} onClick={() => setPainting(true)}>Paint edit area</button></footer>
  </ImageDialog>
}
