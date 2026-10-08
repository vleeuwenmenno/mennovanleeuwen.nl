import { DESKTOP_ICONS } from '../os/Desktop'
import { restoreIcons, useDesktop } from '../os/desktopStore'

const items = [
  { name: 'kubernetes-for-my-blog.yaml', note: 'It was one static page.' },
  { name: 'salt-states-v1/', note: 'Replaced by Pepper. No regrets.' },
  { name: 'electron-spotify-config.json', note: '1.4 GB of RAM to play a song.' },
  { name: 'TODO-final-FINAL-v3.md', note: 'Still not final.' },
  { name: 'works-on-my-machine.iso', note: 'Archived for historical reasons.' },
]

export function Trash() {
  const desk = useDesktop()
  const trashed = DESKTOP_ICONS.filter((i) => desk.trashed.includes(i.id))
  return (
    <div className="trash">
      <p className="muted pad-sm">
        {items.length + trashed.length} items · emptying is disabled, these are cautionary tales
        {trashed.length > 1 && (
          <button className="btn btn-small trash-restore-all" onClick={() => restoreIcons(trashed.map((i) => i.id))}>
            Put back all
          </button>
        )}
      </p>
      <ul>
        {trashed.map((i) => (
          <li key={i.id} className="trash-desk">
            <span className="trash-icon">{i.image ? <img src={i.image} alt="" width={18} height={18} /> : i.glyph}</span>
            <span className="trash-name">{desk.names[i.id] ?? i.label}</span>
            <button className="btn btn-small" onClick={() => restoreIcons([i.id])}>
              Put back
            </button>
          </li>
        ))}
        {items.map((i) => (
          <li key={i.name}>
            <span className="trash-icon">{i.name.endsWith('/') ? '📁' : '📄'}</span>
            <span className="trash-name">{i.name}</span>
            <span className="muted">{i.note}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
