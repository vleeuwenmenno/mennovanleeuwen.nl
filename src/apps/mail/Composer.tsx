import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useAccount } from '../../os/account'
import { openMenuAt } from '../../os/ContextMenu'
import { ask } from '../../os/Dialogs'
import { useDropTarget, type DragItem } from '../../os/dnd'
import { pickFiles } from '../../os/FolderPicker'
import { notify } from '../../os/notify'
import { Select } from '../../os/Select'
import { readBytes } from '../../data/fileOps'
import { fileLink, parseSf } from '../../data/seafile'
import { discardDraft, saveDraft, sendMail, uploadBlob, useMailPrefs, type Address, type Boot, type ComposeAttachment, type DraftBody } from '../../data/mail'
import { Icon } from './icons'
import { formatSize, RecipientField } from './parts'

// Writing a message: a new one, a reply, a forward or a draft picked up again. Plain text, with
// attachments from this computer or from Files (Seafile), or dropped on it (files from the
// computer, Files or the desktop; a launcher drops in as its link). Every change is saved as a draft after a
// moment's pause (Email/set in Drafts, replacing the one before), so closing the window loses
// nothing; Send submits it with the chosen identity.

export type ComposeInit = {
  /** Which composer this is: a new key starts a new one. */
  key: string
  title: string
  identityId?: string
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  text: string
  /** Attachments already in the account (a forward's, a draft's). */
  attachments: Att[]
  /** Files to upload first (composeMail from another app). */
  files?: ComposeAttachment[]
  inReplyTo?: string[]
  references?: string[]
  replyOf?: string | null
  forwardOf?: string | null
  draftId?: string | null
  /** Where the cursor starts: the recipients for a new message, the text for a reply. */
  focus: 'to' | 'text'
}

type Att = { key: string; name: string; type: string; size: number; blobId?: string; error?: string }

/** A launcher in a drag (on its own, or a .desktop file): its name and address. */
const launcherOf = (i: DragItem) => (i.kind === 'launcher' ? i : i.kind === 'file' ? i.launcher : undefined)
/** A file in a drag that can be attached (not a folder, not a launcher). */
const attachable = (i: DragItem): i is Extract<DragItem, { kind: 'file' }> => i.kind === 'file' && !i.dir && !i.launcher

const SAVE_AFTER = 2000

