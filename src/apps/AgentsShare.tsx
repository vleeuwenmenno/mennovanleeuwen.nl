import { useCallback, useEffect, useState } from 'react'
import { expiryText, listShares, SHARE_EXPIRY, SHARE_NOTE, shareThread, stopSharing, type AgentMessage, type Share, type ShareExpiry, type Thread } from '../data/agents'
import { choose } from '../os/Dialogs'
import { Select } from '../os/Select'

// Shared links for the Agents app (server/shares.ts): the dialog that shares a thread or one
// answer, and the list of links in Settings → Agents → Shared links. A link is a snapshot read by
// anyone who has it, on a plain page outside MvL OS, until it expires or sharing stops.

const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {})
const when = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** One link: its address to select or copy, open it, stop sharing it. */
export function ShareLink({ share, onStopped, showTitle = false }: { share: Share; onStopped: () => void; showTitle?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const stop = async () => {
    setBusy(true)
    setError(null)
    try {
      await stopSharing(share.token)
      onStopped()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <div className="agt-share-link">
      {showTitle && (
        <strong className="agt-share-title">
          {share.title} <span className="muted">· {share.kind === 'response' ? 'one answer' : 'whole thread'}</span>
        </strong>
      )}
      <input className="agt-share-url" value={share.url} readOnly onFocus={(e) => e.currentTarget.select()} aria-label="Shared link" spellCheck={false} />
      <div className="agt-share-row">
        <span className="muted">
          Made {when(share.createdAt)} · {expiryText(share)} · {share.views} {share.views === 1 ? 'view' : 'views'}
        </span>
        <span className="agt-share-actions">
          <button type="button" className="btn btn-small" onClick={() => (copy(share.url), setCopied(true))}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="btn btn-small" onClick={() => window.open(share.url, '_blank', 'noopener')}>
            Open
          </button>
          <button type="button" className="btn btn-small btn-danger" onClick={() => void stop()} disabled={busy}>
            {busy ? 'Stopping…' : 'Stop sharing'}
          </button>
        </span>
      </div>
      {error && <p className="t-red">{error}</p>}
    </div>
  )
}

/**
 * What the share dialog holds: the links this thread (or this answer) has already, and making a
 * new one with an expiry. Existing links come first, so sharing again doesn't make duplicates
 * unless asked to (New link).
 */
function SharePanel({ thread, message }: { thread: Thread; message?: AgentMessage }) {
  const [shares, setShares] = useState<Share[] | null>(null)
  const [expires, setExpires] = useState<ShareExpiry>('never')
  const [making, setMaking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mine = useCallback((s: Share) => (message ? s.kind === 'response' && s.messageId === message.id : s.kind === 'thread'), [message])
  const load = useCallback(() => listShares(thread.id).then((list) => setShares(list.filter(mine)), (e: Error) => (setShares([]), setError(e.message))), [thread.id, mine])
  useEffect(() => void load(), [load])
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const s = await shareThread(thread.id, { kind: message ? 'response' : 'thread', messageId: message?.id, expires })
      setShares((list) => [s, ...(list ?? [])])
      setMaking(false)
      copy(s.url)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const form = (
    <div className="agt-share-new">
      <Select className="set-select" value={expires} onChange={setExpires} options={SHARE_EXPIRY} aria-label="When the link expires" />
      <button type="button" className="btn btn-small btn-primary" onClick={() => void create()} disabled={busy}>
        {busy ? 'Creating…' : 'Create link'}
      </button>
    </div>
  )
  return (
    <div className="agt-share">
      <p>{SHARE_NOTE}</p>
      <p>{message ? 'This answer and the message it answers, as they are now.' : 'The thread as it is now: later messages are not added to the link.'} Anyone with the link can read it, without an account; it is not listed anywhere.</p>
      {shares === null ? (
        <p>Loading…</p>
      ) : (
        <>
          {shares.map((s) => (
            <ShareLink key={s.token} share={s} onStopped={() => setShares((list) => list?.filter((x) => x.token !== s.token) ?? null)} />
          ))}
          {!shares.length || making ? (
            form
          ) : (
            <button type="button" className="btn btn-small agt-share-more" onClick={() => setMaking(true)}>
              New link…
            </button>
          )}
        </>
      )}
      {error && <p className="t-red">{error}</p>}
    </div>
  )
}

/** The share dialog: a whole thread, or one answer (`message`, an assistant message with text). */
export const openShareDialog = (thread: Thread, message?: AgentMessage) =>
  choose({ title: message ? 'Share this answer' : 'Share this thread', body: <SharePanel thread={thread} message={message} />, buttons: [{ id: 'done', label: 'Done', primary: true }] })

/** Settings → Agents → Shared links: every link the user has, to copy, open or stop. */
export function SharesSettings() {
  const [shares, setShares] = useState<Share[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => void listShares().then(setShares, (e: Error) => (setShares([]), setError(e.message))), [])
  return (
    <>
      <ul className="set-list">
        {shares === null && <li className="set-row muted">Loading…</li>}
        {shares?.length === 0 && <li className="set-row muted">Nothing is shared. Share a thread from its ⋯ menu, or one answer with Share under it.</li>}
        {shares?.map((s) => (
          <li key={s.token} className="set-row">
            <ShareLink share={s} showTitle onStopped={() => setShares((list) => list?.filter((x) => x.token !== s.token) ?? null)} />
          </li>
        ))}
      </ul>
      {error && <p className="t-red">{error}</p>}
      <p className="muted set-help">{SHARE_NOTE} A link is a snapshot from when it was made. Expired links are deleted; deleting a thread deletes its links.</p>
    </>
  )
}
