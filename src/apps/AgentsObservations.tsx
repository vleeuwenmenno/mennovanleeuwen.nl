import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { deleteMemory } from '../data/agents'
import { getImageObservations } from '../data/agentImages'
import { matchesObservation, modelKey, NO_FILTER, OBSERVATION_SOURCES, presetTitle, fileTitle, settingsLine, sourceLabel, type Observation, type ObservationFilter, type ObservationProfile, type ObservationsView } from '../data/imageObservations'
import { ask } from '../os/Dialogs'
import { Select } from '../os/Select'
import { useIsMobile } from '../os/useIsMobile'
import { useWM } from '../os/wm'
import { ImageDialog } from './AgentsModelBrowser'
import { Lightbox, type Picture } from './AgentsImages'

// Image observations ("learnings") and style profiles as an overview: cards with the picture, the
// task and the note at a glance, detail on demand, filters, and delete. Read-and-delete only:
// profiles are edited in Settings → Agents → Images, observations by the agent's own tools. Opened
// from Settings → Agents → Images and from Memory's Images/Learnings; ObservationLine is the same
// card, compact, for the Memory list.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const day = (ms: number) => {
  const d = new Date(ms)
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) })
}
const imageUrl = (id: string) => `/api/agents/images/${id}`
const originLabel = (p: Pick<ObservationProfile, 'origin'>) => (p.origin === 'suggestion' ? 'Suggested by the agent' : 'Confirmed by you')

/** A delete is permanent and leaves the picture alone: say both before anything goes. */
const confirmDeleteObservations = (items: Pick<Observation, 'task' | 'raw'>[]) => {
  const n = items.length
  return ask({
    title: n === 1 ? `Delete “${items[0].raw ? 'Unreadable observation' : items[0].task || 'Untitled'}”?` : `Delete ${n} observations?`,
    body: `${n === 1 ? 'Removes the observation' : 'Removes the observations'} only, not the image: the picture stays in its thread. The agent no longer reads ${n === 1 ? 'it' : 'them'} for later images. This cannot be undone.`,
    confirm: n === 1 ? 'Delete observation' : `Delete ${n}`,
    danger: true,
  })
}

/** The linked picture, small; a tap opens the full view. A deleted or broken one says so. */
function ObservationThumb({ o }: { o: Observation }) {
  const [open, setOpen] = useState(false)
  const [broken, setBroken] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  if (!o.imageId || o.imageAvailable === false || broken)
    return <span className="agt-obs-thumb is-empty" aria-hidden title={o.imageId ? 'The picture was deleted with its thread' : 'No picture linked'}>{o.imageId ? 'Gone' : '—'}</span>
  const picture: Picture = { name: o.task || 'Generated image', src: imageUrl(o.imageId), size: 0, source: 'Generated with ComfyUI', preview: true }
  return <>
    <button ref={anchor} type="button" className="agt-thumb agt-obs-thumb" onClick={() => setOpen(true)} aria-label={`View the picture for ${picture.name}`}>
      <img src={picture.src} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} />
    </button>
    {open && <Lightbox pictures={[picture]} start={0} anchor={anchor.current} onClose={() => setOpen(false)} />}
  </>
}

const SourceBadge = ({ o }: { o: Observation }) => <span className={`agt-obs-badge is-${o.source ?? 'unknown'}`} title={OBSERVATION_SOURCES.find((s) => s.id === o.source)?.detail}>{o.raw ? 'Unreadable' : sourceLabel(o.source)}</span>

/** What an observation rests on and was made with: shown when a card is opened. */
export function ObservationDetail({ o }: { o: Observation }) {
  const [prompt, setPrompt] = useState(false)
  const id = useId()
  if (o.raw) return <div className="agt-obs-detail">
    <p className="muted">This note is not in the usual shape (an older or hand-edited one), so here it is as stored.</p>
    <pre className="agt-obs-pre selectable">{o.raw}</pre>
  </div>
  const line = settingsLine(o.settings)
  return <div className="agt-obs-detail">
    {o.note && <p className="agt-obs-full-note selectable">{o.note}</p>}
    {o.quote ? <blockquote className="agt-obs-quote selectable"><span className="muted">{o.source === 'vision' ? 'The vision model saw' : 'You said'}</span>{o.quote}</blockquote>
      : <p className="muted agt-obs-small">No evidence: the agent’s own guess, not checked against what you said or what a vision model saw.</p>}
    {line && <p className="agt-obs-settings" title={[o.settings?.model, ...(o.settings?.loras.map((l) => l.name) ?? [])].filter(Boolean).join('\n')}>{line}</p>}
    {o.settings && (o.settings.width || o.settings.seed !== null) && <p className="muted agt-obs-small">{[o.settings.width && o.settings.height && `${o.settings.width} × ${o.settings.height} px`, o.settings.seed !== null && `seed ${o.settings.seed}`].filter(Boolean).join(' · ')}</p>}
    {o.currentBackend === false && <p className="muted agt-obs-small">Made with a different ComfyUI than the one connected now: the agent reads it only on that one.</p>}
    {o.prompt && <>
      <button type="button" className="btn btn-small agt-obs-prompt-toggle" aria-expanded={prompt} aria-controls={id} onClick={() => setPrompt(!prompt)}>{prompt ? 'Hide prompt' : 'Show prompt'}</button>
      {prompt && <pre id={id} className="agt-obs-pre selectable">{o.prompt}{o.negativePrompt ? `\n\nNegative: ${o.negativePrompt}` : ''}</pre>}
    </>}
  </div>
}

