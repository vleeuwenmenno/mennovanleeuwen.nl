import { BADGE_NOTE, CAMERA_MOVES, CAMERA_PHRASES, LANE_LABEL, laneBadge, SHOT_TRANSITIONS, tiledShots, type Compiled, type LaneKind, type Lanes, type VideoProject } from '../../data/videoPlan'
import { Select } from '../../os/Select'
import { itemsOf, timeOf, type Selection } from './lanes'

// What the selected item says, as fields; and a lane as a list (the phone's way to edit, and the
// keyboard's on a desktop). Times are typed in seconds; the timeline shows the same item.

type Props = {
  project: VideoProject
  compiled: Compiled
  lanes: Lanes
  duration: number
  selection: Selection
  onItem: (lane: LaneKind, id: string, patch: Record<string, unknown>) => void
  onProject: (patch: Partial<VideoProject>) => void
  onDelete: (lane: LaneKind, id: string) => void
  onTime: (lane: LaneKind, id: string, at: number) => void
}

const TRANSITION_LABEL: Record<string, string> = { cut: 'Cut', cross_dissolve: 'Cross-dissolve', fade: 'Fade', wipe: 'Wipe' }

export function Inspector({ project, compiled, lanes, duration, selection, onItem, onProject, onDelete, onTime }: Props) {
  if (!selection) return <p className="muted vs-note">Select an item on the timeline (or in a lane's list) to edit it. Double-click a lane, or its +, to add one.</p>
  if (selection.lane === 'bed') {
    return (
      <div className="vs-fields">
        <Header title="Sound beds" badge="Hint" />
        <label className="vs-field"><span>Soundscape</span><textarea rows={3} value={project.soundscape} placeholder="Ambience and action sounds over the whole clip: hangar hum, wind…" onChange={(e) => onProject({ soundscape: e.target.value })} /></label>
        <label className="vs-field"><span>Music</span><textarea rows={2} value={project.music} placeholder="Score only the audience hears: instruments, tempo. Empty: none" onChange={(e) => onProject({ music: e.target.value })} /></label>
      </div>
    )
  }
  const { lane } = selection
  const item = itemsOf(lanes, lane).find((i) => i.id === selection.id) as (Record<string, unknown> & { id: string; at?: number; start?: number; end?: number }) | undefined
  if (!item) return <p className="muted vs-note">That item is gone.</p>
  const b = compiled.items[item.id]?.badge ?? laneBadge(project.family, lane)
  const set = (patch: Record<string, unknown>) => onItem(lane, item.id, patch)
  const shotIndex = lane === 'shots' ? tiledShots(lanes, duration).findIndex((s) => s.id === item.id) : compiled.items[item.id]?.shot ?? 0
  const time = (
    <label className="vs-field is-short">
      <span>{lane === 'shots' ? 'Cut at (s)' : 'At (s)'}</span>
      <input type="number" min={0} max={duration} step={0.25} value={timeOf(item)} disabled={lane === 'shots' && shotIndex === 0} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && onTime(lane, item.id, e.target.valueAsNumber)} />
    </label>
  )
  const until = lane !== 'shots' && (
    <label className="vs-field is-short">
      <span>Until (s)</span>
      <input type="number" min={0} max={duration} step={0.25} value={item.end ?? ''} placeholder="—" onChange={(e) => set({ end: Number.isFinite(e.target.valueAsNumber) && e.target.valueAsNumber > timeOf(item) ? Math.min(duration, e.target.valueAsNumber) : undefined })} />
    </label>
  )
  return (
    <div className="vs-fields">
      <Header title={`${LANE_LABEL[lane]} · Shot ${shotIndex + 1}`} badge={b} note={compiled.items[item.id]?.note} />
      <span className="vs-row">{time}{until}</span>
      {lane === 'shots' && (
        <>
          <label className="vs-field"><span>Framing</span><textarea rows={3} value={String(item.framing ?? '')} placeholder="Shot size and who or what is in frame: a wide shot of the ship on the pad" onChange={(e) => set({ framing: e.target.value })} /></label>
          {shotIndex > 0 && (
            <div className="vs-field">
              <span>Transition</span>
              <Select aria-label="Transition" value={String(item.transition ?? 'cut')} onChange={(v) => set({ transition: v })} options={SHOT_TRANSITIONS.map((t) => ({ value: t, label: TRANSITION_LABEL[t] }))} />
            </div>
          )}
        </>
      )}
      {(lane === 'action' || lane === 'sound') && (
        <label className="vs-field"><span>{lane === 'action' ? 'What happens' : 'Sound'}</span><textarea rows={3} value={String(item.text ?? '')} placeholder={lane === 'action' ? 'The crew steps back from the ship' : 'a klaxon wails'} onChange={(e) => set({ text: e.target.value })} /></label>
      )}
      {lane === 'camera' && (
        <>
          <div className="vs-field">
            <span>Move</span>
            <Select aria-label="Camera move" value={String(item.move)} onChange={(v) => set({ move: v })} options={CAMERA_MOVES.map((m) => ({ value: m, label: CAMERA_PHRASES[m].label }))} />
          </div>
          <Seg label="Amount" value={(item.amplitude as string) ?? ''} options={[['', 'Normal'], ['small', 'Small'], ['large', 'Large']]} onChange={(v) => set({ amplitude: v || undefined })} />
          <Seg label="Speed" value={(item.speed as string) ?? ''} options={[['', 'Normal'], ['slow', 'Slow'], ['fast', 'Fast']]} onChange={(v) => set({ speed: v || undefined })} />
          <label className="vs-field"><span>Target</span><input value={String(item.target ?? '')} placeholder="around the ship's hull" onChange={(e) => set({ target: e.target.value || undefined })} /></label>
        </>
      )}
      {lane === 'speech' && (
        <>
          <div className="vs-field">
            <span>Speaker</span>
            <Select aria-label="Speaker" value={String(item.speaker)} onChange={(v) => set({ speaker: v })} options={project.speakers.length ? project.speakers.map((s) => ({ value: s.id, label: `${s.id} · ${s.who || 'who?'}` })) : [{ value: String(item.speaker), label: `${item.speaker} (add speakers under Style)` }]} />
          </div>
          <label className="vs-field"><span>Line (exact words)</span><textarea rows={2} value={String(item.line ?? '')} placeholder="Clear the pad!" onChange={(e) => set({ line: e.target.value })} /></label>
          <span className="vs-row">
            <label className="vs-field is-short"><span>Language</span><input value={String(item.language ?? '')} onChange={(e) => set({ language: e.target.value })} /></label>
            <label className="vs-check"><input type="checkbox" checked={item.voiceover === true} onChange={(e) => set({ voiceover: e.target.checked || undefined })} /> Voice-over</label>
          </span>
          <label className="vs-field"><span>Delivery</span><input value={String(item.delivery ?? '')} placeholder="shouting over the engines" onChange={(e) => set({ delivery: e.target.value || undefined })} /></label>
        </>
      )}
      {lane === 'text' && (
        <>
          <label className="vs-field"><span>Text (exact)</span><input value={String(item.content ?? '')} placeholder="NX-01" onChange={(e) => set({ content: e.target.value })} /></label>
          <label className="vs-field"><span>Written on</span><input value={String(item.on ?? '')} placeholder="the ship's hull" onChange={(e) => set({ on: e.target.value })} /></label>
        </>
      )}
      {!(lane === 'shots' && shotIndex === 0 && lanes.shots.length <= 1) && (
        <button type="button" className="btn btn-small vs-danger" onClick={() => onDelete(lane, item.id)}>{lane === 'shots' ? 'Remove this cut' : 'Delete'}</button>
      )}
    </div>
  )
}

