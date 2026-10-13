import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { signIn, useAccount } from '../../os/account'
import { openContextMenu, type MenuItem } from '../../os/ContextMenu'
import { ask } from '../../os/Dialogs'
import { useWM, type WinState } from '../../os/wm'
import {
  act,
  bootstrap,
  fetchMessage,
  fetchThread,
  fetchThreads,
  mailChangedElsewhere,
  nameOf,
  orderMailboxes,
  setMailPrefs,
  takeCompose,
  toAddresses,
  useMailAccounts,
  useMailPrefs,
  useMailVersion,
  type Address,
  type Boot,
  type Mailbox,
  type Message,
  type Op,
  type ThreadRow,
} from '../../data/mail'
import { findMail } from '../../data/pim'
import { Composer, type ComposeInit } from './Composer'
import { Avatar, htmlToText, shortDate } from './parts'
import { Reader, type ReplyMode } from './Reader'
import './mail.css'

// The Mail app: JMAP accounts (Fastmail and others) linked in Settings → Integrations → Mail,
// read and written through the site's server (server/jmap.ts), which keeps the tokens. Mailboxes
// on the left, conversations in the middle (a list drawn only where it shows, loading more as it
// scrolls), the conversation on the right, a message being written in its place. On a phone, or
// in a narrow window, one at a time: mailboxes, list, conversation, with a way back.
//
// props.account picks an account, props.email opens a message (a notification, openMail()),
// props.message opens one by its Message-ID (openMailByMessageId(), a task's link back), and
// props.compose takes a message to write from composeMail() (src/data/mail.ts); props.search
// searches (Spotlight's "Search Mail for …").

const ROW = 74
const PAGE = 50
/** What may be loaded at once when refreshing the list after a change. */
const REFRESH_MAX = 200
type View = 'boxes' | 'list' | 'thread' | 'compose'

const ROLE_GLYPH: Record<string, string> = { inbox: '📥', drafts: '📝', sent: '📤', archive: '🗄', junk: '⚠', trash: '🗑' }
const DRAG_TYPE = 'application/x-mvlos-mail'

