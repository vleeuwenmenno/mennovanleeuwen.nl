import { browserStoreIdentity } from '../data/browserfs'
import { forwardRef, useEffect, useRef, useState } from 'react'
import { Conversation } from './Agents'
import { XedAgentsDock, type XedAgentsDockHandle } from './XedAgentsDock'
import { agentSettings, createThread, getThread, stopThread, textAttachment, updateThread, deleteThread, type Attachment, type Thread, type Workdir } from '../data/agents'
import { seafileAt } from '../data/agentPlaces'
import { rememberXedThread, xedThreads } from '../data/xedThreads'
import { readFileText } from '../terminal/fs'
import { prettyPath } from '../terminal/vfs'
import { useAccount } from '../os/account'
import { accountGuard } from '../os/accountSpace'
import { choose, ask } from '../os/Dialogs'
import { setCloseGuard, useWM } from '../os/wm'
import './XedAgentsPane.css'

export type XedAttachment = { id: number; path: string; text?: string; startLine?: number; endLine?: number }
type Slot = { thread: Thread; root: string; workdir: Workdir | null; browser: ReturnType<typeof browserStoreIdentity>; attachment?: { id: number; file: Attachment }; busy: boolean }
type Props = {
  root: string; attach: XedAttachment | null; onFocusEditor: () => void
  pid: number; sheet: boolean; hidden: boolean; onClose: () => void
  onFilesChanged: () => void
}

/** Every visited conversation keeps its own immutable folder and executor until the window closes. */
export const XedAgentsPane = forwardRef<XedAgentsDockHandle, Props>(function XedAgentsPane(props, ref) {
  const account = useAccount()
  return <ProjectConversations key={account.user?.id ?? 'signed-out'} {...props} account={account.status === 'user' ? account.user?.id ?? null : null} ref={ref} />
})

