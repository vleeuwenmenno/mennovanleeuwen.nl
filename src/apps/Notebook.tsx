import { useEffect, useMemo, useRef, useState } from 'react'
import { createNote, NOTE_COLORS, noteTitle, purgeNote, restoreNote, trashNote, updateNote, useAllNotes, type Note, type NoteColor } from '../data/notes'
import { timeAgo } from '../data/recents'
import { signIn, useAccount } from '../os/account'
import { openContextMenu } from '../os/ContextMenu'
import { useSyncStatus } from '../os/synced'
import { useWM, type WinState } from '../os/wm'
import { closeStickies, noteMenu, openSticky } from './Sticky'
import { MarkdownPreview } from './Zed'

// Every note in one place: search, write in Markdown, preview it, colour it, and put it on the
// desktop as a sticky (or take it off again). Deleted notes wait in the trash.

const when = (ms: number) => timeAgo(new Date(ms).toISOString())

function excerpt(n: Note) {
  const lines = n.text.split('\n').filter((l) => l.trim())
  return lines.slice(1).join(' ').slice(0, 90)
}

export function SyncLine() {
  const account = useAccount()
  const sync = useSyncStatus()
  if (account.status === 'off') return <span className="muted">Saved in this browser</span>
  if (account.status !== 'user')
    return (
      <span className="muted">
        Saved in this browser ·{' '}
        <button className="link-btn" onClick={signIn}>
          sign in to sync
        </button>
      </span>
    )
  if (sync.state === 'error') return <span className="t-red">Sync failed: {sync.error}</span>
  if (sync.state === 'syncing') return <span className="muted">Syncing…</span>
  return <span className="muted">Synced{sync.at ? ` · ${when(sync.at)}` : ''}</span>
}

