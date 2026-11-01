import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Select, type SelectOption } from '../os/Select'
import './XedAgentsDock.css'

// The frame Xed's Agents panel lives in: a header (title, the thread switch, new thread, open in
// Agents, close) around whatever pane the parent hands in as `children`. The frame knows nothing
// about conversations. Xed (Zed.tsx) decides where it goes (docked beside the editor, or a sheet
// over it) and mounts it on first use; after that it stays mounted when hidden, so a running
// conversation and its draft survive a toggle. A hidden frame is `hidden` and `inert`.
//
// What the pane in `children` should do: mark its message box `data-xed-composer` (Ctrl+L focuses
// it, and Escape in it returns to the editor, unless the pane handles that Escape itself and
// prevents the default).

export type XedAgentsDockHandle = {
  /** Moves focus to the message box, or the frame when the pane has none. */
  focus: () => void
}

type Props = {
  /** Over the editor with a close shadow, instead of docked in its own column. */
  sheet: boolean
  hidden: boolean
  onClose: () => void
  /** Escape in the message box: Xed puts the cursor back in the editor. */
  onEscape: () => void
  title?: string
  /** The thread switch: omitted, the header shows only the title. */
  threads?: SelectOption<string>[]
  thread?: string | null
  onThread?: (id: string) => void
  onNew?: () => void
  onOpenInAgents?: () => void
  /** More header controls, between the thread switch and the buttons. */
  headerExtra?: ReactNode
  children: ReactNode
}

const COMPOSER = '[data-xed-composer]'
const TYPING = `${COMPOSER}, textarea, input, [contenteditable="true"]`

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
)

export const XedAgentsDock = forwardRef<XedAgentsDockHandle, Props>(function XedAgentsDock({ sheet, hidden, onClose, onEscape, title = 'Agents', threads, thread, onThread, onNew, onOpenInAgents, headerExtra, children }, ref) {
  const frame = useRef<HTMLElement>(null)
  useImperativeHandle(ref, () => ({
    focus: () => {
      const el = frame.current
      if (!el) return
      const target = el.querySelector<HTMLElement>(COMPOSER) ?? el.querySelector<HTMLElement>('textarea, [contenteditable="true"]') ?? el
      target.focus({ preventScroll: true })
    },
  }))

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
    if (!(e.target as HTMLElement).closest(TYPING)) return
    e.preventDefault()
    e.stopPropagation()
    onEscape()
  }

  return (
    <aside ref={frame} className={`xed-agents ${sheet ? 'is-sheet' : ''}`} aria-label={title} hidden={hidden} inert={hidden} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="xed-agents-head">
        <span className="xed-agents-title">{title}</span>
        {threads && threads.length > 0 && onThread && <Select className="xed-agents-threads" value={thread} options={threads} onChange={onThread} aria-label="Thread" />}
        <span className="spacer" />
        {headerExtra}
        {onNew && (
          <button className="xed-agents-btn" onClick={onNew} title="New thread" aria-label="New thread">
            <Icon d="M8 3v10M3 8h10" />
          </button>
        )}
        {onOpenInAgents && (
          <button className="xed-agents-btn" onClick={onOpenInAgents} title="Open in Agents" aria-label="Open in Agents">
            <Icon d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
          </button>
        )}
        <button className="xed-agents-btn" onClick={onClose} title="Close (Esc in the message box returns to the editor)" aria-label="Close Agents panel">
          <Icon d="M4 4l8 8M12 4l-8 8" />
        </button>
      </header>
      <div className="xed-agents-body">{children}</div>
    </aside>
  )
})
