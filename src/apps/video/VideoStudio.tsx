import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import './video.css'
import { imageProgressFraction } from '../../data/imageModels'
import { effectiveSeconds, FAMILY_LABEL, FAMILY_RULES, JOB_ACTIVE, snapDuration, snapVideoSize, VIDEO_ASPECT_RATIOS, VIDEO_SIZE_TIERS, videoAspectLabel, videoSizeFor, videoSizeTier, type VideoFamily } from '../../data/videoModels'
import { compileProject, defaultProject, LANE_KINDS, LANE_LABEL, VIDEO_PLAN_LIMITS, type LaneKind, type Lanes, type Segment, type VideoProject } from '../../data/videoPlan'
import { cancelVideoJob, createVideoProject, deleteStudioVideo, deleteVideoProject, getVideoProject, getVideoStatus, listStudioVideos, listVideoJobs, listVideoProjects, renderVideoProject, saveVideoProject, sourceUrl, type ProjectRecord, type ProjectSummary, type StudioVideo, type VideoJob } from '../../data/videoStudio'
import { signIn, useAccount } from '../../os/account'
import { ask } from '../../os/Dialogs'
import { openMenuAt, type MenuItem } from '../../os/ContextMenu'
import { localPref } from '../../os/localPref'
import { notify } from '../../os/notify'
import { Select } from '../../os/Select'
import { useIsMobile } from '../../os/useIsMobile'
import { useMediaQuery } from '../../os/useMediaQuery'
import { useWM, type WinState } from '../../os/wm'
import { Inspector, LaneList } from './Inspector'
import { KeyframeSlots } from './Keyframes'
import { addItem, duplicateItem, fitLanes, moveItem, removeItem, updateItem, type Selection } from './lanes'
import { Timeline } from './Timeline'

// The Video Studio: one picture (or none) and a timeline of what should happen, made into one clip
// by the account's own ComfyUI (MiniMax H3 or LTX 2.5). The project is the server's (saved as you
// go, with a revision so two tabs don't overwrite each other); the lanes compile to the model's
// prompt here and again on the server before a render (src/data/videoPlan.ts). Renders are jobs
// on the server: they go on with this window or the whole tab closed, and the history keeps the
// videos. A wide window has the keyframes and style on the left, the preview in the middle, the
// selected item on the right and the timeline below; a phone shows one lane at a time with its list
// (tap to edit in a sheet) and the drawers and Render in a bar at the bottom.

/** Pixels per second on the timeline, per browser. */
const zoomPref = localPref<number>('mvlos.video.zoom', (raw) => Math.min(400, Math.max(20, Number(raw) || 80)))
/** The lane a phone shows. */
const phoneLanePref = localPref<LaneKind>('mvlos.video.lane', (raw) => (LANE_KINDS.includes(raw as LaneKind) ? (raw as LaneKind) : 'action'), String)
/** The project open last, per account. */
const lastPref = localPref<string>('mvlos.video.last', (raw) => raw ?? '', String, { account: true })

export function VideoStudio({ win }: { win: WinState }) {
  const account = useAccount()
  if (account.status === 'loading') return <div className="nb-blank muted">Loading…</div>
  if (account.status !== 'user')
    return (
      <div className="nb-blank">
        <p className="muted">The Video Studio turns a picture into a video clip with your own ComfyUI server, for signed-in users.</p>
        {account.status === 'anon' && <button className="btn btn-primary" onClick={signIn}>Sign in with GitHub</button>}
      </div>
    )
  return <Studio win={win} />
}

/** The account's renders: read often while one is going, rarely otherwise; a finished one is announced. */
function useJobs() {
  const [jobs, setJobs] = useState<VideoJob[]>([])
  const before = useRef(new Map<string, VideoJob['status']>())
  const read = useCallback(() => listVideoJobs().then((list) => {
    for (const j of list) {
      const was = before.current.get(j.id)
      if (was && JOB_ACTIVE.includes(was) && !JOB_ACTIVE.includes(j.status)) {
        if (j.status === 'done') notify({ title: 'Your video is ready', body: j.title, transient: true })
        else if (j.status === 'failed' || j.status === 'interrupted') notify({ title: 'A video render failed', body: j.error ?? j.title, transient: true })
      }
      before.current.set(j.id, j.status)
    }
    setJobs(list)
  }, () => {}), [])
  const active = jobs.some((j) => JOB_ACTIVE.includes(j.status))
  useEffect(() => {
    void read()
    const t = setInterval(() => !document.hidden && void read(), active ? 1500 : 15000)
    const onVisible = () => !document.hidden && void read()
    document.addEventListener('visibilitychange', onVisible)
    return () => (clearInterval(t), document.removeEventListener('visibilitychange', onVisible))
  }, [active, read])
  return { jobs, refresh: read }
}