const ProjectConversations = forwardRef<XedAgentsDockHandle, Props & { account: number | null }>(function ProjectConversations({ root, attach, onFocusEditor, pid, sheet, hidden, onClose, onFilesChanged, account }, ref) {
  const wm = useWM()
  const [slots, setSlots] = useState<Slot[]>([])
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const live = useRef(true)
  const now = useRef(slots); now.current = slots
  const requested = useRef(new Set<string>())
  const active = selected[root]
  const current = slots.find(x => x.thread.id === active)
  const valid = () => live.current && account !== null && accountGuard()
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])

  const make = async (folder: string) => {
    const at = seafileAt(folder)
    if (at === undefined) throw new Error('The project mount is still loading. Try again.')
    const workdir = at ? { ...at, label: prettyPath(folder) } : null
    const browser = at ? null : browserStoreIdentity()
    const settings = agentSettings()
    const thread = await createThread({ mode: settings.mode, tools: settings.tools, workdir, permission: 'auto' })
    if (!valid()) return
    rememberXedThread({ id: thread.id, account: account!, root: folder, backing: at ? JSON.stringify(at) : null, browser })
    setSlots(all => [...all, { thread, root: folder, workdir, browser, busy: false }])
    setSelected(all => ({ ...all, [folder]: thread.id }))
  }
  const newThread = async () => {
    if (!valid() || loading) return
    setLoading(true); setError('')
    try { await make(root) } catch (e) { if (live.current) setError((e as Error).message) }
    finally { if (live.current) setLoading(false) }
  }
  useEffect(() => {
    if (account === null || !accountGuard() || requested.current.has(root)) return
    requested.current.add(root)
    setLoading(true); setError('')
    const folder = root
    void (async () => {
      const at = seafileAt(folder)
      if (at === undefined) throw new Error('The project mount is still loading. Reopen the project when it is ready.')
      const backing = at ? JSON.stringify(at) : null
      const bindings = xedThreads.get().filter(x => x.account === account && x.root === folder && x.backing === backing && JSON.stringify(x.browser ?? null) === JSON.stringify(at ? null : browserStoreIdentity()))
      const loaded: Slot[] = []
      for (const b of bindings) {
        try {
          const { thread } = await getThread(b.id)
          const actual = thread.workdir ? JSON.stringify({ repo: thread.workdir.repo, path: thread.workdir.path }) : null
          if (!thread.archived && actual === backing) loaded.push({ thread, root: folder, workdir: thread.workdir, browser: b.browser ?? null, busy: thread.running })
        } catch (e) {
          // A missing/deleted ID is stale. Network/auth failures must not create duplicate threads.
          if (!/not found|404/i.test((e as Error).message)) throw e
          if (valid()) xedThreads.set(all => all.filter(x => x.id !== b.id))
        }
      }
      if (!valid()) return
      if (!loaded.length) await make(folder)
      else {
        setSlots(all => [...all, ...loaded.filter(x => !all.some(y => y.thread.id === x.thread.id))])
        setSelected(all => ({ ...all, [folder]: loaded.at(-1)!.thread.id }))
      }
    })().catch(e => { if (live.current) setError((e as Error).message) }).finally(() => { if (live.current) setLoading(false) })
  }, [root, account])

  const seen = useRef<number | null>(null)
  useEffect(() => {
    if (!attach || !active || seen.current === attach.id) return
    seen.current = attach.id
    const target = active
    void (async () => {
      const content = attach.text ?? (await readFileText(attach.path))?.text
      if (content === undefined) throw new Error('The file could not be read')
      const lines = attach.startLine === undefined ? '' : ` (${attach.startLine}-${attach.endLine})`
      const file = { ...textAttachment(content, `${attach.path}${lines}`), source: 'Xed' }
      if (valid()) setSlots(all => all.map(x => x.thread.id === target ? { ...x, attachment: { id: attach.id, file } } : x))
    })().catch(e => { if (live.current) setError((e as Error).message) })
  }, [attach, active])

  useEffect(() => {
    setCloseGuard(pid, async () => {
      const busy = now.current.filter(x => x.busy || x.thread.running)
      if (!busy.length) return true
      const choice = await choose({
        title: `${busy.length} Xed thread${busy.length === 1 ? ' is' : 's are'} still answering`,
        body: 'Hiding the panel keeps its executor running. Closing this window releases it: terminal calls may wait until this project is reopened. Keep running on the server, or stop before closing.',
        buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'stop', label: 'Stop and close', danger: true }, { id: 'keep', label: 'Keep running', primary: true }],
      })
      if (choice === 'stop') { try { await Promise.all(busy.map(x => stopThread(x.thread.id))); return true } catch (e) { setError((e as Error).message); return false } }
      return choice === 'keep'
    })
    return () => setCloseGuard(pid, null)
  }, [pid])

  const change = (id: string, t: Thread | null, busy: boolean) => setSlots(all => all.map(x => x.thread.id === id ? { ...x, thread: t ?? x.thread, busy } : x))
  const refresh = (id: string) => { void getThread(id).then(r => { if (valid()) change(id, r.thread, r.thread.running) }, () => {}) }
  const remove = async (t: Thread) => {
    if (!await ask({ title: 'Delete this thread?', body: 'Its messages will be deleted.', danger: true })) return
    try { await deleteThread(t.id); setSlots(all => all.filter(x => x.thread.id !== t.id)); xedThreads.set(all => all.filter(x => x.id !== t.id)); await make(root) } catch (e) { setError((e as Error).message) }
  }
  return <XedAgentsDock ref={ref} sheet={sheet} hidden={hidden} onClose={onClose} onEscape={onFocusEditor}
    threads={slots.filter(x => x.root === root).map(x => ({ value: x.thread.id, label: x.thread.title }))} thread={active}
    onThread={id => setSelected(all => ({ ...all, [root]: id }))} onNew={account !== null && !loading ? () => void newThread() : undefined}
    onOpenInAgents={current ? () => wm.open('agents', { thread: current.thread.id, t: String(Date.now()) }) : undefined}>
    <div className="xed-project-label" title={root}>{prettyPath(root)}</div>
    {account === null ? <p className="muted xed-pane-notice">Sign in to use Agents.</p> : loading && !current ? <p className="muted xed-pane-notice">Opening project threads…</p> : null}
    {error && <div className="xed-pane-notice" role="alert">{error}<button onClick={() => void newThread()}>New thread</button></div>}
    {slots.map(slot => <div className="xed-conversation" key={slot.thread.id} hidden={slot.thread.id !== active} inert={slot.thread.id !== active}>
      <Conversation id={slot.thread.id} draftProject={null} projects={[]} listThread={slot.thread} ask={null} onAsked={() => {}} onBack={onFocusEditor}
        onCreated={t => change(slot.thread.id, t, t.running)} onChanged={() => refresh(slot.thread.id)}
        onArchive={(t, archived) => { void updateThread(t.id, { archived }).then(() => refresh(t.id)) }} onDelete={t => void remove(t)}
        onOpenRun={focus => wm.open('agents', { tab: 'tasks', task: focus.task ?? '', run: focus.run ?? '', t: String(Date.now()) })}
        onOpenThread={id => wm.open('agents', { thread: id, t: String(Date.now()) })}
        embedded={{ folder: { path: slot.root, label: prettyPath(slot.root), browser: slot.browser }, workdir: slot.workdir, attachment: slot.attachment, onCallDone: onFilesChanged, onState: (t, busy) => change(slot.thread.id, t, busy) }} />
    </div>)}
  </XedAgentsDock>
})
