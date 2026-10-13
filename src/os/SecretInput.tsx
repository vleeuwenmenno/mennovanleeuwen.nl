import { useState, type InputHTMLAttributes } from 'react'

// A field for a secret that belongs to another service (an API token, an app password, a library
// password), not to this site. Browsers fill saved passwords into any <input type="password">
// they find, and ignore autocomplete="off" there; one such fill sent a saved site password to
// Fastmail as an API token. So the field is a plain text input masked with CSS
// (-webkit-text-security, which Chrome, Safari and current Firefox honour): browsers and password
// managers only look at password inputs, and the manager hints below catch the ones that guess by
// label. Where the CSS isn't supported it falls back to type="password" with
// autoComplete="new-password", the one value browsers do respect there. A show/hide button
// sits at the right edge.

const maskable = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc')

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'autoComplete'>

export function SecretInput({ className, ...rest }: Props) {
  const [shown, setShown] = useState(false)
  const hidden = !shown
  return (
    <span className="secret">
      <input
        {...rest}
        className={[className, hidden && maskable ? 'secret-mask' : ''].filter(Boolean).join(' ') || undefined}
        type={hidden && !maskable ? 'password' : 'text'}
        autoComplete={hidden && !maskable ? 'new-password' : 'off'}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        data-bwignore="true"
        data-protonpass-ignore="true"
        data-form-type="other"
      />
      <button type="button" className="secret-eye" onClick={() => setShown(!shown)} aria-label={shown ? 'Hide' : 'Show'} aria-pressed={shown} title={shown ? 'Hide' : 'Show'} tabIndex={-1}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
          {shown && <path d="M4 4l16 16" />}
        </svg>
      </button>
    </span>
  )
}
