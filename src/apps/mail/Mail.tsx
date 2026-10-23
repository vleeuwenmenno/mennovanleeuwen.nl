import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as RPointerEvent, type RefObject } from 'react'
import { signIn, useAccount } from '../../os/account'
import { openContextMenu, openMenuAt, type MenuItem } from '../../os/ContextMenu'
import { ask } from '../../os/Dialogs'
import { setDragGhost } from '../../os/dnd'
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
  signatureFor,
  takeCompose,
  toAddresses,
  useMailAccounts,
  useMailPrefs,
  useMailVersion,
  type Address,
  type Boot,
  type Identity,
  type Mailbox,
  type Message,
  type Op,
  type ThreadRow,
} from '../../data/mail'
import { findMail } from '../../data/pim'
import { Composer, type ComposeInit } from './Composer'
import { Icon, mailboxIcon, type IconName } from './icons'
import { Avatar, htmlToText, shortDate } from './parts'
import { Reader, type ReplyMode } from './Reader'
import './mail.css'

// The Mail app: JMAP accounts (Fastmail and others) linked in Settings → Integrations → Mail,
// read and written through the site's server (server/jmap.ts), which keeps the tokens. Mailboxes
// on the left, conversations in the middle (a list drawn only where it shows, loading more as it
// scrolls), the conversation on the right, a message being written in its place. On a phone, or
// in a narrow window, one at a time: mailboxes, list, conversation, with a way back.
//
// Selecting several conversations, as in Files and Photos: Ctrl or Cmd+click (or the circle on a
// row's picture) takes one in or out, Shift+click (or Shift+↑/↓) a range, Ctrl+A all of those
// loaded, Esc none. On a touch screen a long press starts selecting, and taps then add and take
// away. With two or more the right side says how many, with what can be done to them all; the
// toolbar keys, the row menu and dragging onto a mailbox act on all of them too (one request, one
// Email/set on the server). The selection outlives new mail arriving, not a change of mailbox.
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

const DRAG_TYPE = 'application/x-mvlos-mail'
const LONG_PRESS_MS = 500
const NONE: ReadonlySet<string> = new Set()
const plural = (n: number) => (n === 1 ? '1 message' : `${n} messages`)