const observationTitle = (o: Observation) => (o.raw ? 'Unreadable observation' : o.task || 'Untitled')

/** At a glance: [checkbox] picture, then task, source · profile · date, and (closed) the note in two lines. */
function ObservationHead({ o, profile, open, controls, onToggle, children }: { o: Observation; profile: string; open: boolean; controls: string; onToggle: () => void; children?: ReactNode }) {
  return <div className="agt-obs-head">
    {children}
    <ObservationThumb o={o} />
    <button type="button" className="agt-obs-toggle" data-obs-toggle={o.id} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <span className="agt-obs-title">{observationTitle(o)}</span>
      <span className="agt-obs-meta"><SourceBadge o={o} /><span>{profile}</span><span>{day(o.updatedAt)}</span></span>
      {!open && <span className="agt-obs-note muted">{o.raw ? o.raw.split('\n')[0] : o.note}</span>}
    </button>
  </div>
}

/** Arrow keys, Home and End between cards; Delete asks to delete the focused one. */
function cardKeys(e: KeyboardEvent<HTMLElement>, onDelete?: (id: number) => void) {
  const toggle = (e.target as HTMLElement).closest<HTMLElement>('[data-obs-toggle]')
  if (!toggle) return
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-obs-toggle]')]
  const at = all.indexOf(toggle)
  const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : null
  if (to !== null) {
    e.preventDefault()
    all[Math.max(0, Math.min(all.length - 1, to))]?.focus()
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && onDelete) {
    e.preventDefault()
    onDelete(Number(toggle.dataset.obsToggle))
  }
}

