import { useEffect, useRef } from 'react'
import { useIsMobile } from '../os/useIsMobile'
import { FONT_DEFAULT, FONT_MAX, FONT_MIN, setTerminalPrefs, useTerminalPrefs, type TerminalPrefs } from './prefs'

/** A size in px with − and + on either side, and its default a click away. */
function Stepper({ value, onChange, label }: { value: number; onChange: (px: number) => void; label: string }) {
  return (
    <span className="t-stepper" role="group" aria-label={label}>
      <button type="button" className="btn btn-small" aria-label={`${label} smaller`} disabled={value <= FONT_MIN} onClick={() => onChange(value - 1)}>
        −
      </button>
      <output aria-live="polite">{value} px</output>
      <button type="button" className="btn btn-small" aria-label={`${label} larger`} disabled={value >= FONT_MAX} onClick={() => onChange(value + 1)}>
        +
      </button>
      <button type="button" className="btn btn-small btn-ghost" disabled={value === FONT_DEFAULT} onClick={() => onChange(FONT_DEFAULT)}>
        Default
      </button>
    </span>
  )
}

/**
 * The Terminal's settings, as a sheet over its own window: text size per kind of screen, this
 * window's zoom, and the extra keys on touch screens. Changes apply as they are made.
 */
export function TerminalSettings({ zoom, onZoom, onClose, onAppearance }: { zoom: number; onZoom: (z: number | 'in' | 'out') => void; onClose: () => void; onAppearance: () => void }) {
  const prefs = useTerminalPrefs()
  const mobile = useIsMobile()
  const sheet = useRef<HTMLDivElement>(null)
  const size = (key: keyof Pick<TerminalPrefs, 'fontDesktop' | 'fontMobile'>) => (px: number) => setTerminalPrefs({ [key]: px })

  // The sheet itself takes the focus, so Escape closes it. Not its close button: the Enter that
  // ran `settings` would go on to press it.
  useEffect(() => sheet.current?.focus({ preventScroll: true }), [])

  return (
    <div className="t-sheet-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="t-sheet"
        role="dialog"
        aria-label="Terminal settings"
        ref={sheet}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }}
      >
        <div className="t-sheet-head">
          <strong>Terminal settings</strong>
          <button type="button" className="t-sheet-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <section className="set-section">
          <h4>Text size</h4>
          <ul className="set-list">
            <li className="set-row">
              <span className="set-row-text">
                <strong>Desktop</strong>
                <span className="muted">{mobile ? 'Wider screens' : 'In use on this screen'}</span>
              </span>
              <Stepper label="Desktop text size" value={prefs.fontDesktop} onChange={size('fontDesktop')} />
            </li>
            <li className="set-row">
              <span className="set-row-text">
                <strong>Phone</strong>
                <span className="muted">{mobile ? 'In use on this screen' : 'Narrow screens, like phones'}</span>
              </span>
              <Stepper label="Phone text size" value={prefs.fontMobile} onChange={size('fontMobile')} />
            </li>
          </ul>
          <p className="muted set-help">Every terminal window uses these. Synced when signed in.</p>
        </section>

        <section className="set-section">
          <h4>Zoom</h4>
          <div className="t-zoom-row">
            <span className="t-stepper" role="group" aria-label="Zoom">
              <button type="button" className="btn btn-small" aria-label="Zoom out" onClick={() => onZoom('out')}>
                −
              </button>
              <output aria-live="polite">{Math.round(zoom * 100)}%</output>
              <button type="button" className="btn btn-small" aria-label="Zoom in" onClick={() => onZoom('in')}>
                +
              </button>
              <button type="button" className="btn btn-small btn-ghost" disabled={zoom === 1} onClick={() => onZoom(1)}>
                Reset
              </button>
            </span>
          </div>
          <p className="muted set-help">Only this window, until it closes. Ctrl + / − / 0, Ctrl with the scroll wheel, or pinch with two fingers on a touch screen.</p>
        </section>

        <section className="set-section">
          <h4>Touch screens</h4>
          <label className="set-check">
            <input type="checkbox" checked={prefs.extraKeys} onChange={(e) => setTerminalPrefs({ extraKeys: e.target.checked })} />
            Extra keys above the keyboard: Esc, Tab, Ctrl, Alt, Shift, arrows
          </label>
          <p className="muted set-help">Tap Ctrl, Alt or Shift for the next key, tap twice to lock it, or hold it while you type.</p>
        </section>

        <section className="set-section">
          <h4>Colours</h4>
          <p className="muted set-help">The terminal follows the desktop's theme and accent (also with the theme command).</p>
          <button type="button" className="btn btn-small" onClick={onAppearance}>
            Open Appearance settings
          </button>
        </section>
      </div>
    </div>
  )
}
