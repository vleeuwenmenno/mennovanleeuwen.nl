import { useEffect, useState } from 'react'
import { cancelAll, cancelUpload, clearFinished, retryFailed, retryUpload, targetName, useConflict, useUploads, type Upload } from '../data/uploads'
import { formatSize } from '../terminal/vfs'
import { formatTime } from '../data/media'
import { useWM } from './wm'

// The uploads panel, bottom right while anything uploads: the whole lot's progress and time left,
// and each file with its own bar and what happened to it (cancel, retry, show in Files). Folded
// down it is one line. Plus the question when names are already there.

export function Uploads() {
  const uploads = useUploads()
  const conflict = useConflict()
  const wm = useWM()
  const [folded, setFolded] = useState(false)
  const [hidden, setHidden] = useState(false)

  const active = uploads.filter((u) => u.status === 'queued' || u.status === 'uploading')
  // New uploads bring the panel back.
  useEffect(() => {
    if (active.length) setHidden(false)
  }, [active.length])

  const counted = uploads.filter((u) => u.status !== 'skipped' && u.status !== 'canceled')
  const total = counted.reduce((a, u) => a + u.size, 0)
  const loaded = counted.reduce((a, u) => a + (u.status === 'done' ? u.size : u.loaded), 0)
  const speed = uploads.reduce((a, u) => a + (u.status === 'uploading' ? u.speed : 0), 0)
  const left = speed > 0 ? (total - loaded) / speed : NaN
  const done = uploads.filter((u) => u.status === 'done').length
  const failed = uploads.filter((u) => u.status === 'failed').length
  const pct = total ? Math.round((loaded / total) * 100) : 100

  const show = (u: Upload) => wm.openNew('files', { path: u.rel ? `${u.target}/${u.rel}` : u.target, select: `${u.rel ? `${u.target}/${u.rel}` : u.target}/${u.name}` })

  return (
    <>
      {conflict && <ConflictDialog names={conflict.names} where={targetName(conflict.target)} answer={conflict.resolve} />}
      {uploads.length > 0 && !hidden && (
        <section className={`up ${folded ? 'is-folded' : ''}`} aria-label="Uploads">
          <header className="up-head">
            <button className="up-fold" onClick={() => setFolded(!folded)} aria-expanded={!folded} title={folded ? 'Show the uploads' : 'Fold'}>
              <span className={`up-caret ${folded ? '' : 'is-open'}`}>›</span>
              <span className="up-summary">
                <strong>{active.length ? `Uploading ${active.length} ${active.length === 1 ? 'file' : 'files'}` : failed ? `${failed} failed, ${done} uploaded` : `Uploaded ${done} ${done === 1 ? 'file' : 'files'}`}</strong>
                <span className="muted">
                  {formatSize(loaded)} of {formatSize(total)}
                  {active.length > 0 && isFinite(left) && ` · ${formatSize(speed)}/s · ${formatTime(left)} left`}
                </span>
              </span>
            </button>
            {!active.length && (
              <button className="up-x" onClick={() => (clearFinished(), setHidden(true))} aria-label="Close the uploads" title="Close">
                ×
              </button>
            )}
          </header>
          <div className="up-bar" aria-hidden>
            <div className={failed && !active.length ? 'is-failed' : ''} style={{ width: `${pct}%` }} />
          </div>
          {!folded && (
            <>
              <ul className="up-list">
                {[...uploads].reverse().map((u) => (
                  <li key={u.id} className={`up-item is-${u.status}`}>
                    <span className="up-name" title={`${u.rel ? `${u.rel}/` : ''}${u.name}`}>
                      {u.name}
                      <span className="muted"> → {u.rel ? u.rel.split('/').pop() : targetName(u.target)}</span>
                    </span>
                    <span className="up-state">
                      {u.status === 'uploading'
                        ? `${formatSize(u.loaded)} of ${formatSize(u.size)}${u.speed ? ` · ${formatSize(u.speed)}/s` : ''}`
                        : u.status === 'queued'
                          ? `Waiting · ${formatSize(u.size)}`
                          : u.status === 'done'
                            ? `Done · ${formatSize(u.size)}`
                            : u.status === 'failed'
                              ? u.error
                              : u.status === 'skipped'
                                ? 'Skipped: already there'
                                : 'Canceled'}
                    </span>
                    {(u.status === 'uploading' || u.status === 'queued') && (
                      <div className="up-item-bar">
                        <div style={{ width: `${u.size ? (u.loaded / u.size) * 100 : 0}%` }} />
                      </div>
                    )}
                    <span className="up-actions">
                      {(u.status === 'uploading' || u.status === 'queued') && (
                        <button onClick={() => cancelUpload(u.id)} aria-label={`Cancel ${u.name}`} title="Cancel">
                          ×
                        </button>
                      )}
                      {(u.status === 'failed' || u.status === 'canceled') && (
                        <button onClick={() => retryUpload(u.id)} aria-label={`Retry ${u.name}`} title="Try again">
                          ↻
                        </button>
                      )}
                      {u.status === 'done' && (
                        <button onClick={() => show(u)} aria-label={`Show ${u.name} in Files`} title="Show in Files">
                          ⌕
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <footer className="up-foot">
                {active.length > 0 && (
                  <button className="btn btn-small" onClick={cancelAll}>
                    Cancel all
                  </button>
                )}
                {failed > 0 && (
                  <button className="btn btn-small" onClick={retryFailed}>
                    Retry failed
                  </button>
                )}
                <span className="spacer" />
                {uploads.length > active.length && (
                  <button className="btn btn-small" onClick={clearFinished}>
                    Clear finished
                  </button>
                )}
              </footer>
            </>
          )}
        </section>
      )}
    </>
  )
}

function ConflictDialog({ names, where, answer }: { names: string[]; where: string; answer: (c: 'replace' | 'keep' | 'skip' | 'cancel') => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && answer('cancel')
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [answer])
  const one = names.length === 1
  return (
    <div className="up-modal" onPointerDown={(e) => e.target === e.currentTarget && answer('cancel')}>
      <div className="up-dialog" role="alertdialog" aria-label="Files already there">
        <strong>{one ? `“${names[0]}” is already in ${where}` : `${names.length} files are already in ${where}`}</strong>
        {!one && (
          <ul>
            {names.slice(0, 6).map((n) => (
              <li key={n}>{n}</li>
            ))}
            {names.length > 6 && <li className="muted">and {names.length - 6} more</li>}
          </ul>
        )}
        <p className="muted">Replace {one ? 'it' : 'them'} (Seafile keeps the old version in its history), keep both (the new {one ? 'one gets' : 'ones get'} “(1)”), or leave {one ? 'it' : 'them'} out?</p>
        <div className="up-dialog-actions">
          <button className="btn btn-small" onClick={() => answer('cancel')}>
            Cancel
          </button>
          <span className="spacer" />
          <button className="btn btn-small" onClick={() => answer('skip')}>
            Skip
          </button>
          <button className="btn btn-small" onClick={() => answer('keep')}>
            Keep both
          </button>
          <button className="btn btn-small btn-primary" autoFocus onClick={() => answer('replace')}>
            Replace
          </button>
        </div>
      </div>
    </div>
  )
}
