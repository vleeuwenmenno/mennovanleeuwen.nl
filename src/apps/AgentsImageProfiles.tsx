import { useEffect, useState } from 'react'
import { getImageProfiles, getImageProfilePin, pinImageProfile, saveImageProfile, deleteImageProfile, type ImageProfile } from '../data/agentImages'
import { ask } from '../os/Dialogs'
import { Select } from '../os/Select'

type Profile = ImageProfile & { observations: number }

/** The server's limit for a profile's preferences (server/agentImageProfiles.ts), so one the agent wrote is never cut short here. */
const DESCRIPTION_MAX = 1200

const observations = (n: number) => `${n} ${n === 1 ? 'observation' : 'observations'}`
const originLabel = (p: ImageProfile) => p.origin === 'suggestion' ? 'Suggested by the agent' : 'Confirmed by you'

/** Destructive profile actions, confirmed in the OS's own dialog. Resolves false when cancelled. */
const confirmReset = (p: Profile) => ask({ title: `Reset observations for “${p.name}”?`, body: `Forgets ${observations(p.observations)} filed under this profile. Its name and style preferences stay.`, confirm: 'Reset observations', danger: true })
const confirmDelete = (p: Profile) => ask({ title: `Delete “${p.name}”?`, body: `Deletes the profile and ${observations(p.observations)}. Threads that pinned it go back to no profile.`, confirm: 'Delete profile', danger: true })

/** Shared loading, error and notice state for the profile views. */
function useProfiles() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const reload = async () => setProfiles(await getImageProfiles())
  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setError(''); setNotice('')
    try { await action(); await reload(); setNotice(message) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return { profiles, setProfiles, busy, error, setError, notice, run }
}

function ProfileEditor({ profile, busy, onSave, onCancel }: { profile?: ImageProfile; busy: boolean; onSave: (name: string, description: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(profile?.name ?? ''), [description, setDescription] = useState(profile?.description ?? '')
  return <div className="image-profile-editor">
    <label><span>Name</span><input value={name} maxLength={60} disabled={busy} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (name.trim()) onSave(name, description) } }} /></label>
    <label><span className="image-profile-label">Style preferences<span className="muted" aria-live="polite">{description.length} / {DESCRIPTION_MAX}</span></span><textarea value={description} maxLength={DESCRIPTION_MAX} rows={6} disabled={busy} onChange={(e) => setDescription(e.target.value)} placeholder="What you like and what to avoid." /></label>
    <div className="set-actions"><button type="button" className="btn btn-small btn-primary" disabled={busy || !name.trim()} onClick={() => onSave(name, description)}>Save profile</button><button type="button" className="btn btn-small" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </div>
}

function ProfileActions({ profile, busy, onEdit, onReset, onDelete }: { profile: Profile; busy: boolean; onEdit: () => void; onReset: () => void; onDelete: () => void }) {
  return <span className="image-profile-actions">
    <button type="button" className="btn btn-small" disabled={busy} onClick={onEdit} aria-label={`Edit ${profile.name}`}>Edit</button>
    <button type="button" className="btn btn-small" disabled={busy || !profile.observations} onClick={onReset} aria-label={`Reset observations for ${profile.name}`}>Reset</button>
    <button type="button" className="btn btn-small" disabled={busy} onClick={onDelete} aria-label={`Delete ${profile.name}`}>Delete</button>
  </span>
}

