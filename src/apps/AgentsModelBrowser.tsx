import { getModelMetadata, type ModelCategory, type ModelMetadata } from '../data/agentImages'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { IMAGE_PRESETS, imagePresetSpec, modelAssets, modelFolders, visibleModelAssets, type ImagePreset, type ModelFolder } from '../data/imageModels'
import { useIsMobile } from '../os/useIsMobile'

/** A themed OS dialog. Native modality traps focus and makes the underlying window inert. */
export function ImageDialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const mobile = useIsMobile()
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const dialog = ref.current!
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-image-autofocus]')?.focus()
    return () => { dialog.close(); if (before?.isConnected) before.focus({ preventScroll: true }) }
  }, [])
  return createPortal(<dialog ref={ref} className={`image-dialog ${wide ? 'is-wide' : ''} ${mobile ? 'is-mobile' : ''}`} aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }} onKeyDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
    <header className="image-dialog-head"><div><span className="muted image-eyebrow">AGENTS · IMAGES</span><h2 id={titleId}>{title}</h2></div><button type="button" className="btn" aria-label={`Close ${title}`} onClick={onClose}>Close ×</button></header>
    {children}
  </dialog>, document.body)
}

export function PresetPicker({ value, onChange, disabled }: { value: ImagePreset; onChange: (value: ImagePreset) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const preset = IMAGE_PRESETS.find((p) => p.id === value)!
  return <>
    <button type="button" className="image-picker" disabled={disabled} aria-haspopup="dialog" aria-label={`Choose workflow preset: ${preset.title}`} onClick={() => setOpen(true)}><strong>{preset.title}</strong><span className="muted">{preset.detail}</span><span>Browse workflows →</span></button>
    {open && <ImageDialog title="Choose workflow" onClose={() => setOpen(false)} wide>
      <p className="image-dialog-intro muted">Choose the family your installed model supports. Names and folders do not establish compatibility. Only these six workflows are supported.</p>
      <div className="image-presets">{IMAGE_PRESETS.map((p) => <button key={p.id} type="button" className={`image-preset ${value === p.id ? 'is-selected' : ''}`} aria-pressed={value === p.id} onClick={() => { onChange(p.id); setOpen(false) }}><strong>{p.title}{p.id === value ? ' · Selected' : ''}</strong><span>{p.detail}</span><p className="muted">{p.requirements}</p><span className="image-preset-use">Use {p.title} →</span></button>)}</div>
    </ImageDialog>}
  </>
}

/** Fetch artwork only when its tile becomes visible, and cancel when it leaves the UI. */
function ModelArtwork({ category, name, details = false }: { category?: ModelCategory; name: string; details?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [metadata, setMetadata] = useState<ModelMetadata | null>(null)
  const [error, setError] = useState('')
  const [failedImage, setFailedImage] = useState(false)
  useEffect(() => {
    setMetadata(null); setError(''); setFailedImage(false)
    if (!category || !name) return
    const abort = new AbortController()
    let started = false
    const start = () => {
      if (started) return
      started = true
      void getModelMetadata(category, name, abort.signal).then((value) => { if (!abort.signal.aborted) setMetadata(value) }, (e: Error) => { if (!abort.signal.aborted) setError(e.message) })
    }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { start(); observer.disconnect() } })
    if (ref.current) observer.observe(ref.current)
    return () => { abort.abort(); observer.disconnect() }
  }, [category, name])
  return <span ref={ref} className={details ? 'image-artwork-details' : 'image-artwork'}>
    {metadata?.preview && !failedImage ? <img src={metadata.preview} alt={details ? `Preview of ${name}` : ''} loading="lazy" onError={() => setFailedImage(true)} /> : <span className="image-artwork-empty" aria-hidden>◇</span>}
    {details && <span className="image-metadata muted">{error || (failedImage ? 'Preview unavailable. Refresh the catalog to retry.' : !metadata ? 'Loading model details…' : metadata.available ? <>{metadata.title && <strong>{metadata.title}</strong>}{metadata.baseModel && <span>Base model: {metadata.baseModel}</span>}{metadata.size !== undefined && <span>{(metadata.size / 1024 ** 3).toFixed(2)} GiB</span>}{!!metadata.tags?.length && <span>{metadata.tags.join(' · ')}</span>}<span>Source: {metadata.source}{!metadata.preview ? ' · No artwork supplied' : ''}</span></> : metadata.reason)}</span>}
  </span>
}

