import { headlines, profile } from '../data/profile'
import { useWM } from '../os/wm'

export function Notes() {
  const wm = useWM()
  return (
    <div className="note">
      <p className="note-hello">Hi, I'm {profile.name.split(' ')[0]} 👋</p>
      <ul className="note-list">
        {headlines.map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
      <p className="note-footer">
        psst, the terminal works →{' '}
        <button className="note-link" onClick={() => wm.open('terminal', { run: 'help' })}>
          try <code>help</code>
        </button>
      </p>
    </div>
  )
}
