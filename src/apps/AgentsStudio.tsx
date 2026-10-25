import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import './AgentsStudio.css'
import { deleteStudioImage, getImageCatalog, getLoraDetails, getStudio, getStudioEmbeddings, getStudioImages, getStudioModelDetails, loraPreviewUrl, runStudio, uploadStudioImage, type GeneratedImage, type LoraDetail, type MaskedEditInput, type ModelDetails, type RefineImageInput, type StudioImage, type UpscaleImageInput } from '../data/agentImages'
import { applyRecipe, defaultStudioForm, formFromSettings, normalizeStudioForm, sourceSize, STEP_PRESETS, STUDIO_LIMITS, studioProblems, studioRecipe, studioRunInput, studioSamplers, studioSchedulers, variantPreset, type StudioCatalog, type StudioForm, type StudioRecipe, type StudioSource } from '../data/imageStudio'
import { isTurbo, presetRules, promptTokens, SIZE_LIMITS, sizeBuckets } from '../data/modelFamilies'
import { detectedImageFamily, IMAGE_PRESETS, imagePresetSpec, resolveImageAssets, type ImagePreset, type ImageProgress } from '../data/imageModels'
import { toAttachment, type Thread } from '../data/agents'
import { getDraft, setDraft } from '../data/agentDrafts'
import { imageFileName } from '../data/agentImageFiles'
import { synced } from '../os/synced'
import { Select } from '../os/Select'
import { ask } from '../os/Dialogs'
import { openMenuAt } from '../os/ContextMenu'
import { useIsMobile } from '../os/useIsMobile'
import { ImageDialog, ImageModelFields, ModelBrowser } from './AgentsModelBrowser'
import { GeneratedPicture, Lightbox } from './AgentsImages'
import { RefineDialog } from './AgentsRefine'
import { InpaintDialog } from './AgentsInpaint'
import { UpscaleDialog } from './AgentsUpscale'

// The Image Studio: a ComfyUI generation driven by hand, modelled on Diffu's Generate page. Left,
// what to draw with (model, encoder, VAE, the family's card, LoRAs and embeddings, the prompts,
// a source picture, the size); in the middle the picture as it is made and the history; right,
// Generate and the queue, then seed and sampling, and the hires pass. A narrow window (or a phone)
// shows the middle with the prompt, Parameters and Advanced as drawers, and Generate in a bar at
// the bottom. Runs go to server/agentImageStudio.ts, through the same graph builder and checks as
// the agent's generate_image; the form follows the account (synced), the history is the server's.

/** The form, following the account between devices (and kept in this browser without storage too). */
const studioForm = synced<StudioForm>('agents-image-studio', defaultStudioForm(), { normalize: normalizeStudioForm })
/** Changes the form from outside the controls: the seam an assistant's proposals apply through. */
export const applyStudioPatch = (patch: Partial<StudioForm>) => studioForm.set((f) => normalizeStudioForm({ ...f, ...patch, edited: true }))
/**
 * The fields a helper can attach to (a button beside the field's label). Nothing is attached in this
 * release; `assist` is where per-field help plugs in.
 */
export type StudioField = 'model' | 'loras' | 'embeddings' | 'prompt' | 'negative' | 'source' | 'size' | 'seed' | 'sampling' | 'upscale'

// --- the runner: one job at a time, kept while the Studio view is closed ----------------------

type Operation = 'generate' | 'refine' | 'inpaint' | 'remove' | 'upscale'
type Job = { id: number; input: Record<string, unknown>; batch: number; label: string; operation: Operation }
type Live = { job: Job; index: number; total: number; width: number; height: number; progress?: ImageProgress }
type RunnerState = { live: Live | null; queue: Job[]; error: string; fresh: StudioImage[]; lastSeed: number | null }
let runner: RunnerState = { live: null, queue: [], error: '', fresh: [], lastSeed: null }
const runnerListeners = new Set<() => void>()
let controller: AbortController | null = null
let nextJob = 1
const update = (patch: Partial<RunnerState>) => {
  runner = { ...runner, ...patch }
  runnerListeners.forEach((l) => l())
}
const useRunner = () => useSyncExternalStore((l) => (runnerListeners.add(l), () => void runnerListeners.delete(l)), () => runner)
function pump() {
  if (runner.live || !runner.queue.length) return
  const [job, ...queue] = runner.queue
  const width = Number(job.input.width) || 1024, height = Number(job.input.height) || 1024
  const ctl = (controller = new AbortController())
  update({ live: { job, index: 0, total: job.batch, width, height }, queue, error: '' })
  void runStudio(job.input, job.batch, (e) => {
    const live = runner.live
    if (e.type === 'start' && live) update({ live: { ...live, index: e.index, total: e.total, width: e.width, height: e.height, progress: undefined } })
    else if (e.type === 'progress' && live) update({ live: { ...live, progress: e.progress } })
    else if (e.type === 'image') update({ fresh: [{ ...e.image, settings: e.image.settings ?? null, created_at: Date.now(), studio: true }, ...runner.fresh].slice(0, 60), lastSeed: e.image.seed ?? runner.lastSeed })
    else if (e.type === 'error') update({ error: e.error })
  }, ctl.signal)
    .catch((err: Error) => { if (!ctl.signal.aborted) update({ error: err.message }) })
    .finally(() => {
      if (controller === ctl) controller = null
      update({ live: null })
      pump()
    })
}
const enqueue = (input: Record<string, unknown>, batch: number, label: string, operation: Operation) => {
  update({ queue: [...runner.queue, { id: nextJob++, input, batch, label, operation }] })
  pump()
}
const cancelRun = () => controller?.abort()

// --- small pieces ------------------------------------------------------------------------------

const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {})
const round2 = (v: number) => Math.round(v * 100) / 100
const asGenerated = (i: StudioImage): GeneratedImage => ({ ...i, settings: i.settings ?? undefined })
const randomSeed = () => Math.floor(Math.random() * 2 ** 32)

/** A labelled field, with room beside the label for a helper (Release 2's ✨). */
function Field({ label, field, assist, children, hint, id }: { label: string; field?: StudioField; assist?: (field: StudioField) => ReactNode; children: ReactNode; hint?: ReactNode; id?: string }) {
  return <div className="studio-field">
    <div className="studio-label"><label htmlFor={id}>{label}</label>{field && assist?.(field)}</div>
    {children}
    {hint && <p className="studio-hint muted">{hint}</p>}
  </div>
}

/** A slider with the exact number beside it; both edit the same value. */
function NumberSlider({ value, min, max, step, onChange, label, disabled }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string; disabled?: boolean }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (raw: string) => {
    const n = Number(raw)
    if (raw.trim() !== '' && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n / step) * step)))
    else setDraft(String(value))
  }
  return <span className="studio-slider">
    <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
    <input type="number" min={min} max={max} step={step} value={draft} disabled={disabled} aria-label={`${label}, exact`} onChange={(e) => setDraft(e.target.value)} onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)} />
  </span>
}

