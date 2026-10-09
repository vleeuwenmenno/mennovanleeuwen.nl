import { useEffect, useMemo, useState } from 'react'
import { useWM, type WinState } from '../os/wm'
import { fileKind, formatSize, kindOfName, lookup, prettyPath, stat } from '../terminal/vfs'
import { isSf, libraryName, parseSf, sfPath, useFileLink } from '../data/seafile'

// Opens one file from the virtual filesystem: images are shown, text is shown as text, and the
// large stand-in files (ISOs, music, video) explain politely why they will not play.

const UNPLAYABLE: Record<string, string> = {
  audio: 'This is a FLAC from a filesystem that only exists in your browser. Omasoloist plays the real ones.',
  video: 'The codec for imaginary video has not been invented yet.',
  disc: 'Write it to a USB stick and boot a real machine. This one is a web page.',
  archive: 'Unpacking a pretend archive gives you a pretend folder. Saved you the trouble.',
  package: 'AppImages run on Linux, not inside a CV. Get Boltwarden from boltwarden.org.',
}

export function Viewer({ win }: { win: WinState }) {
  const path = win.props.path ?? ''
  return isSf(path) ? <SeafileViewer path={path} /> : <LocalViewer path={path} />
}

function LocalViewer({ path }: { path: string }) {
  const wm = useWM()
  const node = lookup(path)
  const kind = node ? fileKind(node) : 'file'
  const src = useMemo(() => (node?.type === 'file' && kind === 'image' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(node.content())}` : null), [node, kind])

  if (!node || node.type !== 'file') return <div className="viewer-empty muted">{path ? `${prettyPath(path)} no longer exists.` : 'Nothing to show.'}</div>
  const info = stat(path, node)

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <span className="viewer-path">{prettyPath(path)}</span>
        <span className="muted">{formatSize(info.size)}</span>
        <span className="spacer" />
        <button className="btn btn-small" onClick={() => wm.openNew('files', { path: path.split('/').slice(0, -1).join('/') || '/', select: path })}>
          Show in Files
        </button>
        {kind !== 'image' && !UNPLAYABLE[kind] && (
          <button className="btn btn-small" onClick={() => wm.openNew('terminal', { run: `cat ${prettyPath(path)}` })}>
            Open in terminal
          </button>
        )}
      </div>
      {src ? (
        <div className="viewer-image">
          <img src={src} alt={node.name} />
        </div>
      ) : UNPLAYABLE[kind] ? (
        <div className="viewer-empty">
          <p className="viewer-big">{node.name}</p>
          <p className="muted">{UNPLAYABLE[kind]}</p>
        </div>
      ) : (
        <pre className="viewer-text">{node.content()}</pre>
      )}
    </div>
  )
}

/** A file in Seafile, from its file server: pictures, video, audio, PDFs and (asked for) text. */
function SeafileViewer({ path }: { path: string }) {
  const wm = useWM()
  const at = parseSf(path)!
  const name = at.p.split('/').pop() ?? ''
  const kind = kindOfName(name)
  const { url, error, status } = useFileLink(path)
  const [text, setText] = useState<string | null>(null)
  const [pdf, setPdf] = useState<string | null>(null)
  const textual = !['image', 'video', 'audio', 'pdf'].includes(kind)
  // The file server sends files as attachments, which a frame would download: a PDF is shown from a blob.
  useEffect(() => {
    if (!url || kind !== 'pdf') return
    let live = true
    let blobUrl: string | null = null
    fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`Seafile answered ${r.status}`))))
      .then((b) => {
        if (!live) return
        blobUrl = URL.createObjectURL(new Blob([b], { type: 'application/pdf' }))
        setPdf(blobUrl)
      })
      .catch((e: Error) => live && setText(`Could not read it: ${e.message}`))
    return () => {
      live = false
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [url, kind])
  useEffect(() => {
    if (!url || !textual) return
    let live = true
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Seafile answered ${r.status}`))))
      .then((t) => live && setText(t.length > 2_000_000 ? t.slice(0, 2_000_000) + '\n…' : t))
      .catch((e: Error) => live && setText(`Could not read it: ${e.message}`))
    return () => {
      live = false
    }
  }, [url, textual])
  const folder = sfPath(at.repo, at.p.split('/').slice(0, -1).join('/') || '/')

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <span className="viewer-path">
          {libraryName(at.repo)}
          {at.p}
        </span>
        <span className="spacer" />
        <button className="btn btn-small" onClick={() => wm.openNew('files', { path: folder, select: path })}>
          Show in Files
        </button>
        {url && (
          <a className="btn btn-small" href={url} download={name} rel="noopener">
            Download
          </a>
        )}
      </div>
      {error ? (
        <div className="viewer-empty">
          <p className="viewer-big">{name}</p>
          <p className="muted">{status === 423 ? 'The library is locked: unlock it in Files first.' : error}</p>
        </div>
      ) : !url ? (
        <div className="viewer-empty muted">Loading…</div>
      ) : kind === 'image' ? (
        <div className="viewer-image">
          <img src={url} alt={name} />
        </div>
      ) : kind === 'video' ? (
        <div className="viewer-image">
          <video src={url} controls autoPlay />
        </div>
      ) : kind === 'audio' ? (
        <div className="viewer-empty">
          <p className="viewer-big">{name}</p>
          <audio src={url} controls autoPlay />
        </div>
      ) : kind === 'pdf' ? (
        pdf ? <iframe className="viewer-frame" src={pdf} title={name} /> : <div className="viewer-empty muted">{text ?? 'Loading…'}</div>
      ) : (
        <pre className="viewer-text">{text ?? 'Loading…'}</pre>
      )}
    </div>
  )
}
