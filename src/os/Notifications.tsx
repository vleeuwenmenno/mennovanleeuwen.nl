import { dismiss, useNotices } from './notify'

/** The notification stack. Click one to dismiss it. */
export function Notifications() {
  const notices = useNotices()
  if (!notices.length) return null
  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map((n) => (
        <button key={n.id} className="notice" onClick={() => dismiss(n.id)}>
          {n.icon && <img src={n.icon} alt="" width={32} height={32} className="notice-icon" />}
          <span className="notice-text">
            <strong>{n.title}</strong>
            {n.body && <span className="muted">{n.body}</span>}
          </span>
        </button>
      ))}
    </div>
  )
}
