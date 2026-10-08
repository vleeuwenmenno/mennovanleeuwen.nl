import { useState } from 'react'
import { maskedEmail, revealEmail } from '../data/email'

/** Shows the masked address with a Show button; the real one only enters the page after a click. */
export function EmailReveal({ className = '', link = false, forceShown = false }: { className?: string; link?: boolean; forceShown?: boolean }) {
  const [shown, setShown] = useState(false)
  if (!shown && !forceShown)
    return (
      <span className={`email-reveal ${className}`}>
        <span aria-label="Email address, hidden">{maskedEmail()}</span>
        <button className="email-show" onClick={() => setShown(true)}>
          Show
        </button>
      </span>
    )
  const address = revealEmail()
  return link ? (
    <a className={className} href={`mailto:${address}`}>
      {address}
    </a>
  ) : (
    <span className={className}>{address}</span>
  )
}
