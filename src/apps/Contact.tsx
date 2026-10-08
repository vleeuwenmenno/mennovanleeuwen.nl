import { useState } from 'react'
import { profile } from '../data/profile'

export function Contact() {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(profile.email)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked; the mailto link still works */
    }
  }
  return (
    <div className="contact">
      <div className="mail-head">
        <div className="mail-field">
          <span className="muted">To</span>
          <span className="mail-to">{profile.email}</span>
          <button className="btn btn-small" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <div className="mail-field">
          <span className="muted">Subject</span>
          <span>Saw your site, let's talk</span>
        </div>
      </div>
      <div className="mail-body">
        <p>Hey Menno,</p>
        <p className="muted">
          Infrastructure that needs to stop paging people, a desktop app idea, or a question about Boltwarden or Pepper? Write me. I read everything, and I answer most of it.
        </p>
        <a className="btn btn-primary" href={`mailto:${profile.email}?subject=${encodeURIComponent("Saw your site, let's talk")}`}>
          Open in mail app ↗
        </a>
      </div>
      <div className="mail-links">
        {profile.links.map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="link-tile">
            <strong>{l.label}</strong>
            <span className="muted">{l.url.replace(/^https:\/\//, '')}</span>
          </a>
        ))}
      </div>
    </div>
  )
}
