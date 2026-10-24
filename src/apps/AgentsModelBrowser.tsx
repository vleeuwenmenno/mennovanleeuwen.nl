import { getModelDetails, getModelMetadata, saveImageIntelSettings, type ModelCategory, type ModelDetails, type ModelMetadata, type PredictionSetting } from '../data/agentImages'
import { recommendedLine, recommendedSourceLabel, type Recommended } from '../data/modelFamilies'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type KeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { IMAGE_PRESETS, imagePresetSpec, resolveImageAssets, recommendedImageSampling, type ImageAssetCatalog, modelAssets, modelFolders, visibleModelAssets, type ImagePreset, type ModelFolder } from '../data/imageModels'
import { useIsMobile } from '../os/useIsMobile'
import { FileIcon, FolderIcon } from './Files'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'

/**
 * A themed OS dialog over everything but the desktop's own menus and questions. It is not a native
 * modal <dialog>: that would sit in the browser's top layer, above the OS dropdown menus (Select)
 * and the confirm dialogs (ask) used inside it. It mounts in the desktop's layer (a fixed element,
 * so its own stacking context) next to those, under them by z-index. A backdrop blocks the page
 * and Tab stays inside.
 */
export function ImageDialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const mobile = useIsMobile()
  const [host] = useState(() => document.querySelector<HTMLElement>('.desktop') ?? document.body)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const box = ref.current!
    ;(box.querySelector<HTMLElement>('[data-image-autofocus]') ?? box).focus()
    return () => { if (before?.isConnected) before.focus({ preventScroll: true }) }
  }, [])
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose() }
    else if (e.key === 'Tab') {
      const items = Array.from(ref.current!.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
      if (!items.length) return
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }
  return createPortal(<div className="image-dialog-backdrop" onPointerDown={(e) => e.stopPropagation()}>
    <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1} className={`image-dialog ${wide ? 'is-wide' : ''} ${mobile ? 'is-mobile' : ''}`} aria-labelledby={titleId} onKeyDown={keys}>
      <header className="image-dialog-head"><h2 id={titleId}>{title}</h2><button type="button" className="btn btn-small" aria-label={`Close ${title}`} onClick={onClose}>Close</button></header>
      {children}
    </div>
  </div>, host)
}

/** A compact picker row: optional thumb, name, path when it adds something, and Change… on the right. */
function PickRow({ thumb, name, detail, label, onClick, disabled, empty }: { thumb?: ReactNode; name: string; detail?: string; label: string; onClick: () => void; disabled?: boolean; empty?: boolean }) {
  return <button type="button" className={`image-pick ${empty ? 'is-empty' : ''}`} disabled={disabled} aria-haspopup="dialog" aria-label={label} onClick={onClick}>
    {thumb}
    <span className="image-pick-text"><strong>{name}</strong>{detail && <small className="muted">{detail}</small>}</span>
    <span className="btn btn-small image-pick-change" aria-hidden>Change…</span>
  </button>
}

export function PresetPicker({ value, onChange, disabled }: { value: ImagePreset; onChange: (value: ImagePreset) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const preset = IMAGE_PRESETS.find((p) => p.id === value)!
  return <>
    <PickRow name={preset.title} detail={preset.detail} label={`Change workflow preset: ${preset.title}`} onClick={() => setOpen(true)} disabled={disabled} />
    {open && <ImageDialog title="Choose workflow" onClose={() => setOpen(false)} wide>
      <p className="image-dialog-intro muted">Pick the family your model supports. File names and folders don’t prove compatibility.</p>
      <div className="image-presets">{IMAGE_PRESETS.map((p) => <button key={p.id} type="button" data-image-autofocus={p.id === value ? '' : undefined} className={`image-preset ${value === p.id ? 'is-selected' : ''}`} aria-pressed={value === p.id} onClick={() => { onChange(p.id); setOpen(false) }}>
        <span className="image-preset-title"><strong>{p.title}</strong>{p.id === value && <span className="image-current">Current</span>}</span>
        <span>{p.detail}</span>
        <small className="muted">{p.requirements}</small>
      </button>)}</div>
    </ImageDialog>}
  </>
}

/** Model metadata, fetched only once the element is on screen and cancelled when it leaves the UI. */
function useModelMetadata(ref: RefObject<HTMLElement | null>, category: ModelCategory | undefined, name: string, revision = 0) {
  const [metadata, setMetadata] = useState<ModelMetadata | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setMetadata(null); setError('')
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
  }, [category, name, revision, ref])
  return { metadata, error }
}