export function ModelPicker({ category, label, values, value, onChange, disabled, loading, error, onRefresh }: { category?: ModelCategory; label: string; values: string[]; value: string; onChange: (value: string) => void; disabled?: boolean; loading?: boolean; error?: string; onRefresh?: () => void }) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className="image-picker" disabled={disabled} aria-haspopup="dialog" aria-label={`Browse ${label}`} onClick={() => setOpen(true)}><span className="image-picker-content">{value && <ModelArtwork category={category} name={value} />}<span className="image-picker-text"><strong>{value ? modelAssets([value])[0].name : `Choose ${label.toLowerCase()}`}</strong>{value && <span className="muted image-path">{value}</span>}<span>Browse models →</span></span></span></button>
    {open && <ModelBrowser category={category} label={label} values={values} value={value} onChoose={(v) => { onChange(v); setOpen(false) }} onClose={() => setOpen(false)} loading={loading} error={error} onRefresh={onRefresh} />}
  </>
}

export function ModelBrowser({ category, label, values, value, onChoose, onClose, loading, error, onRefresh }: { category?: ModelCategory; label: string; values: string[]; value: string; onChoose: (value: string) => void; onClose: () => void; loading?: boolean; error?: string; onRefresh?: () => void }) {
  const assets = useMemo(() => modelAssets(values), [values])
  const tree = useMemo(() => modelFolders(assets), [assets])
  const current = assets.find((a) => a.value === value)
  const [folder, setFolder] = useState(current?.folder ?? '')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(value)
  const [shown, setShown] = useState(150)
  const [artworkRevision, setArtworkRevision] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const picked = assets.find((a) => a.value === selected)
  const files = useMemo(() => visibleModelAssets(assets, folder, query), [assets, folder, query])
  const trail = folder.split('/').filter(Boolean)
  let here = tree
  for (const part of trail) here = here.children.find((f) => f.name === part) ?? tree
  const navigate = (path: string) => { setFolder(path); setQuery(''); setShown(150) }
  const go = (path: string) => { navigate(path); requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>('button')?.focus()) }
  const branch = (node: ModelFolder, level = 0): ReactNode => <li key={node.path}>
    <button type="button" aria-current={folder === node.path && !query ? 'location' : undefined} style={{ paddingInlineStart: `${12 + level * 14}px` }} onClick={() => navigate(node.path)}><span aria-hidden>▱</span><span>{node.name}</span><small>{node.count}</small></button>
    {node.children.length > 0 && (node.path === '' || folder === node.path || folder.startsWith(`${node.path}/`)) && <ul>{node.children.map((child) => branch(child, level + 1))}</ul>}
  </li>
  const keys = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    const next = e.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1) : e.key === 'ArrowUp' ? Math.max(index - 1, 0) : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : -1
    if (next >= 0) { e.preventDefault(); buttons[next]?.focus() }
    else if (e.key === 'ArrowLeft' && folder && !query) { e.preventDefault(); go(trail.slice(0, -1).join('/')) }
    else if (e.key === 'ArrowRight' && buttons[index].dataset.folder !== undefined) { e.preventDefault(); buttons[index].click() }
  }
  return <ImageDialog title={`Browse ${label.toLowerCase()}`} onClose={onClose} wide>
    <div className="image-browser-tools"><input data-image-autofocus="" aria-label="Search model names and folders" placeholder="Search all folders…" onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); list.current?.querySelector<HTMLButtonElement>('button')?.focus() } }} value={query} onChange={(e) => { setQuery(e.target.value); setShown(150) }} />{onRefresh && <button type="button" className="btn" disabled={loading} onClick={() => { setArtworkRevision((n) => n + 1); onRefresh() }}>{loading ? 'Refreshing…' : 'Refresh'}</button>}</div>
    <div className="image-browser-body">
      <nav className="image-folders" aria-label="Model folders"><ul>{branch(tree)}</ul></nav>
      <section className="image-browser-main">
        <nav className="image-breadcrumbs" aria-label="Model path"><button type="button" onClick={() => navigate('')}>All folders</button>{!query && trail.map((part, i) => <span key={i}><span aria-hidden> / </span><button type="button" onClick={() => navigate(trail.slice(0, i + 1).join('/'))}>{part}</button></span>)}{query && <span> / Search results</span>}</nav>
        <p className="muted image-browser-count">{files.length} {query ? 'matching' : ''} models{query ? ' across all folders' : ` · ${here.children.length} ${here.children.length === 1 ? 'folder' : 'folders'}`}</p>
        {loading && <p role="status" className="muted">Loading installed models…</p>}
        {error && <p className="t-red copyable" role="alert">{error}</p>}
        {!loading && !error && !assets.length && <p className="muted">No models in this catalog. Save your ComfyUI connection and refresh, or install models in ComfyUI.</p>}
        {query && !files.length && !!assets.length && <p className="muted">No matching models. Try another name or folder.</p>}
        <ul ref={list} className="image-model-list" aria-label={`${label} catalog`} onKeyDown={keys}>
          {!query && here.children.map((f) => <li key={`folder:${f.path}`}><button type="button" data-folder="" className="image-model-row" onClick={() => go(f.path)}><span className="image-file-icon" aria-hidden>▱</span><span><strong>{f.name}</strong><small>{f.count} {f.count === 1 ? 'model' : 'models'} in this folder</small></span><span aria-hidden>→</span></button></li>)}
          {files.slice(0, shown).map((asset) => <li key={asset.value}><button type="button" className={`image-model-row ${selected === asset.value ? 'is-selected' : ''}`} aria-pressed={selected === asset.value} onFocus={() => setSelected(asset.value)} onClick={() => setSelected(asset.value)} onDoubleClick={() => onChoose(asset.value)}><ModelArtwork key={artworkRevision} category={category} name={asset.value} /><span><strong>{asset.name}</strong><small>{query ? asset.value : asset.extension}</small></span>{value === asset.value && <span className="image-current">Current</span>}</button></li>)}
        </ul>
        {files.length > shown && <button type="button" className="btn" onClick={() => setShown((n) => n + 150)}>Show more ({files.length - shown} left)</button>}
      </section>
      <aside className="image-model-details" aria-label="Selected model details">
        <span className="image-eyebrow muted">SELECTION</span>
        {picked ? <><ModelArtwork key={`${picked.value}:${artworkRevision}`} category={category} name={picked.value} details /><h3>{picked.name}</h3><dl><dt>Catalog</dt><dd>{label}</dd><dt>Folder</dt><dd>{picked.folder || 'Root'}</dd><dt>Format</dt><dd>{picked.extension}</dd><dt>Exact identifier</dt><dd className="copyable image-path">{picked.value}</dd></dl><p className="muted">Catalog identity comes from ComfyUI. Artwork and metadata do not establish workflow compatibility.</p></> : <p className="muted">{selected ? 'The saved selection is not in this catalog. Refresh or choose an installed model.' : 'Select a model to inspect its full path.'}</p>}
      </aside>
    </div>
    <footer className="image-dialog-foot"><span className="muted">Arrow keys navigate · Enter selects · Double-click confirms</span><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!picked || loading} onClick={() => picked && onChoose(picked.value)}>Use selected model</button></footer>
  </ImageDialog>
}

