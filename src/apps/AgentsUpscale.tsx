import { useEffect, useState } from 'react'
import { getImageCatalog, type GeneratedImage, type ImageCatalog, type UpscaleImageInput } from '../data/agentImages'
import { Select } from '../os/Select'
import { ImageDialog, ModelPicker } from './AgentsModelBrowser'

/** A direct image operation: choose an installed model and preserve the source's aspect ratio. */
export function UpscaleDialog({ image, disabled, onClose, onUpscale }: { image: GeneratedImage; disabled: boolean; onClose: () => void; onUpscale: (input: UpscaleImageInput) => void }) {
  const [catalog, setCatalog] = useState<ImageCatalog | null>(null)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [model, setModel] = useState('')
  const [scale, setScale] = useState(2)
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    getImageCatalog().then((value) => { if (alive) setCatalog(value) }, (e: Error) => { if (alive) { setCatalog(null); setError(e.message) } }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [revision])
  const width = Math.round(image.width * scale), height = Math.round(image.height * scale)
  const sourceTooLarge = image.width > 2048 || image.height > 2048
  const invalid = !Number.isInteger(width) || !Number.isInteger(height) || width <= image.width || height <= image.height || width > 4096 || height > 4096 || width * height > 16777216
  const capabilityError = catalog && !catalog.upscale ? catalog.upscaleError || 'Model upscaling is unavailable on this backend.' : ''
  const ready = !disabled && !loading && !error && !!catalog?.upscale && catalog.upscalers?.includes(model) && !invalid && !sourceTooLarge
  return <ImageDialog title="Upscale image" onClose={onClose}>
    <div className="image-session-body">
      <p>Enlarge {image.name} with an installed upscaler. No prompt needed.</p>
      <ModelPicker category="upscale_models" label="Upscale model" values={catalog?.upscalers ?? []} value={model} onChange={setModel} loading={loading} error={error || capabilityError} onRefresh={() => setRevision((r) => r + 1)} />
      <div className="image-config-field">
        <span>Scale</span>
        <Select aria-label="Scale" value={scale} onChange={setScale} options={[1.5, 2, 4].map((value) => ({ value, label: `${value}×` }))} />
      </div>
      <p role="status" aria-live="polite">{image.width} × {image.height} → {width} × {height} px · aspect ratio preserved</p>
      {sourceTooLarge && <p className="t-red" role="alert">This source exceeds 2048 px per side. Resize a copy to at most 2048 px per side before upscaling; original pixels are never silently reduced.</p>}
      {invalid && <p className="t-red" role="alert">Choose a smaller scale. Output must enlarge the source and fit within 4096 × 4096 px (16,777,216 pixels).</p>}
      {(error || capabilityError) && <p className="t-red copyable" role="alert">{error || capabilityError}</p>}
      {!loading && catalog?.upscale && !catalog.upscalers?.length && <p role="status">No upscale models installed. Install one in ComfyUI and refresh the model browser.</p>}
      <p className="muted">The model’s native intermediate image can be larger than the requested output. Memory use is not guaranteed. Original source pixels feed the model. Sources above 2048 px per side must be resized separately; input dimensions are recorded in the result’s settings.</p>
    </div>
    <footer className="image-dialog-foot"><button type="button" className="btn btn-small" onClick={onClose}>Cancel</button><span className="image-grow" /><button type="button" className="btn btn-small btn-primary" disabled={!ready} onClick={() => { if (ready) onUpscale({ operation: 'upscale', source_image_id: image.id, upscale_model: model, scale }) }}>Upscale</button></footer>
  </ImageDialog>
}
