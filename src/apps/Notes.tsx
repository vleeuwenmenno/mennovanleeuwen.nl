import { headlines, profile } from '../data/profile'
import { signIn, useAccount } from '../os/account'
import { cvMode } from '../os/cvMode'
import { useWM } from '../os/wm'

/** The sticky note on the desktop: Menno's headlines at /cv, a welcome to MvL OS everywhere else. */
export function Notes() {
  return cvMode() ? <Headlines /> : <Welcome />
}

function Headlines() {
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

function Welcome() {
  const wm = useWM()
  const account = useAccount()
  const u = account.user
  return (
    <div className="note">
      <p className="note-hello">{u ? `Hi, ${(u.name ?? u.login).split(' ')[0]} 👋` : 'Welcome to MvL OS 👋'}</p>
      <ul className="note-list">
        <li>A desktop in your browser: terminal, files, an editor, music, games</li>
        {account.status === 'anon' && (
          <li>
            <button className="note-link" onClick={signIn}>
              Sign in with GitHub
            </button>{' '}
            for your own: notes, layouts and services that follow you
          </li>
        )}
        {u && <li>This desktop is yours: it follows you to every device you sign in on</li>}
        <li>
          Made by Menno van Leeuwen:{' '}
          <a className="note-link" href="/cv">
            his CV
          </a>
        </li>
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