/** Settings → Agents → Images: every account profile, with create, edit, reset and delete. */
export function ImageProfileManager() {
  const { profiles, setProfiles, busy, error, setError, notice, run } = useProfiles()
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  useEffect(() => { getImageProfiles().then(setProfiles, (e: Error) => setError(e.message)) }, [])
  const save = (name: string, description: string) => void run(async () => { await saveImageProfile({ ...(editing === 'new' || editing === null ? {} : { id: editing }), name, description }); setEditing(null) }, 'Profile saved.')
  return <div className="image-profile-manager">
    {!profiles && !error && <p className="muted">Loading…</p>}
    {profiles && !profiles.length && editing !== 'new' && <p className="muted set-help">No profiles yet. The agent can suggest one, or create your own.</p>}
    {profiles && profiles.length > 0 && <ul className="set-list image-profile-list">{profiles.map((p) => <li key={p.id} className="set-row image-profile-row">
      {editing === p.id ? <ProfileEditor profile={p} busy={busy} onSave={save} onCancel={() => setEditing(null)} /> : <>
        <span className="set-row-text">
          <strong>{p.name}</strong>
          <span className="muted image-profile-meta"><span className={`image-origin is-${p.origin}`}>{originLabel(p)}</span> · {observations(p.observations)}</span>
          {p.description && <span className="muted image-profile-desc">{p.description}</span>}
        </span>
        <ProfileActions profile={p} busy={busy} onEdit={() => setEditing(p.id)} onReset={() => void (async () => { if (await confirmReset(p)) await run(() => deleteImageProfile(p.id, true), 'Observations reset. Preferences kept.') })()} onDelete={() => void (async () => { if (await confirmDelete(p)) await run(() => deleteImageProfile(p.id), 'Profile deleted.') })()} />
      </>}
    </li>)}</ul>}
    {editing === 'new' ? <ProfileEditor busy={busy} onSave={save} onCancel={() => setEditing(null)} /> : <div className="set-actions"><button type="button" className="btn btn-small" disabled={busy || !profiles} onClick={() => setEditing('new')}>New profile</button></div>}
    {error && <p role="alert" className="t-red copyable">{error}</p>}{notice && <p role="status" className="muted">{notice}</p>}
  </div>
}

/** A thread's Images dialog: pin one profile for this thread, with quick edits. */
export function ImageProfiles({ threadId }: { threadId: string }) {
  const { profiles, setProfiles, busy, error, setError, notice, run } = useProfiles()
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  useEffect(() => {
    let alive = true
    Promise.all([getImageProfiles(), getImageProfilePin(threadId)]).then(([all, pin]) => { if (alive) { setProfiles(all); setSelected(pin.profile?.id ?? null) } }, (e: Error) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [threadId])
  const profile = profiles?.find((p) => p.id === selected)
  const pin = (id: number | null) => void run(async () => { await pinImageProfile(threadId, id); setSelected(id) }, 'Saved for this thread.')
  const save = (name: string, description: string) => void run(async () => { const saved = await saveImageProfile({ ...(editing === 'new' || editing === null ? {} : { id: editing }), name, description }); await pinImageProfile(threadId, saved.id); setSelected(saved.id); setEditing(null) }, 'Profile saved and pinned.')
  return <section className="image-profile-settings" aria-label="Image style profile">
    <div className="image-config-label"><strong>Style profile</strong><span className="muted">Saved for this thread at once · manage all in Settings → Agents → Images</span></div>
    <div className="image-profile-pin">
      <Select<number> className="set-select" aria-label="Style profile for this thread" disabled={busy || !profiles} value={selected ?? 0} onChange={(id) => pin(id || null)} options={[{ value: 0, label: 'None · agent may choose per image' }, ...(profiles ?? []).map((p) => ({ value: p.id, label: p.name, note: p.origin === 'suggestion' ? 'suggested' : undefined }))]} />
      <button type="button" className="btn btn-small" disabled={busy || !profiles} onClick={() => setEditing('new')}>New</button>
    </div>
    {profile && editing !== profile.id && <div className="image-profile-current">
      <span className="muted image-profile-meta"><span className={`image-origin is-${profile.origin}`}>{originLabel(profile)}</span> · {observations(profile.observations)}{profile.description ? ` · ${profile.description}` : ''}</span>
      <ProfileActions profile={profile} busy={busy} onEdit={() => setEditing(profile.id)} onReset={() => void (async () => { if (await confirmReset(profile)) await run(() => deleteImageProfile(profile.id, true), 'Observations reset. Preferences kept.') })()} onDelete={() => void (async () => { if (await confirmDelete(profile)) await run(async () => { await deleteImageProfile(profile.id); setSelected(null) }, 'Profile deleted.') })()} />
    </div>}
    {editing !== null && <ProfileEditor key={String(editing)} profile={editing === 'new' ? undefined : profile} busy={busy} onSave={save} onCancel={() => setEditing(null)} />}
    {error && <p role="alert" className="t-red copyable">{error}</p>}{notice && <p role="status" className="muted">{notice}</p>}
  </section>
}
