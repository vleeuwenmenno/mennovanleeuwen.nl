import { dismiss, useNotices } from './notify'

/**
 * The notification stack. Clicking one runs its action, if it has one, and dismisses it; the ×
 * that shows on hover, or a right-click, just dismisses it.
 */
export function Notifications() {
  const notices = useNotices()
  if (!notices.length) return null
  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map((n) => (
        <div
          key={n.id}
          className="notice"
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            dismiss(n.id)
          }}
        >
          <button
            className="notice-main"
            onClick={() => {
              n.onClick?.()
              dismiss(n.id)
            }}
          >
            {n.icon && <img src={n.icon} alt="" width={32} height={32} className="notice-icon" />}
            <span className="notice-text">
              <strong>{n.title}</strong>
              {n.body && <span className="muted">{n.body}</span>}
            </span>
          </button>
          <button className="notice-close" onClick={() => dismiss(n.id)} aria-label="Dismiss notification" title="Dismiss">
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden stroke="currentColor" strokeWidth="1.6" strokeLinecap="square">
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