export function Notebook({ win }: { win: WinState }) {
  const wm = useWM()
  const all = useAllNotes()
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<'notes' | 'trash'>('notes')
  const [selected, setSelected] = useState<string | null>(win.props.id ?? null)
  const [preview, setPreview] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)

  // "Open in Notebook" from a sticky selects that note.
  useEffect(() => {
    if (win.props.id) {
      setSelected(win.props.id)
      setTab('notes')
    }
  }, [win.props.id, win.props.t])

  const live = all.filter((n) => !n.purged)
  const notes = useMemo(() => {
    const query = q.trim().toLowerCase()
    return live
      .filter((n) => (tab === 'trash' ? n.deleted : !n.deleted))
      .filter((n) => !query || n.text.toLowerCase().includes(query))
      .sort((a, b) => b.updated - a.updated)
  }, [live, q, tab])
  const note = live.find((n) => n.id === selected && (tab === 'trash' ? n.deleted : !n.deleted)) ?? notes[0]
  const onDesktop = (id: string) => wm.windows.some((w) => w.app === 'sticky' && w.props.id === id)
  const trashCount = live.filter((n) => n.deleted).length

  const add = () => {
    const n = createNote()
    setTab('notes')
    setQ('')
    setSelected(n.id)
    setPreview(false)
    setTimeout(() => editor.current?.focus(), 0)
  }

  const remove = (n: Note) => {
    closeStickies(wm, n.id)
    trashNote(n.id)
  }

  return (
    <div className="nb">
      <aside className="nb-side">
        <div className="nb-search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes" aria-label="Search notes" spellCheck={false} />
          <button className="btn btn-small btn-primary" onClick={add} title="New note">
            + New
          </button>
        </div>
        <div className="nb-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'notes'} className={tab === 'notes' ? 'is-on' : ''} onClick={() => setTab('notes')}>
            Notes {live.length - trashCount ? `(${live.length - trashCount})` : ''}
          </button>
          <button role="tab" aria-selected={tab === 'trash'} className={tab === 'trash' ? 'is-on' : ''} onClick={() => setTab('trash')}>
            Trash {trashCount ? `(${trashCount})` : ''}
          </button>
        </div>
        <ul className="nb-list">
          {notes.map((n) => (
            <li key={n.id}>
              <button
                className={`nb-item ${n.id === note?.id ? 'is-active' : ''}`}
                onClick={() => setSelected(n.id)}
                onDoubleClick={() => tab === 'notes' && openSticky(wm, n.id)}
                onContextMenu={(e) =>
                  openContextMenu(
                    e,
                    tab === 'trash'
                      ? [
                          { label: 'Put back', onSelect: () => restoreNote(n.id) },
                          { label: 'Delete forever', danger: true, onSelect: () => purgeNote(n.id) },
                        ]
                      : noteMenu(n, [
                          { separator: true },
                          onDesktop(n.id) ? { label: 'Take off the desktop', onSelect: () => closeStickies(wm, n.id) } : { label: 'Put on the desktop', onSelect: () => openSticky(wm, n.id) },
                          { separator: true },
                          { label: 'Move to Trash', danger: true, onSelect: () => remove(n) },
                        ]),
                  )
                }
              >
                <span className="nb-swatch" style={{ background: NOTE_COLORS[n.color].bg }} />
                <span className="nb-item-text">
                  <span className="nb-item-title">
                    {noteTitle(n)}
                    {onDesktop(n.id) && <span className="nb-pin" title="On the desktop"> ◆</span>}
                  </span>
                  <span className="nb-item-sub muted">
                    {when(n.updated)}
                    {excerpt(n) && ` · ${excerpt(n)}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {!notes.length && <li className="nb-empty muted">{q ? 'Nothing matches.' : tab === 'trash' ? 'The trash is empty.' : 'No notes yet.'}</li>}
        </ul>
        {tab === 'trash' && trashCount > 0 && (
          <button className="btn btn-small nb-empty-trash" onClick={() => live.filter((n) => n.deleted).forEach((n) => purgeNote(n.id))}>
            Empty trash
          </button>
        )}
      </aside>

      <section className="nb-main">
        {note ? (
          <>
            <div className="nb-toolbar">
              <div className="nb-seg" role="group" aria-label="View">
                <button className={!preview ? 'is-on' : ''} onClick={() => setPreview(false)}>
                  Edit
                </button>
                <button className={preview ? 'is-on' : ''} onClick={() => setPreview(true)}>
                  Preview
                </button>
              </div>
              {!note.deleted && (
                <div className="nb-colors">
                  {(Object.keys(NOTE_COLORS) as NoteColor[]).map((c) => (
                    <button key={c} className={`sticky-dot ${note.color === c ? 'is-on' : ''}`} style={{ background: NOTE_COLORS[c].bg }} title={NOTE_COLORS[c].label} aria-label={NOTE_COLORS[c].label} onClick={() => updateNote(note.id, { color: c })} />
                  ))}
                </div>
              )}
              <span className="nb-spacer" />
              {note.deleted ? (
                <>
                  <button className="btn btn-small" onClick={() => restoreNote(note.id)}>
                    Put back
                  </button>
                  <button className="btn btn-small is-danger" onClick={() => purgeNote(note.id)}>
                    Delete forever
                  </button>
                </>
              ) : (
                <>
                  <button className={`btn btn-small ${onDesktop(note.id) ? 'is-on' : ''}`} onClick={() => (onDesktop(note.id) ? closeStickies(wm, note.id) : openSticky(wm, note.id))} title="Show this note as a sticky on the desktop">
                    {onDesktop(note.id) ? '◆ On desktop' : '◇ Put on desktop'}
                  </button>
                  <button className="btn btn-small" onClick={(e) => openContextMenu(e, noteMenu(note, [{ separator: true }, { label: 'Move to Trash', danger: true, onSelect: () => remove(note) }]))} aria-label="More">
                    ⋯
                  </button>
                </>
              )}
            </div>
            {preview || note.deleted ? (
              <article className="zed-preview nb-preview" onDoubleClick={() => !note.deleted && setPreview(false)}>
                {note.text.trim() ? <MarkdownPreview text={note.text} /> : <p className="muted">Empty note.</p>}
              </article>
            ) : (
              <textarea
                ref={editor}
                className="nb-editor"
                value={note.text}
                placeholder={'# A title\n\nWrite in Markdown: **bold**, _italic_, `code`, - lists, [links](https://…)'}
                onChange={(e) => updateNote(note.id, { text: e.target.value })}
                spellCheck
              />
            )}
            <footer className="nb-foot">
              <span className="muted">
                {note.text.trim() ? note.text.trim().split(/\s+/).length : 0} words · edited {when(note.updated)}
              </span>
              <SyncLine />
            </footer>
          </>
        ) : (
          <div className="nb-blank">
            <p className="muted">{tab === 'trash' ? 'Nothing in the trash.' : 'Notes you write here stay in this browser, or sync everywhere once you sign in.'}</p>
            {tab === 'notes' && (
              <button className="btn btn-primary" onClick={add}>
                Write a note
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
