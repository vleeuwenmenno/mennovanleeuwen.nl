import type { MouseEventHandler, ReactNode } from 'react'
import { Icon } from './icons'
import type { IconName } from './package'
import './platform.css'

/** One small icon button of the widget toolbar. The label stays in the DOM (screen readers, tests, search) and in the tooltip. */
export function ToolButton({ icon, label, title, aria, onClick, expanded }: { icon: IconName; label: string; title?: string; aria?: string; onClick: MouseEventHandler<HTMLButtonElement>; expanded?: boolean }) {
  return <button type="button" className="wp-tool" title={title ?? label} aria-label={aria} aria-expanded={expanded} onClick={onClick}><Icon name={icon} /><span className="wp-sr">{label}</span></button>
}
export const Toolbar = ({ children, open }: { children: ReactNode; open?: boolean }) => <div className="wp-tools" role="toolbar" aria-label="Widget controls" data-open={open ? '' : undefined}>{children}</div>

/** "‹ 2/5 ›": the host-owned page control, shown only when there is more than one page. */
export function Pager({ page, pages, label, detail, previous, next }: { page: number; pages?: number; label: string; detail?: string; previous: { text: string; run: () => void; disabled: boolean }; next: { text: string; run: () => void; disabled: boolean } }) {
  if ((pages === undefined || pages <= 1) && previous.disabled && next.disabled) return null
  return <div className="wp-pager" role="group" aria-label={label}>
    <button type="button" title={previous.text} disabled={previous.disabled} onClick={previous.run}><Icon name="chevron-left" /><span className="wp-sr">{previous.text}</span></button>
    <span title={detail} aria-live="polite">{pages === undefined ? page : `${page}/${pages}`}</span>
    <button type="button" title={next.text} disabled={next.disabled} onClick={next.run}><Icon name="chevron-right" /><span className="wp-sr">{next.text}</span></button>
  </div>
}