export function Composer({ account, boot, init, narrow, onClose }: { account: number; boot: Boot; init: ComposeInit; narrow: boolean; onClose: () => void }) {
  const me = useAccount()
  const { ctrlEnter } = useMailPrefs()
  const [identityId, setIdentityId] = useState(init.identityId ?? boot.identities[0]?.id ?? '')
  const [to, setTo] = useState(init.to)
  const [cc, setCc] = useState(init.cc)
  const [bcc, setBcc] = useState(init.bcc)
  const [showCc, setShowCc] = useState(init.cc.length > 0 || init.bcc.length > 0)
  const [subject, setSubject] = useState(init.subject)
  const [text, setText] = useState(init.text)
  const [atts, setAtts] = useState<Att[]>(init.attachments)
  const [draftId, setDraftId] = useState<string | null>(init.draftId ?? null)
  const [saved, setSaved] = useState<{ at: Date } | null>(null)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLElement>(null)
  const touched = useRef(false)
  const dirty = useRef(false)
  const pcFiles = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const closed = useRef(false)

  // The latest of everything, for saves that run after a pause.
  const body = (): DraftBody => ({
    id: draftRef.current,
    identityId,
    to,
    cc,
    bcc,
    subject,
    text,
    attachments: atts.filter((a) => a.blobId).map((a) => ({ blobId: a.blobId!, type: a.type, name: a.name, size: a.size })),
    inReplyTo: init.inReplyTo,
    references: init.references,
    replyOf: init.replyOf ?? null,
    forwardOf: init.forwardOf ?? null,
  })
  const bodyRef = useRef(body)
  bodyRef.current = body
  const draftRef = useRef(draftId)
  draftRef.current = draftId
  const busy = useRef<Promise<void> | null>(null)
  const uploading = atts.some((a) => !a.blobId && !a.error)

  /** Saves the draft now (one save at a time; a change during one is saved after it). */
  const save = useCallback(async () => {
    if (busy.current) await busy.current
    if (!dirty.current) return
    dirty.current = false
    setSaving(true)
    const run = saveDraft(account, bodyRef.current())
      .then((r) => {
        draftRef.current = r.id
        if (!closed.current) {
          setDraftId(r.id)
          setSaved({ at: new Date() })
        }
      })
      .catch((e: Error) => {
        dirty.current = true
        if (!closed.current) setError(`Draft not saved: ${e.message}`)
      })
      .finally(() => {
        busy.current = null
        if (!closed.current) setSaving(false)
      })
    busy.current = run
    await run
  }, [account])

  // A change: saved as a draft after a pause (not while an attachment is still uploading).
  const snapshot = JSON.stringify([identityId, to, cc, bcc, subject, text, atts.map((a) => a.blobId ?? a.key)])
  const unchanged = useRef(snapshot)
  useEffect(() => {
    if (snapshot === unchanged.current) return
    touched.current = true
    dirty.current = true
    if (uploading) return
    const t = setTimeout(() => {
      unchanged.current = snapshot
      void save()
    }, SAVE_AFTER)
    return () => clearTimeout(t)
  }, [snapshot, uploading, save])

  // Closing the window (or the app) with unsaved changes: saved on the way out.
  useEffect(() => {
    closed.current = false
    return () => {
      closed.current = true
      if (dirty.current && touched.current) {
        dirty.current = false
        // After a save still on its way, so this one replaces the draft that one makes.
        void (busy.current ?? Promise.resolve()).then(() => saveDraft(account, bodyRef.current())).catch(() => {})
      }
    }
  }, [account])

  // Files handed over by another app (composeMail), uploaded once.
  useEffect(() => {
    if (init.files?.length) void addFiles(init.files)
    if (init.focus === 'text')
      requestAnimationFrame(() => {
        textRef.current?.focus()
        textRef.current?.setSelectionRange(0, 0)
        if (textRef.current) textRef.current.scrollTop = 0
      })
  }, [init.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = async (list: ComposeAttachment[]) => {
    for (const item of list) {
      const key = crypto.randomUUID()
      const name = item instanceof File ? item.name : 'seafile' in item ? (item.seafile.split('/').pop() ?? 'file') : item.name
      setAtts((a) => [...a, { key, name, type: '', size: item instanceof Blob ? item.size : 'blob' in item ? item.blob.size : 0 }])
      try {
        let blob: Blob
        if (item instanceof Blob) blob = item
        else if ('blob' in item) blob = item.blob
        else {
          if (!parseSf(item.seafile)) throw new Error('Not a Seafile file')
          const res = await fetch(await fileLink(item.seafile, 'download'))
          if (!res.ok) throw new Error(`Seafile answered ${res.status}`)
          blob = await res.blob()
        }
        if (blob.size > boot.maxSizeUpload) throw new Error(`bigger than ${formatSize(boot.maxSizeUpload)}`)
        const type = blob.type || 'application/octet-stream'
        const up = await uploadBlob(account, blob, type)
        setAtts((a) => a.map((x) => (x.key === key ? { ...x, blobId: up.blobId, type: up.type || type, size: up.size } : x)))
      } catch (e) {
        setAtts((a) => a.map((x) => (x.key === key ? { ...x, error: (e as Error).message } : x)))
      }
    }
  }

  const close = async () => {
    if (dirty.current && touched.current) await save()
    onClose()
  }

  const discard = async () => {
    const something = !!draftRef.current || text.trim() !== init.text.trim() || to.length > 0 || subject !== init.subject
    if (something && !(await ask({ title: 'Discard this message?', body: draftRef.current ? 'Its draft is deleted too.' : undefined, confirm: 'Discard', danger: true }))) return
    dirty.current = false
    touched.current = false
    if (busy.current) await busy.current
    if (draftRef.current) await discardDraft(account, draftRef.current).catch(() => {})
    onClose()
  }

  const send = async () => {
    setError(null)
    if (!boot.canSend) return setError('This account can only read: link it again with a token that has Submission access.')
    if (uploading) return setError('Wait for the attachments to finish uploading.')
    if (!to.length && !cc.length && !bcc.length) return setError('Who is it to?')
    if (!subject.trim() && !(await ask({ title: 'Send without a subject?', confirm: 'Send' }))) return
    setSending(true)
    try {
      if (busy.current) await busy.current
      dirty.current = false
      await sendMail(account, bodyRef.current())
      touched.current = false
      notify({ title: 'Sent', body: subject.trim() || '(No subject)', transient: true })
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setSending(false)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation() // the app's own keys (j, k, e…) are text here
    if (ctrlEnter && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      void close()
    }
  }
  // Dropped here: files are attached (from the computer, Files or the desktop), launchers go into
  // the text as their links.
  useDropTarget(box, {
    accept: (d) => (d.os || d.items.some(attachable) ? 'copy' : d.items.some((i) => launcherOf(i)?.url) ? 'link' : null),
    drop: async (d) => {
      if (d.os) void addFiles((await d.files()).map((p) => p.file))
      const files = d.items.filter(attachable)
      if (files.length)
        void addFiles(
          await Promise.all(
            files.map(async (f) => {
              try {
                return { name: f.name, blob: await readBytes(f.path) }
              } catch (e) {
                setError(`${f.name}: ${(e as Error).message}`)
                return null
              }
            }),
          ).then((l) => l.filter((x): x is { name: string; blob: Blob } => !!x)),
        )
      const links = d.items.map(launcherOf).filter((l): l is NonNullable<ReturnType<typeof launcherOf>> => !!l?.url)
      if (links.length) {
        const add = links.map((l) => `${l.label}: ${l.url}`).join('\n')
        const el = textRef.current
        const at = el && document.activeElement === el ? el.selectionStart : text.length
        setText((t) => `${t.slice(0, at)}${at > 0 && !t.slice(0, at).endsWith('\n') ? '\n' : ''}${add}\n${t.slice(at)}`)
      }
    },
  })
  const attachMenu = (el: Element) =>
    openMenuAt(el, [
      { label: 'From this computer…', onSelect: () => pcFiles.current?.click() },
      { label: 'From Files (Seafile)…', disabled: !me.seafile, hint: me.seafile ? undefined : 'Link Seafile in Settings first', onSelect: () => void pickFiles({ title: 'Attach files' }).then((p) => void (p?.length && addFiles(p.map((seafile) => ({ seafile }))))) },
    ], 'above')

  const status = sending ? 'Sending…' : saving ? 'Saving…' : saved ? `Draft saved ${saved.at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''

  return (
    <section ref={box} className={`ml-compose ${narrow ? 'is-narrow' : ''}`} aria-label={init.title} onKeyDown={onKey}>
      <header className="ml-compose-head">
        <strong>{init.title}</strong>
        <span className="nb-spacer" />
        <button className="ml-icon" onClick={() => void close()} title="Close (the draft is kept)" aria-label="Close">
          ×
        </button>
      </header>
      <div className="ml-compose-fields">
        {boot.identities.length > 1 ? (
          <div className="ml-field">
            <span className="ml-field-label">From</span>
            <Select value={identityId} onChange={setIdentityId} options={boot.identities.map((i) => ({ value: i.id, label: i.name ? `${i.name} <${i.email}>` : i.email }))} aria-label="From" />
          </div>
        ) : boot.identities[0] ? (
          <div className="ml-field">
            <span className="ml-field-label">From</span>
            <span className="ml-from">{boot.identities[0].name ? `${boot.identities[0].name} <${boot.identities[0].email}>` : boot.identities[0].email}</span>
          </div>
        ) : null}
        <div className="ml-to-row">
          <RecipientField label="To" value={to} onChange={setTo} account={account} autoFocus={init.focus === 'to'} />
          {!showCc && (
            <button className="link-btn ml-cc-toggle" onClick={() => setShowCc(true)}>
              Cc/Bcc
            </button>
          )}
        </div>
        {showCc && <RecipientField label="Cc" value={cc} onChange={setCc} account={account} />}
        {showCc && <RecipientField label="Bcc" value={bcc} onChange={setBcc} account={account} />}
        <label className="ml-field">
          <span className="ml-field-label">Subject</span>
          <input className="ml-subject-input" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
        </label>
      </div>
      <textarea ref={textRef} className="ml-compose-text" value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" spellCheck />
      {atts.length > 0 && (
        <ul className="ml-compose-atts">
          {atts.map((a) => (
            <li key={a.key} className={a.error ? 'is-bad' : !a.blobId ? 'is-busy' : ''} title={a.error ?? a.name}>
              <span className="ml-att-name">{a.name}</span>
              <span className="ml-att-size">{a.error ? a.error : a.blobId ? formatSize(a.size) : 'Uploading…'}</span>
              <button aria-label={`Remove ${a.name}`} onClick={() => setAtts((l) => l.filter((x) => x.key !== a.key))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="ml-problem copyable">{error}</p>}
      <footer className="ml-compose-foot">
        <button className="btn btn-primary" onClick={() => void send()} disabled={sending} title={ctrlEnter ? 'Send (Ctrl+Enter)' : 'Send'}>
          {sending ? 'Sending…' : 'Send'}
        </button>
        <button className="btn btn-small" onClick={(e) => attachMenu(e.currentTarget)} title="Attach files">
          <Icon name="paperclip" size={14} /> Attach
        </button>
        <span className="ml-saved muted">{status}</span>
        <span className="nb-spacer" />
        <button className="ml-icon" onClick={() => void discard()} title="Discard" aria-label="Discard">
          <Icon name="trash" />
        </button>
      </footer>
      <input
        ref={pcFiles}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void addFiles([...e.target.files])
          e.target.value = ''
        }}
      />
    </section>
  )
}
