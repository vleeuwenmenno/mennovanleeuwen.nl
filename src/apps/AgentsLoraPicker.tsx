import { useState } from 'react'
import { fileSize } from '../data/agents'
import { loraPreviewUrl, type LoraDetail } from '../data/agentImages'

// The composer's # picker, per LoRA: a row that reads at a glance (its own title, the folder
// dimmed, the base model short) and the detail for the highlighted one: its preview, base model,
// trigger words, tags, folder and size. Beside the list on a wide screen, under the row on a phone.
// Facts come from LoRA Manager when ComfyUI has it (server/agentLoraPreview.ts); without it, from
// the file name alone, and the picture is a plain placeholder.

/** The row: title, folder, base model. The token it inserts stays the installed name. */
export function LoraRow({ lora }: { lora: LoraDetail }) {
  return <span className="agt-lora-row">
    <b className="agt-lora-title">{lora.title || lora.name}</b>
    {lora.folder && <span className="muted agt-lora-folder">{lora.folder}</span>}
    {lora.baseModel && <span className="agt-lora-base" title={lora.baseModel}>{lora.baseModel}</span>}
  </span>
}

function Preview({ lora }: { lora: LoraDetail }) {
  const [broken, setBroken] = useState(false)
  if (!lora.hasPreview || broken) return <div className="agt-lora-thumb is-empty" aria-hidden>No preview</div>
  return <img className="agt-lora-thumb" src={loraPreviewUrl(lora.name)} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} />
}

const Chips = ({ list, empty }: { list: string[]; empty: string }) =>
  list.length ? <span className="agt-lora-chips">{list.map((w) => <span key={w} className="agt-lora-chip">{w}</span>)}</span> : <span className="muted">{empty}</span>

/** The highlighted LoRA in full. `manager`: whether LoRA Manager answered at all. */
export function LoraDetailPane({ lora, manager, onUse }: { lora: LoraDetail; manager: boolean; /** A button to insert it (the phone's expanded row) */ onUse?: () => void }) {
  return <div className="agt-lora-pane" aria-live="polite">
    <Preview key={lora.name} lora={lora} />
    <div className="agt-lora-facts">
      <strong className="agt-lora-pane-title">{lora.title || lora.name}</strong>
      <code className="agt-lora-name">#{lora.name}</code>
      <dl>
        <dt>Base model</dt><dd>{lora.baseModel || <span className="muted">Unknown</span>}</dd>
        <dt>Trigger words</dt><dd><Chips list={lora.triggers} empty="No trigger words recorded" /></dd>
        {lora.tags.length > 0 && <><dt>Tags</dt><dd><Chips list={lora.tags} empty="" /></dd></>}
        <dt>Folder</dt><dd>{lora.folder || <span className="muted">Top level</span>}</dd>
        {lora.size !== null && <><dt>Size</dt><dd>{fileSize(lora.size)}</dd></>}
      </dl>
      {!manager && <p className="muted agt-lora-note">Only the file name is known: LoRA Manager on ComfyUI adds previews and trigger words.</p>}
      {onUse && <button type="button" className="btn btn-small agt-lora-use" onMouseDown={(e) => e.preventDefault()} onClick={onUse}>Use #{lora.title || lora.name}</button>}
    </div>
  </div>
}
