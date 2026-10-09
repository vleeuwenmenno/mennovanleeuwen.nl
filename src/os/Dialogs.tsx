import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'

// The desktop's own dialogs, instead of the browser's confirm and alert: a question in the
// middle of the screen, the desktop dimmed behind it. One at a time; more wait their turn.
//
//   if (await ask({ title: 'Delete it?', body: '…', confirm: 'Delete', danger: true })) …
//   const choice = await choose({ title, body, buttons: [{ id: 'keep', label: 'Keep both' }, …] })

export type Button = { id: string; label: string; primary?: boolean; danger?: boolean }
type Dialog = { title: string; body?: ReactNode; buttons: Button[]; resolve: (id: string | null) => void }

let queue: Dialog[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Asks with buttons of your own; answers the chosen button's id, or null for Cancel / Escape. */
export function choose(d: { title: string; body?: ReactNode; buttons: Button[] }): Promise<string | null> {
  return new Promise((resolve) => {
    queue = [...queue, { ...d, resolve }]
    emit()
  })
}

/** A yes-or-no question: true when confirmed. */
export async function ask(d: { title: string; body?: ReactNode; confirm?: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  const id = await choose({
    title: d.title,
    body: d.body,
    buttons: [
      { id: 'cancel', label: d.cancel ?? 'Cancel' },
      { id: 'ok', label: d.confirm ?? 'OK', primary: !d.danger, danger: d.danger },
    ],
  })
  return id === 'ok'
}

/** Just telling: one button. */
export const tell = (d: { title: string; body?: ReactNode; ok?: string }) => choose({ title: d.title, body: d.body, buttons: [{ id: 'ok', label: d.ok ?? 'OK', primary: true }] }).then(() => undefined)

function answer(id: string | null) {
  const [first, ...rest] = queue
  if (!first) return
  queue = rest
  emit()
  first.resolve(id)
}

export function Dialogs() {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => queue[0] ?? null,
  )
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        answer(current.buttons.some((b) => b.id === 'cancel') ? 'cancel' : null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    // The safe button has the focus: Enter never deletes by accident.
    requestAnimationFrame(() => box.current?.querySelector<HTMLButtonElement>('[data-default]')?.focus())
    return () => window.removeEventListener('keydown', onKey, true)
  }, [current])
  if (!current) return null
  const safe = current.buttons.find((b) => b.primary && !b.danger) ?? current.buttons.find((b) => b.id === 'cancel') ?? current.buttons[0]
  return (
    <div className="dlg-modal" onPointerDown={(e) => e.target === e.currentTarget && answer('cancel')}>
      <div className="dlg" role="alertdialog" aria-modal="true" aria-label={current.title} ref={box}>
        <strong className="dlg-title">{current.title}</strong>
        {current.body && <div className="dlg-body">{current.body}</div>}
        <div className="dlg-actions">
          {current.buttons.map((b, i) => (
            <button key={b.id} className={`btn btn-small ${b.primary ? 'btn-primary' : ''} ${b.danger ? 'btn-danger' : ''} ${i === 0 && current.buttons.length > 2 ? 'dlg-first' : ''}`} data-default={b === safe ? '' : undefined} onClick={() => answer(b.id)}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
