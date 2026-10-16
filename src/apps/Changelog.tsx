import { useEffect, useState } from 'react'
import { MarkdownPreview } from '../data/markdown/MarkdownPreview'
import { useChangelog, type Release } from '../data/changelog'
import { useIsMobile } from '../os/useIsMobile'

function formatDate(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function versionLabel(r: Release) {
  // Releases are named "MvL OS X.Y.Z"; fall back to the tag (vX.Y.Z).
  return r.name.replace(/^MvL OS\s+/i, '') || r.tag.replace(/^v/, '')
}

function ReleaseCard({ release, open, onToggle }: { release: Release; open: boolean; onToggle: () => void }) {
  const id = `cl-body-${release.id}`
  return (
    <article className={`cl-item ${open ? 'is-open' : ''}`}>
      <button type="button" className="cl-item-head" onClick={onToggle} aria-expanded={open} aria-controls={id}>
        <div className="cl-item-titles">
          <h3>
            {versionLabel(release)}
            {release.prerelease && <span className="cl-pre">Pre-release</span>}
          </h3>
          <p className="muted">
            <time dateTime={release.publishedAt}>{formatDate(release.publishedAt)}</time>
            <span> · {release.tag}</span>
          </p>
        </div>
        <span className="cl-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div id={id} className="cl-item-body">
          {release.body ? (
            <div className="zed-preview cl-md selectable">
              <MarkdownPreview text={release.body} />
            </div>
          ) : (
            <p className="muted">No release notes for this version.</p>
          )}
          <a className="cl-link" href={release.url} target="_blank" rel="noopener noreferrer">
            View on GitHub ↗
          </a>
        </div>
      )}
    </article>
  )
}

export function Changelog() {
  const { releases, status, error, refresh } = useChangelog()
  const mobile = useIsMobile()
  const [openId, setOpenId] = useState<number | null>(null)

  // Open the latest release once it arrives (or keep the user's pick if still present).
  useEffect(() => {
    if (!releases.length) return
    setOpenId((cur) => (cur !== null && releases.some((r) => r.id === cur) ? cur : releases[0].id))
  }, [releases])

  return (
    <div className={`cl ${mobile ? 'is-mobile' : ''}`}>
      <header className="cl-head">
        <div>
          <h2>Changelog</h2>
          <p className="muted">What changed in each MvL OS release</p>
        </div>
        <button type="button" className="btn btn-small" onClick={() => void refresh()} disabled={status === 'loading'}>
          {status === 'loading' ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      <div className="cl-list">
        {status === 'loading' && !releases.length && <p className="muted cl-pad">Fetching releases…</p>}
        {status === 'error' && !releases.length && (
          <div className="cl-pad">
            <p className="muted">Could not load releases{error ? ` (${error})` : ''}.</p>
            <button type="button" className="btn btn-small" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}
        {status === 'ready' && !releases.length && <p className="muted cl-pad">No releases yet.</p>}
        {releases.map((r) => (
          <ReleaseCard key={r.id} release={r} open={openId === r.id} onToggle={() => setOpenId((cur) => (cur === r.id ? null : r.id))} />
        ))}
      </div>
    </div>
  )
}
