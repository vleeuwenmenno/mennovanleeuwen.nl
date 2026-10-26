import { useLayoutEffect, useRef } from 'react'
import type { Hint } from './types'

// The row of suggestions above a phone's keyboard (touch screens only): what Tab would offer for
// the word being typed, as chips to tap, so nothing has to be typed out in full or reached through
// a Tab key that is not there. The shell's come from its own completion (commands, folders, files),
// a program's (agents: slash commands, #LoRA, $skill, @tool, @./path and `!` commands) through
// `Ctx.setHints`. Tapping one does what Tab does with it.
//
// Like the extra keys it never takes the focus: the prompt keeps the keyboard up.

/** The chips, one line that scrolls sideways. */
export function HintBar({ hints }: { hints: Hint[] }) {
  const row = useRef<HTMLDivElement>(null)
  // A new set of suggestions starts from its first chip again.
  const first = hints[0]?.label
  useLayoutEffect(() => {
    if (row.current) row.current.scrollLeft = 0
  }, [first])
  return (
    <div className="t-hints" role="toolbar" aria-label="Suggestions" data-no-touch-menu ref={row} onContextMenu={(e) => e.preventDefault()}>
      {hints.map((h, i) => (
        <button
          key={`${i}:${h.label}`}
          type="button"
          tabIndex={-1}
          className="t-hint"
          title={h.hint}
          // The prompt keeps the focus, so the keyboard stays up.
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={h.apply}
        >
          {h.label}
        </button>
      ))}
    </div>
  )
}

/** Whether two lists would show the same chips (what they do is looked up again when tapped). */
export const sameHints = (a: Hint[], b: Hint[]) => a.length === b.length && a.every((h, i) => h.label === b[i].label)