function ObservationCard({ o, profile, open, selected, busy, onToggle, onSelect, onProfile, onDelete }: { o: Observation; profile: string; open: boolean; selected: boolean; busy: boolean; onToggle: () => void; onSelect: (on: boolean) => void; onProfile?: () => void; onDelete: () => void }) {
  const detail = useId()
  return <li className={`agt-obs-card ${open ? 'is-open' : ''} ${selected ? 'is-selected' : ''}`}>
    <ObservationHead o={o} profile={profile} open={open} controls={detail} onToggle={onToggle}>
      <label className="agt-obs-check" title="Select for delete"><input type="checkbox" checked={selected} disabled={busy} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${observationTitle(o)}`} /></label>
    </ObservationHead>
    {open && <div id={detail} className="agt-obs-body">
      <ObservationDetail o={o} />
      <div className="agt-obs-actions">
        {onProfile && <button type="button" className="btn btn-small" onClick={onProfile}>Only “{profile}”</button>}
        <button type="button" className="btn btn-small" disabled={busy} onClick={onDelete}>Delete…</button>
      </div>
    </div>}
  </li>
}

function ProfileCard({ p, on, onPick, onThread }: { p: ObservationProfile; on: boolean; onPick: () => void; onThread: (id: string) => void }) {
  return <li className={`agt-obs-profile ${on ? 'is-on' : ''}`}>
    <button type="button" className="agt-obs-profile-pick" aria-pressed={on} onClick={onPick}>
      <strong>{p.name}</strong>
      <span className="agt-obs-meta"><span className={`image-origin is-${p.origin}`}>{originLabel(p)}</span><span>{plural(p.observations, 'observation')}</span>{p.lastTouched > 0 && <span>{day(p.lastTouched)}</span>}</span>
    </button>
    {p.description ? <p className="agt-obs-profile-desc selectable">{p.description}</p> : <p className="muted agt-obs-small">No style preferences written down.</p>}
    <div className="agt-obs-threads">
      {p.threadCount ? <>
        <span className="muted">Pinned in</span>
        {p.threads.map((t) => <button key={t.id} type="button" className="agt-obs-thread" onClick={() => onThread(t.id)} title="Open this thread">{t.title || 'Untitled thread'}</button>)}
        {p.threadCount > p.threads.length && <span className="muted">and {p.threadCount - p.threads.length} more</span>}
      </> : <span className="muted">Not pinned in any thread</span>}
    </div>
  </li>
}

/**
 * The overview: profiles beside (or, narrow, above) the observations, filters, and the cards.
 * `onChanged` hears every delete, so a list behind it (Memory) can reload.
 */
export function ObservationsPanel({ initialProfile, onChanged }: { initialProfile?: number | 'none'; onChanged?: () => void }) {
  const wm = useWM()
  const mobile = useIsMobile()
  const [view, setView] = useState<ObservationsView | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<ObservationFilter>({ ...NO_FILTER, profile: initialProfile ?? 'all' })
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const list = useRef<HTMLUListElement>(null)
  const load = () => getImageObservations().then(setView, (e: Error) => setError(e.message))
  useEffect(() => void load(), [])

  const profiles = view?.profiles ?? []
  const name = (id: number | null) => (id === null ? 'No profile' : profiles.find((p) => p.id === id)?.name ?? `Profile ${id} (deleted)`)
  const all = view?.observations ?? []
  const shown = useMemo(() => all.filter((o) => matchesObservation(o, filter)), [all, filter])
  const hidden = all.length - shown.length
  const filtered = filter.profile !== 'all' || filter.source !== 'all' || !!filter.model || !!filter.query.trim()
  const models = useMemo(() => {
    const seen = new Map<string, Observation['settings']>()
    for (const o of all) if (o.settings && !seen.has(modelKey(o))) seen.set(modelKey(o), o.settings)
    return [...seen].map(([value, s]) => ({ value, label: s!.operation === 'upscale' ? s!.upscale_model ? fileTitle(s!.upscale_model) : 'Unknown upscale model' : s!.model ? fileTitle(s!.model) : 'Automatic model', note: s!.operation === 'upscale' ? 'Upscale' : presetTitle(s!.preset) })).sort((a, b) => a.label.localeCompare(b.label))
  }, [all])
  const chosen = shown.filter((o) => selected.has(o.id))
  const set = (patch: Partial<ObservationFilter>) => setFilter((f) => ({ ...f, ...patch }))
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n })
  const pick = (id: number, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })

  const remove = async (ids: number[]) => {
    if (!ids.length || busy || !(await confirmDeleteObservations(all.filter((o) => ids.includes(o.id))))) return
    // Keyboard users keep their place: the card that takes the first deleted one's spot gets focus.
    const at = shown.findIndex((o) => ids.includes(o.id))
    setBusy(true); setError(''); setNotice('')
    let done = 0
    try {
      for (const id of ids) { await deleteMemory(id); done++ }
      setNotice(done === 1 ? 'Observation deleted. The picture stays.' : `${done} observations deleted. The pictures stay.`)
    } catch (e) { setError(`${done ? `${plural(done, 'observation')} deleted, then: ` : ''}${(e as Error).message}`) }
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))))
    await load()
    setBusy(false)
    onChanged?.()
    requestAnimationFrame(() => {
      const cards = list.current?.querySelectorAll<HTMLElement>('[data-obs-toggle]')
      if (cards?.length) cards[Math.max(0, Math.min(at, cards.length - 1))].focus()
    })
  }
  const openThread = (id: string) => wm.open('agents', { thread: id, t: String(Date.now()) })
  const showProfile = (id: number | null) => { set({ profile: id ?? 'none' }); list.current?.closest('.agt-obs')?.scrollIntoView({ block: 'start' }) }

  if (!view) return error ? <p className="t-red copyable" role="alert">{error}</p> : <p className="muted" role="status">Loading observations…</p>

  const profileList = <ul className="agt-obs-profiles">
    {profiles.map((p) => <ProfileCard key={p.id} p={p} on={filter.profile === p.id} onPick={() => set({ profile: filter.profile === p.id ? 'all' : p.id })} onThread={openThread} />)}
    {view.unfiled > 0 && <li className={`agt-obs-profile ${filter.profile === 'none' ? 'is-on' : ''}`}>
      <button type="button" className="agt-obs-profile-pick" aria-pressed={filter.profile === 'none'} onClick={() => set({ profile: filter.profile === 'none' ? 'all' : 'none' })}>
        <strong>No profile</strong>
        <span className="agt-obs-meta"><span>{plural(view.unfiled, 'observation')}</span></span>
      </button>
      <p className="muted agt-obs-small">Made in threads with no style profile pinned.</p>
    </li>}
    {!profiles.length && !view.unfiled && <li className="muted agt-obs-small">No style profiles yet. The agent can suggest one, or create one in Settings → Agents → Images.</li>}
  </ul>

  return <div className="agt-obs">
    <section className="agt-obs-side" aria-label="Style profiles">
      {mobile ? <details className="agt-obs-fold"><summary>Style profiles <span className="muted">{profiles.length}</span></summary>{profileList}</details>
        : <><h4 className="set-subhead">Style profiles</h4><p className="muted agt-obs-small">The agent prefers these. Pick one to see only its observations.</p>{profileList}</>}
    </section>
    <section className="agt-obs-main" aria-label="Observations">
      <div className="agt-obs-filters">
        <label className="agt-search agt-obs-search"><input type="search" value={filter.query} onChange={(e) => set({ query: e.target.value })} placeholder="Search task and note" aria-label="Search observations" spellCheck={false} /></label>
        <Select<string> className="set-select" aria-label="Profile" value={String(filter.profile)} onChange={(v) => set({ profile: v === 'all' || v === 'none' ? v : Number(v) })} options={[{ value: 'all', label: 'Every profile' }, ...profiles.map((p) => ({ value: String(p.id), label: p.name, note: String(p.observations) })), ...(view.unfiled ? [{ value: 'none', label: 'No profile', note: String(view.unfiled) }] : [])]} />
        <Select<string> className="set-select" aria-label="Source" value={filter.source} onChange={(v) => set({ source: v as ObservationFilter['source'] })} options={[{ value: 'all', label: 'Every source' }, ...OBSERVATION_SOURCES.map((s) => ({ value: s.id, label: s.label }))]} />
        {models.length > 1 && <Select<string> className="set-select" aria-label="Model" value={filter.model} onChange={(v) => set({ model: v })} options={[{ value: '', label: 'Every model' }, ...models]} />}
      </div>
      <div className="agt-obs-status" role="status">
        <span className="muted">
          {filtered ? `${shown.length} of ${plural(all.length, 'observation')} · ${hidden} hidden by the filter` : plural(all.length, 'observation')}
          {view.total > all.length ? ` · newest ${all.length} of ${view.total}` : ''}
        </span>
        {filtered && <button type="button" className="btn btn-small" onClick={() => setFilter(NO_FILTER)}>Show all</button>}
        <span className="agt-obs-grow" />
        {shown.length > 0 && <button type="button" className="btn btn-small" disabled={busy} onClick={() => setSelected(chosen.length === shown.length ? new Set() : new Set(shown.map((o) => o.id)))}>{chosen.length === shown.length ? 'Select none' : 'Select all shown'}</button>}
        {chosen.length > 0 && <button type="button" className="btn btn-small" disabled={busy} onClick={() => void remove(chosen.map((o) => o.id))}>Delete {chosen.length}…</button>}
      </div>
      {error && <p className="t-red copyable" role="alert">{error}</p>}
      {notice && <p className="muted" role="status">{notice}</p>}
      {!all.length && <p className="muted">No image observations yet. With Save image observations on, the agent notes what you said about a picture, or what a vision model saw in it.</p>}
      {all.length > 0 && !shown.length && <p className="muted">Nothing matches the filter.</p>}
      <ul ref={list} className="agt-obs-list" aria-label="Observations: arrow keys move, Enter opens, Delete deletes" onKeyDown={(e) => cardKeys(e, (id) => void remove([id]))}>
        {shown.map((o) => <ObservationCard key={o.id} o={o} profile={name(o.profileId)} open={open.has(o.id)} selected={selected.has(o.id)} busy={busy} onToggle={() => toggle(o.id)} onSelect={(on) => pick(o.id, on)} onProfile={filter.profile === (o.profileId ?? 'none') ? undefined : () => showProfile(o.profileId)} onDelete={() => void remove([o.id])} />)}
      </ul>
    </section>
  </div>
}

/** The overview in the Agents dialog frame: a centred window on a desktop, a sheet on a phone. */
export function ObservationsDialog({ initialProfile, onClose, onChanged }: { initialProfile?: number | 'none'; onClose: () => void; onChanged?: () => void }) {
  return <ImageDialog title="Image observations" wide onClose={onClose}>
    <div className="image-session-body"><ObservationsPanel initialProfile={initialProfile} onChanged={onChanged} /></div>
  </ImageDialog>
}

/**
 * One observation in the Memory list: picture, source, task, profile and date on a line, the note
 * under it, and the same detail as the overview on demand.
 */
export function ObservationLine({ o, profile }: { o: Observation; profile: string }) {
  const [open, setOpen] = useState(false)
  const detail = useId()
  return <div className={`agt-obs-line ${open ? 'is-open' : ''}`}>
    <ObservationHead o={o} profile={profile} open={open} controls={detail} onToggle={() => setOpen(!open)} />
    {open && <div id={detail} className="agt-obs-body"><ObservationDetail o={o} /></div>}
  </div>
}
