import { useMemo } from 'react'
import { useWM, type WinState } from '../os/wm'
import { fileKind, formatSize, lookup, prettyPath, stat } from '../terminal/vfs'

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
  const wm = useWM()
  const path = win.props.path ?? ''
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