function ErrorBox({ text, onDismiss }: { text: string; onDismiss?: () => void }) {
  return <div className="studio-error" role="alert">
    <p className="t-red copyable">{text}</p>
    <span className="studio-row">
      <button type="button" className="btn btn-small" onClick={() => copy(text)}>Copy</button>
      {onDismiss && <button type="button" className="btn btn-small" onClick={onDismiss}>Dismiss</button>}
    </span>
  </div>
}

// --- the Studio --------------------------------------------------------------------------------

export function ImageStudio({ threads, onBack, onOpenThread, onSettings, assist }: { /** The threads Send to chat offers; null when chat is unavailable (no Ollama key). */ threads: Thread[] | null; onBack: () => void; onOpenThread: (id: string | null) => void; onSettings: () => void; assist?: (field: StudioField) => ReactNode }) {
  const form = studioForm.use()
  const run = useRunner()
  const mobile = useIsMobile()
  const root = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const el = root.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= 1000))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const columns = wide && !mobile
  const [drawer, setDrawer] = useState<'params' | 'advanced' | null>(null)
  useEffect(() => { if (columns) setDrawer(null) }, [columns])

  /** `edit`: a change by hand to what a recipe sets, so a new model asks before replacing it. */
  const set = (patch: Partial<StudioForm>, edit = false) => studioForm.set((f) => ({ ...f, ...patch, ...(edit ? { edited: true } : {}) }))

  // The backend, its catalog and the Studio's own thread.
  const [studio, setStudio] = useState<{ thread: string; configured: boolean; batchMax: number } | null>(null)
  const [bootError, setBootError] = useState('')
  const [catalog, setCatalog] = useState<StudioCatalog | null>(null)
  const [catalogError, setCatalogError] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const discover = () => {
    setDiscovering(true); setCatalogError('')
    getImageCatalog().then((c) => setCatalog(c as StudioCatalog), (e: Error) => setCatalogError(e.message)).finally(() => setDiscovering(false))
  }
  useEffect(() => {
    getStudio().then((s) => { setStudio(s); if (s.configured) discover() }, (e: Error) => setBootError(e.message))
  }, [])

  // History: the server's, with this page's fresh results in front.
  const [history, setHistory] = useState<StudioImage[]>([])
  const [olderFrom, setOlderFrom] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState('')
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set())
  const loadHistory = (before?: string) => getStudioImages('studio', before).then((r) => { setHistory((h) => (before ? [...h, ...r.images] : r.images)); setOlderFrom(r.next_before) }, (e: Error) => setHistoryError(e.message))
  useEffect(() => { void loadHistory() }, [])
  const images = useMemo(() => {
    const seen = new Set<string>()
    return [...run.fresh, ...history].filter((i) => !deleted.has(i.id) && !seen.has(i.id) && (seen.add(i.id), true))
  }, [run.fresh, history, deleted])
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => { if (run.fresh[0]) setSelected(run.fresh[0].id) }, [run.fresh[0]?.id])
  const shown = images.find((i) => i.id === selected) ?? images[0] ?? null

  // What the model resolves to and its recipe (model_details), offered when the model changes.
  const resolved = catalog ? resolveImageAssets({ preset: form.preset, model: form.model, clip: form.clip, vae: form.vae }, catalog) : null
  const model = resolved?.effective.model || form.model
  const [details, setDetails] = useState<ModelDetails | null>(null)
  const [detailsFor, setDetailsFor] = useState('')
  const [offer, setOffer] = useState<(StudioRecipe & { key: string }) | null>(null)
  const recipeKey = `${form.preset}|${model}`
  useEffect(() => {
    if (!catalog) return
    setDetails(null); setDetailsFor('')
    if (!model) { setDetailsFor(recipeKey); return }
    const abort = new AbortController()
    const timer = setTimeout(() => void getStudioModelDetails(model, form.preset, abort.signal).then((d) => { if (!abort.signal.aborted) { setDetails(d); setDetailsFor(recipeKey) } }, () => { if (!abort.signal.aborted) setDetailsFor(recipeKey) }), 250)
    return () => { clearTimeout(timer); abort.abort() }
  }, [recipeKey, catalog])
  const recipe = useMemo(() => (detailsFor === recipeKey ? studioRecipe(form.preset, model, catalog, details?.recommended) : null), [detailsFor, recipeKey, details, catalog])
  useEffect(() => {
    if (!recipe || !model) return
    const current = form.recipe
    // Back on the model the settings are for: nothing to ask any more.
    if (current && current.model === model && current.preset === form.preset) return setOffer(null)
    // An untouched form takes the new model's settings; an edited one asks first.
    if (!form.edited) studioForm.set((f) => applyRecipe(f, recipe, model))
    else setOffer({ ...recipe, key: recipeKey })
  }, [recipe])
  const acceptOffer = () => { if (offer) studioForm.set((f) => applyRecipe(f, offer, model)); setOffer(null) }
  const keepCurrent = () => { set({ recipe: { model, preset: form.preset, source: 'user_saved', label: 'Your settings, kept over the recipe' } }); setOffer(null) }

  const problems = studio ? studioProblems(form, { configured: studio.configured, catalog, catalogError, loading: discovering }) : [bootError || 'Opening the Studio…']
  const generate = () => { if (!problems.length) enqueue(studioRunInput(form), form.batch, `${form.batch > 1 ? `${form.batch} × ` : ''}${form.prompt.trim().slice(0, 60) || 'Picture'}`, 'generate') }
  // The model hands its preset to the Variant switch: Auto reads raw or turbo from the name.
  const changeAssets = (patch: Partial<Pick<StudioForm, 'preset' | 'model' | 'clip' | 'vae'>>) => studioForm.set((f) => {
    const next = { ...f, ...patch }
    if (patch.preset && patch.preset !== f.preset) {
      // A new workflow: its own encoder and VAE, its pair's variant, and a fresh recipe.
      if (Boolean(imagePresetSpec(patch.preset).clipType) !== Boolean(imagePresetSpec(f.preset).clipType)) Object.assign(next, { model: '', clip: '', vae: '', checkpointVae: '' })
      next.variant = presetRules(patch.preset).variants ? (isTurbo(patch.preset) ? 'turbo' : 'raw') : 'auto'
      if (!presetRules(patch.preset).embeddings) next.embeddings = []
    }
    if (patch.model !== undefined && next.variant === 'auto') next.preset = variantPreset(next.preset, 'auto', patch.model)
    return next
  })

  const sendToChat = async (image: StudioImage, thread: string | null) => {
    const blob = await (await fetch(image.url, { credentials: 'same-origin' })).blob()
    const file = await toAttachment(blob, imageFileName(image), 'Image Studio')
    const key = thread ?? 'new'
    const draft = getDraft(key)
    setDraft(key, draft?.text ?? '', [...(draft?.files ?? []), file])
    onOpenThread(thread)
  }
  const removeImage = async (image: StudioImage) => {
    if (!(await ask({ title: 'Delete this picture?', body: 'It leaves the Studio’s history for good. Copies sent to a chat stay there.', confirm: 'Delete', danger: true }))) return
    await deleteStudioImage(image.id).then(() => setDeleted((d) => new Set(d).add(image.id)), (e: Error) => update({ error: e.message }))
  }

  const [dialog, setDialog] = useState<{ kind: 'refine' | 'inpaint' | 'upscale' | 'view'; image: StudioImage } | null>(null)
  const frame = useRef<HTMLDivElement>(null)

  // --- the sections ---
  const modelSection = <ModelSection form={form} catalog={catalog} details={details} resolved={resolved} model={model} offer={offer} onAccept={acceptOffer} onKeep={keepCurrent} onAssets={changeAssets} onSet={set} discovering={discovering} catalogError={catalogError} onRefresh={discover} assist={assist} />
  const promptSection = <PromptSection form={form} onSet={set} assist={assist} />
  const loraSection = <LoraSection form={form} catalog={catalog} onSet={set} assist={assist} />
  const sourceSection = <SourceSection form={form} onSet={set} assist={assist} onError={(e) => update({ error: e })} />
  const sizeSection = <SizeSection form={form} onSet={set} batchMax={studio?.batchMax ?? STUDIO_LIMITS.batch[1]} assist={assist} />
  const advanced = <AdvancedSection form={form} catalog={catalog} lastSeed={run.lastSeed} recipe={recipe} onSet={set} onRecipe={() => recipe && studioForm.set((f) => applyRecipe(f, recipe, model, true))} assist={assist} />
  const actions = <ActionSection problems={problems} live={run.live} queue={run.queue} error={run.error} batch={form.batch} onGenerate={generate} onSettings={onSettings} configured={!!studio?.configured} />

  const preview = <section className="studio-preview" aria-label="Preview">
    {run.live ? <>
      <p className="muted studio-caption">{run.live.job.label}{run.live.total > 1 ? ` · ${run.live.index + 1} of ${run.live.total}` : ''} · {run.live.width} × {run.live.height}</p>
      <GeneratedPicture operation={run.live.job.operation} width={run.live.width} height={run.live.height} pending progress={run.live.progress} frame={frame} onView={() => {}} />
    </> : shown ? <>
      <p className="muted studio-caption" title={shown.name}>{shown.width} × {shown.height}{shown.settings && 'seed' in shown.settings ? ` · seed ${shown.settings.seed}` : ''}{shown.settings && 'model' in shown.settings ? ` · ${shown.settings.model.split(/[\\/]/).at(-1)}` : shown.settings ? '' : ' · uploaded'} · {new Date(shown.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</p>
      <GeneratedPicture image={asGenerated(shown)} width={shown.width || 1024} height={shown.height || 1024} pending={false} frame={frame} onView={() => setDialog({ kind: 'view', image: shown })} />
      <ResultActions image={shown} threads={threads} disabled={false} onUse={() => shown.settings && studioForm.set((f) => formFromSettings(f, shown.settings!))} onSend={(t) => void sendToChat(shown, t).catch((e: Error) => update({ error: e.message }))} onDialog={(kind) => setDialog({ kind, image: shown })} onDelete={() => void removeImage(shown)} />
    </> : <div className="studio-empty muted">{studio && !studio.configured ? 'Connect ComfyUI to start.' : 'Your pictures show here. Write a prompt and press Generate.'}</div>}
  </section>
  const historySection = <section className="studio-history" aria-label="History">
    <h4 className="studio-head">History</h4>
    {historyError && <ErrorBox text={historyError} />}
    {!images.length && !historyError && <p className="muted">Nothing generated in the Studio yet.</p>}
    <ul className="studio-thumbs">
      {images.map((i) => <li key={i.id}><button type="button" className={`studio-thumb ${shown?.id === i.id && !run.live ? 'is-on' : ''}`} onClick={() => setSelected(i.id)} title={i.settings && 'prompt' in i.settings ? i.settings.prompt.slice(0, 200) : i.name} aria-label={`Show ${i.name}`}><img src={i.url} alt="" loading="lazy" draggable={false} /></button></li>)}
    </ul>
    {olderFrom && <button type="button" className="btn btn-small" onClick={() => void loadHistory(olderFrom)}>Show older</button>}
  </section>

  const head = <header className="studio-top">
    {(!columns || mobile) && <button type="button" className="btn btn-small" onClick={onBack} aria-label="Back to threads" title="Back to threads">‹</button>}
    <h3>Image Studio</h3>
    <span className="studio-grow" />
    {!columns && <>
      <button type="button" className={`btn btn-small ${drawer === 'params' ? 'btn-primary' : ''}`} aria-expanded={drawer === 'params'} onClick={() => setDrawer(drawer === 'params' ? null : 'params')}>Parameters</button>
      <button type="button" className={`btn btn-small ${drawer === 'advanced' ? 'btn-primary' : ''}`} aria-expanded={drawer === 'advanced'} onClick={() => setDrawer(drawer === 'advanced' ? null : 'advanced')}>Advanced</button>
    </>}
  </header>

  return <div ref={root} className={`studio ${columns ? 'is-wide' : 'is-narrow'}`}>
    {head}
    {bootError && <ErrorBox text={bootError} />}
    {columns ? <div className="studio-cols">
      <aside className="studio-col studio-left" aria-label="Parameters">{modelSection}{loraSection}{promptSection}{sourceSection}{sizeSection}</aside>
      <main className="studio-col studio-centre">{preview}{historySection}</main>
      <aside className="studio-col studio-right" aria-label="Generate and advanced settings">{actions}{advanced}</aside>
    </div> : <>
      <main className="studio-col studio-centre">{promptSection}{preview}{historySection}</main>
      <div className="studio-bar">
        <ActionSection compact problems={problems} live={run.live} queue={run.queue} error={run.error} batch={form.batch} onGenerate={generate} onSettings={onSettings} configured={!!studio?.configured} />
      </div>
      {drawer && <div className="studio-drawer-backdrop" onClick={() => setDrawer(null)} />}
      {drawer && <aside className={`studio-drawer is-${drawer}`} aria-label={drawer === 'params' ? 'Parameters' : 'Advanced'}>
        <header className="studio-drawer-head"><strong>{drawer === 'params' ? 'Parameters' : 'Advanced'}</strong><button type="button" className="btn btn-small" onClick={() => setDrawer(null)}>Done</button></header>
        {drawer === 'params' ? <>{modelSection}{loraSection}{sourceSection}{sizeSection}</> : <>{advanced}{run.queue.length > 0 && <QueueList queue={run.queue} />}</>}
      </aside>}
    </>}
    {dialog?.kind === 'view' && <Lightbox pictures={[{ name: imageFileName(dialog.image), src: dialog.image.url, size: dialog.image.size, source: 'Image Studio', preview: true }]} start={0} anchor={frame.current} onClose={() => setDialog(null)} />}
    {dialog?.kind === 'refine' && studio && <RefineDialog image={asGenerated(dialog.image)} threadId={studio.thread} disabled={false} onClose={() => setDialog(null)} onRefine={(input: RefineImageInput) => { setDialog(null); enqueue(input, 1, 'Refine', 'refine') }} />}
    {dialog?.kind === 'inpaint' && studio && <InpaintDialog image={asGenerated(dialog.image)} threadId={studio.thread} disabled={false} onClose={() => setDialog(null)} onInpaint={(input: MaskedEditInput) => { setDialog(null); enqueue(input, 1, input.operation === 'remove' ? 'Remove masked area' : 'Inpaint', input.operation) }} />}
    {dialog?.kind === 'upscale' && <UpscaleDialog image={asGenerated(dialog.image)} disabled={false} onClose={() => setDialog(null)} onUpscale={(input: UpscaleImageInput) => { setDialog(null); enqueue(input, 1, 'Upscale', 'upscale') }} />}
  </div>
}

// --- left: model, LoRAs and embeddings, prompts, source, size --------------------------------------

type Assets = Pick<StudioForm, 'preset' | 'model' | 'clip' | 'vae'>
/** Every installed model, sorted by the family its name or metadata says, for the quick pick. */
function familyOptions(catalog: StudioCatalog | null) {
  if (!catalog) return []
  const label = (f: ReturnType<typeof detectedImageFamily>) => f === 'unsupported' ? 'Not supported here' : f === 'krea2' ? 'Krea2' : f ? IMAGE_PRESETS.find((p) => p.id === f)!.title : 'Family unknown'
  const hint = (name: string, category: 'checkpoints' | 'diffusionModels') => catalog.modelHints?.find((h) => h.category === category && h.name.replaceAll('\\', '/') === name.replaceAll('\\', '/'))?.baseModel ?? ''
  const rows = [...catalog.checkpoints.map((name) => ({ name, category: 'checkpoints' as const })), ...catalog.diffusionModels.map((name) => ({ name, category: 'diffusionModels' as const }))].map((r) => {
    const family = detectedImageFamily(hint(r.name, r.category)) ?? detectedImageFamily(r.name)
    return { ...r, family, group: `${r.category === 'checkpoints' ? 'Checkpoint' : 'Diffusion model'} · ${label(family)}` }
  })
  return rows.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
}
function ModelSection({ form, catalog, details, resolved, model, offer, onAccept, onKeep, onAssets, onSet, discovering, catalogError, onRefresh, assist }: {
  form: StudioForm; catalog: StudioCatalog | null; details: ModelDetails | null; resolved: ReturnType<typeof resolveImageAssets> | null; model: string
  offer: StudioRecipe | null; onAccept: () => void; onKeep: () => void; onAssets: (patch: Partial<Assets>) => void; onSet: (patch: Partial<StudioForm>, edit?: boolean) => void
  discovering: boolean; catalogError: string; onRefresh: () => void; assist?: (field: StudioField) => ReactNode
}) {
  const rules = presetRules(form.preset)
  const [vaeOpen, setVaeOpen] = useState(false)
  const options = useMemo(() => familyOptions(catalog), [catalog])
  const pick = (name: string) => {
    const row = options.find((o) => o.name === name)
    if (!row) return
    const checkpoint = row.category === 'checkpoints'
    const f = row.family
    const preset: ImagePreset = f && f !== 'unsupported' && f !== 'krea2' && Boolean(imagePresetSpec(f).clipType) !== checkpoint ? f
      : f === 'krea2' ? (form.preset.startsWith('krea2') ? form.preset : 'krea2_turbo')
      : checkpoint ? (imagePresetSpec(form.preset).clipType ? 'sdxl' : form.preset) : imagePresetSpec(form.preset).clipType ? form.preset : 'z_image'
    onAssets({ preset, model: name, ...(preset !== form.preset ? { clip: '', vae: '' } : {}) })
  }
  const notes = [...new Set([...(details?.notes ?? []), ...(form.recipe && form.recipe.model === model && details?.recommended?.notes ? [details.recommended.notes] : [])])]
  const ruleLine = [rules.encoder ? 'separate text encoder and VAE' : 'encoder and VAE built in', rules.negative ? 'negative prompt' : 'positive prompt only, CFG 1', rules.clipSkip ? 'clip skip' : null, rules.embeddings ? 'embeddings' : null, rules.loraClip ? 'LoRAs on model and encoder' : 'model-only LoRAs'].filter(Boolean).join(' · ')
  return <section className="studio-section" aria-label="Model">
    <div className="studio-label"><h4 className="studio-head">Model</h4>{assist?.('model')}</div>
    {catalogError && <ErrorBox text={catalogError} />}
    {/* Asked here, where the model was just changed: the settings were edited by hand since the last recipe. */}
    {offer && <div className="studio-offer" role="group" aria-label="Recommended settings">
      <span>The new model recommends {offer.steps} steps · CFG {offer.cfg} · {offer.sampler}/{offer.scheduler}{rules.clipSkip ? ` · clip skip ${offer.clipSkip}` : ''} ({offer.label}). Your settings were changed by hand.</span>
      <span className="studio-row"><button type="button" className="btn btn-small btn-primary" onClick={onAccept}>Apply recommended settings</button><button type="button" className="btn btn-small" onClick={onKeep}>Keep current</button></span>
    </div>}
    {options.length > 0 && <Field label="Quick pick by family">
      <Select aria-label="Quick pick a model by family" value={model || null} placeholder="Choose a model…" onChange={pick} options={options.map((o) => ({ value: o.name, label: o.name.split(/[\\/]/).at(-1) ?? o.name, note: o.group, disabled: o.family === 'unsupported' }))} />
    </Field>}
    <ImageModelFields value={form} catalog={catalog} onChange={onAssets} loading={discovering} error={catalogError} onRefresh={onRefresh} />
    {rules.variants && <Field label="Variant" hint="Raw and Turbo are the same kind of file run two ways; Auto reads it from the name.">
      <span className="seg seg-small" role="radiogroup" aria-label="Variant">
        {(['auto', 'raw', 'turbo'] as const).map((v) => <button key={v} type="button" role="radio" aria-checked={form.variant === v} className={form.variant === v ? 'is-active' : ''} onClick={() => onSet({ variant: v, preset: variantPreset(form.preset, v, model) })}>{v === 'auto' ? `Auto (${isTurbo(form.preset) ? 'Turbo' : 'Raw'})` : v === 'raw' ? 'Raw' : 'Turbo'}</button>)}
      </span>
    </Field>}
    {rules.vae === 'builtin' && <Field label="VAE" hint={form.checkpointVae ? form.checkpointVae : 'The checkpoint’s own VAE.'}>
      <span className="seg seg-small" role="radiogroup" aria-label="Checkpoint VAE">
        <button type="button" role="radio" aria-checked={!form.checkpointVae} className={!form.checkpointVae ? 'is-active' : ''} onClick={() => onSet({ checkpointVae: '' })}>Built-in</button>
        <button type="button" role="radio" aria-checked={!!form.checkpointVae} className={form.checkpointVae ? 'is-active' : ''} disabled={!catalog?.vaes.length} onClick={() => setVaeOpen(true)}>Custom…</button>
      </span>
      {vaeOpen && <ModelBrowser category="vae" label="VAE" values={catalog?.vaes ?? []} value={form.checkpointVae} onChoose={(v) => { onSet({ checkpointVae: v }); setVaeOpen(false) }} onClose={() => setVaeOpen(false)} />}
    </Field>}
    <div className="studio-card">
      <strong>{details?.family?.label ?? IMAGE_PRESETS.find((p) => p.id === form.preset)!.title}</strong>
      {details?.lora_manager?.base_model && <span className="muted">Base model: {details.lora_manager.base_model}</span>}
      <span className="muted">{ruleLine}</span>
      {form.recipe && <span>Settings from: <strong>{form.recipe.label}</strong>{form.recipe.model !== model ? <span className="muted"> (for another model)</span> : null}</span>}
      {details?.supported === false && <span className="t-yellow">Not supported: {details.unsupported_reason}</span>}
      {details?.prediction?.v_prediction && <span className="t-yellow">V-prediction model: sampled with v_prediction automatically.</span>}
      {resolved?.errors.length ? <span className="t-red">{resolved.errors.join(' ')}</span> : null}
      {notes.length > 0 && <span className="muted">{notes.join(' ')}</span>}
    </div>
  </section>
}

function PromptSection({ form, onSet, assist }: { form: StudioForm; onSet: (patch: Partial<StudioForm>, edit?: boolean) => void; assist?: (field: StudioField) => ReactNode }) {
  const rules = presetRules(form.preset)
  const id = useId()
  const count = (text: string) => {
    if (rules.counter === 'chars') return `${text.length} / ${STUDIO_LIMITS.prompt} characters`
    const n = promptTokens(text)
    return `~${n} tokens${n > 75 ? ` · ${Math.ceil(n / 75)} chunks of 75` : ' of 75'}`
  }
  return <section className="studio-section" aria-label="Prompt">
    <Field label="Prompt" field="prompt" assist={assist} id={`${id}-p`} hint={count(form.prompt)}>
      <textarea id={`${id}-p`} className="studio-prompt" rows={5} maxLength={STUDIO_LIMITS.prompt} value={form.prompt} placeholder="What to draw" onChange={(e) => onSet({ prompt: e.target.value })} />
    </Field>
    {rules.negative ? <Field label="Negative prompt" field="negative" assist={assist} id={`${id}-n`} hint={count(form.negative)}>
      <textarea id={`${id}-n`} className="studio-prompt is-negative" rows={3} maxLength={STUDIO_LIMITS.prompt} value={form.negative} placeholder="What to keep out" onChange={(e) => onSet({ negative: e.target.value })} />
    </Field> : <p className="studio-hint muted">This workflow has no negative prompt: it runs at CFG 1 with the positive prompt only.</p>}
  </section>
}

function LoraSection({ form, catalog, onSet, assist }: { form: StudioForm; catalog: StudioCatalog | null; onSet: (patch: Partial<StudioForm>, edit?: boolean) => void; assist?: (field: StudioField) => ReactNode }) {
  const rules = presetRules(form.preset)
  const [details, setDetails] = useState<LoraDetail[] | null>(null)
  const [embeddings, setEmbeddings] = useState<string[] | null>(null)
  const [picking, setPicking] = useState<'lora' | 'embedding' | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { if (form.loras.length && !details) getLoraDetails().then((r) => setDetails(r.loras), () => setDetails([])) }, [form.loras.length])
  const openPicker = (kind: 'lora' | 'embedding') => {
    setError('')
    if (kind === 'lora' && !details) getLoraDetails().then((r) => setDetails(r.loras), () => setDetails([]))
    if (kind === 'embedding' && !embeddings) getStudioEmbeddings().then((r) => setEmbeddings(r.embeddings), (e: Error) => (setEmbeddings([]), setError(e.message)))
    setPicking(kind)
  }
  const insert = (word: string) => { if (!form.prompt.includes(word)) onSet({ prompt: form.prompt.trim() ? `${form.prompt.trim()}, ${word}` : word }) }
  const loras = catalog?.loras ?? []
  return <section className="studio-section" aria-label="LoRAs and embeddings">
    <div className="studio-label"><h4 className="studio-head">LoRAs &amp; embeddings</h4>{assist?.('loras')}</div>
    {error && <ErrorBox text={error} onDismiss={() => setError('')} />}
    <ul className="studio-loras">
      {form.loras.map((l, i) => {
        const d = details?.find((x) => x.name === l.name)
        return <li key={l.name} className="studio-lora">
          <span className="studio-lora-head">
            {d?.hasPreview ? <img className="studio-lora-thumb" src={loraPreviewUrl(l.name)} alt="" loading="lazy" /> : <span className="studio-lora-thumb is-empty" aria-hidden />}
            <span className="studio-lora-name" title={l.name}>{d?.title || l.name.split(/[\\/]/).at(-1)}</span>
            <button type="button" className="btn btn-small" aria-label={`Remove ${l.name}`} onClick={() => onSet({ loras: form.loras.filter((_, j) => j !== i) })}>Remove</button>
          </span>
          {!!d?.triggers.length && <span className="studio-words" aria-label="Trigger words: click to add to the prompt">{d.triggers.map((w) => <button key={w} type="button" className="studio-word" onClick={() => insert(w)} title="Add to the prompt">{w}</button>)}</span>}
          <NumberSlider label={`${l.name} weight`} value={l.weight} min={STUDIO_LIMITS.loraWeight[0]} max={STUDIO_LIMITS.loraWeight[1]} step={0.01} onChange={(w) => onSet({ loras: form.loras.map((x, j) => (j === i ? { ...x, weight: round2(w) } : x)) })} />
        </li>
      })}
      {form.embeddings.map((e, i) => <li key={`e:${e.name}`} className="studio-lora">
        <span className="studio-lora-head">
          <button type="button" className={`studio-polarity ${e.negative ? 'is-negative' : ''}`} disabled={!rules.negative && !e.negative} aria-label={e.negative ? 'In the negative prompt; make positive' : 'In the prompt; make negative'} title={e.negative ? 'Negative: goes in the negative prompt' : 'Positive: goes in the prompt'} onClick={() => onSet({ embeddings: form.embeddings.map((x, j) => (j === i ? { ...x, negative: !x.negative } : x)) })}>{e.negative ? '−' : '+'}</button>
          <span className="studio-lora-name" title={e.name}>embedding:{e.name}</span>
          <button type="button" className="btn btn-small" aria-label={`Remove ${e.name}`} onClick={() => onSet({ embeddings: form.embeddings.filter((_, j) => j !== i) })}>Remove</button>
        </span>
        <NumberSlider label={`${e.name} weight`} value={e.weight} min={STUDIO_LIMITS.embeddingWeight[0]} max={STUDIO_LIMITS.embeddingWeight[1]} step={0.01} onChange={(w) => onSet({ embeddings: form.embeddings.map((x, j) => (j === i ? { ...x, weight: round2(w) } : x)) })} />
      </li>)}
    </ul>
    <span className="studio-row">
      <button type="button" className="btn btn-small" disabled={!loras.length || form.loras.length >= STUDIO_LIMITS.loras} onClick={() => openPicker('lora')}>Add LoRA…</button>
      <button type="button" className="btn btn-small" disabled={!rules.embeddings} onClick={() => openPicker('embedding')}>Add embedding…</button>
    </span>
    <p className="studio-hint muted">{!rules.loraClip ? 'LoRAs patch the model only in this workflow. ' : ''}{!rules.embeddings ? 'Embeddings work with SD 1.5 and SDXL checkpoints only. ' : ''}{form.loras.length >= STUDIO_LIMITS.loras ? `At most ${STUDIO_LIMITS.loras} LoRAs.` : ''}</p>
    {picking === 'lora' && <ModelBrowser label="LoRA" values={loras.filter((n) => !form.loras.some((l) => l.name === n))} value="" onChoose={(name) => { onSet({ loras: [...form.loras, { name, weight: 1 }] }); setPicking(null) }} onClose={() => setPicking(null)} loading={!details} />}
    {picking === 'embedding' && <ModelBrowser label="Embedding" values={(embeddings ?? []).filter((n) => !form.embeddings.some((e) => e.name === n))} value="" onChoose={(name) => { onSet({ embeddings: [...form.embeddings, { name, weight: 1, negative: false }] }); setPicking(null) }} onClose={() => setPicking(null)} loading={!embeddings} />}
  </section>
}

