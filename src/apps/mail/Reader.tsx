import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { getAccount } from '../../os/account'
import { openContextMenu, openMenuAt, selectionIn, type MenuItem } from '../../os/ContextMenu'
import { pickFolder } from '../../os/FolderPicker'
import { useWM } from '../../os/wm'
import { notify } from '../../os/notify'
import { uploadFiles } from '../../data/uploads'
import { openImport, pimAppFor } from '../../data/pimFiles'
import {
  act,
  allowImagesFrom,
  blobFile,
  blobUrl,
  fetchMessage,
  fetchThread,
  useMailPrefs,
  nameOf,
  orderMailboxes,
  useMailVersion,
  useMessageActions,
  type Attachment,
  type Boot,
  type Message,
  type MessageRef,
  type Op,
} from '../../data/mail'
import { PersonChip } from '../contacts/people'
import { Icon, type IconName } from './icons'
import { Avatar, formatSize, htmlToText, InviteCard, longDate, MessageFrame, PlainText, showPerson } from './parts'

// The reading pane: one conversation, oldest message first. Read and unread-but-old messages are
// folded to a line; the newest and the unread ones are open. HTML mail shows in a sandboxed frame
// (parts.tsx) with remote images held back until asked for.

export type ReplyMode = 'reply' | 'replyAll' | 'forward' | 'draft'

type Props = {
  account: number
  threadId: string
  boot: Boot
  /** The mailbox the conversation was opened from (moves take it out of there). */
  mailbox: string | null
  narrow: boolean
  onBack: () => void
  /** A change to the whole conversation (archive, delete…), done by the app so the list follows. */
  onAction: (op: Op, opts?: { to?: string }) => void
  onReply: (m: Message, mode: ReplyMode) => void
  onSearch: (q: string) => void
}

/** What other apps get to see of a message (Make task, Create event, invitations). */
export const messageRef = (account: number, m: Message): MessageRef => ({ account, id: m.id, threadId: m.threadId, subject: m.subject, from: m.from, to: m.to, cc: m.cc, receivedAt: m.receivedAt, text: m.text ?? (m.html ? htmlToText(m.html) : ''), invite: m.invite, messageId: m.messageId[0] ?? null })

