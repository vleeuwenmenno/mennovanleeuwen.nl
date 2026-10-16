import type { ReactNode } from 'react'
import type { GitPerson, GitState, Label } from '../../data/gitTypes'
import { timeAgo } from '../../data/recents'

// Small pieces the Git app's views share.

export const ago = (iso: string | null | undefined) => (iso ? timeAgo(iso) : '')

export const fullDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '')

/** The arrow-out-of-a-box that says "this leaves MvL OS for the web". */
export const ExtIcon = () => (
  <svg className="git-ext-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 2h5v5" />
    <path d="M14 2L7.5 8.5" />
    <path d="M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" />
  </svg>
)

/** A link out to the host's web page, marked as one. Everything the app doesn't do itself goes here. */
export function ExtLink({ href, label, small = false, title }: { href: string; label: string; small?: boolean; title?: string }) {
  return (
    <a className={`git-btn git-ext ${small ? 'is-small' : ''}`} href={href} target="_blank" rel="noopener noreferrer" title={title ?? `${label} (opens the web page)`}>
      <span>{label}</span>
      <ExtIcon />
    </a>
  )
}

export function StateBadge({ state, draft }: { state: GitState; draft?: boolean }) {
  const label = draft && state === 'open' ? 'Draft' : state === 'open' ? 'Open' : state === 'merged' ? 'Merged' : 'Closed'
  return (
    <span className={`git-state is-${draft && state === 'open' ? 'draft' : state}`}>
      {label}
    </span>
  )
}

export function Avatar({ p, size = 20 }: { p: GitPerson | null; size?: number }) {
  const name = p?.login ?? p?.name ?? '?'
  return p?.avatar ? (
    <img className="git-avatar" src={p.avatar} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <span className="git-avatar is-letter" style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

export const who = (p: GitPerson | null) => p?.login ?? p?.name ?? 'someone'

export function Labels({ labels }: { labels: Label[] }) {
  if (!labels.length) return null
  return (
    <span className="git-labels">
      {labels.map((l) => (
        <span key={l.name} className="git-label" style={{ ['--label' as string]: l.color }}>
          {l.name}
        </span>
      ))}
    </span>
  )
}

export function Loading({ what }: { what: string }) {
  return <p className="git-pad muted">Loading {what}…</p>
}

export function ErrorBox({ error, onRetry, web, hostLabel }: { error: string; onRetry?: () => void; web?: string; hostLabel?: string }) {
  return (
    <div className="git-pad git-error" role="alert">
      <p>{error}</p>
      <p className="git-row-actions">
        {onRetry && (
          <button className="git-btn" onClick={onRetry}>
            Try again
          </button>
        )}
        {web && <ExtLink href={web} label={`Open on ${hostLabel ?? 'the web'}`} />}
      </p>
    </div>
  )
}

/** Tabs (or a filter): buttons in a row that scrolls sideways on a narrow screen. */
export function Tabs<T extends string>({ value, options, onChange, small = false }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className={`git-tabs ${small ? 'is-small' : ''}`} role="tablist">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} className={value === o.id ? 'is-on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function MoreButton({ next, loading, error, onMore }: { next: number | null; loading: boolean; error: string | null; onMore: () => void }) {
  if (error) return <ErrorBox error={error} onRetry={onMore} />
  if (next === null) return null
  return (
    <div className="git-more">
      <button className="git-btn" disabled={loading} onClick={onMore}>
        {loading ? 'Loading…' : 'Load more'}
      </button>
    </div>
  )
}

/** Copies text, quietly: the button says it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
