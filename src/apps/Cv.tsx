import { contributions, education, experience, hobbies, profile, projects, skills } from '../data/profile'
import { useWM } from '../os/wm'

export function Cv() {
  const wm = useWM()
  return (
    <div className="cv-wrap">
      <div className="cv-toolbar">
        <span className="muted">cv.md</span>
        <span className="spacer" />
        <button className="btn btn-small" onClick={() => wm.open('terminal', { run: 'cat ~/cv.md' })}>
          View as text
        </button>
        <button className="btn btn-small btn-primary" onClick={() => window.print()}>
          Print / PDF
        </button>
      </div>
      <article className="cv" id="cv-print">
        <header className="cv-head">
          <div>
            <h1>{profile.name}</h1>
            <p className="cv-role">
              {profile.role} @ {profile.company}
            </p>
          </div>
          <ul className="cv-contact">
            <li>
              <a href={`mailto:${profile.email}`}>{profile.email}</a>
            </li>
            {profile.links.map((l) => (
              <li key={l.url}>
                <a href={l.url} target="_blank" rel="noopener noreferrer">
                  {l.url.replace(/^https:\/\//, '')}
                </a>
              </li>
            ))}
          </ul>
        </header>
        <p className="cv-summary">{profile.summary}</p>

        <section>
          <h2>Experience</h2>
          {experience.map((e) => (
            <div className="cv-row" key={e.role + e.company}>
              <div className="cv-when">{e.period}</div>
              <div>
                <strong>{e.role}</strong>, {e.company}
                {e.notes.map((n) => (
                  <p key={n}>{n}</p>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section>
          <h2>Projects</h2>
          {projects.map((p) => (
            <div className="cv-row" key={p.slug}>
              <div className="cv-when">{p.stack.slice(0, 2).join(', ')}</div>
              <div>
                <button className="cv-link" onClick={() => wm.open('projects', { slug: p.slug })}>
                  {p.name}
                </button>{' '}
                · {p.tagline}
                <p>{p.description}</p>
              </div>
            </div>
          ))}
        </section>

        <section>
          <h2>Open source</h2>
          {contributions.map((c) => (
            <div className="cv-row" key={c.slug}>
              <div className="cv-when">{c.owner}</div>
              <div>
                <button className="cv-link" onClick={() => wm.open('projects', { slug: c.slug })}>
                  {c.name}
                </button>{' '}
                · {c.description}
              </div>
            </div>
          ))}
        </section>

        <section>
          <h2>Education</h2>
          {education.map((e) => (
            <div className="cv-row" key={e.title}>
              <div className="cv-when">{e.period}</div>
              <div>
                <strong>{e.title}</strong>, {e.school}
                {e.note && <p>{e.note}</p>}
              </div>
            </div>
          ))}
        </section>

        <section>
          <h2>Skills</h2>
          {Object.entries(skills).map(([k, v]) => (
            <div className="cv-row" key={k}>
              <div className="cv-when">{k}</div>
              <div className="cv-skills">
                {v.map((s) => (
                  <span key={s}>{s}</span>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section>
          <h2>Off the clock</h2>
          {hobbies.map((h) => (
            <div className="cv-row" key={h.name}>
              <div className="cv-when">{h.name}</div>
              <div>
                {h.note}
                {h.url && (
                  <>
                    {' '}
                    <a href={h.url} target="_blank" rel="noopener noreferrer">
                      See my work ↗
                    </a>
                  </>
                )}
              </div>
            </div>
          ))}
        </section>
      </article>
    </div>
  )
}
