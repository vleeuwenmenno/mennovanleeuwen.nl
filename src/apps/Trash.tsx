const items = [
  { name: 'kubernetes-for-my-blog.yaml', note: 'It was one static page.' },
  { name: 'salt-states-v1/', note: 'Replaced by Pepper. No regrets.' },
  { name: 'electron-spotify-config.json', note: '1.4 GB of RAM to play a song.' },
  { name: 'TODO-final-FINAL-v3.md', note: 'Still not final.' },
  { name: 'works-on-my-machine.iso', note: 'Archived for historical reasons.' },
]

export function Trash() {
  return (
    <div className="trash">
      <p className="muted pad-sm">{items.length} items · emptying is disabled, these are cautionary tales</p>
      <ul>
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