const gib = (size: number) => size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(2)} GiB` : `${Math.max(1, Math.round(size / 1024 ** 2))} MiB`

/** A small thumb: the model's artwork when it has some, otherwise a file icon. */
function Thumb({ preview, name }: { preview?: string; name: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [preview])
  return preview && !failed
    ? <span className="image-thumb"><img src={preview} alt="" loading="lazy" onError={() => setFailed(true)} /></span>
    : <span className="image-thumb is-icon"><FileIcon size={26} kind="package" name={name} /></span>
}

/** The selected model's large artwork and metadata in the browser's details pane. */
function ModelDetails({ category, name, revision }: { category?: ModelCategory; name: string; revision: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const { metadata, error } = useModelMetadata(ref, category, name, revision)
  const [failedImage, setFailedImage] = useState(false)
  useEffect(() => setFailedImage(false), [name, revision])
  return <div ref={ref} className="image-artwork-details">
    {metadata?.preview && !failedImage && <img src={metadata.preview} alt={`Preview of ${name}`} loading="lazy" onError={() => setFailedImage(true)} />}
    <span className="image-metadata muted">{error || (failedImage ? 'Preview unavailable. Refresh to retry.' : !metadata ? 'Loading model details…' : metadata.available ? <>{metadata.title && <strong>{metadata.title}</strong>}{metadata.baseModel && <span>Base model: {metadata.baseModel}</span>}{metadata.size !== undefined && <span>{gib(metadata.size)}</span>}{!!metadata.tags?.length && <span>{metadata.tags.join(' · ')}</span>}<span>Source: {metadata.source}{!metadata.preview ? ' · no artwork' : ''}</span></> : metadata.reason)}</span>
  </div>
}

/** What model_details knows about the selected checkpoint: family, tags, trained words, and the recipe with its source. */
function ModelIntel({ name, checkpoint }: { name: string; checkpoint: boolean }) {
  const [details, setDetails] = useState<ModelDetails | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    setDetails(null); setError('')
    const abort = new AbortController()
    // A short pause, so arrowing through the list does not ask about every file.
    const timer = setTimeout(() => void getModelDetails(name, 'checkpoint', abort.signal).then((d) => { if (!abort.signal.aborted) setDetails(d) }, (e: Error) => { if (!abort.signal.aborted) setError(e.message) }), 350)
    return () => { clearTimeout(timer); abort.abort() }
  }, [name, revision])
  // The owner's own word on the file's prediction type, for when automatic detection is wrong.
  const setPrediction = (value: PredictionSetting) => {
    setSaving(true)
    void saveImageIntelSettings({ prediction: { model: name, value } }).then(() => setRevision((n) => n + 1), (e: Error) => setError(e.message)).finally(() => setSaving(false))
  }
  if (error) return <p className="muted image-intel">Model details unavailable: {error}</p>
  if (!details) return <p className="muted image-intel" role="status">Reading model details…</p>
  const r = details.recommended
  const tags = details.lora_manager?.tags.filter((t) => !/^(base models?|checkpoint)$/i.test(t)).slice(0, 8) ?? []
  const words = [...new Set([...(details.lora_manager?.trained_words ?? []), ...(details.civitai?.trained_words ?? [])])].slice(0, 8)
  return <dl className="image-intel">
    <dt>Base model</dt><dd>{details.lora_manager?.base_model || details.civitai?.base_model || 'Unknown'}{details.family ? ` · ${details.family.label}` : ''}</dd>
    {checkpoint && details.prediction && <><dt>Prediction</dt><dd>
      <span className="image-prediction" role="group" aria-label="Prediction type">
        {(['auto', 'vpred', 'eps'] as const).map((v) => <button key={v} type="button" className={`btn btn-small ${details.prediction!.setting === v ? 'btn-primary' : ''}`} aria-pressed={details.prediction!.setting === v} disabled={saving} onClick={() => setPrediction(v)}>{v === 'auto' ? 'Auto' : v === 'vpred' ? 'v-pred' : 'eps'}</button>)}
      </span>
      <span className="muted">{details.prediction.setting === 'auto' ? `Detected: ${details.prediction.v_prediction ? 'v-pred' : 'eps'}` : 'Your setting'}</span>
    </dd></>}
    {details.supported === false && <><dt>Supported</dt><dd className="t-yellow">No: {details.unsupported_reason}</dd></>}
    {!!tags.length && <><dt>Tags</dt><dd>{tags.join(' · ')}</dd></>}
    {!!words.length && <><dt>Trained words</dt><dd className="copyable">{words.join(', ')}</dd></>}
    {r?.sampler && <><dt>Recommended</dt><dd>{r.preset ? `${r.preset} · ` : ''}{recommendedLine(r as Recommended)}{r.v_prediction ? ' · v-prediction' : ''}<br /><span className="muted">{recommendedSourceLabel(r as Recommended)}</span></dd></>}
    {details.civitai && <><dt>Civitai</dt><dd><a href={details.civitai.url} target="_blank" rel="noopener noreferrer">{details.civitai.model || 'Model page'}{details.civitai.version ? ` · ${details.civitai.version}` : ''}</a></dd></>}
    {!!details.notes.length && <><dt>Notes</dt><dd className="muted">{details.notes.join(' ')}</dd></>}
  </dl>
}

/** The compact row for a chosen model, with its artwork when the catalog has some. */
function ModelPickRow({ category, label, value, onClick, disabled }: { category?: ModelCategory; label: string; value: string; onClick: () => void; disabled?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const { metadata } = useModelMetadata(ref, category, value)
  const asset = value ? modelAssets([value])[0] : null
  return <span ref={ref} className="image-pick-wrap">
    <PickRow thumb={asset ? <Thumb preview={metadata?.preview} name={asset.name} /> : undefined} name={asset ? asset.name : `Choose ${label.toLowerCase()}`} detail={asset && asset.value !== asset.name ? asset.value : undefined} label={asset ? `Change ${label}: ${asset.value}` : `Choose ${label}`} onClick={onClick} disabled={disabled} empty={!asset} />
  </span>
}

export function ModelPicker({ category, label, values, value, onChange, disabled, loading, error, onRefresh }: { category?: ModelCategory; label: string; values: string[]; value: string; onChange: (value: string) => void; disabled?: boolean; loading?: boolean; error?: string; onRefresh?: () => void }) {
  const [open, setOpen] = useState(false)
  return <>
    <ModelPickRow category={category} label={label} value={value} onClick={() => setOpen(true)} disabled={disabled} />
    {open && <ModelBrowser category={category} label={label} values={values} value={value} onChoose={(v) => { onChange(v); setOpen(false) }} onClose={() => setOpen(false)} loading={loading} error={error} onRefresh={onRefresh} />}
  </>
}

/** One file in the browser: a thumb only when the model has artwork, plus size and base model once known. */
function ModelRow({ category, asset, query, selected, current, revision, onSelect, onChoose }: { category?: ModelCategory; asset: ReturnType<typeof modelAssets>[number]; query: string; selected: boolean; current: boolean; revision: number; onSelect: () => void; onChoose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const { metadata } = useModelMetadata(ref, category, asset.value, revision)
  const [failed, setFailed] = useState(false)
  const meta = [query ? asset.value : asset.extension, metadata?.available && metadata.size !== undefined ? gib(metadata.size) : '', metadata?.available ? metadata.baseModel ?? '' : ''].filter(Boolean).join(' · ')
  return <button ref={ref} type="button" className={`image-model-row ${selected ? 'is-selected' : ''} ${current ? 'is-current' : ''}`} aria-pressed={selected} onFocus={onSelect} onClick={onSelect} onDoubleClick={onChoose}>
    {metadata?.preview && !failed ? <span className="image-thumb"><img src={metadata.preview} alt="" loading="lazy" onError={() => setFailed(true)} /></span> : <span className="image-row-icon"><FileIcon size={22} kind="package" name={asset.name} /></span>}
    <span className="image-row-text"><strong>{asset.name}</strong><small>{meta}</small></span>
    {current && <span className="image-current">Current</span>}
  </button>
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
    <button type="button" aria-current={folder === node.path && !query ? 'location' : undefined} style={{ paddingInlineStart: `${10 + level * 14}px` }} onClick={() => navigate(node.path)}><FolderIcon size={16} /><span>{node.name}</span><small>{node.count}</small></button>
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
  return <ImageDialog title={`Choose ${label.toLowerCase()}`} onClose={onClose} wide>
    <div className="image-browser-tools"><input data-image-autofocus="" aria-label="Search model names and folders" placeholder="Search all folders…" onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); list.current?.querySelector<HTMLButtonElement>('button')?.focus() } }} value={query} onChange={(e) => { setQuery(e.target.value); setShown(150) }} />{onRefresh && <button type="button" className="btn btn-small" disabled={loading} onClick={() => { setArtworkRevision((n) => n + 1); onRefresh() }}>{loading ? 'Refreshing…' : 'Refresh'}</button>}</div>
    <div className="image-browser-body">
      <nav className="image-folders" aria-label="Model folders"><ul>{branch(tree)}</ul></nav>
      <section className="image-browser-main">
        <div className="image-browser-head">
          <nav className="image-breadcrumbs" aria-label="Model path"><button type="button" onClick={() => navigate('')}>All</button>{!query && trail.map((part, i) => <span key={i}><span aria-hidden className="muted">/</span><button type="button" onClick={() => navigate(trail.slice(0, i + 1).join('/'))}>{part}</button></span>)}{query && <span className="muted">/ Search</span>}</nav>
          <span className="muted image-browser-count">{files.length} {files.length === 1 ? 'model' : 'models'}{!query && here.children.length > 0 ? ` · ${here.children.length} ${here.children.length === 1 ? 'folder' : 'folders'}` : ''}</span>
        </div>
        {loading && <p role="status" className="muted image-browser-note">Loading installed models…</p>}
        {error && <p className="t-red copyable image-browser-note" role="alert">{error}</p>}
        {!loading && !error && !assets.length && <p className="muted image-browser-note">No models found. Save your ComfyUI connection and refresh, or install models in ComfyUI.</p>}
        {query && !files.length && !!assets.length && <p className="muted image-browser-note">No matching models.</p>}
        <ul ref={list} className="image-model-list" aria-label={`${label} catalog`} onKeyDown={keys}>
          {!query && here.children.map((f) => <li key={`folder:${f.path}`}><button type="button" data-folder="" className="image-model-row is-folder" onClick={() => go(f.path)}><span className="image-row-icon"><FolderIcon size={22} /></span><span className="image-row-text"><strong>{f.name}</strong><small>{f.count} {f.count === 1 ? 'model' : 'models'}</small></span><span aria-hidden className="muted">›</span></button></li>)}
          {files.slice(0, shown).map((asset) => <li key={asset.value}><ModelRow category={category} asset={asset} query={query} selected={selected === asset.value} current={value === asset.value} revision={artworkRevision} onSelect={() => setSelected(asset.value)} onChoose={() => onChoose(asset.value)} /></li>)}
        </ul>
        {files.length > shown && <button type="button" className="btn btn-small image-browser-more" onClick={() => setShown((n) => n + 150)}>Show more ({files.length - shown} left)</button>}
      </section>
      <aside className="image-model-details" aria-label="Selected model details">
        {picked ? <><h3>{picked.name}{picked.value === value && <span className="image-current">Current</span>}</h3><ModelDetails category={category} name={picked.value} revision={artworkRevision} />{(category === 'checkpoints' || category === 'diffusion_models') && <ModelIntel name={picked.value} checkpoint={category === 'checkpoints'} />}<dl><dt>Folder</dt><dd>{picked.folder || 'Root'}</dd><dt>Format</dt><dd>{picked.extension}</dd><dt>Identifier</dt><dd className="copyable image-path">{picked.value}</dd></dl><p className="muted">Artwork and metadata don’t prove workflow compatibility.</p></> : <p className="muted">{selected ? 'The saved selection is not in this catalog. Refresh or choose an installed model.' : 'Select a model to see its details.'}</p>}
      </aside>
    </div>
    <footer className="image-dialog-foot"><span className="muted image-dialog-hint">Arrows move · ← up · Double-click uses</span><span className="image-grow" /><button type="button" className="btn btn-small" onClick={onClose}>Cancel</button><button type="button" className="btn btn-small btn-primary" disabled={!picked || loading} onClick={() => picked && onChoose(picked.value)}>Use selected</button></footer>
  </ImageDialog>
}

type Field = 'model' | 'clip' | 'vae'
type Assets = { preset: ImagePreset; model: string; clip: string; vae: string }

/** One model field: label, Auto | Manual, the picker row and why this model was picked. */
function AssetField({ field, label, category, values, value, selection, onChange, disabled, loading, error, onRefresh, extra }: {
  field: Field; label: string; category: ModelCategory; values: string[]; value: string
  selection?: ReturnType<typeof resolveImageAssets>['selection'][Field]
  onChange: (patch: Partial<Assets>) => void; disabled?: boolean; loading?: boolean; error?: string; onRefresh: () => void; extra?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const manual = Boolean(value)
  const shown = selection?.value ?? value
  const problem = selection && 'error' in selection ? selection.error : undefined
  const labelId = useId()
  return <div className="image-config-field" role="group" aria-labelledby={labelId}>
    <div className="image-config-label">
      <strong id={labelId}>{label}</strong>{extra}
      <span className="seg seg-small image-mode" role="radiogroup" aria-label={`${label} choice`}>
        <button type="button" role="radio" aria-checked={!manual} className={!manual ? 'is-active' : ''} disabled={disabled} onClick={() => onChange({ [field]: '' })}>Auto</button>
        <button type="button" role="radio" aria-checked={manual} className={manual ? 'is-active' : ''} disabled={disabled} onClick={() => { if (!manual) setOpen(true) }}>Manual</button>
      </span>
    </div>
    <ModelPickRow category={category} label={label} value={shown} onClick={() => setOpen(true)} disabled={disabled} />
    <p className={`image-selection-reason ${problem ? 't-red' : 'muted'}`}>{problem || selection?.reason || 'Discover installed models to see recommendations.'}</p>
    {selection?.automatic && !selection.value && selection.candidates.length > 0 && <div className="image-recommendations" aria-label={`Recommended ${label.toLowerCase()} choices`}>{selection.candidates.slice(0, 6).map((candidate) => <button type="button" key={candidate} disabled={disabled} onClick={() => onChange({ [field]: candidate })}>{candidate}</button>)}{selection.candidates.length > 6 && <span className="muted">More matches in the model browser.</span>}</div>}
    {open && <ModelBrowser category={category} label={label} values={values} value={shown} onChoose={(v) => { onChange({ [field]: v }); setOpen(false) }} onClose={() => setOpen(false)} loading={loading} error={error} onRefresh={onRefresh} />}
  </div>
}

export function ImageModelFields({ value, catalog, onChange, disabled, loading, error, onRefresh, extra }: {
  value: Assets
  catalog: ImageAssetCatalog | null
  onChange: (patch: Partial<Assets>) => void
  disabled?: boolean; loading?: boolean; error?: string; onRefresh: () => void
  extra?: (field: 'preset' | Field) => ReactNode
}) {
  const diffusion = Boolean(imagePresetSpec(value.preset).clipType)
  const resolved = catalog ? resolveImageAssets(value, catalog) : null
  const sampling = recommendedImageSampling(value.preset, resolved?.effective.model ?? value.model, catalog ?? undefined)
  const field = (name: Field, label: string, category: ModelCategory, values: string[]) => <AssetField field={name} label={label} category={category} values={values} value={value[name]} selection={resolved?.selection[name]} onChange={onChange} disabled={disabled} loading={loading} error={error} onRefresh={onRefresh} extra={extra?.(name)} />
  return <div className="image-config-fields">
    <div className="image-config-field"><div className="image-config-label"><strong>Workflow</strong>{extra?.('preset')}</div><PresetPicker value={value.preset} onChange={(preset) => onChange({ preset })} disabled={disabled} /></div>
    {field('model', diffusion ? 'Diffusion model' : 'Checkpoint', diffusion ? 'diffusion_models' : 'checkpoints', (diffusion ? catalog?.diffusionModels : catalog?.checkpoints) ?? [])}
    {diffusion && <>{field('clip', `Text encoder (${imagePresetSpec(value.preset).clipType})`, 'text_encoders', catalog?.clips ?? [])}{field('vae', 'VAE', 'vae', catalog?.vaes ?? [])}</>}
    <div className="image-auto-summary">
      <span className="muted" title="Ask the agent to tune a single generation; saved defaults stay unchanged.">Recommended sampling: {sampling.steps} steps · CFG {sampling.cfg} · {sampling.sampler || 'no supported sampler'} / {sampling.scheduler || 'no supported scheduler'}</span>
      <button type="button" className="btn btn-small" disabled={disabled || (!value.model && !value.clip && !value.vae)} onClick={() => onChange({ model: '', clip: '', vae: '' })}>Use recommended assets</button>
    </div>
  </div>
}
