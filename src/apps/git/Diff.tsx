import { useMemo, useState } from 'react'
import type { GitFile } from '../../data/gitTypes'
import { ExtLink } from './ui'

// Changed files as unified diffs: one collapsible box per file, its lines numbered on both sides
// and tinted for additions and deletions. A long line scrolls inside its box, never the window.
// Binary files and diffs too large to send show a link to the host's page instead.

type Row = { kind: 'hunk' | 'add' | 'del' | 'ctx' | 'note'; old: number | null; new: number | null; text: string }

/** Lines past this in one file are left to the web page. */
const MAX_LINES = 2500

export function diffRows(patch: string): Row[] {
  const rows: Row[] = []
  let o = 0
  let n = 0
  for (const line of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      rows.push({ kind: 'hunk', old: null, new: null, text: line })
    } else if (line.startsWith('+')) rows.push({ kind: 'add', old: null, new: n++, text: line.slice(1) })
    else if (line.startsWith('-')) rows.push({ kind: 'del', old: o++, new: null, text: line.slice(1) })
    else if (line.startsWith('\\')) rows.push({ kind: 'note', old: null, new: null, text: line.slice(1).trim() })
    else rows.push({ kind: 'ctx', old: o++, new: n++, text: line.slice(1) })
  }
  return rows
}

const STATUS_LETTER: Record<GitFile['status'], string> = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M' }

function Lines({ patch }: { patch: string }) {
  const rows = useMemo(() => diffRows(patch), [patch])
  const shown = rows.length > MAX_LINES ? rows.slice(0, MAX_LINES) : rows
  return (
    <div className="git-diff-scroll">
      <table className="git-diff">
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className={`is-${r.kind}`}>
              {r.kind === 'hunk' || r.kind === 'note' ? (
                <td colSpan={3} className="git-diff-hunk">
                  {r.text}
                </td>
              ) : (
                <>
                  <td className="git-ln">{r.old ?? ''}</td>
                  <td className="git-ln">{r.new ?? ''}</td>
                  <td className="git-code">
                    <span className="git-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
                    {r.text}
                  </td>
                </>
              )}
            </tr>
          ))}
          {shown.length < rows.length && (
            <tr className="is-note">
              <td colSpan={3} className="git-diff-hunk">
                {rows.length - shown.length} more lines: open the file on the web to see them.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function FileBox({ f, open, onToggle, web, hostLabel }: { f: GitFile; open: boolean; onToggle: () => void; web: string; hostLabel: string }) {
  return (
    <section className={`git-file ${open ? 'is-open' : ''}`}>
      <header className="git-file-head">
        <button className="git-file-toggle" onClick={onToggle} aria-expanded={open}>
          <span className="git-chev" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
          <span className={`git-fstatus is-${f.status}`} title={f.status}>
            {STATUS_LETTER[f.status]}
          </span>
          <span className="git-fname">
            {f.previousFilename && f.previousFilename !== f.filename && <span className="muted">{f.previousFilename} → </span>}
            {f.filename}
          </span>
          <span className="git-fcount">
            {f.additions > 0 && <span className="git-add">+{f.additions}</span>} {f.deletions > 0 && <span className="git-del">−{f.deletions}</span>}
          </span>
        </button>
      </header>
      {open &&
        (f.patch ? (
          <Lines patch={f.patch} />
        ) : (
          <p className="git-file-note muted">
            {f.binary ? 'Binary file, not shown here.' : f.tooLarge ? 'This diff is too large to show here.' : f.status === 'renamed' ? 'Renamed without changes.' : 'No changes to show.'}{' '}
            {(f.binary || f.tooLarge) && <ExtLink href={web} label={`View on ${hostLabel}`} small />}
          </p>
        ))}
    </section>
  )
}

/** All of a pull request's or commit's files. `web` is the host's page with the same diff. */
export function DiffFiles({ files, truncated, web, hostLabel }: { files: GitFile[]; truncated: boolean; web: string; hostLabel: string }) {
  // Big change sets start folded past the first few files, so the first paint stays quick.
  const total = files.reduce((n, f) => n + f.additions + f.deletions, 0)
  const [open, setOpen] = useState<Set<number>>(() => new Set(files.map((_, i) => i).filter((i) => total < 1500 || i < 5)))
  const add = files.reduce((n, f) => n + f.additions, 0)
  const del = files.reduce((n, f) => n + f.deletions, 0)
  const toggle = (i: number) => setOpen((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set([...s, i])))
  if (!files.length) return <p className="muted git-pad">No changed files.</p>
  return (
    <div className="git-files">
      <div className="git-files-bar">
        <span>
          {files.length} {files.length === 1 ? 'file' : 'files'} · <span className="git-add">+{add}</span> <span className="git-del">−{del}</span>
        </span>
        <span className="git-files-actions">
          <button className="git-btn is-small" onClick={() => setOpen(new Set(files.map((_, i) => i)))}>
            Expand all
          </button>
          <button className="git-btn is-small" onClick={() => setOpen(new Set())}>
            Collapse all
          </button>
        </span>
      </div>
      {truncated && (
        <p className="git-warn">
          Only the first {files.length} files are shown. <ExtLink href={web} label={`All files on ${hostLabel}`} small />
        </p>
      )}
      {files.map((f, i) => (
        <FileBox key={`${f.filename}-${i}`} f={f} open={open.has(i)} onToggle={() => toggle(i)} web={web} hostLabel={hostLabel} />
      ))}
    </div>
  )
}
