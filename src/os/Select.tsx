import { useRef, type KeyboardEvent } from 'react'
import { closeContextMenu, openMenuAt } from './ContextMenu'

export type SelectOption<T extends string | number> = {
  value: T
  label: string
  /** A second, smaller line under the label in the menu. */
  hint?: string
  /** Muted text on the right of the menu row, for details that would crowd the label. */
  note?: string
  disabled?: boolean
}

type Props<T extends string | number> = {
  value: T | null | undefined
  options: SelectOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
  /** Shown while no option matches the value. */
  placeholder?: string
  'aria-label'?: string
}

/**
 * A dropdown that opens the desktop's own menu instead of the browser's popup, which ignores the
 * theme. Controlled, like a native select: it shows `value` and reports picks through `onChange`.
 */
export function Select<T extends string | number>({ value, options, onChange, disabled, className, placeholder, 'aria-label': ariaLabel }: Props<T>) {
  const ref = useRef<HTMLButtonElement>(null)
  const selected = options.find((o) => o.value === value)
  // Like a native select, an unmatched value shows the first option unless there is a placeholder.
  const text = selected?.label ?? placeholder ?? options.find((o) => !o.disabled)?.label ?? ''

  const open = () => {
    const button = ref.current
    if (!button || disabled) return
    openMenuAt(
      button,
      options.map((o) => ({
        label: o.label,
        hint: o.hint,
        shortcut: o.note,
        disabled: o.disabled,
        checked: o.value === value,
        onSelect: () => {
          button.focus()
          if (o.value !== value) onChange(o.value)
        },
      })),
    )
    // The menu has no keyboard handling of its own, so put focus on the current choice and let
    // the arrow keys walk the rows; Enter and Space then pick through the row's own click.
    requestAnimationFrame(() => {
      const menu = document.querySelector<HTMLElement>('.ctx-menu')
      if (!menu || menu.dataset.select) return
      menu.dataset.select = '1'
      const rows = () => [...menu.querySelectorAll<HTMLButtonElement>('.ctx-item:not(:disabled)')]
      const start = options.filter((o) => !o.disabled).findIndex((o) => o.value === value)
      rows()[Math.max(0, start)]?.focus()
      menu.addEventListener('keydown', (e) => {
        const list = rows()
        const at = list.indexOf(document.activeElement as HTMLButtonElement)
        const go = (i: number) => (e.preventDefault(), list[(i + list.length) % list.length]?.focus())
        if (e.key === 'ArrowDown') go(at + 1)
        else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1)
        else if (e.key === 'Home') go(0)
        else if (e.key === 'End') go(list.length - 1)
        // The menu host closes on Escape, and Tab would leave focus on a menu that is about to
        // go, so both hand focus back to the button.
        else if (e.key === 'Escape') button.focus()
        else if (e.key === 'Tab') (e.preventDefault(), button.focus(), closeContextMenu())
      })
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      open()
    }
  }

  return (
    <button
      ref={ref}
      type="button"
      className={`ui-select ${className ?? ''}`}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup="menu"
      onClick={open}
      onKeyDown={onKeyDown}
    >
      <span className="ui-select-label">{text}</span>
      <svg className="ui-select-chev" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
        <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  )
}