export function Mail({ win }: { win: WinState }) {
  const me = useAccount()
  const wm = useWM()
  const { accounts, error: accountsError } = useMailAccounts()
  const prefs = useMailPrefs()
  const root = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [view, setView] = useState<View>('list')
  const [accountId, setAccountId] = useState<number | null>(() => (win.props.account ? Number(win.props.account) : null))
  const account = accounts?.find((a) => a.id === accountId) ?? accounts?.find((a) => a.id === prefs.defaultAccount) ?? accounts?.[0] ?? null
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
  // Several selected (thread ids; two or more, or any while selecting with a finger). `selected`
  // stays the one that was open, shown again when the selection is let go.
  const [picked, setPicked] = useState<ReadonlySet<string>>(NONE)
  const [fingerPick, setFingerPick] = useState(false)
  /** Where a Shift range starts, and where Shift+↑/↓ has got to. */
  const anchor = useRef<string | null>(null)
  const lead = useRef<string | null>(null)
  const picking = picked.size > 1 || (fingerPick && picked.size > 0)
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
    unpick()
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
  // A refresh (new mail, a change elsewhere) keeps the selection, less what has left the list.
  useEffect(() => {
    if (!picked.size || !rows.length) return
    const here = new Set(rows.map((r) => r.threadId))
    if ([...picked].every((id) => here.has(id))) return
    const left = new Set([...picked].filter((id) => here.has(id)))
    setPicked(left.size > 1 || (fingerPick && left.size) ? left : NONE)
    if (!left.size) setFingerPick(false)
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

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
        unpick()
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

  /** A change to conversations: off the list at once when they leave it, the next one selected. */
  const change = async (op: Op, threadIds: string[], opts: { to?: string } = {}) => {
    if (acc === null || !threadIds.length) return
    if (op === 'destroy' && !(await ask({ title: threadIds.length === 1 ? 'Delete this conversation for good?' : `Delete ${threadIds.length} conversations for good?`, body: 'They are gone from Trash and cannot be brought back.', confirm: 'Delete', danger: true }))) return
    const leaves = op === 'archive' || op === 'trash' || op === 'junk' || op === 'notjunk' || op === 'destroy' || (op === 'move' && opts.to !== mailbox)
    const before = rows
    // Moved away, the selection is done with; marked or flagged, it stays for the next thing.
    if (leaves && threadIds.some((id) => picked.has(id))) unpick()
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
  const flagRow = (r: ThreadRow) => flagRows([r], !r.flagged)
  /** Flags the newest message of each conversation (as Fastmail does), or takes every flag in them away. */
  const flagRows = (list: ThreadRow[], on: boolean) => {
    if (acc === null || !list.length) return
    const ids = new Set(list.map((r) => r.threadId))
    const before = rows
    setRows((all) => all.map((x) => (ids.has(x.threadId) ? { ...x, flagged: on } : x)))
    act(acc, on ? 'flag' : 'unflag', on ? { emailIds: list.map((r) => r.id) } : { threadIds: [...ids] }).catch((e: Error) => {
      setRows(before)
      setError(e.message)
    })
  }

  // --- Selecting several -----------------------------------------------------------------------
  function unpick() {
    setPicked(NONE)
    setFingerPick(false)
    lead.current = null
  }
  /** The conversations an action is for: those selected, in list order, or the open one. */
  const targets = (): string[] => (picking ? rows.filter((r) => picked.has(r.threadId)).map((r) => r.threadId) : selected ? [selected] : [])
  const rowsOf = (ids: string[]) => rows.filter((r) => ids.includes(r.threadId))
  /** What is selected now, as a set to change: the selection, or the open conversation. */
  const pickedNow = () => new Set(picking ? picked : selected ? [selected] : [])
  /** A new selection: two or more (or any, with a finger) show as selected; one is simply opened. */
  const applyPick = (next: Set<string>, finger = fingerPick) => {
    if (finger) {
      setPicked(next.size ? next : NONE)
      setFingerPick(next.size > 0)
      return
    }
    if (next.size > 1) return setPicked(next)
    setPicked(NONE)
    const only = [...next][0] ?? null
    setSelected(only)
    if (only && !narrow) setView('thread')
  }
  const togglePick = (id: string) => {
    const next = pickedNow()
    if (next.has(id)) next.delete(id)
    else next.add(id)
    anchor.current = id
    lead.current = id
    applyPick(next)
  }
  /** From the anchor to `id`, added to what is selected (`add`) or instead of it. */
  const pickRange = (id: string, add: boolean) => {
    const from = anchor.current ?? selected ?? id
    const a = rows.findIndex((r) => r.threadId === from)
    const b = rows.findIndex((r) => r.threadId === id)
    if (b < 0) return
    if (a < 0) anchor.current = id
    const span = rows.slice(Math.min(a < 0 ? b : a, b), Math.max(a, b) + 1).map((r) => r.threadId)
    lead.current = id
    applyPick(new Set([...(add ? pickedNow() : []), ...span]))
  }
  const pickAll = () => {
    if (!rows.length) return
    anchor.current = rows[0].threadId
    lead.current = rows[rows.length - 1].threadId
    applyPick(new Set(rows.map((r) => r.threadId)))
  }
  /** A click on a row: open it, or (Ctrl, Cmd, Shift, or while selecting with a finger) select. */
  const clickRow = (r: ThreadRow, e: MouseEvent) => {
    if (e.shiftKey) return pickRange(r.threadId, e.ctrlKey || e.metaKey)
    if (e.ctrlKey || e.metaKey || fingerPick) return togglePick(r.threadId)
    unpick()
    anchor.current = r.threadId
    setSelected(r.threadId)
    setView('thread')
  }
  const checkRow = (r: ThreadRow, e: MouseEvent) => (e.shiftKey ? pickRange(r.threadId, true) : togglePick(r.threadId))
  // A finger held on a row starts selecting (the click its lift sends is not also a tap).
  const lastPointer = useRef('mouse')
  const suppressClick = useRef(false)
  const pressRow = (r: ThreadRow, e: RPointerEvent) => {
    lastPointer.current = e.pointerType
    suppressClick.current = false
    if (e.pointerType !== 'touch' || fingerPick) return
    const start = { x: e.clientX, y: e.clientY }
    const timer = setTimeout(() => {
      stop()
      suppressClick.current = true
      try {
        navigator.vibrate?.(10)
      } catch {
        /* no vibration */
      }
      anchor.current = r.threadId
      applyPick(new Set([r.threadId]), true)
    }, LONG_PRESS_MS)
    const move = (ev: PointerEvent) => Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 10 && stop()
    function stop() {
      clearTimeout(timer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('scroll', stop, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('scroll', stop, true)
  }

  // What the toolbar keys, the row menu and the selection's own buttons do, to one or many.
  const inTrash = mailbox !== null && mailbox === roleOf('trash')
  const inJunk = mailbox !== null && mailbox === roleOf('junk')
  const canArchive = !!roleOf('archive') && mailbox !== roleOf('archive')
  const remove = (ids: string[]) => void change(inTrash ? 'destroy' : 'trash', ids)
  const junk = (ids: string[]) => void change(inJunk ? 'notjunk' : 'junk', ids)
  /** Read if any is unread, else unread. */
  const toggleSeen = (ids: string[]) => void change(rowsOf(ids).some((r) => !r.seen) ? 'seen' : 'unseen', ids)
  /** Flagged if any is not, else no flags. */
  const toggleFlag = (ids: string[]) => {
    const list = rowsOf(ids)
    flagRows(list, list.some((r) => !r.flagged))
  }

  // --- Writing ---------------------------------------------------------------------------------
  const own = useMemo(() => new Set((boot?.identities ?? []).map((i) => i.email.toLowerCase())), [boot])
  const startCompose = (c: Partial<ComposeInit> & { title: string }) => {
    const identity = identityOf(c.identityId)
    setCompose({ key: crypto.randomUUID(), to: [], cc: [], bcc: [], subject: '', text: signature('new', identity), attachments: [], focus: c.to?.length ? 'text' : 'to', ...c, identityId: identity?.id })
    setView('compose')
  }
  /** The identity asked for, or the one set as the default for this account in Settings → Apps → Mail. */
  const identityOf = (id?: string) => boot?.identities.find((i) => i.id === id) ?? boot?.identities.find((i) => i.id === prefs.defaultIdentity[String(acc)]) ?? boot?.identities[0]
  /** The signature as it starts a message of this kind (above any quote), or nothing. */
  const signature = (kind: 'new' | 'reply' | 'forward', identity: Identity | undefined) => {
    const sig = acc === null ? '' : signatureFor(kind, acc, identity)
    return sig ? `\n\n${sig}` : ''
  }
  const reply = (m: Message, mode: ReplyMode) => {
    const body = m.text ?? (m.html ? htmlToText(m.html) : '')
    const sender = m.from[0]
    // Answer from the identity the message was sent to.
    const identity = boot?.identities.find((i) => [...m.to, ...m.cc, ...m.bcc].some((a) => a.email.toLowerCase() === i.email.toLowerCase())) ?? identityOf()
    const notMe = (list: Address[]) => list.filter((a) => !own.has(a.email.toLowerCase()))
    const subject = (prefix: string) => (new RegExp(`^${prefix}:`, 'i').test(m.subject.trim()) ? m.subject : `${prefix}: ${m.subject}`)
    if (mode === 'draft') {
      return startCompose({ title: 'Draft', identityId: identity?.id, to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, text: body, attachments: m.attachments.map((a) => ({ key: a.blobId, name: a.name, type: a.type, size: a.size, blobId: a.blobId })), draftId: m.id, inReplyTo: m.inReplyTo, references: m.references, focus: 'text' })
    }
    if (mode === 'forward') {
      const head = ['---------- Forwarded message ---------', `From: ${sender ? (sender.name ? `${sender.name} <${sender.email}>` : sender.email) : ''}`, `Date: ${new Date(m.receivedAt).toLocaleString()}`, `Subject: ${m.subject}`, `To: ${m.to.map((a) => a.email).join(', ')}`].join('\n')
      return startCompose({ title: 'Forward', identityId: identity?.id, subject: subject('Fwd'), text: `${signature('forward', identity)}\n\n${head}\n\n${body}`, attachments: m.attachments.map((a) => ({ key: a.blobId, name: a.name, type: a.type, size: a.size, blobId: a.blobId })), forwardOf: m.id, focus: 'to' })
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
      text: `\n${signature('reply', identity)}\n\n${quoted}`,
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
  const reveal = (row: ThreadRow) => {
    const el = listEl.current
    const idx = rows.indexOf(row)
    if (el && (idx * ROW < el.scrollTop || (idx + 1) * ROW > el.scrollTop + el.clientHeight)) el.scrollTop = idx * ROW - el.clientHeight / 2 + ROW / 2
    if (idx > rows.length - 10) loadMore()
  }
  const step = (d: 1 | -1) => {
    if (!rows.length) return
    unpick()
    const i = rows.findIndex((r) => r.threadId === selected)
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + d))]
    anchor.current = next.threadId
    setSelected(next.threadId)
    if (!narrow) setView('thread')
    reveal(next)
  }
  /** Shift+↑/↓: the selection grows (or shrinks) from the anchor to the next row. */
  const extend = (d: 1 | -1) => {
    if (!rows.length) return
    const from = lead.current ?? selected
    const i = rows.findIndex((r) => r.threadId === from)
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + d))]
    if (!anchor.current || !rows.some((r) => r.threadId === anchor.current)) anchor.current = from ?? next.threadId
    pickRange(next.threadId, false)
    reveal(next)
  }
  const onKey = (e: KeyboardEvent) => {
    if (compose || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
      pickAll()
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const sel = targets()
    switch (e.key) {
      case 'j':
        step(1)
        break
      case 'k':
        step(-1)
        break
      case 'ArrowDown':
        if (e.shiftKey) extend(1)
        else step(1)
        break
      case 'ArrowUp':
        if (e.shiftKey) extend(-1)
        else step(-1)
        break
      case 'Enter':
      case 'o':
        if (selected && !picking) setView('thread')
        break
      case 'Escape':
        if (picking) unpick()
        else if (view === 'thread' && narrow) setView('list')
        else if (search) (setSearch(''), setTyped(''))
        else return
        break
      case 'e':
        if (canArchive) void change('archive', sel)
        break
      case '#':
      case 'Delete':
        remove(sel)
        break
      case 's':
        toggleFlag(sel)
        break
      case 'u':
        toggleSeen(sel)
        break
      case '!':
        junk(sel)
        break
      case 'r':
        if (!picking) void replyToSelected(prefs.replyAll ? 'replyAll' : 'reply')
        break
      case 'a':
        if (!picking) void replyToSelected('replyAll')
        break
      case 'f':
        if (!picking) void replyToSelected('forward')
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
  /** What can be done to several conversations at once: the row menu on a selection. */
  const manyItems = (ids: string[]): MenuItem[] => {
    const list = rowsOf(ids)
    return [
      { label: 'Mark as read', disabled: !list.some((r) => !r.seen), onSelect: () => void change('seen', ids) },
      { label: 'Mark as unread', disabled: !list.some((r) => r.seen), onSelect: () => void change('unseen', ids) },
      { label: 'Flag', disabled: !list.some((r) => !r.flagged), onSelect: () => flagRows(list, true) },
      { label: 'Unflag', disabled: !list.some((r) => r.flagged), onSelect: () => flagRows(list, false) },
      { label: 'Move to', submenu: moveItems(ids) },
      ...(canArchive ? [{ label: 'Archive', shortcut: 'E', onSelect: () => void change('archive', ids) }] : []),
      { label: inJunk ? 'Not junk' : 'Mark as junk', shortcut: '!', onSelect: () => junk(ids) },
      { separator: true },
      inTrash ? { label: 'Delete for good…', danger: true, onSelect: () => remove(ids) } : { label: 'Delete', shortcut: '#', danger: true, onSelect: () => remove(ids) },
      { separator: true },
      { label: 'Clear selection', shortcut: 'Esc', onSelect: unpick },
    ]
  }
  const rowMenu = (e: MouseEvent, r: ThreadRow) => {
    // A finger's long press selects (pressRow); the browser's own menu for it is not wanted.
    if (lastPointer.current === 'touch') return e.preventDefault()
    // On a selected row: the whole selection.
    if (picking && picked.has(r.threadId)) return openContextMenu(e, manyItems(targets()))
    const ids = [r.threadId]
    openContextMenu(e, [
      { label: 'Open', onSelect: () => (unpick(), setSelected(r.threadId), setView('thread')) },
      { separator: true },
      { label: r.seen ? 'Mark as unread' : 'Mark as read', onSelect: () => void change(r.seen ? 'unseen' : 'seen', ids) },
      { label: r.flagged ? 'Unflag' : 'Flag', onSelect: () => flagRow(r) },
      { label: 'Move to', submenu: moveItems(ids) },
      ...(canArchive ? [{ label: 'Archive', shortcut: 'E', onSelect: () => void change('archive', ids) }] : []),
      { label: inJunk ? 'Not junk' : 'Mark as junk', onSelect: () => junk(ids) },
      { separator: true },
      inTrash ? { label: 'Delete for good…', danger: true, onSelect: () => remove(ids) } : { label: 'Delete', shortcut: '#', danger: true, onSelect: () => remove(ids) },
      { separator: true },
      ...(r.from[0] ? [{ label: `Mail from ${r.from[0].email}`, onSelect: () => runSearch(`from:${r.from[0].email}`) }] : []),
    ])
  }
  /** Dragging a row: the whole selection when the row is in it, with how many on the ghost. */
  const dragRow = (r: ThreadRow, e: DragEvent) => {
    const ids = picking && picked.has(r.threadId) ? targets() : [r.threadId]
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ account: acc, threadIds: ids }))
    e.dataTransfer.setData('text/plain', ids.length > 1 ? plural(ids.length) : r.subject)
    e.dataTransfer.effectAllowed = 'move'
    setDragGhost(e, '✉', ids.length > 1 ? plural(ids.length) : r.subject || '(No subject)', ids.length)
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
    unpick()
    setView('list')
  }
  const pickMailbox = (id: string) => {
    setMailbox(id)
    setSearch('')
    setTyped('')
    setSelected(null)
    unpick()
    setView('list')
    if (listEl.current) listEl.current.scrollTop = 0
  }

  // --- Empty states ----------------------------------------------------------------------------
  if (me.status !== 'user' || (accounts && !accounts.length))
    return (
      <div className="ml ml-empty">
        <div className="ml-empty-box">
          <span className="ml-empty-glyph">
            <Icon name="mail" size={40} />
          </span>
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
          {accountsError && <p className="ml-problem copyable">{accountsError}</p>}
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
            <Icon name="menu" />
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
          <span aria-hidden="true">
            <Icon name="refresh" />
          </span>
        </button>
        <button className="btn btn-small btn-primary ml-compose-btn" onClick={() => startCompose({ title: 'New message' })} title="New message (C)" aria-label="New message" disabled={!boot}>
          <Icon name="compose" size={14} />
          {!narrow && <span>New</span>}
        </button>
      </header>
      {error && (
        <p className="ml-problem copyable">
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
                    <Icon name={mailboxIcon(box.role, box.name)} />
                  </span>
                  <span className="ml-box-name">{box.name}</span>
                  {box.role === 'drafts' ? box.total > 0 && <span className="ml-box-count is-quiet">{box.total}</span> : box.unread > 0 && box.role !== 'trash' && box.role !== 'sent' && <span className={`ml-box-count ${box.role === 'junk' ? 'is-quiet' : ''}`}>{box.unread}</span>}
                </button>
              ))}
            </nav>
            <div className="ml-side-foot">
              <button className="link-btn" onClick={() => wm.open('settings', { section: 'mail', t: String(Date.now()) })}>
                Mail settings…
              </button>
            </div>
          </aside>
        )}
        {showList && (
          <section className="ml-listpane" aria-label="Conversations">
            {picking && narrow ? (
              <Selection compact count={picked.size} rows={rowsOf(targets())} ids={targets()} canArchive={canArchive} inTrash={inTrash} inJunk={inJunk} moveItems={moveItems} change={change} flagRows={flagRows} onClear={unpick} />
            ) : (
              <div className="ml-list-head">
                <strong>{search ? `Search: ${search}` : (current?.name ?? '')}</strong>
                {total !== null && <span className="muted">{total === 1 ? '1 conversation' : `${total} conversations`}</span>}
              </div>
            )}
            <ThreadList
              rows={rows}
              total={total}
              selected={picking ? null : selected}
              picked={picking ? picked : NONE}
              picking={picking}
              listRef={listEl}
              trash={inTrash}
              onClick={(r, e) => {
                if (suppressClick.current) return void (suppressClick.current = false)
                clickRow(r, e)
              }}
              onCheck={checkRow}
              onPress={pressRow}
              onDrag={dragRow}
              onMenu={rowMenu}
              onMore={loadMore}
              onArchive={canArchive ? (r) => void change('archive', [r.threadId]) : null}
              onDelete={(r) => remove([r.threadId])}
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
            ) : picking ? (
              <Selection count={picked.size} rows={rowsOf(targets())} ids={targets()} canArchive={canArchive} inTrash={inTrash} inJunk={inJunk} moveItems={moveItems} change={change} flagRows={flagRows} onClear={unpick} />
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

/**
 * Two or more conversations selected: how many, and what can be done to them all (in the reading
 * pane; `compact`, a bar over the list on a phone).
 */
function Selection(props: {
  count: number
  rows: ThreadRow[]
  ids: string[]
  compact?: boolean
  canArchive: boolean
  inTrash: boolean
  inJunk: boolean
  moveItems: (ids: string[]) => MenuItem[]
  change: (op: Op, threadIds: string[], opts?: { to?: string }) => Promise<void>
  flagRows: (list: ThreadRow[], on: boolean) => void
  onClear: () => void
}) {
  const { count, rows, ids, change } = props
  const unread = rows.filter((r) => !r.seen).length
  const flagged = rows.filter((r) => r.flagged).length
  const messages = rows.reduce((n, r) => n + r.count, 0)
  const actions: { label: string; glyph: IconName; title: string; run: (e: MouseEvent<HTMLButtonElement>) => void; danger?: boolean; off?: boolean }[] = [
    ...(props.canArchive ? [{ label: 'Archive', glyph: 'archive' as const, title: 'Archive (E)', run: () => void change('archive', ids) }] : []),
    { label: props.inTrash ? 'Delete for good…' : 'Delete', glyph: 'trash', title: props.inTrash ? 'Delete for good' : 'Delete (#)', danger: true, run: () => void change(props.inTrash ? 'destroy' : 'trash', ids) },
    { label: props.inJunk ? 'Not junk' : 'Mark as junk', glyph: props.inJunk ? 'notJunk' : 'junk', title: props.inJunk ? 'Not junk (!)' : 'Mark as junk (!)', run: () => void change(props.inJunk ? 'notjunk' : 'junk', ids) },
    { label: 'Mark as read', glyph: 'read', title: 'Mark as read (U)', off: !unread, run: () => void change('seen', ids) },
    { label: 'Mark as unread', glyph: 'unread', title: 'Mark as unread (U)', off: unread === rows.length, run: () => void change('unseen', ids) },
    { label: 'Flag', glyph: 'starFilled', title: 'Flag (S)', off: flagged === rows.length, run: () => props.flagRows(rows, true) },
    { label: 'Unflag', glyph: 'star', title: 'Unflag (S)', off: !flagged, run: () => props.flagRows(rows, false) },
    { label: 'Move to…', glyph: 'move', title: 'Move to a mailbox', run: (e) => openMenuAt(e.currentTarget, props.moveItems(ids)) },
  ]
  if (props.compact) {
    // A phone's width: read and flagged as one button each (all of them, or none when all are).
    const read = unread ? actions.find((a) => a.label === 'Mark as read')! : actions.find((a) => a.label === 'Mark as unread')!
    const flag = flagged === rows.length ? actions.find((a) => a.label === 'Unflag')! : actions.find((a) => a.label === 'Flag')!
    const few = actions.filter((a) => !/^(Mark as (un)?read|Flag|Unflag)$/.test(a.label) || a === read || a === flag)
    return (
      <div className="ml-sel-bar" role="toolbar" aria-label="Selected conversations">
        <button className="ml-icon" onClick={props.onClear} aria-label="Clear selection" title="Clear selection (Esc)">
          <Icon name="close" />
        </button>
        <strong className="ml-sel-count">{count} selected</strong>
        <span className="nb-spacer" />
        {few.map((a) => (
          <button key={a.label} className="ml-icon" onClick={a.run} disabled={a.off} aria-label={a.label} title={a.title}>
            <Icon name={a.glyph} />
          </button>
        ))}
      </div>
    )
  }
  return (
    <div className="ml-sel" aria-live="polite">
      <div className="ml-sel-stack" aria-hidden>
        <span>
          <Icon name="mail" size={22} />
        </span>
        <span>
          <Icon name="mail" size={22} />
        </span>
        <span>
          <Icon name="mail" size={22} />
        </span>
      </div>
      <h3 className="ml-sel-title">{plural(count)} selected</h3>
      <p className="muted ml-sel-facts">
        {[messages > count ? `${messages} in all` : '', unread ? `${unread} unread` : 'all read', flagged ? `${flagged} flagged` : ''].filter(Boolean).join(' · ')}
      </p>
      <div className="ml-sel-actions">
        {actions.map((a) => (
          <button key={a.label} className={`btn btn-small ${a.danger ? 'btn-danger' : ''}`} onClick={a.run} disabled={a.off} title={a.title}>
            <Icon name={a.glyph} size={14} /> {a.label}
          </button>
        ))}
      </div>
      <button className="link-btn" onClick={props.onClear} title="Esc">
        Clear selection
      </button>
    </div>
  )
}

const CHECK = <path d="M6 12.5l4 4 8-9" />

/** The conversations, drawn only where they show; more are asked for near the end. */
function ThreadList(props: {
  rows: ThreadRow[]
  total: number | null
  selected: string | null
  picked: ReadonlySet<string>
  /** Several are selected (or a finger is selecting): every row shows its circle. */
  picking: boolean
  listRef: RefObject<HTMLDivElement | null>
  trash: boolean
  onClick: (r: ThreadRow, e: MouseEvent) => void
  onCheck: (r: ThreadRow, e: MouseEvent) => void
  onPress: (r: ThreadRow, e: RPointerEvent) => void
  onDrag: (r: ThreadRow, e: DragEvent) => void
  onMenu: (e: MouseEvent, r: ThreadRow) => void
  onMore: () => void
  onArchive: ((r: ThreadRow) => void) | null
  onDelete: (r: ThreadRow) => void
  onFlag: (r: ThreadRow) => void
  onSeen: (r: ThreadRow) => void
  empty: string
}) {
  const { rows, total, selected, picked, listRef, onMore } = props
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
    <div
      className={`ml-list ${props.picking ? 'is-picking' : ''}`}
      ref={listRef}
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      role="listbox"
      aria-label="Conversations"
      aria-multiselectable
      data-no-touch-menu
    >
      {!rows.length && <p className="muted ml-list-empty">{props.empty}</p>}
      <div style={{ height: rows.length * ROW + (more ? 40 : 0), position: 'relative' }}>
        {rows.slice(first, last).map((r, k) => {
          const i = first + k
          const who = r.draft ? 'Draft' : r.from.map((a) => nameOf(a)).join(', ') || '(No sender)'
          const on = props.picking ? picked.has(r.threadId) : r.threadId === selected
          return (
            <div
              key={r.threadId}
              role="option"
              aria-selected={on}
              data-thread={r.threadId}
              className={`ml-row ${r.threadId === selected ? 'is-on' : ''} ${props.picking && on ? 'is-picked' : ''} ${r.seen ? '' : 'is-unread'}`}
              style={{ top: i * ROW, height: ROW }}
              onClick={(e) => props.onClick(r, e)}
              onPointerDown={(e) => props.onPress(r, e)}
              onContextMenu={(e) => props.onMenu(e, r)}
              draggable
              onDragStart={(e) => props.onDrag(r, e)}
            >
              <span className="ml-row-pic">
                <Avatar person={r.from[0]} size={30} />
                <span
                  className="ml-check"
                  role="checkbox"
                  aria-checked={on}
                  aria-label={on ? 'Selected' : 'Select'}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onCheck(r, e)
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                    {CHECK}
                  </svg>
                </span>
              </span>
              <div className="ml-row-text">
                <div className="ml-row-top">
                  <span className="ml-row-from">{who}</span>
                  {r.count > 1 && <span className="ml-row-count">{r.count}</span>}
                  <span className="nb-spacer" />
                  {r.hasAttachment && (
                    <span className="ml-row-mark" title="Attachments">
                      <Icon name="paperclip" size={12} />
                    </span>
                  )}
                  {r.answered && (
                    <span className="ml-row-mark" title="Answered">
                      <Icon name="reply" size={12} />
                    </span>
                  )}
                  {r.flagged && (
                    <span className="ml-row-mark ml-flag" title="Flagged">
                      <Icon name="starFilled" size={12} />
                    </span>
                  )}
                  <time className="ml-row-date">{shortDate(r.receivedAt)}</time>
                </div>
                <div className="ml-row-subject">{r.subject || '(No subject)'}</div>
                <div className="ml-row-preview">{r.preview}</div>
              </div>
              <div className="ml-row-actions" onClick={(e) => e.stopPropagation()}>
                {props.onArchive && (
                  <button className="ml-icon" title="Archive (E)" aria-label="Archive" onClick={() => props.onArchive!(r)}>
                    <Icon name="archive" size={15} />
                  </button>
                )}
                <button className="ml-icon" title={props.trash ? 'Delete for good' : 'Delete (#)'} aria-label={props.trash ? 'Delete for good' : 'Delete'} onClick={() => props.onDelete(r)}>
                  <Icon name="trash" size={15} />
                </button>
                <button className="ml-icon" title={r.seen ? 'Mark as unread (U)' : 'Mark as read (U)'} aria-label={r.seen ? 'Mark as unread' : 'Mark as read'} onClick={() => props.onSeen(r)}>
                  <Icon name={r.seen ? 'unread' : 'read'} size={15} />
                </button>
                <button className={`ml-icon ${r.flagged ? 'is-flagged' : ''}`} title={r.flagged ? 'Unflag (S)' : 'Flag (S)'} aria-label={r.flagged ? 'Unflag' : 'Flag'} onClick={() => props.onFlag(r)}>
                  <Icon name={r.flagged ? 'starFilled' : 'star'} size={15} />
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
export const mailMenu = (_w: WinState, wm: ReturnType<typeof useWM>): MenuItem[] => [
  { label: 'Mail settings…', onSelect: () => wm.open('settings', { section: 'mail', t: String(Date.now()) }) },
  { label: 'Mail accounts…', onSelect: () => wm.open('settings', { section: 'integrations', sub: 'mail', t: String(Date.now()) }) },
]