export function ImageModelFields({ value, catalog, onChange, disabled, loading, error, onRefresh, extra }: {
  value: { preset: ImagePreset; model: string; clip: string; vae: string }
  catalog: { checkpoints: string[]; diffusionModels: string[]; clips: string[]; vaes: string[] } | null
  onChange: (patch: Partial<{ preset: ImagePreset; model: string; clip: string; vae: string }>) => void
  disabled?: boolean; loading?: boolean; error?: string; onRefresh: () => void
  extra?: (field: 'preset' | 'model' | 'clip' | 'vae') => ReactNode
}) {
  const diffusion = Boolean(imagePresetSpec(value.preset).clipType)
  const picker = (field: 'model' | 'clip' | 'vae', label: string, values: string[]) => <div className="image-config-field"><div className="image-config-label"><strong>{label}</strong>{extra?.(field)}</div><ModelPicker category={field === 'model' ? diffusion ? 'diffusion_models' : 'checkpoints' : field === 'clip' ? 'text_encoders' : 'vae'} label={label} values={values} value={value[field]} onChange={(v) => onChange({ [field]: v })} disabled={disabled} loading={loading} error={error} onRefresh={onRefresh} /></div>
  return <div className="image-config-fields">
    <div className="image-config-field"><div className="image-config-label"><strong>Workflow preset</strong>{extra?.('preset')}</div><PresetPicker value={value.preset} onChange={(preset) => onChange({ preset, model: '' })} disabled={disabled} /></div>
    {picker('model', diffusion ? 'Diffusion model' : 'Checkpoint', (diffusion ? catalog?.diffusionModels : catalog?.checkpoints) ?? [])}
    {diffusion && <>{picker('clip', `Text encoder (${imagePresetSpec(value.preset).clipType})`, catalog?.clips ?? [])}{picker('vae', 'VAE', catalog?.vaes ?? [])}</>}
  </div>
}