function Header({ title, badge, note }: { title: string; badge: keyof typeof BADGE_NOTE; note?: string }) {
  return (
    <div className="vs-insp-head">
      <strong>{title}</strong>
      <span className={`vs-badge is-${badge.toLowerCase()}`}>{badge}</span>
      <span className="muted vs-note">{BADGE_NOTE[badge]}{note ? `. ${note}.` : '.'}</span>
    </div>
  )
}

function Seg({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="vs-field">
      <span>{label}</span>
      <span className="seg seg-small" role="radiogroup" aria-label={label}>
        {options.map(([v, l]) => (
          <button key={v || 'none'} type="button" role="radio" aria-checked={value === v} className={value === v ? 'is-active' : ''} onClick={() => onChange(v)}>{l}</button>
        ))}
      </span>
    </div>
  )
}

/** One lane's items as a list, in time order: tap one to edit it (on a phone, in a sheet). */
export function LaneList({ project, compiled, lanes, duration, lane, playhead, selection, onSelect, onAdd }: { project: VideoProject; compiled: Compiled; lanes: Lanes; duration: number; lane: LaneKind; playhead: number; selection: Selection; onSelect: (s: Selection) => void; onAdd: (lane: LaneKind, at: number) => void }) {
  const rows = lane === 'shots' ? tiledShots(lanes, duration).map((s) => ({ id: s.id, at: s.start, text: s.framing || 'No framing yet', real: lanes.shots.some((x) => x.id === s.id) })) : itemsOf(lanes, lane).map((i) => ({ id: i.id, at: timeOf(i), text: describe(lane, i as Record<string, unknown>), real: true })).sort((a, b) => a.at - b.at)
  return (
    <ul className="vs-list" aria-label={`${LANE_LABEL[lane]} items`}>
      {rows.map((r) => {
        const b = compiled.items[r.id]?.badge ?? laneBadge(project.family, lane)
        return (
          <li key={r.id}>
            <button type="button" className={`vs-list-row ${selection?.lane === lane && selection.id === r.id ? 'is-on' : ''}`} onClick={() => (r.real ? onSelect({ lane, id: r.id }) : onAdd('shots', 0))}>
              <span className="vs-list-time">{r.at.toFixed(1)} s</span>
              <span className="vs-list-text">{r.text}</span>
              <span className={`vs-badge is-${b.toLowerCase()}`}>{b}</span>
              <span aria-hidden>›</span>
            </button>
          </li>
        )
      })}
      <li>
        <button type="button" className="vs-list-row is-add" onClick={() => onAdd(lane, playhead)}>
          + {lane === 'shots' ? 'Cut' : `Add ${LANE_LABEL[lane].toLowerCase()}`} at {playhead.toFixed(1)} s
        </button>
      </li>
    </ul>
  )
}

const describe = (lane: LaneKind, i: Record<string, unknown>) =>
  lane === 'action' || lane === 'sound' ? String(i.text || '…') : lane === 'camera' ? `${CAMERA_PHRASES[i.move as keyof typeof CAMERA_PHRASES]?.label ?? 'Camera'}${i.target ? ` ${i.target}` : ''}` : lane === 'speech' ? `${i.speaker}: “${String(i.line || '…')}”` : lane === 'text' ? `“${String(i.content || '…')}” on ${String(i.on || '…')}` : ''