function Studio({ win }: { win: WinState }) {
  const wm = useWM()
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(() => win.props.project || lastPref.get() || null)
  const [error, setError] = useState('')
  const { jobs, refresh: refreshJobs } = useJobs()
  useEffect(() => void getVideoStatus().then((s) => setConfigured(s.configured), (e: Error) => setError(e.message)), [])
  const loadList = () => listVideoProjects().then(setProjects, (e: Error) => setError(e.message))
  useEffect(() => void loadList(), [])
  // Opened on a project (an agent's "Open in Video Studio", a notification).
  useEffect(() => {
    if (win.props.project) setOpenId(win.props.project)
  }, [win.props.project, win.props.t])
  useEffect(() => lastPref.set(openId ?? ''), [openId])
  const openSettings = () => wm.open('settings', { section: 'studio', t: String(Date.now()) })
  const newProject = async () => {
    try {
      const r = await createVideoProject(defaultProject())
      setOpenId(r.id)
      void loadList()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  if (openId)
    return <Editor key={openId} id={openId} configured={configured} jobs={jobs} refreshJobs={refreshJobs} onClose={() => (setOpenId(null), void loadList())} onGone={() => (setOpenId(null), void loadList())} onSettings={openSettings} />
  return (
    <div className="vs vs-projects-view">
      <header className="vs-top">
        <h3>Video Studio</h3>
        <span className="vs-grow" />
        <button type="button" className="btn btn-small" onClick={openSettings}>Settings</button>
        <button type="button" className="btn btn-small btn-primary" onClick={() => void newProject()}>New video</button>
      </header>
      {configured === false && (
        <div className="vs-banner">
          <span>Connect your ComfyUI server first: the Video Studio renders on it.</span>
          <button type="button" className="btn btn-small" onClick={openSettings}>Open settings</button>
        </div>
      )}
      {error && <p className="t-red copyable vs-pad" role="alert">{error}</p>}
      {!projects && !error && <p className="muted vs-pad">Loading…</p>}
      {projects && !projects.length && <p className="muted vs-pad">No videos yet. Start one from a picture: New video, then choose its first frame.</p>}
      <ul className="vs-project-list">
        {projects?.map((p) => (
          <li key={p.id}>
            <button type="button" className="vs-project" onClick={() => setOpenId(p.id)}>
              <span className="vs-project-pic">{p.firstFrame ? <img src={p.firstFrame} alt="" loading="lazy" /> : <span className="muted">No picture</span>}</span>
              <span className="vs-project-text">
                <strong>{p.title}</strong>
                <span className="muted">{FAMILY_LABEL[p.family]} · {p.duration} s · {p.width} × {p.height}{p.origin === 'agent' ? ' · planned by an agent' : ''}</span>
                <span className="muted">{new Date(p.updated_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <JobBar jobs={jobs} onCancel={(id) => void cancelVideoJob(id).then(refreshJobs)} />
    </div>
  )
}

type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

function Editor({ id, configured, jobs, refreshJobs, onClose, onGone, onSettings }: { id: string; configured: boolean | null; jobs: VideoJob[]; refreshJobs: () => void; onClose: () => void; onGone: () => void; onSettings: () => void }) {
  const wm = useWM()
  const mobile = useIsMobile()
  const touch = useMediaQuery('(pointer: coarse)')
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

  const [record, setRecord] = useState<ProjectRecord | null>(null)
  const [project, setProject] = useState<VideoProject | null>(null)
  const [loadError, setLoadError] = useState('')
  const [save, setSave] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState('')
  const [conflict, setConflict] = useState<ProjectRecord | null>(null)
  const revision = useRef(0)
  useEffect(() => {
    getVideoProject(id).then((r) => (setRecord(r), setProject(r.project), (revision.current = r.revision)), (e: Error) => (/No such/.test(e.message) ? onGone() : setLoadError(e.message)))
  }, [id])

  // Saved a moment after the last change; Render waits for it.
  const pending = useRef<VideoProject | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) (clearTimeout(timer.current), (timer.current = null))
    const next = pending.current
    if (!next) return true
    pending.current = null
    setSave('saving')
    try {
      const r = await saveVideoProject(id, revision.current, next)
      if ('conflict' in r) {
        setConflict(r.conflict)
        pending.current = next
        setSave('error')
        return false
      }
      revision.current = r.saved.revision
      setRecord(r.saved)
      setSave(pending.current ? 'dirty' : 'saved')
      setSaveError('')
      return true
    } catch (e) {
      pending.current = pending.current ?? next
      setSave('error')
      setSaveError((e as Error).message)
      return false
    }
  }, [id])
  const change = (fn: (p: VideoProject) => VideoProject) =>
    setProject((p) => {
      if (!p) return p
      const next = fn(p)
      pending.current = next
      setSave('dirty')
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), 700)
      return next
    })
  useEffect(() => () => void flush(), [flush])

  const [selection, setSelection] = useState<Selection>(null)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const pps = zoomPref.use()
  const [phoneLane, setPhoneLane] = [phoneLanePref.use(), phoneLanePref.set]
  const [drawer, setDrawer] = useState<'keys' | 'style' | 'prompt' | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)
  const [renderError, setRenderError] = useState('')
  const [rendering, setRendering] = useState(false)
  const [videos, setVideos] = useState<StudioVideo[]>([])
  const [shownVideo, setShownVideo] = useState<string | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const loadVideos = () => listStudioVideos(id).then((r) => setVideos(r.videos), () => {})
  const mine = jobs.filter((j) => j.project_id === id)
  const doneCount = mine.filter((j) => j.status === 'done').length
  useEffect(() => void loadVideos(), [id, doneCount])
  useEffect(() => {
    if (videos[0] && !videos.some((v) => v.id === shownVideo)) setShownVideo(videos[0].id)
  }, [videos])

  const compiled = useMemo(() => (project ? compileProject(project) : null), [project])
  const [videoPlaying, setVideoPlaying] = useState(false)
  // Without a rendered video, Play runs the playhead over the timeline.
  const duration0 = project?.segments[0].duration ?? 0
  useEffect(() => {
    if (!playing) return
    const duration = duration0
    let last = performance.now(), raf = 0
    const step = (now: number) => {
      setPlayhead((t) => {
        const next = t + (now - last) / 1000
        if (next >= duration) setPlaying(false)
        return Math.min(duration, next)
      })
      last = now
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, duration0])

  if (loadError) return <div className="vs"><p className="t-red copyable vs-pad">{loadError}</p><button type="button" className="btn btn-small" onClick={onClose}>Back to projects</button></div>
  if (!project || !compiled || !record) return <div className="vs"><p className="muted vs-pad">Loading…</p></div>

  const seg = project.segments[0]
  const duration = seg.duration
  const effective = effectiveSeconds(project.family, duration)
  const lanes = seg.lanes
  const setSeg = (patch: Partial<Segment>) => change((p) => ({ ...p, segments: [{ ...p.segments[0], ...patch }, ...p.segments.slice(1)] }))
  const setLanes = (next: Lanes) => setSeg({ lanes: next })
  const shown = videos.find((v) => v.id === shownVideo) ?? null
  const active = mine.find((j) => JOB_ACTIVE.includes(j.status))
  const lastEnded = mine.find((j) => !JOB_ACTIVE.includes(j.status))

  const add = (lane: LaneKind, at: number) => {
    const r = addItem(lanes, lane, at, duration, project.speakers)
    if (!r) return setRenderError(lane === 'shots' ? `A cut needs a second on each side, and at most ${VIDEO_PLAN_LIMITS.maxShots} shots.` : 'This lane is full.')
    setLanes(r.lanes)
    setSelection({ lane, id: r.id })
  }
  const remove = (lane: LaneKind, itemId: string) => {
    setLanes(removeItem(lanes, lane, itemId))
    setSelection(null)
  }
  const menuFor = (lane: LaneKind, itemId: string): MenuItem[] => [
    { label: 'Edit', onSelect: () => (setSelection({ lane, id: itemId }), mobile && setDrawer(null)) },
    ...(lane !== 'shots' ? [{ label: 'Duplicate', onSelect: () => { const r = duplicateItem(lanes, lane, itemId, duration); if (r) (setLanes(r.lanes), setSelection({ lane, id: r.id })) } }] : []),
    { label: 'Cut a shot at the playhead', onSelect: () => add('shots', playhead) },
    { separator: true },
    { label: lane === 'shots' ? 'Remove this cut' : 'Delete', danger: true, onSelect: () => remove(lane, itemId) },
  ]

  const togglePlay = () => {
    const v = video.current
    if (v && shown) {
      if (v.paused) void v.play().catch(() => {})
      else v.pause()
      return
    }
    setPlaying((p) => !p)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('input, textarea, [contenteditable]') || e.altKey || e.ctrlKey || e.metaKey) return
    const sel = selection
    if (e.key === ' ') return e.preventDefault(), togglePlay()
    if (e.key === 's' || e.key === 'S') return e.preventDefault(), add('shots', playhead)
    if (e.key === 'Escape') return setSelection(null)
    if (!sel || sel.lane === 'bed') return
    if (e.key === 'Delete' || e.key === 'Backspace') return e.preventDefault(), remove(sel.lane, sel.id)
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const item = (lanes[sel.lane] as { id: string; at?: number; start?: number }[]).find((i) => i.id === sel.id)
      if (!item) return
      const d = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowLeft' ? -1 : 1)
      setLanes(moveItem(lanes, sel.lane, sel.id, Math.round(((item.at ?? item.start ?? 0) + d) * 100) / 100, duration))
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      root.current?.querySelector<HTMLElement>('.vs-fields textarea, .vs-fields input')?.focus()
    }
  }

  const setFamily = (family: VideoFamily) =>
    change((p) => {
      const d = snapDuration(family, p.segments[0].duration)
      const size = snapVideoSize(p.width, p.height, family)
      return { ...p, family, ...size, segments: [{ ...p.segments[0], duration: d, lastFrame: FAMILY_RULES[family].lastFrame ? p.segments[0].lastFrame : null, turbo: family === 'minimax_h3' && p.segments[0].turbo, lanes: fitLanes(p.segments[0].lanes, d) }] }
    })
  const setDuration = (raw: number) => {
    const d = snapDuration(project.family, raw)
    setSeg({ duration: d, lanes: fitLanes(lanes, d) })
    setPlayhead((t) => Math.min(t, d))
  }
  // "Match first frame" takes the picture's own shape, so ComfyUI has nothing to cut off.
  const frameRatio = seg.firstFrame && seg.firstFrame.width > 0 && seg.firstFrame.height > 0 ? seg.firstFrame.width / seg.firstFrame.height : null
  const matchesFrame = frameRatio !== null && Math.abs(project.width / project.height / frameRatio - 1) < 0.03
  const aspect = videoAspectLabel(project.width, project.height) ?? (matchesFrame ? 'frame' : 'custom')
  const tier = videoSizeTier(project.width, project.height, project.family) ?? 'custom'
  const ratioOf = (label: string) => (label === 'frame' && frameRatio) || VIDEO_ASPECT_RATIOS.find((a) => a.label === label)?.value || project.width / project.height
  const setSize = (ratioLabel: string, tierLabel: string) => {
    const ratio = ratioOf(ratioLabel)
    const short = VIDEO_SIZE_TIERS.find((t) => t.label === tierLabel)?.shortSide ?? Math.min(project.width, project.height)
    change((p) => ({ ...p, ...videoSizeFor(ratio, short, p.family) }))
  }

  const render = async () => {
    setRenderError('')
    setRendering(true)
    try {
      if (!(await flush())) throw new Error(saveError || 'Save the project first')
      await renderVideoProject(id)
      refreshJobs()
    } catch (e) {
      setRenderError((e as Error).message)
    } finally {
      setRendering(false)
    }
  }
  const removeVideo = async (v: StudioVideo) => {
    if (!(await ask({ title: 'Delete this video?', body: 'It is deleted from the server for good. Copies you downloaded stay.', confirm: 'Delete', danger: true }))) return
    await deleteStudioVideo(v.id).then(() => (setShownVideo(null), loadVideos()), (e: Error) => setRenderError(e.message))
  }
  const removeProject = async () => {
    if (!(await ask({ title: `Delete “${project.title}”?`, body: 'The project and its timeline go. Its rendered videos stay in your storage until you delete them.', confirm: 'Delete', danger: true }))) return
    await flush()
    await deleteVideoProject(id).then(onGone, (e: Error) => setRenderError(e.message))
  }

  const problems = [...(configured === false ? ['Connect ComfyUI in Settings → Image & Video Studio first.'] : []), ...compiled.problems]
  const canRender = !problems.length && !rendering
  const renderLabel = rendering ? 'Starting…' : active ? `Queue · ${duration} s` : `Render ${duration} s`
  const fmt = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(3).padStart(6, '0')}`

  // --- the parts -----------------------------------------------------------------------------
  const keyframes = <KeyframeSlots family={project.family} first={seg.firstFrame} last={seg.lastFrame} width={project.width} height={project.height} onChange={(slot, k) => setSeg({ [slot]: k })} />
  const style = (
    <section className="vs-section" aria-label="Style and speakers">
      <h4 className="vs-head">Style</h4>
      <input className="vs-input" value={project.style} onChange={(e) => change((p) => ({ ...p, style: e.target.value }))} placeholder="Live-action, cinematic" aria-label="Style" />
      <h4 className="vs-head">Speakers</h4>
      {project.speakers.map((s, i) => (
        <div key={s.id} className="vs-speaker">
          <strong>{s.id}</strong>
          <input className="vs-input" value={s.who} placeholder="who: the pilot" aria-label={`${s.id}: who`} onChange={(e) => change((p) => ({ ...p, speakers: p.speakers.map((x, j) => (j === i ? { ...x, who: e.target.value } : x)) }))} />
          <input className="vs-input" value={s.voice} placeholder="voice: a low, calm male voice" aria-label={`${s.id}: voice`} onChange={(e) => change((p) => ({ ...p, speakers: p.speakers.map((x, j) => (j === i ? { ...x, voice: e.target.value } : x)) }))} />
          <button type="button" className="btn btn-small" aria-label={`Remove ${s.id}`} onClick={() => change((p) => ({ ...p, speakers: p.speakers.filter((_, j) => j !== i) }))}>×</button>
        </div>
      ))}
      {project.speakers.length < VIDEO_PLAN_LIMITS.maxSpeakers && (
        <button type="button" className="btn btn-small" onClick={() => change((p) => ({ ...p, speakers: [...p.speakers, { id: `S${[1, 2, 3, 4].find((n) => !p.speakers.some((s) => s.id === `S${n}`))}`, who: '', voice: '' }] }))}>+ Speaker</button>
      )}
      <h4 className="vs-head">Generation</h4>
      <span className="vs-row">
        <label className="vs-field is-short"><span>Seed</span><input type="number" min={-1} value={seg.seed} onChange={(e) => setSeg({ seed: Number.isSafeInteger(e.target.valueAsNumber) && e.target.valueAsNumber >= -1 ? e.target.valueAsNumber : -1 })} /></label>
        <button type="button" className="btn btn-small" onClick={() => setSeg({ seed: -1 })} disabled={seg.seed === -1}>Random</button>
        {project.family === 'minimax_h3' && <label className="vs-check"><input type="checkbox" checked={seg.turbo} onChange={(e) => setSeg({ turbo: e.target.checked })} /> Turbo (8 steps)</label>}
      </span>
    </section>
  )
  const promptPane = (
    <section className="vs-section vs-prompt" aria-label="Prompt">
      <span className="vs-row">
        <h4 className="vs-head">Prompt the model gets</h4>
        <span className="vs-grow" />
        {project.rawPrompt === null ? (
          <button type="button" className="btn btn-small" onClick={() => change((p) => ({ ...p, rawPrompt: compiled.prompt }))} title="Write the prompt by hand; the lanes stop being used">Edit as text</button>
        ) : (
          <button type="button" className="btn btn-small" onClick={() => change((p) => ({ ...p, rawPrompt: null }))}>Back to the timeline</button>
        )}
      </span>
      {project.rawPrompt === null ? <pre className="vs-prompt-text copyable">{compiled.prompt || '—'}</pre> : <textarea className="vs-prompt-edit" value={project.rawPrompt} onChange={(e) => change((p) => ({ ...p, rawPrompt: e.target.value }))} aria-label="Prompt" />}
    </section>
  )
  const checks = (problems.length > 0 || compiled.warnings.length > 0) && (
    <ul className="vs-checks" aria-live="polite">
      {problems.map((p) => <li key={p} className="t-red">{p}</li>)}
      {compiled.warnings.map((w) => <li key={w} className="t-yellow">{w}</li>)}
    </ul>
  )
  const inspector = <Inspector project={project} compiled={compiled} lanes={lanes} duration={duration} selection={selection} onItem={(lane, itemId, patch) => setLanes(updateItem(lanes, lane, itemId, patch))} onProject={(patch) => change((p) => ({ ...p, ...patch }))} onDelete={remove} onTime={(lane, itemId, at) => setLanes(moveItem(lanes, lane, itemId, at, duration))} />

  const preview = (
    <section className="vs-preview" aria-label="Preview">
      <div className="vs-stage" style={{ '--vs-ar': project.width / project.height } as React.CSSProperties}>
        {shown ? (
          <video
            ref={video}
            key={shown.id}
            src={shown.url}
            muted
            playsInline
            controls={touch}
            preload="metadata"
            onTimeUpdate={(e) => setPlayhead(Math.min(duration, e.currentTarget.currentTime))}
            onPlay={() => (setPlaying(false), setVideoPlaying(true))}
            onPause={() => setVideoPlaying(false)}
            onEnded={() => setVideoPlaying(false)}
          />
        ) : seg.firstFrame ? (
          <img src={sourceUrl(seg.firstFrame.sourceId)} alt="The first frame" />
        ) : (
          <span className="muted">{configured === false ? 'Connect ComfyUI to render.' : 'Choose a first frame, lay out what happens below, then Render.'}</span>
        )}
        {active && <span className="vs-stage-badge">{phaseText(active)}</span>}
      </div>
      <div className="vs-transport">
        <button type="button" className="btn btn-small" onClick={togglePlay} aria-label="Play or pause (Space)">{playing || videoPlaying ? '❚❚' : '▶'}</button>
        <span className="vs-time">{fmt(playhead)} / {fmt(shown ? shown.duration : effective)}</span>
        {shown && <span className="muted vs-note">{shown.width} × {shown.height} · seed {String(shown.settings.seed ?? '?')}</span>}
      </div>
    </section>
  )
  const history = (
    <section className="vs-history" aria-label="History">
      {videos.map((v) => (
        <button key={v.id} type="button" className={`vs-hist ${v.id === shownVideo ? 'is-on' : ''}`} onClick={() => setShownVideo(v.id)} title={`${new Date(v.created_at).toLocaleString()} · ${(v.size / 1024 / 1024).toFixed(1)} MB`} aria-label={`Show the video from ${new Date(v.created_at).toLocaleString()}`}>
          <video src={`${v.url}#t=0.1`} muted preload="metadata" playsInline />
        </button>
      ))}
      {shown && (
        <span className="vs-row vs-hist-actions">
          <button type="button" className="btn btn-small" onClick={() => wm.open('player', { src: shown.url, name: shown.name, kind: 'video', t: String(Date.now()) })}>Open in Player</button>
          <a className="btn btn-small" href={shown.url} download={shown.name}>Download</a>
          <button type="button" className="btn btn-small vs-danger" onClick={() => void removeVideo(shown)}>Delete</button>
        </span>
      )}
      {!videos.length && <span className="muted vs-note">Rendered videos show here.</span>}
    </section>
  )
  const top = (
    <header className="vs-top">
      <button type="button" className="btn btn-small" onClick={() => void flush().then(onClose)} aria-label="All projects" title="All projects">‹{columns ? ' Projects' : ''}</button>
      <input className="vs-title" value={project.title} onChange={(e) => change((p) => ({ ...p, title: e.target.value }))} aria-label="Title" maxLength={120} />
      {columns && (
        <>
          <Select aria-label="Model" value={project.family} onChange={setFamily} options={(['minimax_h3', 'ltx25'] as VideoFamily[]).map((f) => ({ value: f, label: FAMILY_LABEL[f] }))} />
          <Select aria-label="Aspect ratio" value={aspect} onChange={(a) => setSize(a, tier)} options={[...(frameRatio ? [{ value: 'frame', label: `Match first frame (${seg.firstFrame!.width} × ${seg.firstFrame!.height})` }] : []), ...VIDEO_ASPECT_RATIOS.map((a) => ({ value: a.label, label: a.label })), ...(aspect === 'custom' ? [{ value: 'custom', label: 'Custom' }] : [])]} />
          <Select aria-label="Size" value={tier} onChange={(t) => setSize(aspect, t)} options={[...VIDEO_SIZE_TIERS.map((t) => ({ value: t.label, label: `${t.label} · ${videoSizeFor(ratioOf(aspect), t.shortSide, project.family).width} × ${videoSizeFor(ratioOf(aspect), t.shortSide, project.family).height}` })), ...(tier === 'custom' ? [{ value: 'custom', label: `${project.width} × ${project.height}` }] : [])]} />
          <DurationField family={project.family} duration={duration} onChange={setDuration} effective={effective} />
          <button type="button" className={`btn btn-small ${promptOpen ? 'btn-primary' : ''}`} aria-expanded={promptOpen} onClick={() => setPromptOpen((o) => !o)}>Prompt</button>
        </>
      )}
      <span className="vs-grow" />
      <span className={`vs-save muted is-${save}`} role="status" title={saveError}>{save === 'saved' ? 'Saved' : save === 'saving' ? 'Saving…' : save === 'dirty' ? 'Edited' : 'Not saved'}</span>
      <button
        type="button"
        className="btn btn-small"
        aria-label="More"
        onClick={(e) => {
          const items: MenuItem[] = [
            ...(!columns ? [{ label: 'Model', submenu: (['minimax_h3', 'ltx25'] as VideoFamily[]).map((f) => ({ label: FAMILY_LABEL[f], checked: project.family === f, onSelect: () => setFamily(f) })) }, { label: 'Aspect ratio', submenu: [...(frameRatio ? [{ label: 'Match first frame', checked: aspect === 'frame', onSelect: () => setSize('frame', tier) }] : []), ...VIDEO_ASPECT_RATIOS.map((a) => ({ label: a.label, checked: aspect === a.label, onSelect: () => setSize(a.label, tier) }))] }, { label: 'Size', submenu: VIDEO_SIZE_TIERS.map((t) => ({ label: t.label, checked: tier === t.label, onSelect: () => setSize(aspect, t.label) })) }] : []),
            { label: 'Video settings…', onSelect: onSettings },
            { separator: true },
            { label: 'Delete this project…', danger: true, onSelect: () => void removeProject() },
          ]
          openMenuAt(e.currentTarget, items)
        }}
      >
        ⋯
      </button>
      {columns && <button type="button" className="btn btn-small btn-primary" disabled={!canRender} onClick={() => void render()} title={problems[0] ?? `Render on your ComfyUI: ${FAMILY_LABEL[project.family]}, ${project.width} × ${project.height}`}>{renderLabel}</button>}
    </header>
  )
  const banners = (
    <>
      {conflict && (
        <div className="vs-banner" role="alert">
          <span>This project was changed in another window or device.</span>
          <button type="button" className="btn btn-small" onClick={() => (setProject(conflict.project), setRecord(conflict), (revision.current = conflict.revision), (pending.current = null), setConflict(null), setSave('saved'))}>Load theirs</button>
          <button type="button" className="btn btn-small" onClick={() => ((revision.current = conflict.revision), setConflict(null), void flush())}>Keep mine</button>
        </div>
      )}
      {save === 'error' && !conflict && saveError && <div className="vs-banner t-red" role="alert"><span>{saveError}</span><button type="button" className="btn btn-small" onClick={() => void flush()}>Try again</button></div>}
      {renderError && <div className="vs-banner" role="alert"><span className="t-red">{renderError}</span><button type="button" className="btn btn-small" onClick={() => setRenderError('')}>Dismiss</button></div>}
      {lastEnded && lastEnded.status !== 'done' && lastEnded.status !== 'cancelled' && !active && lastEnded.error && <div className="vs-banner"><span className="t-red">Last render: {lastEnded.error}</span></div>}
    </>
  )
  const jobBar = <JobBar jobs={mine} onCancel={(jobId) => void cancelVideoJob(jobId).then(refreshJobs)} />
  const timelineProps = { project, compiled, duration, effective, lanes, pps, setPps: zoomPref.set, playhead, setPlayhead: (t: number) => { setPlayhead(t); if (video.current && shown) video.current.currentTime = t }, selection, setSelection, onLanes: setLanes, onAdd: add, menuFor, onKey, touch }

  if (columns)
    return (
      <div ref={root} className="vs is-wide" onKeyDown={onKey}>
        {top}
        {banners}
        <div className="vs-cols">
          <aside className="vs-col vs-left" aria-label="Keyframes and style">{keyframes}{style}</aside>
          <main className="vs-col vs-centre">{preview}{promptOpen && promptPane}{checks}</main>
          <aside className="vs-col vs-right" aria-label="Inspector"><h4 className="vs-head">Inspector</h4>{inspector}</aside>
        </div>
        <Timeline {...timelineProps} shown={LANE_KINDS} showBed />
        <footer className="vs-foot">{jobBar}{history}</footer>
      </div>
    )
  // Narrow window or phone: one lane at a time, its list, the drawers and Render at the bottom.
  return (
    <div ref={root} className="vs is-narrow">
      {top}
      {banners}
      <main className="vs-narrow-main">
        {preview}
        {jobBar}
        <div className="vs-row vs-lane-pick">
          <Select aria-label="Lane" value={phoneLane} onChange={(l) => (setPhoneLane(l), setSelection(null))} options={LANE_KINDS.map((l) => ({ value: l, label: LANE_LABEL[l] }))} />
          <span className="vs-grow" />
          <DurationField family={project.family} duration={duration} onChange={setDuration} effective={effective} />
        </div>
        <Timeline {...timelineProps} shown={[phoneLane]} showBed={false} />
        <LaneList project={project} compiled={compiled} lanes={lanes} duration={duration} lane={phoneLane} playhead={playhead} selection={selection} onSelect={setSelection} onAdd={add} />
        <button type="button" className="vs-list-row is-bed" onClick={() => setSelection({ lane: 'bed', id: 'bed' })}>Sound beds: {project.soundscape || 'soundscape…'}{project.music ? ` · music: ${project.music}` : ''} ›</button>
        {checks}
        {history}
      </main>
      <div className="vs-bar">
        <span className="vs-row">
          {(['keys', 'style', 'prompt'] as const).map((d) => (
            <button key={d} type="button" className={`btn btn-small ${drawer === d ? 'btn-primary' : ''}`} aria-expanded={drawer === d} onClick={() => setDrawer(drawer === d ? null : d)}>{d === 'keys' ? 'Keyframes' : d === 'style' ? 'Style' : 'Prompt'}</button>
          ))}
        </span>
        <button type="button" className="btn btn-primary vs-render" disabled={!canRender} onClick={() => void render()}>{renderLabel}</button>
        {problems[0] && <span className="vs-note t-red vs-bar-why">{problems[0]}</span>}
      </div>
      {(drawer || selection) && <div className="vs-sheet-backdrop" onClick={() => (setDrawer(null), setSelection(null))} />}
      {drawer && (
        <aside className="vs-sheet" aria-label={drawer === 'keys' ? 'Keyframes' : drawer === 'style' ? 'Style' : 'Prompt'}>
          <header className="vs-sheet-head"><strong>{drawer === 'keys' ? 'Keyframes' : drawer === 'style' ? 'Style' : 'Prompt'}</strong><button type="button" className="btn btn-small" onClick={() => setDrawer(null)}>Done</button></header>
          {drawer === 'keys' ? keyframes : drawer === 'style' ? style : promptPane}
        </aside>
      )}
      {!drawer && selection && (
        <aside className="vs-sheet" aria-label="Edit item">
          <header className="vs-sheet-head"><strong>Edit</strong><button type="button" className="btn btn-small" onClick={() => setSelection(null)}>Done</button></header>
          {inspector}
        </aside>
      )}
    </div>
  )
}

