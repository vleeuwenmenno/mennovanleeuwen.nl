import { useEffect, useState } from 'react'
import './XedAgentsPane.css'

// THE INTEGRATION SEAM. Xed (Zed.tsx) renders exactly one of these inside <XedAgentsDock>, and
// this file is what the real Agents conversation replaces: keep the props, swap the body.
//
// - `root`: the project folder Xed has open, for the conversation's working folder.
// - `attach`: a request to attach something from the editor. Ctrl+L makes one each time (a new `id`)
//   with the selected text and its lines, or just the file when nothing is selected. Act on each
//   id once, when it changes (it is null until the first Ctrl+L).
// - `onFocusEditor`: give the cursor back to the editor (the dock does this on Escape already).
// - The message box carries `data-xed-composer`, which is how Ctrl+L finds it to focus.
//
// Until then it only lists what was attached and has a plain message box, so the layout around it
// can be used and tested.

/** What Ctrl+L attaches. `startLine` and `endLine` count from 1; `text` is the selection. */
export type XedAttachment = { id: number; path: string; text?: string; startLine?: number; endLine?: number }

export type XedAgentsPaneProps = {
  root: string
  attach: XedAttachment | null
  onFocusEditor: () => void
}

export function XedAgentsPane({ attach }: XedAgentsPaneProps) {
  const [attached, setAttached] = useState<XedAttachment[]>([])
  useEffect(() => {
    if (attach) setAttached((a) => [...a.filter((x) => x.id !== attach.id), attach])
  }, [attach])
  return (
    <div className="xed-pane">
      <div className="xed-pane-log">
        {attached.length === 0 && <p className="muted">Select code and press Ctrl+L to attach it.</p>}
        {attached.map((a) => (
          <div key={a.id} className="xed-pane-chip" title={a.text}>
            {a.path}
            {a.startLine !== undefined && ` (${a.startLine === a.endLine ? a.startLine : `${a.startLine}-${a.endLine}`})`}
          </div>
        ))}
      </div>
      <textarea className="xed-pane-composer" data-xed-composer placeholder="Message the agent…" aria-label="Message the agent" rows={3} />
    </div>
  )
}
