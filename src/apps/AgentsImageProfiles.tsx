import { useEffect, useState } from 'react'
import { getImageProfiles, getImageProfilePin, pinImageProfile, saveImageProfile, deleteImageProfile, type ImageProfile } from '../data/agentImages'

/** Profiles organize evidence, not hidden overrides of the user's model settings. */
export function ImageProfiles({ threadId }: { threadId: string }) {
  const [profiles, setProfiles] = useState<ImageProfile[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [name, setName] = useState(''), [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  useEffect(() => {
    let alive = true
    Promise.all([getImageProfiles(), getImageProfilePin(threadId)]).then(([all, pin]) => { if (alive) { setProfiles(all); setSelected(pin.profile?.id ?? null) } }, (e: Error) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [threadId])
  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setError(''); setNotice('')
    try { await action(); setProfiles(await getImageProfiles()); setNotice(message) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const profile = profiles.find((p) => p.id === selected)
  const edit = (p?: ImageProfile) => { setEditing(p?.id ?? 'new'); setName(p?.name ?? ''); setDescription(p?.description ?? '') }
  return <section className="image-profile-settings" aria-label="Image style profiles">
    <div className="image-config-label"><label htmlFor="image-profile-pin">Style profile</label><span className="muted">Saved for this session immediately</span></div>
    <select id="image-profile-pin" value={selected ?? ''} disabled={busy} onChange={(e) => { const id = e.target.value ? Number(e.target.value) : null; void run(async () => { await pinImageProfile(threadId, id); setSelected(id) }, 'Session profile saved.') }}>
      <option value="">No pinned profile · agent may choose per image</option>
      {profiles.map((p) => <option value={p.id} key={p.id}>{p.name}{p.origin === 'suggestion' ? ' (suggested)' : ''}</option>)}
    </select>
    <p className="muted">Profiles remember style preferences and separate model recipes. Evidence guides the agent; your explicit requests and manual model settings stay in control. Inspect or forget observations in Memory → Images.</p>
    {profile && <p className="copyable">{profile.description || 'No style preferences recorded yet.'}</p>}
    <div className="image-profile-actions">
      <button type="button" className="btn btn-small" disabled={busy} onClick={() => edit()}>New profile</button>
      {profile && <><button type="button" className="btn btn-small" disabled={busy} onClick={() => edit(profile)}>Edit / rename</button><button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(() => deleteImageProfile(profile.id, true), 'Profile observations reset. Preferences kept.')}>Reset observations</button><button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(async () => { await deleteImageProfile(profile.id); setSelected(null); setEditing(null) }, 'Profile and its observations deleted.')}>Delete profile + observations</button></>}
    </div>
    {editing !== null && <div className="image-profile-editor">
      <label>Profile name<input value={name} maxLength={60} disabled={busy} onChange={(e) => setName(e.target.value)} /></label>
      <label>Style preferences<textarea value={description} maxLength={400} rows={3} disabled={busy} onChange={(e) => setDescription(e.target.value)} placeholder="Describe what you like and what to avoid. Settings evidence is recorded separately." /></label>
      <div className="image-profile-actions"><button type="button" className="btn btn-small" disabled={busy || !name.trim()} onClick={() => void run(async () => { const saved = await saveImageProfile({ ...(editing === 'new' ? {} : { id: editing }), name, description }); await pinImageProfile(threadId, saved.id); setSelected(saved.id); setEditing(null) }, 'Profile saved and selected. Preferences are user-confirmed.')}>Save profile</button><button type="button" className="btn btn-small" disabled={busy} onClick={() => setEditing(null)}>Cancel edit</button></div>
    </div>}
    {error && <p role="alert" className="t-red">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>
}