function DurationField({ family, duration, effective, onChange }: { family: VideoFamily; duration: number; effective: number; onChange: (v: number) => void }) {
  const r = FAMILY_RULES[family]
  const [draft, setDraft] = useState(String(duration))
  useEffect(() => setDraft(String(duration)), [duration])
  const commit = () => (Number.isFinite(Number(draft)) ? onChange(Number(draft)) : setDraft(String(duration)))
  return (
    <label className="vs-duration" title={`${FAMILY_LABEL[family]}: ${r.minSeconds}–${r.maxSeconds} s${r.wholeSeconds ? ', whole seconds' : ''}`}>
      <input type="number" min={r.minSeconds} max={r.maxSeconds} step={r.wholeSeconds ? 1 : 0.25} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} aria-label="Length in seconds" />
      <span className="muted">s{effective > duration + 0.01 ? ` → ${effective.toFixed(2)} s` : ''}</span>
    </label>
  )
}

const PHASE: Record<string, string> = { queued: 'waiting in ComfyUI', running: 'running', loading: 'loading models', encoding: 'encoding', sampling: 'sampling', upscaling: 'upscaling', refining: 'refining', decoding: 'decoding', saving: 'saving' }
function phaseText(j: VideoJob) {
  if (j.status === 'queued') return 'Waiting for your ComfyUI'
  if (j.status === 'uploading') return 'Sending the keyframes'
  const p = j.progress
  if (!p) return j.status === 'saving' ? 'Saving the video' : 'Starting'
  return `${PHASE[p.phase] ?? p.phase}${p.max ? ` ${p.value ?? 0}/${p.max}` : ''}${p.position !== undefined ? ` (#${p.position + 1})` : ''}`
}

/** The renders going on, each with where it is and Cancel. */
function JobBar({ jobs, onCancel }: { jobs: VideoJob[]; onCancel: (id: string) => void }) {
  const going = jobs.filter((j) => JOB_ACTIVE.includes(j.status))
  if (!going.length) return null
  return (
    <ul className="vs-jobs" aria-label="Renders">
      {going.map((j) => {
        const f = j.progress ? imageProgressFraction(j.progress) : null
        return (
          <li key={j.id} className="vs-job">
            <span className="vs-job-text"><strong>{j.title}</strong> · {phaseText(j)}</span>
            <span className="vs-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={f === null ? undefined : Math.round(f * 100)}><span style={{ width: `${Math.round((f ?? 0) * 100)}%` }} className={f === null ? 'is-unknown' : ''} /></span>
            <button type="button" className="btn btn-small" onClick={() => onCancel(j.id)}>Cancel</button>
          </li>
        )
      })}
    </ul>
  )
}