export function Reader({ account, threadId, boot, mailbox, narrow, onBack, onAction, onReply, onSearch }: Props) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const version = useMailVersion()
  const marked = useRef(new Set<string>())
  const scroller = useRef<HTMLDivElement>(null)
  const extra = useMessageActions()
  const prefs = useMailPrefs()

  // Load (again after a change anywhere); messages shown with images keep them.
  const withImages = useRef(new Set<string>())
  useEffect(() => {
    withImages.current = new Set()
    marked.current = new Set()
    setMessages(null)
    setOpen(new Set())
  }, [threadId, account])
  useEffect(() => {
    let live = true
    setError(null)
    fetchThread(account, threadId, [...withImages.current])
      .then((t) => {
        if (!live) return
        setMessages(t.messages)
        setOpen((o) => {
          if (o.size) return o
          // The newest, and anything unread, start open.
          const next = new Set(t.messages.filter((m) => !m.seen).map((m) => m.id))
          if (t.messages.length) next.add(t.messages[t.messages.length - 1].id)
          return next
        })
      })
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [account, threadId, version])

  // Read as it opens, or a few seconds after, or never by itself (Settings → Apps → Mail). Once
  // a conversation has been marked here it is not marked again, so "Mark as unread" stays.
  const unseen = !!messages?.some((m) => !m.seen)
  useEffect(() => {
    if (!unseen || prefs.markRead === 'never' || marked.current.has(threadId)) return
    const mark = () => {
      marked.current.add(threadId)
      act(account, 'seen', { threadIds: [threadId] }).catch(() => {})
    }
    if (prefs.markRead === 'open') return mark()
    const t = setTimeout(mark, prefs.markReadAfter * 1000)
    return () => clearTimeout(t)
  }, [account, threadId, unseen, prefs.markRead, prefs.markReadAfter])

  // The reading pane's height, for frames that fill it.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => el.style.setProperty('--ml-reader-h', `${el.clientHeight}px`))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const loadImages = async (m: Message) => {
    withImages.current.add(m.id)
    try {
      const fresh = await fetchMessage(account, m.id, true)
      setMessages((list) => list?.map((x) => (x.id === m.id ? fresh : x)) ?? null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  /** "Always for" a sender or their whole domain: on the allow list, and this message loads now. */
  const alwaysImages = (m: Message, domain = false) => {
    const sender = m.from[0]?.email
    if (!sender) return
    const who = domain ? sender.slice(sender.lastIndexOf('@')) : sender
    allowImagesFrom(who)
    void loadImages(m)
    notify({ title: domain ? 'Images from this domain will load' : 'Images from this sender will load', body: who, transient: true })
  }

  const last = messages?.at(-1)
  const subject = last?.subject || messages?.[0]?.subject || ''
  const role = (r: string) => boot.mailboxes.find((b) => b.role === r)?.id ?? null
  const inMailbox = (r: string) => !!messages?.some((m) => m.mailboxIds.includes(role(r) ?? '-'))
  const inTrash = mailbox === role('trash')
  const inJunk = mailbox === role('junk')
  const flagged = !!messages?.some((m) => m.flagged)

  const moveItems = (): MenuItem[] =>
    orderMailboxes(boot.mailboxes)
      .filter(({ box }) => box.id !== mailbox && box.role !== 'drafts')
      .map(({ box, depth }) => ({ label: `${'  '.repeat(depth)}${box.name}`, onSelect: () => onAction('move', { to: box.id }) }))

  /** A message's menu: answering, changes, other apps' actions, images. */
  const messageMenu = (m: Message): MenuItem[] => {
    const ref = messageRef(account, m)
    const registered = new Map(extra.map((a) => [a.id, a]))
    const plugin = (id: string, label: string): MenuItem => {
      const a = registered.get(id)
      return a ? { label: a.label, hint: a.hint, onSelect: () => a.run(ref) } : { label, hint: 'Coming soon', disabled: true }
    }
    return [
      ...(m.draft ? [{ label: 'Edit draft', onSelect: () => onReply(m, 'draft') }] : []),
      { label: 'Reply', shortcut: 'R', onSelect: () => onReply(m, 'reply') },
      { label: 'Reply all', shortcut: 'A', onSelect: () => onReply(m, 'replyAll') },
      { label: 'Forward', shortcut: 'F', onSelect: () => onReply(m, 'forward') },
      { separator: true },
      { label: m.seen ? 'Mark as unread' : 'Mark as read', onSelect: () => void act(account, m.seen ? 'unseen' : 'seen', { emailIds: [m.id] }).catch((e: Error) => setError(e.message)) },
      { label: m.flagged ? 'Unflag' : 'Flag', onSelect: () => void act(account, m.flagged ? 'unflag' : 'flag', { emailIds: [m.id] }).catch((e: Error) => setError(e.message)) },
      { separator: true },
      plugin('task', 'Make task from this email'),
      plugin('event', 'Create event from this email'),
      ...extra.filter((a) => a.id !== 'task' && a.id !== 'event').map((a) => ({ label: a.label, hint: a.hint, onSelect: () => a.run(ref) })),
      ...(m.blocked > 0 && !m.images
        ? [{ separator: true as const }, { label: 'Load images', onSelect: () => void loadImages(m) }, ...(m.from[0] ? [{ label: `Always load images from ${m.from[0].email}`, onSelect: () => alwaysImages(m) }, { label: `Always load images from @${m.from[0].email.split('@').pop()}`, onSelect: () => alwaysImages(m, true) }] : [])]
        : []),
    ]
  }

  const flag = () => last && void act(account, flagged ? 'unflag' : 'flag', { emailIds: flagged ? messages!.filter((m) => m.flagged).map((m) => m.id) : [last.id] }).catch((e: Error) => setError(e.message))
  /**
   * The conversation's actions, Fastmail-style: an icon whose name shows beside it on hover or
   * keyboard focus, or always once the pane is wide enough (mail.css). Without hover (a finger),
   * More lists them again by name.
   */
  const tools: { id: string; icon: IconName; label: string; title: string; run: (e: MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; on?: boolean; menu?: boolean }[] = [
    { id: 'archive', icon: 'archive', label: 'Archive', title: 'Archive (E)', run: () => onAction('archive'), disabled: !role('archive') || mailbox === role('archive') },
    { id: 'delete', icon: 'trash', label: inTrash ? 'Delete for good' : 'Delete', title: inTrash ? 'Delete for good (#)' : 'Delete (#)', run: () => onAction(inTrash ? 'destroy' : 'trash') },
    { id: 'junk', icon: inJunk ? 'notJunk' : 'junk', label: inJunk ? 'Not junk' : 'Junk', title: inJunk ? 'Not junk (!)' : 'Mark as junk (!)', run: () => onAction(inJunk ? 'notjunk' : 'junk') },
    { id: 'move', icon: 'move', label: 'Move to', title: 'Move to a mailbox', run: (e) => openMenuAt(e.currentTarget, moveItems()), menu: true },
    { id: 'unread', icon: 'unread', label: 'Mark unread', title: 'Mark as unread (U)', run: () => onAction('unseen') },
    { id: 'flag', icon: flagged ? 'starFilled' : 'star', label: flagged ? 'Unflag' : 'Flag', title: flagged ? 'Unflag (S)' : 'Flag (S)', run: () => flag(), on: flagged },
  ]
  /** More: the message's menu, led on touch screens and in a narrow pane by the toolbar's actions, by name. */
  const moreMenu = (): MenuItem[] => {
    if (!last) return []
    const own = messageMenu(last)
    if (!narrow && !matchMedia('(hover: none)').matches) return own
    const named: MenuItem[] = tools.map((t) =>
      t.menu ? { label: t.label, submenu: moveItems() } : { label: t.title.replace(/ \(.*\)$/, ''), disabled: t.disabled, danger: t.id === 'delete', onSelect: () => t.run(undefined as unknown as MouseEvent<HTMLButtonElement>) },
    )
    // The message's own read and flag items would repeat the ones just listed (each message's own More still has them).
    const rest = own.filter((i) => !('label' in i) || !/^(Mark as (un)?read|Flag|Unflag)$/.test(i.label))
    return [...named, { separator: true }, ...rest.filter((i, k) => !('separator' in i && i.separator && rest[k - 1] && 'separator' in rest[k - 1]))]
  }

  const toolbar = (
    <header className="ml-reader-bar">
      {narrow && (
        <button className="ml-icon" onClick={onBack} aria-label="Back to the list" title="Back (Esc)">
          <Icon name="back" size={18} />
        </button>
      )}
      <span className="nb-spacer" />
      {tools.map((t) => (
        <button key={t.id} data-minor={t.id === 'junk' || t.id === 'move' || t.id === 'unread' ? '' : undefined} className={`ml-icon ml-tool ${t.on ? 'is-on is-flagged' : ''}`} onClick={t.run} title={t.title} aria-label={t.label} aria-haspopup={t.menu ? 'menu' : undefined} disabled={t.disabled}>
          <Icon name={t.icon} />
          <span className="ml-tool-label" aria-hidden>
            {t.label}
          </span>
        </button>
      ))}
      <button className="ml-icon ml-tool" onClick={(e) => last && openMenuAt(e.currentTarget, moreMenu())} title="More actions" aria-label="More" aria-haspopup="menu">
        <Icon name="more" />
        <span className="ml-tool-label" aria-hidden>
          More
        </span>
      </button>
    </header>
  )

  return (
    <section className="ml-reader" aria-label="Conversation">
      {toolbar}
      <div className="ml-reader-scroll" ref={scroller}>
        {error && <p className="ml-problem copyable">{error}</p>}
        {!messages && !error && <p className="muted ml-loading">Loading…</p>}
        {messages && (
          <>
            <h2 className="ml-subject selectable">
              {subject || '(No subject)'}
              {messages.length > 1 && <span className="ml-count">{messages.length}</span>}
              {inMailbox('junk') && !inJunk && <span className="ml-tag">Junk</span>}
            </h2>
            {messages.map((m, i) => (
              <MessageCard
                key={m.id}
                account={account}
                m={m}
                open={open.has(m.id)}
                tall={i === messages.length - 1 || messages.length === 1}
                onToggle={() => setOpen((o) => (o.has(m.id) ? new Set([...o].filter((x) => x !== m.id)) : new Set([...o, m.id])))}
                onReply={(mode) => onReply(m, mode)}
                onMenu={(e) => openContextMenu(e, messageMenu(m))}
                onMore={(e) => openMenuAt(e.currentTarget, messageMenu(m))}
                onLoadImages={() => void loadImages(m)}
                onAlwaysImages={(domain) => alwaysImages(m, domain)}
                quotes={prefs.quotes}
                onSearch={onSearch}
              />
            ))}
            {last && !last.draft && (
              <div className="ml-answer">
                <button className="btn btn-small" onClick={() => onReply(last, 'reply')}>
                  <Icon name="reply" size={14} /> Reply
                </button>
                <button className="btn btn-small" onClick={() => onReply(last, 'replyAll')}>
                  <Icon name="replyAll" size={14} /> Reply all
                </button>
                <button className="btn btn-small" onClick={() => onReply(last, 'forward')}>
                  <Icon name="forward" size={14} /> Forward
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function MessageCard({
  account,
  m,
  open,
  tall,
  onToggle,
  onReply,
  onMenu,
  onMore,
  onLoadImages,
  onAlwaysImages,
  quotes,
  onSearch,
}: {
  account: number
  m: Message
  open: boolean
  tall: boolean
  onToggle: () => void
  onReply: (mode: ReplyMode) => void
  onMenu: (e: MouseEvent) => void
  onMore: (e: MouseEvent<HTMLButtonElement>) => void
  onLoadImages: () => void
  onAlwaysImages: (domain?: boolean) => void
  quotes: 'collapsed' | 'expanded'
  onSearch: (q: string) => void
}) {
  const sender = m.from[0]
  const ref = useMemo(() => messageRef(account, m), [account, m])
  const searchFrom = sender ? [{ label: `Mail from ${sender.email}`, onSelect: () => onSearch(`from:${sender.email}`) }] : []
  if (!open)
    return (
      <article className={`ml-msg is-folded ${m.seen ? '' : 'is-unread'}`} onClick={onToggle} onContextMenu={onMenu}>
        <Avatar person={sender} size={26} />
        <strong className="ml-msg-from">{nameOf(sender)}</strong>
        <span className="ml-msg-snippet">{m.draft ? <em className="ml-draft">Draft</em> : null} {m.preview}</span>
        <time className="ml-msg-date">{longDate(m.receivedAt)}</time>
      </article>
    )
  const recipients = (label: string, list: Message['to']) =>
    list.length > 0 && (
      <span>
        {label}{' '}
        {list.map((a) => (
          <PersonChip key={a.email} email={a.email} name={a.name ?? undefined} compact title={a.name ? `${a.name} <${a.email}>` : a.email} onMenu={(e) => showPerson(a, e)} />
        ))}
      </span>
    )
  return (
    <article className={`ml-msg ${m.seen ? '' : 'is-unread'}`} onContextMenu={(e) => !(e.target as Element).closest('a, input, textarea') && onMenu(e)}>
      {/* Not when the click ends a drag that selected the sender's address. */}
      <header className="ml-msg-head" onClick={(e) => !selectionIn(e.currentTarget) && onToggle()}>
        <Avatar person={sender} />
        <div className="ml-msg-who selectable">
          <div>
            {sender ? (
              <span onClick={(e) => e.stopPropagation()}>
                <PersonChip email={sender.email} name={sender.name ?? undefined} title={sender.name ? `${sender.name} <${sender.email}>` : sender.email} onMenu={(e) => showPerson(sender, e, searchFrom)} />
              </span>
            ) : (
              <strong>(No sender)</strong>
            )}
            {sender?.name && <span className="muted ml-msg-addr"> &lt;{sender.email}&gt;</span>}
            {m.draft && <em className="ml-draft">Draft</em>}
          </div>
          <div className="ml-msg-to muted" onClick={(e) => e.stopPropagation()}>
            {recipients('to', m.to)}
            {m.cc.length > 0 && <> · {recipients('cc', m.cc)}</>}
            {m.bcc.length > 0 && <> · {recipients('bcc', m.bcc)}</>}
          </div>
        </div>
        <time className="ml-msg-date" title={longDate(m.receivedAt)}>
          {longDate(m.receivedAt)}
        </time>
        {m.flagged && (
          <span className="ml-flag" title="Flagged">
            <Icon name="starFilled" size={14} />
          </span>
        )}
        <button className="ml-icon" onClick={(e) => (e.stopPropagation(), onReply(m.draft ? 'draft' : 'reply'))} title={m.draft ? 'Edit draft' : 'Reply'} aria-label={m.draft ? 'Edit draft' : 'Reply'}>
          <Icon name={m.draft ? 'compose' : 'reply'} />
        </button>
        <button className="ml-icon" onClick={(e) => (e.stopPropagation(), onMore(e))} title="More" aria-label="More">
          <Icon name="more" />
        </button>
      </header>
      {m.blocked > 0 && !m.images && (
        <div className="ml-images">
          <span>
            Remote images are hidden ({m.blocked}), so the sender can't see that you opened this{m.trackers > 0 ? `; ${m.trackers} tracking ${m.trackers === 1 ? 'pixel stays' : 'pixels stay'} out either way` : ''}.
          </span>
          <button className="link-btn" onClick={onLoadImages}>
            Load images
          </button>
          {sender && (
            <button className="link-btn" onClick={() => onAlwaysImages()}>
              Always for {sender.email}
            </button>
          )}
          {sender && (
            <button className="link-btn" onClick={() => onAlwaysImages(true)}>
              Always for @{sender.email.split('@').pop()}
            </button>
          )}
        </div>
      )}
      {m.images && m.trackers > 0 && <div className="ml-images muted">Images loaded; {m.trackers} tracking {m.trackers === 1 ? 'pixel was' : 'pixels were'} left out.</div>}
      {m.invite && <InviteCard invite={m.invite} message={ref} />}
      <div className="ml-msg-body selectable">
        {m.html !== null ? <MessageFrame html={m.html} images={m.images} tall={tall} quotes={quotes} /> : <PlainText text={m.text ?? ''} quotes={quotes} />}
        {m.truncated && <p className="muted ml-truncated">This message is long: the end of it is not shown.</p>}
      </div>
      {m.attachments.length > 0 && <Attachments account={account} list={m.attachments} />}
    </article>
  )
}

/** Downloads a file the browser already has, by a link click. */
function download(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
}

async function saveToSeafile(account: number, list: Attachment[]) {
  const folder = await pickFolder({ title: list.length === 1 ? `Save ${list[0].name} to` : `Save ${list.length} attachments to` })
  if (!folder) return
  try {
    const files = await Promise.all(list.map((a) => blobFile(account, a)))
    await uploadFiles(
      files.map((file) => ({ file, rel: '' })),
      folder,
    )
  } catch (e) {
    notify({ title: 'Could not save to Files', body: (e as Error).message, transient: true })
  }
}

/** Pictures Preview shows, and audio and video Player plays, from the attachment's address (as server/jmap.ts serves them inline). */
const SHOWABLE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i
const PLAYABLE = /^(audio\/(mpeg|mp3|mp4|aac|ogg|opus|wav|x-wav|wave|webm|flac|x-flac|x-m4a)|video\/(mp4|webm|ogg|quicktime))$/i
type Viewer = { app: 'pdf' | 'preview' | 'player'; label: string }
/** Which of MvL OS's own viewers opens an attachment, if one does (anything else downloads). */
function viewerOf(a: Attachment): Viewer | null {
  if (/^application\/(x-)?pdf$/i.test(a.type) || (/^application\/octet-stream$/i.test(a.type) && /\.pdf$/i.test(a.name))) return { app: 'pdf', label: 'Open in PDF' }
  if (SHOWABLE.test(a.type)) return { app: 'preview', label: 'Open in Preview' }
  if (PLAYABLE.test(a.type)) return { app: 'player', label: 'Open in Player' }
  return null
}

function Attachments({ account, list }: { account: number; list: Attachment[] }) {
  const wm = useWM()
  const seafile = !!getAccount().seafile
  /**
   * In a window of MvL OS's own, read through this site with the session (never a new browser
   * tab): PDF.js reads the bytes of the download (served as application/octet-stream), Preview
   * and Player the address that serves pictures, audio and video inline.
   */
  const open = (a: Attachment, v: Viewer) => {
    const name = a.name || 'attachment'
    if (v.app === 'pdf') wm.openNew('pdf', { src: blobUrl(account, { ...a, type: 'application/pdf' }), name, from: 'Mail' })
    else if (v.app === 'preview') wm.openNew('preview', { src: blobUrl(account, a, true), name, from: 'Mail' })
    else wm.openNew('player', { src: blobUrl(account, a, true), name, kind: /^audio\//i.test(a.type) ? 'audio' : 'video' })
  }
  const menu = (a: Attachment): MenuItem[] => {
    const v = viewerOf(a)
    return [
      ...(v ? [{ label: v.label, onSelect: () => open(a, v) }] : []),
      // A calendar or address-book file imports into Calendar or Contacts, as when opened from Files.
      ...(pimAppFor(a.name) ? [{ label: pimAppFor(a.name) === 'calendar' ? 'Open in Calendar' : 'Open in Contacts', onSelect: () => openImport(pimAppFor(a.name)!, [{ name: a.name, read: () => blobFile(account, a) }]) }] : []),
      { label: 'Download', onSelect: () => download(blobUrl(account, a), a.name) },
      { label: 'Save to Files (Seafile)…', disabled: !seafile, hint: seafile ? undefined : 'Link Seafile in Settings first', onSelect: () => void saveToSeafile(account, [a]) },
    ]
  }
  return (
    <div className="ml-attachments">
      {list.map((a) => {
        const v = viewerOf(a)
        return (
          <div key={a.blobId + a.name} className={`ml-att-item ${v ? 'is-openable' : ''}`}>
            <button
              className="ml-att"
              data-viewer={v?.app}
              // What opens in MvL OS opens at a click; anything else shows its menu.
              onClick={(e) => (v ? open(a, v) : openMenuAt(e.currentTarget, menu(a)))}
              onContextMenu={(e) => openContextMenu(e, menu(a))}
              title={`${a.name} · ${formatSize(a.size)}${v ? ` · ${v.label}` : ''}`}
            >
              {/^image\/(png|jpe?g|gif|webp)$/i.test(a.type) && a.size < 8_000_000 ? <img src={blobUrl(account, a, true)} alt="" loading="lazy" /> : <span className="ml-att-ext">{(a.name.split('.').pop() ?? '').slice(0, 4).toUpperCase() || 'FILE'}</span>}
              <span className="ml-att-name">{a.name}</span>
              <span className="ml-att-size">{formatSize(a.size)}</span>
            </button>
            {v && (
              <button className="ml-att-dl ml-icon" onClick={() => download(blobUrl(account, a), a.name)} aria-label={`Download ${a.name}`} title="Download">
                <Icon name="download" size={15} />
              </button>
            )}
          </div>
        )
      })}
      {list.length > 1 && (
        <div className="ml-att-all">
          <button className="link-btn" onClick={() => list.forEach((a) => download(blobUrl(account, a), a.name))}>
            Download all
          </button>
          {seafile && (
            <button className="link-btn" onClick={() => void saveToSeafile(account, list)}>
              Save all to Files…
            </button>
          )}
        </div>
      )}
    </div>
  )
}
