import { useLayoutEffect } from 'react'
import { SHORTCUTS } from '../data/shortcuts'
import { useWM, type WinState } from '../os/wm'

const DOCK_SPACE = 96

/** A second sticky note, in blue, listing every shortcut. It scrolls; sticky notes are small. */
export function KeysNote({ win }: { win: WinState }) {
  const wm = useWM()

  // At boot it tucks itself just under the headline note, whose height depends on fonts and width.
  // Measured again once the handwriting font has loaded, since that changes the note's height.
  useLayoutEffect(() => {
    if (!win.props.under) return
    let done = false
    // Only give up (close) after the final measurement; the first one may use a fallback font.
    const place = (final: boolean) => {
      const note = document.querySelector<HTMLElement>('.window[data-app="notes"]')
      if (!note || done) return
      const y = note.offsetTop + note.offsetHeight - 16
      const h = Math.min(400, window.innerHeight - DOCK_SPACE - 14 - y)
      if (h >= 160) wm.setGeometry(win.pid, { y, h })
      else if (final) {
        done = true
        wm.close(win.pid)
      }
    }
    place(false)
    if (document.fonts) document.fonts.ready.then(() => place(true))
    else place(true)
    return () => {
      done = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="note keys-note">
      <p className="note-hello">Shortcuts ⌨</p>
      <div className="keys-scroll">
        {SHORTCUTS.map((group) => (
          <section key={group.area}>
            <p className="keys-area">{group.area}</p>
            <dl className="keys-list">
              {group.keys.map(([k, what]) => (
                <div key={k + what}>
                  <dt>
                    <Hint text={k} />
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  )
}

const MOUSE = /click|drag|hover/i

/** "Ctrl K / Esc" → keycaps; "Double-click title" → a mouse pill. */
function Hint({ text }: { text: string }) {
  const alternatives = text.split(' / ')
  return (
    <span className="hint">
      {alternatives.map((alt, i) => (
        <span key={alt} className="hint-alt">
          {i > 0 && <span className="hint-or">or</span>}
          {MOUSE.test(alt) ? (
            <span className="hint-mouse">
              <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="4" y="1.5" width="8" height="13" rx="4" />
                <path d="M8 1.5v4" />
              </svg>
              {alt}
            </span>
          ) : (
            alt.split(' ').map((key, j) => (
              <kbd key={key + j} className="hint-key">
                {key}
              </kbd>
            ))
          )}
        </span>
      ))}
    </span>
  )
}