export function Mail({ win }: { win: WinState }) {
  const me = useAccount()
  const wm = useWM()
  const { accounts, error: accountsError } = useMailAccounts()
  const prefs = useMailPrefs()
  const root = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [view, setView] = useState<View>('list')
  const [accountId, setAccountId] = useState<number | null>(() => (win.props.account ? Number(win.props.account) : null))
  const account = accounts?.find((a) => a.id === accountId) ?? accounts?.[0] ?? null
  const acc = account?.id ?? null
  const [boot, setBoot] = useState<Boot | null>(null)
  const [mailbox, setMailbox] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [typed, setTyped] = useState('')
  const [rows, setRows] = useState<ThreadRow[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  // Refresh spins for at least a turn, so a quick answer still shows that it looked.
  const [refreshing, setRefreshing] = useState(false)
  const spunSince = useRef(0)
  useEffect(() => {
    if (!refreshing) return
    if (!spunSince.current) spunSince.current = Date.now()
    if (loading) return
    const t = setTimeout(() => {
      spunSince.current = 0
      setRefreshing(false)
    }, Math.max(0, 700 - (Date.now() - spunSince.current)))
    return () => clearTimeout(t)
  }, [refreshing, loading])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null) // a thread id
  const [compose, setCompose] = useState<ComposeInit | null>(null)
  const version = useMailVersion()
  const searchBox = useRef<HTMLInputElement>(null)

  // How wide the window is (once the app itself shows, not its sign-in or linking screen).
  const showing = me.status === 'user' && !!accounts?.length
  useEffect(() => {
    const el = root.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 720))
    ro.observe(el)
    return () => ro.disconnect()
  }, [showing])

  // Mailboxes and identities, for the account in view (again after any change: unread counts).
  useEffect(() => {
    if (acc === null) return
    let live = true
    bootstrap(acc)
      .then((b) => {
        if (!live) return
        setBoot(b)
        setMailbox((m) => (m && b.mailboxes.some((x) => x.id === m) ? m : (b.mailboxes.find((x) => x.role === 'inbox')?.id ?? b.mailboxes[0]?.id ?? null)))
      })
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [acc, version])
  useEffect(() => {
    setBoot(null)
    setMailbox(null)
    setRows([])
    setSelected(null)
    setSearch('')
    setTyped('')
  }, [acc])

  // The list: the first page (or as much as was loaded, after a change), then more on scrolling.
  const loaded = useRef(0)
  loaded.current = rows.length
  const listKey = `${acc}|${mailbox}|${search}`
  const lastKey = useRef('')
  useEffect(() => {
    if (acc === null || (!mailbox && !search)) return
    let live = true
    const fresh = lastKey.current !== listKey
    lastKey.current = listKey
    setLoading(true)
    if (fresh) setError(null)
    fetchThreads(acc, { mailbox: search ? null : mailbox, q: search || undefined, position: 0, limit: fresh ? PAGE : Math.min(REFRESH_MAX, Math.max(PAGE, loaded.current)) })
      .then((r) => {
        if (!live) return
        setRows(r.rows)
        setTotal(r.total)
        if (fresh && !narrow) setSelected((s) => (s && r.rows.some((x) => x.threadId === s) ? s : null))
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [listKey, version]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (lastKey.current !== listKey) setRows([])
  }, [listKey])

  const more = useRef(false)
  const loadMore = useCallback(() => {
    if (acc === null || more.current || loading || (total !== null && rows.length >= total)) return
    more.current = true
    fetchThreads(acc, { mailbox: search ? null : mailbox, q: search || undefined, position: rows.length, limit: PAGE })
      .then((r) => {
        setRows((list) => {
          const seen = new Set(list.map((x) => x.threadId))
          return [...list, ...r.rows.filter((x) => !seen.has(x.threadId))]
        })
        setTotal(r.total)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => (more.current = false))
  }, [acc, mailbox, search, rows.length, total, loading])

  // Opened from elsewhere: on a message, or with one to write.
  useEffect(() => {
    if (win.props.account && accounts?.some((a) => a.id === Number(win.props.account))) setAccountId(Number(win.props.account))
    // Spotlight's "Search Mail for …".
    if (win.props.search) runSearch(win.props.search)
    const req = takeCompose(win.props.compose)
    if (req) startCompose({ to: toAddresses(req.to), cc: toAddresses(req.cc), bcc: toAddresses(req.bcc), subject: req.subject ?? '', text: req.body ?? '', files: req.attachments, title: 'New message' })
  }, [win.props.t, accounts]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = win.props.email
    const target = win.props.account ? Number(win.props.account) : acc
    if (!id || target === null || target !== acc) return
    let live = true
    fetchMessage(acc, id, false)
      .then((m) => {
        if (!live) return
        setSearch('')
        setTyped('')
        if (m.mailboxIds[0]) setMailbox(boot?.mailboxes.find((b) => b.role === 'inbox' && m.mailboxIds.includes(b.id))?.id ?? m.mailboxIds[0])
        setSelected(m.threadId)
        setView('thread')
      })
      .catch((e: Error) => live && setError(e.message))
      // Shown once: a window restored later doesn't go back to it.
      .finally(() => live && wm.setProps(win.pid, { ...win.props, email: undefined }))
    return () => {
      live = false
    }
  }, [win.props.t, acc]) // eslint-disable-line react-hooks/exhaustive-deps

  // Opened on a Message-ID (a task's or an event's link back): found in whichever account has it.
  useEffect(() => {
    const mid = win.props.message
    if (!mid || !accounts?.length) return
    let live = true
    findMail(mid)
      .then((r) => live && wm.setProps(win.pid, { ...win.props, message: undefined, account: String(r.account), email: r.id, t: String(Date.now()) }))
      .catch((e: Error) => {
        if (!live) return
        setError(/not in your mail/.test(e.message) ? 'That message is no longer in your mail.' : e.message)
        wm.setProps(win.pid, { ...win.props, message: undefined })
      })
    return () => {
      live = false
    }
  }, [win.props.t, accounts]) // eslint-disable-line react-hooks/exhaustive-deps

  const roleOf = (role: string) => boot?.mailboxes.find((b) => b.role === role)?.id ?? null
  const current = boot?.mailboxes.find((b) => b.id === mailbox) ?? null
  const selectedRow = rows.find((r) => r.threadId === selected) ?? null

  /** A change to conversations: off the list at once when they leave it, the next one selected. */
  const change = async (op: Op, threadIds: string[], opts: { to?: string } = {}) => {
    if (acc === null || !threadIds.length) return
    if (op === 'destroy' && !(await ask({ title: threadIds.length === 1 ? 'Delete this conversation for good?' : `Delete ${threadIds.length} conversations for good?`, body: 'They are gone from Trash and cannot be brought back.', confirm: 'Delete', danger: true }))) return
    const leaves = op === 'archive' || op === 'trash' || op === 'junk' || op === 'notjunk' || op === 'destroy' || (op === 'move' && opts.to !== mailbox)
    const before = rows
    if (leaves && !search) {
      const i = rows.findIndex((r) => threadIds.includes(r.threadId))
      const rest = rows.filter((r) => !threadIds.includes(r.threadId))
      setRows(rest)
      if (selected && threadIds.includes(selected)) {
        const next = rest[Math.min(i, rest.length - 1)] ?? null
        setSelected(narrow ? null : (next?.threadId ?? null))
        if (narrow) setView('list')
      }
    } else if (op === 'seen' || op === 'unseen') setRows((list) => list.map((r) => (threadIds.includes(r.threadId) ? { ...r, seen: op === 'seen' } : r)))
    try {
      await act(acc, op, { threadIds, from: search ? null : mailbox, to: opts.to })
    } catch (e) {
      setRows(before)
      setError((e as Error).message)
    }
  }
  const flagRow = (r: ThreadRow) => {
    if (acc === null) return
    setRows((list) => list.map((x) => (x.threadId === r.threadId ? { ...x, flagged: !r.flagged } : x)))
    act(acc, r.flagged ? 'unflag' : 'flag', r.flagged ? { threadIds: [r.threadId] } : { emailIds: [r.id] }).catch((e: Error) => setError(e.message))
  }

  // --- Writing ---------------------------------------------------------------------------------
  const own = useMemo(() => new Set((boot?.identities ?? []).map((i) => i.email.toLowerCase())), [boot])
  const startCompose = (c: Partial<ComposeInit> & { title: string }) => {
    setCompose({ key: crypto.randomUUID(), to: [], cc: [], bcc: [], subject: '', text: signature(c.identityId), attachments: [], focus: c.to?.length ? 'text' : 'to', ...c })
    setView('compose')
  }
  const signature = (identityId?: string) => {
    const sig = (boot?.identities.find((i) => i.id === identityId) ?? boot?.identities[0])?.textSignature?.trim()
    return sig ? `\n\n${/^--\s/.test(sig) ? sig : `-- \n${sig}`}` : ''
  }
  const reply = (m: Message, mode: ReplyMode) => {
    const body = m.text ?? (m.html ? htmlToText(m.html) : '')
    const sender = m.from[0]
    // Answer from the identity the message was sent to.
    const identity = boot?.identities.find((i) => [...m.to, ...m.cc, ...m.bcc].some((a) => a.email.toLowerCase() === i.email.toLowerCase())) ?? boot?.identities[0]
    const notMe = (list: Address[]) => list.filter((a) => !own.has(a.email.toLowerCase()))
    const subject = (prefix: string) => (new RegExp(`^${prefix}:`, 'i').test(m.subject.trim()) ? m.subject : `${prefix}: ${m.subject}`)
    if (mode === 'draft') {
      return startCompose({ title: 'Draft', identityId: identity?.id, to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, text: body, attachments: m.attachments.map((a) => ({ key: a.blobId, name: a.name, type: a.type, size: a.size, blobId: a.blobId })), draftId: m.id, inReplyTo: m.inReplyTo, references: m.references, focus: 'text' })
    }
    if (mode === 'forward') {
      const head = ['---------- Forwarded message ---------', `From: ${sender ? (sender.name ? `${sender.name} <${sender.email}>` : sender.email) : ''}`, `Date: ${new Date(m.receivedAt).toLocaleString()}`, `Subject: ${m.subject}`, `To: ${m.to.map((a) => a.email).join(', ')}`].join('\n')
      return startCompose({ title: 'Forward', identityId: identity?.id, subject: subject('Fwd'), text: `${signature(identity?.id)}\n\n${head}\n\n${body}`, attachments: m.attachments.map((a) => ({ key: a.blobId, name: a.name, type: a.type, size: a.size, blobId: a.blobId })), forwardOf: m.id, focus: 'to' })
    }
    const back = m.replyTo.length ? m.replyTo : m.from
    const fromMe = sender && own.has(sender.email.toLowerCase())
    const to = fromMe ? m.to : back
    const quoted = `On ${new Date(m.receivedAt).toLocaleString()}, ${nameOf(sender)} wrote:\n${body
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')}`
    startCompose({
      title: mode === 'replyAll' ? 'Reply all' : 'Reply',
      identityId: identity?.id,
      to,
      cc: mode === 'replyAll' ? notMe([...(fromMe ? [] : m.to), ...m.cc]).filter((a) => !to.some((t) => t.email.toLowerCase() === a.email.toLowerCase())) : [],
      subject: subject('Re'),
      text: `\n${signature(identity?.id)}\n\n${quoted}`,
      inReplyTo: m.messageId,
      references: [...m.references, ...m.messageId],
      replyOf: m.id,
      focus: 'text',
    })
  }
  const closeCompose = () => {
    setCompose(null)
    setView(selected ? 'thread' : 'list')
    root.current?.focus({ preventScroll: true })
  }
  const replyToSelected = async (mode: ReplyMode) => {
    if (acc === null || !selected) return
    try {
      const t = await fetchThread(acc, selected)
      const last = t.messages.at(-1)
      if (last) reply(last, mode)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // --- Keyboard --------------------------------------------------------------------------------
  const listEl = useRef<HTMLDivElement>(null)
  const step = (d: 1 | -1) => {
    if (!rows.length) return
    const i = rows.findIndex((r) => r.threadId === selected)
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + d))]
    setSelected(next.threadId)
    if (!narrow) setView('thread')
    const el = listEl.current
    const idx = rows.indexOf(next)
    if (el && (idx * ROW < el.scrollTop || (idx + 1) * ROW > el.scrollTop + el.clientHeight)) el.scrollTop = idx * ROW - el.clientHeight / 2 + ROW / 2
    if (idx > rows.length - 10) loadMore()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || compose) return
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return
    const sel = selected ? [selected] : []
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        step(1)
        break
      case 'k':
      case 'ArrowUp':
        step(-1)
        break
      case 'Enter':
      case 'o':
        if (selected) setView('thread')
        break
      case 'Escape':
        if (view === 'thread' && narrow) setView('list')
        else if (search) (setSearch(''), setTyped(''))
        else return
        break
      case 'e':
        void change('archive', sel)
        break
      case '#':
      case 'Delete':
        void change(mailbox === roleOf('trash') ? 'destroy' : 'trash', sel)
        break
      case 's':
        if (selectedRow) flagRow(selectedRow)
        break
      case 'u':
        if (selectedRow) void change(selectedRow.seen ? 'unseen' : 'seen', sel)
        break
      case '!':
        void change(mailbox === roleOf('junk') ? 'notjunk' : 'junk', sel)
        break
      case 'r':
        void replyToSelected('reply')
        break
      case 'a':
        void replyToSelected('replyAll')
        break
      case 'f':
        void replyToSelected('forward')
        break
      case 'c':
        startCompose({ title: 'New message' })
        break
      case '/':
        searchBox.current?.focus()
        searchBox.current?.select()
        break
      default:
        return
    }
    e.preventDefault()
  }

  // --- Menus and dragging ----------------------------------------------------------------------
  const moveItems = (threadIds: string[]): MenuItem[] =>
    orderMailboxes(boot?.mailboxes ?? [])
      .filter(({ box }) => box.id !== mailbox && box.role !== 'drafts')
      .map(({ box, depth }) => ({ label: `${'  '.repeat(depth)}${box.name}`, onSelect: () => void change('move', threadIds, { to: box.id }) }))
  const rowMenu = (e: MouseEvent, r: ThreadRow) => {
    const ids = [r.threadId]
    const inTrash = mailbox === roleOf('trash')
    const inJunk = mailbox === roleOf('junk')
    openContextMenu(e, [
      { label: 'Open', onSelect: () => (setSelected(r.threadId), setView('thread')) },
      { separator: true },
      { label: r.seen ? 'Mark as unread' : 'Mark as read', onSelect: () => void change(r.seen ? 'unseen' : 'seen', ids) },
      { label: r.flagged ? 'Unflag' : 'Flag', onSelect: () => flagRow(r) },
      { label: 'Move to', submenu: moveItems(ids) },
      ...(roleOf('archive') && mailbox !== roleOf('archive') ? [{ label: 'Archive', shortcut: 'E', onSelect: () => void change('archive', ids) }] : []),
      { label: inJunk ? 'Not junk' : 'Mark as junk', onSelect: () => void change(inJunk ? 'notjunk' : 'junk', ids) },
      { separator: true },
      inTrash ? { label: 'Delete for good…', danger: true, onSelect: () => void change('destroy', ids) } : { label: 'Delete', shortcut: '#', danger: true, onSelect: () => void change('trash', ids) },
      { separator: true },
      ...(r.from[0] ? [{ label: `Mail from ${r.from[0].email}`, onSelect: () => runSearch(`from:${r.from[0].email}`) }] : []),
    ])
  }
  const [dropOn, setDropOn] = useState<string | null>(null)
  const dropProps = (box: Mailbox) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE) || box.id === mailbox) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropOn(box.id)
    },
    onDragLeave: () => setDropOn((d) => (d === box.id ? null : d)),
    onDrop: (e: DragEvent) => {
      setDropOn(null)
      const raw = e.dataTransfer.getData(DRAG_TYPE)
      if (!raw) return
      e.preventDefault()
      try {
        const d = JSON.parse(raw) as { account: number; threadIds: string[] }
        if (d.account !== acc) return
        if (box.role === 'trash') void change('trash', d.threadIds)
        else if (box.role === 'junk') void change('junk', d.threadIds)
        else void change('move', d.threadIds, { to: box.id })
      } catch {
        /* not ours */
      }
    },
  })

  const runSearch = (q: string) => {
    setTyped(q)
    setSearch(q.trim())
    setSelected(null)
    setView('list')
  }
  const pickMailbox = (id: string) => {
    setMailbox(id)
    setSearch('')
    setTyped('')
    setSelected(null)
    setView('list')
    if (listEl.current) listEl.current.scrollTop = 0
  }

  // --- Empty states ----------------------------------------------------------------------------
  if (me.status !== 'user' || (accounts && !accounts.length))
    return (
      <div className="ml ml-empty">
        <div className="ml-empty-box">
          <span className="ml-empty-glyph">✉</span>
          <h3>Mail</h3>
          {me.status !== 'user' ? (
            <>
              <p className="muted">Your mail shows here once you sign in.</p>
              {me.status === 'anon' && (
                <button className="btn btn-primary" onClick={signIn}>
                  Sign in with GitHub
                </button>
              )}
            </>
          ) : (
            <>
              <p className="muted">Link Fastmail or another JMAP mail server with an API token to read and write mail here.</p>
              <button className="btn btn-primary" onClick={() => wm.open('settings', { section: 'integrations', sub: 'mail', t: String(Date.now()) })}>
                Link a mail account…
              </button>
            </>
          )}
          {accountsError && <p className="ml-problem">{accountsError}</p>}
        </div>
      </div>
    )

  const showSide = narrow ? view === 'boxes' : true
  const showList = narrow ? view === 'list' : true
  const showRight = narrow ? view === 'thread' || view === 'compose' : true

  return (
    <div ref={root} className={`ml ${narrow ? 'is-narrow' : ''}`} tabIndex={-1} onKeyDown={onKey}>
      <header className="ml-toolbar">
        {narrow && (
          <button className={`ml-icon ${view === 'boxes' ? 'is-on' : ''}`} onClick={() => setView(view === 'boxes' ? 'list' : 'boxes')} aria-label="Mailboxes" title="Mailboxes">
            ☰
          </button>
        )}
        <form
          className="ml-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault()
            runSearch(typed)
          }}
        >
          <input
            ref={searchBox}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                runSearch('')
                root.current?.focus({ preventScroll: true })
              }
            }}
            placeholder="Search mail (/)"
            title="Words, or from: to: subject: has:attachment is:unread is:flagged after:2026-01-31 before:2026-12-31"
            aria-label="Search mail"
            spellCheck={false}
          />
          {typed && (
            <button type="button" className="ml-search-x" onClick={() => runSearch('')} aria-label="Clear the search">
              ×
            </button>
          )}
        </form>
        {loading && <span className="ca-spin" aria-label="Loading" />}
        <span className="nb-spacer" />
        <button
          className={`ml-icon ml-refresh ${refreshing ? 'is-spinning' : ''}`}
          onClick={() => {
            setError(null)
            setRefreshing(true)
            mailChangedElsewhere()
          }}
          aria-label="Refresh"
          aria-busy={refreshing}
          title="Refresh"
        >
          <span aria-hidden="true">↻</span>
        </button>
        <button className="btn btn-small btn-primary" onClick={() => startCompose({ title: 'New message' })} title="New message (C)" disabled={!boot}>
          ✎ {narrow ? '' : 'New'}
        </button>
      </header>
      {error && (
        <p className="ml-problem">
          {error}
          <button className="ca-x" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </p>
      )}
      <div className="ml-main">
        {showSide && (
          <aside className="ml-side">
            {accounts && accounts.length > 1 && (
              <div className="ml-accounts">
                {accounts.map((a) => (
                  <button key={a.id} className={a.id === acc ? 'is-on' : ''} onClick={() => setAccountId(a.id)} title={a.username}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
            <nav className="ml-boxes" aria-label="Mailboxes">
              {orderMailboxes(boot?.mailboxes ?? []).map(({ box, depth }) => (
                <button key={box.id} className={`ml-box ${box.id === mailbox && !search ? 'is-on' : ''} ${dropOn === box.id ? 'is-drop' : ''}`} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => pickMailbox(box.id)} {...dropProps(box)}>
                  <span className="ml-box-glyph" aria-hidden>
                    {ROLE_GLYPH[box.role ?? ''] ?? '📁'}
                  </span>
                  <span className="ml-box-name">{box.name}</span>
                  {box.role === 'drafts' ? box.total > 0 && <span className="ml-box-count is-quiet">{box.total}</span> : box.unread > 0 && box.role !== 'trash' && box.role !== 'sent' && <span className={`ml-box-count ${box.role === 'junk' ? 'is-quiet' : ''}`}>{box.unread}</span>}
                </button>
              ))}
            </nav>
            <div className="ml-side-foot">
              <label className="ml-check" title="Opening a conversation marks it as read">
                <input type="checkbox" checked={prefs.markRead} onChange={(e) => setMailPrefs({ markRead: e.target.checked })} /> Mark as read when opened
              </label>
              <button className="link-btn" onClick={() => wm.open('settings', { section: 'integrations', sub: 'mail', t: String(Date.now()) })}>
                Mail accounts…
              </button>
            </div>
          </aside>
        )}
        {showList && (
          <section className="ml-listpane" aria-label="Conversations">
            <div className="ml-list-head">
              <strong>{search ? `Search: ${search}` : (current?.name ?? '')}</strong>
              {total !== null && <span className="muted">{total === 1 ? '1 conversation' : `${total} conversations`}</span>}
            </div>
            <ThreadList
              rows={rows}
              total={total}
              selected={selected}
              listRef={listEl}
              account={acc}
              trash={mailbox === roleOf('trash')}
              onOpen={(r) => {
                setSelected(r.threadId)
                setView('thread')
              }}
              onMenu={rowMenu}
              onMore={loadMore}
              onArchive={roleOf('archive') && mailbox !== roleOf('archive') ? (r) => void change('archive', [r.threadId]) : null}
              onDelete={(r) => void change(mailbox === roleOf('trash') ? 'destroy' : 'trash', [r.threadId])}
              onFlag={flagRow}
              onSeen={(r) => void change(r.seen ? 'unseen' : 'seen', [r.threadId])}
              empty={loading ? 'Loading…' : search ? 'Nothing found.' : 'Nothing here.'}
            />
          </section>
        )}
        {showRight && (
          <div className="ml-right">
            {view === 'compose' && compose && boot && acc !== null ? (
              <Composer key={compose.key} account={acc} boot={boot} init={compose} narrow={narrow} onClose={closeCompose} />
            ) : selected && boot && acc !== null ? (
              <Reader
                account={acc}
                threadId={selected}
                boot={boot}
                mailbox={search ? null : mailbox}
                narrow={narrow}
                onBack={() => setView('list')}
                onAction={(op, opts) => void change(op, [selected], opts)}
                onReply={reply}
                onSearch={runSearch}
              />
            ) : (
              <div className="ml-nothing muted">{rows.length ? 'Pick a conversation' : ''}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** The conversations, drawn only where they show; more are asked for near the end. */
function ThreadList(props: {
  rows: ThreadRow[]
  total: number | null
  selected: string | null
  listRef: RefObject<HTMLDivElement | null>
  account: number | null
  trash: boolean
  onOpen: (r: ThreadRow) => void
  onMenu: (e: MouseEvent, r: ThreadRow) => void
  onMore: () => void
  onArchive: ((r: ThreadRow) => void) | null
  onDelete: (r: ThreadRow) => void
  onFlag: (r: ThreadRow) => void
  onSeen: (r: ThreadRow) => void
  empty: string
}) {
  const { rows, total, selected, listRef, onMore } = props
  const [scroll, setScroll] = useState({ top: 0, height: 600 })
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setScroll({ top: el.scrollTop, height: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [listRef])
  const more = total === null ? rows.length > 0 && rows.length % PAGE === 0 : rows.length < total
  const first = Math.max(0, Math.floor(scroll.top / ROW) - 5)
  const last = Math.min(rows.length, Math.ceil((scroll.top + scroll.height) / ROW) + 5)
  useEffect(() => {
    if (more && last >= rows.length - 10) onMore()
  }, [last, rows.length, more]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ml-list" ref={listRef} onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })} role="listbox" aria-label="Conversations">
      {!rows.length && <p className="muted ml-list-empty">{props.empty}</p>}
      <div style={{ height: rows.length * ROW + (more ? 40 : 0), position: 'relative' }}>
        {rows.slice(first, last).map((r, k) => {
          const i = first + k
          const who = r.draft ? 'Draft' : r.from.map((a) => nameOf(a)).join(', ') || '(No sender)'
          return (
            <div
              key={r.threadId}
              role="option"
              aria-selected={r.threadId === selected}
              className={`ml-row ${r.threadId === selected ? 'is-on' : ''} ${r.seen ? '' : 'is-unread'}`}
              style={{ top: i * ROW, height: ROW }}
              onClick={() => props.onOpen(r)}
              onContextMenu={(e) => props.onMenu(e, r)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ account: props.account, threadIds: [r.threadId] }))
                e.dataTransfer.setData('text/plain', r.subject)
                e.dataTransfer.effectAllowed = 'move'
              }}
            >
              <Avatar person={r.from[0]} size={30} />
              <div className="ml-row-text">
                <div className="ml-row-top">
                  <span className="ml-row-from">{who}</span>
                  {r.count > 1 && <span className="ml-row-count">{r.count}</span>}
                  <span className="nb-spacer" />
                  {r.hasAttachment && <span className="ml-row-mark" title="Attachments">📎</span>}
                  {r.answered && <span className="ml-row-mark" title="Answered">↩</span>}
                  {r.flagged && <span className="ml-row-mark ml-flag" title="Flagged">★</span>}
                  <time className="ml-row-date">{shortDate(r.receivedAt)}</time>
                </div>
                <div className="ml-row-subject">{r.subject || '(No subject)'}</div>
                <div className="ml-row-preview">{r.preview}</div>
              </div>
              <div className="ml-row-actions" onClick={(e) => e.stopPropagation()}>
                {props.onArchive && (
                  <button className="ml-icon" title="Archive (E)" aria-label="Archive" onClick={() => props.onArchive!(r)}>
                    ⤓
                  </button>
                )}
                <button className="ml-icon" title={props.trash ? 'Delete for good' : 'Delete (#)'} aria-label="Delete" onClick={() => props.onDelete(r)}>
                  🗑
                </button>
                <button className="ml-icon" title={r.seen ? 'Mark as unread (U)' : 'Mark as read (U)'} aria-label={r.seen ? 'Mark as unread' : 'Mark as read'} onClick={() => props.onSeen(r)}>
                  {r.seen ? '●' : '○'}
                </button>
                <button className="ml-icon" title="Flag (S)" aria-label="Flag" onClick={() => props.onFlag(r)}>
                  {r.flagged ? '★' : '☆'}
                </button>
              </div>
            </div>
          )
        })}
        {more && (
          <div className="ml-more muted" style={{ top: rows.length * ROW }}>
            Loading more…
          </div>
        )}
      </div>
    </div>
  )
}

/** For the window menu: compose from the app's own menu, and its settings. */
export const mailMenu = (_w: WinState, wm: ReturnType<typeof useWM>): MenuItem[] => [{ label: 'Mail accounts…', onSelect: () => wm.open('settings', { section: 'integrations', sub: 'mail', t: String(Date.now()) }) }]