/** A picture as PNG data (the server keeps PNGs only), drawn once through a canvas, which also drops its metadata. */
async function pngData(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width; canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the picture'))), 'image/png'))
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function SourceSection({ form, onSet, assist, onError }: { form: StudioForm; onSet: (patch: Partial<StudioForm>, edit?: boolean) => void; assist?: (field: StudioField) => ReactNode; onError: (e: string) => void }) {
  const [open, setOpen] = useState(false)
  const choose = (s: StudioSource) => {
    // Image-to-image starts at its size and Diffu's 0.6 strength.
    onSet({ source: s, denoise: 0.6, ...sourceSize(s, presetRules(form.preset).edge) }, true)
    setOpen(false)
  }
  const s = form.source
  const ratio = s ? s.width / s.height : 1, formRatio = form.width / form.height
  return <section className="studio-section" aria-label="Source image">
    <div className="studio-label"><h4 className="studio-head">Source image</h4>{assist?.('source')}</div>
    {s ? <div className="studio-source">
      <img src={s.url} alt={s.name} />
      <span className="studio-source-text"><strong title={s.name}>{s.name}</strong><span className="muted">{s.width} × {s.height} · strength (denoise) {form.denoise}</span>{Math.abs(ratio - formRatio) > 0.05 && <span className="t-yellow">Its shape differs from the output size: it is center-cropped.</span>}</span>
      <span className="studio-row">
        <button type="button" className="btn btn-small" onClick={() => onSet({ ...sourceSize(s, presetRules(form.preset).edge) }, true)}>Use its size</button>
        <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>Change…</button>
        <button type="button" className="btn btn-small" onClick={() => onSet({ source: null })}>Remove</button>
      </span>
    </div> : <span className="studio-row"><button type="button" className="btn btn-small" onClick={() => setOpen(true)}>Choose a source…</button><span className="muted">Image-to-image: start from a picture.</span></span>}
    {open && <SourcePicker onChoose={choose} onClose={() => setOpen(false)} onError={onError} />}
  </section>
}

/** Your generated pictures (every thread's and the Studio's), or an upload from this device. */
function SourcePicker({ onChoose, onClose, onError }: { onChoose: (s: StudioSource) => void; onClose: () => void; onError: (e: string) => void }) {
  const [list, setList] = useState<StudioImage[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const load = (before?: string) => getStudioImages('all', before).then((r) => { setList((l) => [...(before ? l ?? [] : []), ...r.images]); setNext(r.next_before) }, (e: Error) => setError(e.message))
  useEffect(() => { void load() }, [])
  const upload = async (file: File | undefined) => {
    if (!file) return
    setUploading(true); setError('')
    try {
      const saved = await uploadStudioImage(file.name, await pngData(file))
      onChoose({ id: saved.id, name: saved.name, url: saved.url, width: saved.width, height: saved.height })
    } catch (e) { setError((e as Error).message); onError((e as Error).message) } finally { setUploading(false) }
  }
  return <ImageDialog title="Choose a source image" onClose={onClose} wide>
    <div className="studio-picker">
      <span className="studio-row">
        <button type="button" className="btn btn-small btn-primary" data-image-autofocus="" disabled={uploading} onClick={() => input.current?.click()}>{uploading ? 'Uploading…' : 'Upload from this device…'}</button>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void upload(e.target.files?.[0])} />
        <span className="muted">or pick one of your pictures:</span>
      </span>
      {error && <ErrorBox text={error} />}
      {!list && !error && <p className="muted" role="status">Loading your pictures…</p>}
      {list && !list.length && <p className="muted">No generated pictures yet.</p>}
      <ul className="studio-thumbs is-picker">
        {list?.map((i) => <li key={i.id}><button type="button" className="studio-thumb" onClick={() => onChoose({ id: i.id, name: i.name, url: i.url, width: i.width, height: i.height })} aria-label={`Use ${i.name}`} title={`${i.name} · ${i.width} × ${i.height}`}><img src={i.url} alt="" loading="lazy" draggable={false} /></button></li>)}
      </ul>
      {next && <button type="button" className="btn btn-small" onClick={() => void load(next)}>Show older</button>}
    </div>
  </ImageDialog>
}

function SizeSection({ form, onSet, batchMax, assist }: { form: StudioForm; onSet: (patch: Partial<StudioForm>, edit?: boolean) => void; batchMax: number; assist?: (field: StudioField) => ReactNode }) {
  const buckets = sizeBuckets(form.preset)
  const id = useId()
  const snap = (v: number) => Math.min(SIZE_LIMITS.max, Math.max(SIZE_LIMITS.min, Math.round(v / SIZE_LIMITS.step) * SIZE_LIMITS.step))
  const setSide = (side: 'width' | 'height', raw: number) => {
    if (!Number.isFinite(raw)) return
    const v = snap(raw)
    if (!form.aspectLock) return onSet({ [side]: v }, true)
    const ratio = form.width / form.height
    onSet(side === 'width' ? { width: v, height: snap(v / ratio) } : { height: v, width: snap(v * ratio) }, true)
  }
  const over = form.width * form.height > SIZE_LIMITS.area
  return <section className="studio-section" aria-label="Size">
    <div className="studio-label"><h4 className="studio-head">Size</h4>{assist?.('size')}</div>
    <div className="studio-buckets" role="group" aria-label="Size presets">
      {buckets.map((b) => <button key={b.label} type="button" className={`studio-bucket ${b.width === form.width && b.height === form.height ? 'is-on' : ''}`} title={`${b.width} × ${b.height}`} onClick={() => onSet({ width: b.width, height: b.height }, true)}>{b.label}</button>)}
    </div>
    <span className="studio-row studio-size">
      <label htmlFor={`${id}-w`} className="muted">W</label>
      <input id={`${id}-w`} type="number" min={SIZE_LIMITS.min} max={SIZE_LIMITS.max} step={SIZE_LIMITS.step} value={form.width} onChange={(e) => setSide('width', Number(e.target.value))} />
      <button type="button" className="btn btn-small" aria-label="Swap width and height" title="Swap" onClick={() => onSet({ width: form.height, height: form.width }, true)}>⇄</button>
      <label htmlFor={`${id}-h`} className="muted">H</label>
      <input id={`${id}-h`} type="number" min={SIZE_LIMITS.min} max={SIZE_LIMITS.max} step={SIZE_LIMITS.step} value={form.height} onChange={(e) => setSide('height', Number(e.target.value))} />
      <button type="button" className={`btn btn-small ${form.aspectLock ? 'btn-primary' : ''}`} aria-pressed={form.aspectLock} title="Keep the shape when one side changes" onClick={() => onSet({ aspectLock: !form.aspectLock })}>{form.aspectLock ? 'Shape locked' : 'Lock shape'}</button>
    </span>
    <p className={`studio-hint ${over ? 't-red' : 'muted'}`}>{form.width} × {form.height} · {(form.width * form.height / 1e6).toFixed(2)} MP · {SIZE_LIMITS.min}–{SIZE_LIMITS.max} in steps of {SIZE_LIMITS.step}, at most 1536 × 1024 pixels in all{form.source ? ' · the source is resized to this' : ''}</p>
    <Field label="Batch" hint="Pictures per Generate, one after another; a fixed seed counts up by one.">
      <NumberSlider label="Batch" value={form.batch} min={1} max={batchMax} step={1} onChange={(v) => onSet({ batch: v })} />
    </Field>
  </section>
}

// --- right: Generate, the queue, seed and sampling, hires ----------------------------------------

function QueueList({ queue }: { queue: Job[] }) {
  return <ol className="studio-queue" aria-label="Queue">
    {queue.map((j) => <li key={j.id}><span>{j.label}</span><button type="button" className="btn btn-small" aria-label={`Remove ${j.label} from the queue`} onClick={() => update({ queue: runner.queue.filter((x) => x.id !== j.id) })}>×</button></li>)}
  </ol>
}

function ActionSection({ problems, live, queue, error, batch, onGenerate, onSettings, configured, compact = false }: { problems: string[]; live: Live | null; queue: Job[]; error: string; batch: number; onGenerate: () => void; onSettings: () => void; configured: boolean; compact?: boolean }) {
  const blocked = problems.length > 0
  return <section className={`studio-section studio-actions ${compact ? 'is-compact' : ''}`} aria-label="Generate">
    <span className="studio-row studio-go">
      <button type="button" className="btn btn-primary studio-generate" disabled={blocked} onClick={onGenerate} title={blocked ? problems[0] : undefined}>{live ? 'Queue' : 'Generate'}{batch > 1 ? ` ${batch}` : ''}</button>
      {live && <button type="button" className="btn studio-cancel" onClick={cancelRun}>Cancel</button>}
    </span>
    {blocked && <p className="studio-reason muted" role="status">{problems[0]}{problems.length > 1 && !compact ? <> <button type="button" className="studio-link" onClick={() => copy(problems.join('\n'))}>Copy all {problems.length}</button></> : null}</p>}
    {!configured && <button type="button" className="btn btn-small" onClick={onSettings}>Open Images settings</button>}
    {!compact && live && <p className="muted" role="status">Running: {live.job.label}{live.total > 1 ? ` (${live.index + 1} of ${live.total})` : ''}</p>}
    {!compact && queue.length > 0 && <QueueList queue={queue} />}
    {compact && queue.length > 0 && <p className="muted">{queue.length} queued</p>}
    {error && <ErrorBox text={error} onDismiss={() => update({ error: '' })} />}
  </section>
}

function AdvancedSection({ form, catalog, lastSeed, recipe, onSet, onRecipe, assist }: { form: StudioForm; catalog: StudioCatalog | null; lastSeed: number | null; recipe: StudioRecipe | null; onSet: (patch: Partial<StudioForm>, edit?: boolean) => void; onRecipe: () => void; assist?: (field: StudioField) => ReactNode }) {
  const rules = presetRules(form.preset)
  const id = useId()
  const samplers = studioSamplers(catalog), schedulers = studioSchedulers(catalog)
  const withCurrent = (list: string[], v: string) => (v && !list.includes(v) ? [v, ...list] : list)
  const [seedText, setSeedText] = useState(String(form.seed))
  useEffect(() => setSeedText(String(form.seed)), [form.seed])
  const upscalers = catalog?.upscalers ?? []
  return <>
    <section className="studio-section" aria-label="Seed">
      <Field label="Seed" field="seed" assist={assist} id={`${id}-seed`} hint={form.seed < 0 ? 'A new random seed for every picture.' : form.seedLock ? 'Locked: Use these settings keeps it.' : 'Fixed.'}>
        <span className="studio-row">
          <input id={`${id}-seed`} className="studio-seed" type="number" min={-1} step={1} value={seedText} onChange={(e) => setSeedText(e.target.value)} onBlur={() => { const n = Math.trunc(Number(seedText)); onSet({ seed: Number.isFinite(n) ? Math.max(-1, Math.min(STUDIO_LIMITS.seed[1], n)) : -1 }) }} />
          <button type="button" className="btn btn-small" title="A random seed, kept" aria-label="Random seed" onClick={() => onSet({ seed: randomSeed() })}>Roll</button>
          <button type="button" className="btn btn-small" title={lastSeed === null ? 'No picture yet' : `Reuse the last seed (${lastSeed})`} aria-label="Reuse the last seed" disabled={lastSeed === null} onClick={() => lastSeed !== null && onSet({ seed: lastSeed })}>Last</button>
          <button type="button" className={`btn btn-small ${form.seed < 0 ? 'btn-primary' : ''}`} aria-pressed={form.seed < 0} onClick={() => onSet({ seed: form.seed < 0 ? randomSeed() : -1 })}>Random</button>
          <button type="button" className={`btn btn-small ${form.seedLock ? 'btn-primary' : ''}`} aria-pressed={form.seedLock} title="Keep this seed when restoring settings from a result" onClick={() => onSet({ seedLock: !form.seedLock })}>{form.seedLock ? 'Locked' : 'Lock'}</button>
        </span>
      </Field>
    </section>
    <section className="studio-section" aria-label="Sampling">
      <div className="studio-label"><h4 className="studio-head">Sampling</h4>{assist?.('sampling')}</div>
      <Field label="Steps">
        <NumberSlider label="Steps" value={form.steps} min={STUDIO_LIMITS.steps[0]} max={STUDIO_LIMITS.steps[1]} step={1} onChange={(v) => onSet({ steps: v }, true)} />
        <span className="studio-row">{STEP_PRESETS.map((n) => <button key={n} type="button" className={`studio-bucket ${form.steps === n ? 'is-on' : ''}`} onClick={() => onSet({ steps: n }, true)}>{n}</button>)}</span>
      </Field>
      {rules.fixedCfg === null ? <Field label="CFG">
        <NumberSlider label="CFG" value={form.cfg} min={1} max={STUDIO_LIMITS.cfg[1]} step={0.5} onChange={(v) => onSet({ cfg: v }, true)} />
      </Field> : <p className="studio-hint muted">CFG is fixed at {rules.fixedCfg} for this workflow (no negative prompt).</p>}
      <Field label="Sampler">
        <Select aria-label="Sampler" value={form.sampler} placeholder="Choose a sampler" onChange={(v) => onSet({ sampler: v }, true)} options={withCurrent(samplers, form.sampler).map((v) => ({ value: v, label: v, disabled: !samplers.includes(v), note: samplers.includes(v) ? undefined : 'not installed' }))} />
      </Field>
      <Field label="Scheduler">
        <Select aria-label="Scheduler" value={form.scheduler} placeholder="Choose a scheduler" onChange={(v) => onSet({ scheduler: v }, true)} options={withCurrent(schedulers, form.scheduler).map((v) => ({ value: v, label: v, disabled: !schedulers.includes(v), note: schedulers.includes(v) ? undefined : 'not installed' }))} />
      </Field>
      {form.source && <Field label="Denoise (strength)" hint="How much of the source changes: 0.1 keeps it, 1 redraws it.">
        <NumberSlider label="Denoise" value={form.denoise} min={STUDIO_LIMITS.denoise[0]} max={STUDIO_LIMITS.denoise[1]} step={0.01} onChange={(v) => onSet({ denoise: round2(v) })} />
      </Field>}
      {rules.clipSkip && <Field label="Clip skip" hint="2 is usual for anime checkpoints (Illustrious, Pony, NoobAI).">
        <NumberSlider label="Clip skip" value={form.clipSkip} min={STUDIO_LIMITS.clipSkip[0]} max={STUDIO_LIMITS.clipSkip[1]} step={1} onChange={(v) => onSet({ clipSkip: v }, true)} />
      </Field>}
      <span className="studio-row"><button type="button" className="btn btn-small" disabled={!recipe} onClick={onRecipe} title={recipe ? `${recipe.steps} steps · CFG ${recipe.cfg} · ${recipe.sampler}/${recipe.scheduler} (${recipe.label})` : undefined}>Apply recommended settings</button></span>
    </section>
    <section className="studio-section" aria-label="Upscaling">
      <div className="studio-label"><h4 className="studio-head">Upscaling</h4>{assist?.('upscale')}</div>
      <label className="studio-check"><input type="checkbox" checked={form.hires.on} onChange={(e) => onSet({ hires: { ...form.hires, on: e.target.checked } })} /> Hires pass: enlarge, then refine with the same model</label>
      {form.hires.on && <>
        <Field label="Scale" hint={`${Math.round(form.width * form.hires.scale / 64) * 64} × ${Math.round(form.height * form.hires.scale / 64) * 64}`}>
          <NumberSlider label="Hires scale" value={form.hires.scale} min={STUDIO_LIMITS.hiresScale[0]} max={STUDIO_LIMITS.hiresScale[1]} step={0.05} onChange={(v) => onSet({ hires: { ...form.hires, scale: round2(v) } })} />
        </Field>
        <Field label="Hires denoise"><NumberSlider label="Hires denoise" value={form.hires.denoise} min={STUDIO_LIMITS.denoise[0]} max={STUDIO_LIMITS.denoise[1]} step={0.01} onChange={(v) => onSet({ hires: { ...form.hires, denoise: round2(v) } })} /></Field>
        <Field label="Hires steps"><NumberSlider label="Hires steps" value={form.hires.steps} min={1} max={STUDIO_LIMITS.steps[1]} step={1} onChange={(v) => onSet({ hires: { ...form.hires, steps: v } })} /></Field>
        <Field label="Upscale model" hint={upscalers.length ? 'Optional: an upscale model enlarges first; without one it is a Lanczos resize.' : 'No upscale models installed: a Lanczos resize.'}>
          <Select aria-label="Upscale model" value={form.hires.upscaleModel} onChange={(v) => onSet({ hires: { ...form.hires, upscaleModel: v } })} options={[{ value: '', label: 'None (Lanczos resize)' }, ...upscalers.map((u) => ({ value: u, label: u }))]} />
        </Field>
      </>}
      <p className="studio-hint muted">To enlarge a finished picture without diffusion, use Upscale… on the result.</p>
    </section>
  </>
}

// --- the result's actions --------------------------------------------------------------------------

function ResultActions({ image, threads, disabled, onUse, onSend, onDialog, onDelete }: { image: StudioImage; threads: Thread[] | null; disabled: boolean; onUse: () => void; onSend: (thread: string | null) => void; onDialog: (kind: 'refine' | 'inpaint' | 'upscale') => void; onDelete: () => void }) {
  const restorable = !!image.settings && image.settings.operation !== 'upscale' && image.settings.operation !== 'remove'
  const chat = (e: React.MouseEvent<HTMLButtonElement>) => openMenuAt(e.currentTarget, [
    { label: 'New thread', onSelect: () => onSend(null) },
    ...(threads?.length ? [{ separator: true as const }] : []),
    ...(threads ?? []).filter((t) => !t.archived).slice(0, 8).map((t) => ({ label: t.title, onSelect: () => onSend(t.id) })),
  ])
  return <div className="studio-result-actions" role="group" aria-label="Picture actions">
    <button type="button" className="btn btn-small" disabled={!restorable || disabled} title={restorable ? 'Put this picture’s settings back in the form' : 'This picture has no generation settings'} onClick={onUse}>Use these settings</button>
    {threads && <button type="button" className="btn btn-small" disabled={disabled} onClick={chat} aria-haspopup="menu">Send to chat…</button>}
    <button type="button" className="btn btn-small" disabled={disabled} onClick={() => onDialog('refine')}>Refine…</button>
    <button type="button" className="btn btn-small" disabled={disabled} onClick={() => onDialog('inpaint')}>Edit area…</button>
    <button type="button" className="btn btn-small" disabled={disabled} onClick={() => onDialog('upscale')}>Upscale…</button>
    <a className="btn btn-small" href={image.url} download={imageFileName(image)}>Download</a>
    {image.studio && <button type="button" className="btn btn-small" onClick={onDelete}>Delete</button>}
  </div>
}
