import { useEffect, useState } from 'react'
import { FAMILY_LABEL, missingVideoModels, VIDEO_FAMILIES, type VideoCatalog, type VideoFamily, type VideoModelChoice, type VideoModelSettings } from '../../data/videoModels'
import { getVideoCatalog, saveVideoModels } from '../../data/videoStudio'
import { Select } from '../../os/Select'
import { useWM } from '../../os/wm'

// Settings → Image & Video Studio → Video: which files each video model runs with, from what the
// account's ComfyUI has installed. Left on Automatic, a file whose name says the family is used.

const FIELDS: [keyof VideoModelChoice, string, keyof VideoCatalog, VideoFamily[]][] = [
  ['model', 'Video model', 'models', ['minimax_h3', 'ltx25']],
  ['clip', 'Text encoder', 'clips', ['minimax_h3', 'ltx25']],
  ['videoVae', 'Video VAE', 'vaes', ['minimax_h3', 'ltx25']],
  ['audioVae', 'Audio VAE', 'vaes', ['minimax_h3', 'ltx25']],
  ['turboLora', 'Turbo LoRA (optional)', 'loras', ['minimax_h3']],
  ['latentUpscaler', 'Latent upscaler', 'latentUpscalers', ['ltx25']],
]

export function VideoSettings({ connected }: { connected: boolean }) {
  const wm = useWM()
  const [data, setData] = useState<{ catalog: VideoCatalog; chosen: VideoModelSettings; resolved: Record<VideoFamily, VideoModelChoice> } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = (fresh = false) => getVideoCatalog(fresh).then((d) => (setData(d), setError('')), (e: Error) => setError(e.message))
  useEffect(() => {
    if (connected) void load()
  }, [connected])
  const pick = async (family: VideoFamily, field: keyof VideoModelChoice, value: string) => {
    try {
      await saveVideoModels({ [family]: { [field]: value } })
      setNotice('Saved')
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <section className="set-section image-group" aria-labelledby="video-models">
      <h4 className="set-subhead" id="video-models">Video</h4>
      <p className="muted set-help">The Video Studio renders with MiniMax H3 (5–15 s, a first and a last frame) or LTX 2.5 Distilled (1–15 s, a first frame) on the same ComfyUI. Pick the files each one uses; Automatic takes an installed file whose name says the model. Agents can plan a video for you; every render they start asks you first.</p>
      {!connected && <p className="muted">Connect ComfyUI above first.</p>}
      {error && <p className="t-red copyable" role="alert">{error}</p>}
      {connected && !data && !error && <p className="muted">Reading ComfyUI…</p>}
      {data && VIDEO_FAMILIES.map((f) => {
        const status = data.catalog.families[f]
        const missing = status.ok ? missingVideoModels(f, data.resolved[f]) : null
        return (
          <div key={f} className="video-family">
            <strong>{FAMILY_LABEL[f]}</strong> <span className={status.ok && !missing ? 't-green' : 't-yellow'}>{status.ok ? (missing ? 'files missing' : 'ready') : status.error}</span>
            {status.ok && (
              <ul className="set-list">
                {FIELDS.filter(([, , , fams]) => fams.includes(f)).map(([field, label, list]) => (
                  <li key={field} className="set-row">
                    <span className="set-row-text"><strong>{label}</strong><span className="muted">{data.chosen[f][field] ? 'Picked' : `Automatic${data.resolved[f][field] ? `: ${data.resolved[f][field]}` : ': none found'}`}</span></span>
                    <Select className="set-select" aria-label={`${FAMILY_LABEL[f]} ${label}`} value={data.chosen[f][field]} onChange={(v) => void pick(f, field, v)} options={[{ value: '', label: 'Automatic' }, ...((data.catalog[list] as string[]) ?? []).map((n) => ({ value: n, label: n.split(/[\\/]/).at(-1) ?? n, note: n }))]} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
      <div className="set-actions">
        {connected && <button type="button" className="btn btn-small" onClick={() => void load(true)}>Check ComfyUI again</button>}
        <button type="button" className="btn btn-small" onClick={() => wm.open('videostudio', { t: String(Date.now()) })}>Open Video Studio</button>
        {notice && <span className="muted" role="status">{notice}</span>}
      </div>
    </section>
  )
}
