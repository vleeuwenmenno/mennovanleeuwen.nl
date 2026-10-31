import type { ReactNode } from 'react'
import './platform.css'
export type StatusAction = { label: string; run: () => void }
/** One compact, themed state for everything that can go wrong with a widget installation: what
 * happened, whether anything was kept, and one or two buttons that do something about it. It
 * never fixes anything by itself; the person picks. */
export function StatusBanner({ code, tone = 'warn', message, actions, onDismiss }: { code: string; tone?: 'warn' | 'error'; message: ReactNode; actions?: StatusAction[]; onDismiss?: () => void }) {
  return <div className={`wp-banner is-${tone}`} role={tone === 'error' ? 'alert' : 'status'} data-recovery={code}>
    <span className="wp-banner-text">{message}</span>
    <span className="wp-banner-actions">
      {actions?.map(action => <button key={action.label} type="button" onClick={action.run}>{action.label}</button>)}
      {onDismiss && <button type="button" onClick={onDismiss}>Dismiss</button>}
    </span>
  </div>
}
