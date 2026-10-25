import { GptImageDrawing, GptImageResult } from './AgentsGptImage'
import { InpaintDialog, type InpaintSource } from './AgentsInpaint'
import { MaskCards, type SavedMask } from './AgentsMaskCard'
import { PhotoPicker } from './photos/PhotoPicker'
import { checkPhotoAttachmentBudget } from '../data/photoAttachments'
import { mentionAt, mentionText } from '../data/agentMentions'
import { openSessionImages } from './AgentsSessionImages'
import { agentMasks, generatedImage, getLoraDetails, upscaleImage, refineImage, inpaintImage, type MaskedEditInput, type RefineImageInput, type UpscaleImageInput, type LoraDetail } from '../data/agentImages'
import { LoraDetailPane, LoraRow } from './AgentsLoraPicker'
import { useIsMobile } from '../os/useIsMobile'
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ALL_TOOLS,
  TOOL_GROUPS,
  toolState,
  addMemory,
  agentModels,
  answerForm,
  type Form,
  type Question,
  createProject,
  deleteProject,
  listProjects,
  orderProjects,
  renameProject,
  updateMemory,
  type Project,
  type Todo,
  answerApproval,
  MAIL_READ_TOOLS,
  MAIL_READS_EVENT,
  mailReadsLeft,
  revokeMailReads,
  toAttachment,
  textAttachment,
  MAX_MESSAGE,
  PASTE_AS_FILE,
  type Attachment,
  type ToolGroup,
  createThread,
  deleteMemory,
  deleteThread,
  getContext,
  getThread,
  listMemories,
  listThreads,
  followThread,
  sendMessage,
  agentSettings,
  setAgentSettings,
  stopThread,
  queueMessage,
  overrideTurn,
  editQueued,
  saveQueued,
  releaseQueued,
  removeQueued,
  sendQueuedNow,
  type QueuedMessage,
  isDropped,
  retryTurn,
  branchThread,
  generateAnother,
  rewindThread,
  interruptionText,
  compactionText,
  isCompact,
  suggestTitle,
  regenerateTitle,
  threadMatches,
  alsoKnownAs,
  tokenCount,
  toolLabel,
  updateThread,
  useAgentSettings,
  type ContextInfo,
  type AgentMessage,
  type Memory,
  type Mode,
  type ModelInfo,
  type CallSummary,
  type PendingApproval,
  type TurnEvent,
  type Thread,
  type ToolCall,
  listSkills,
  listMentionTools,
  type MentionTool,
  canAlwaysAllow,
  PERMISSIONS,
  siteOf,
  type Permission,
  type Skill,
  type Workdir,
} from '../data/agents'
import { diffLines } from '../terminal/agents/diff'
import { dropDraft, getDraft, setDraft } from '../data/agentDrafts'
import { posixOf } from '../data/mounts'
import { prettyPath } from '../terminal/vfs'
import { libraryName, parseSf } from '../data/seafile'
import { readBytes } from '../data/fileOps'
import { useDropTarget, type Drag as DropDrag } from '../os/dnd'
import { notify } from '../os/notify'
import { useEmojiTyping } from '../os/emojiTyping'
import { pickFiles, pickFolder } from '../os/FolderPicker'
import { Select } from '../os/Select'
import { hasCalendar, signIn, useAccount } from '../os/account'
import { useMailAccounts } from '../data/mail'
import { fieldMenu, linkAt, linkMenu, openContextMenu, openMenuAt, selectionIn, tidyMenu, type MenuItem } from '../os/ContextMenu'
import { searchWeb } from '../data/searchEngine'
import { ask, ask as confirmDialog, askText, choose, tell } from '../os/Dialogs'
import { setCloseGuard, useWM, type WinState } from '../os/wm'
import { pullAll } from '../os/synced'
import { mayTakeFocus } from '../os/overlays'
import { allowNotifications } from '../os/agentWatch'
import { AgentsSettings, showAgentsSection, usePromptLocation } from './AgentsSettings'
import { AlwaysChips, showProjectSkills } from './AgentsSkillRules'
import { openShareDialog } from './AgentsShare'
import { AttachedFiles, memoryPicture, sentPicture, ImageCard, Thumbnails } from './AgentsImages'
import { ACTION, ActionRow, MoreButton, tidy } from './AgentsActions'
import { ObservationLine, ObservationsDialog } from './AgentsObservations'
import { readObservation } from '../data/imageObservations'
import { MarkdownPreview } from './Zed'
import { currenciesIn } from '../data/money'
import { MoneyThread } from '../os/MoneyAmount'
import { ImageStudio } from './AgentsStudio'
import { accountStorage } from '../os/accountSpace'

// Agents: a research assistant on Ollama Cloud (server/agents.ts). Threads on the left (and the
// archived ones, and what the agent remembers), the conversation on the right with each tool call
// as a card. Quick answers fast with a search or two; Deep searches from several angles and reads
// the sources before it writes.

type Live = { content: string; thinking: string }

export function Agents({ win }: { win: WinState }) {
  const account = useAccount()
  const wm = useWM()
  // The Image Studio needs ComfyUI, not Ollama: without an Ollama key it opens on its own.
  const [studioOnly, setStudioOnly] = useState(win.props.tab === 'studio')
  // Opened for it again later (Settings → Images → Open Image Studio) on a window already showing the key screen.
  useEffect(() => {
    if (win.props.tab === 'studio') setStudioOnly(true)
  }, [win.props.t, win.props.tab])
  if (account.status === 'loading') return <div className="nb-blank muted">Loading…</div>
  if (account.status !== 'user')
    return (
      <div className="nb-blank">
        <p className="muted">Agents is a research assistant for signed-in users.</p>
        {account.status === 'anon' && (
          <button className="btn btn-primary" onClick={signIn}>
            Sign in with GitHub
          </button>
        )}
      </div>
    )
  if (!account.integrations.ollama && studioOnly)
    return (
      <div className="studio-alone">
        <ImageStudio threads={null} onBack={() => setStudioOnly(false)} onOpenThread={() => setStudioOnly(false)} onSettings={() => wm.open('settings', { section: 'agents', t: String(Date.now()) })} />
      </div>
    )
  if (!account.integrations.ollama)
    return (
      <div className="nb-blank">
        <p className="muted">Agents runs on Ollama Cloud. Add an API key from your Ollama account to start.</p>
        <button className="btn btn-primary" onClick={() => wm.open('settings', { section: 'integrations', t: String(Date.now()) })}>
          Open Settings → Integrations
        </button>
        <button className="btn" onClick={() => setStudioOnly(true)} title="Generate pictures with your own ComfyUI; no Ollama key needed">
          Open Image Studio
        </button>
      </div>
    )
  return <AgentsApp win={win} />
}

/** What the main pane shows: a conversation, the settings, the memory (the user's or a project's), or the Image Studio. */
type Main = { kind: 'thread' } | { kind: 'settings' } | { kind: 'memory'; scope: number | null } | { kind: 'studio' }
type Drag = { kind: 'project'; id: number } | { kind: 'thread'; id: string } | null

const FOLDED_PROJECTS = 'mvlos.agents.folded'
const readFolded = (): number[] => {
  try {
    return JSON.parse(accountStorage.get(FOLDED_PROJECTS) ?? '[]') as number[]
  } catch {
    return []
  }
}
/** Pinned first, then the newest. */
const pinnedFirst = (list: Thread[]) => [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)

function AgentsApp({ win }: { win: WinState }) {
  const wm = useWM()
  const [archived, setArchived] = useState(false)
  const [threads, setThreads] = useState<Thread[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string | null>(win.props.thread ?? null)
  // Which conversation is shown. Not the same as `selected`: a new thread gets its id from its
  // first message and keeps streaming into the same view.
  const [view, setView] = useState(() => win.props.thread ?? 'new')
  // The project a new thread goes into (its + in the sidebar), until it has an id.
  const [draftProject, setDraftProject] = useState<number | null>(null)
  // In a narrow window only one side shows: the list, or the conversation.
  const [pane, setPane] = useState<'list' | 'chat'>(win.props.thread ? 'chat' : 'list')
  const [main, setMain] = useState<Main>({ kind: 'thread' })
  const open = (id: string | null, project: number | null = null) => {
    setMain({ kind: 'thread' })
    setSelected(id)
    setDraftProject(id ? null : project)
    setView(id ?? `new-${Date.now()}`)
    setPane('chat')
  }
  // Spotlight's "Ask Agents": a new thread that sends the question straight away. The question is
  // taken off the window's props once read, since the window (and its props) outlive a reload.
  const [question, setQuestion] = useState<{ text: string; mode: Mode } | null>(null)
  const consumed = useRef<string | null>(null)
  useEffect(() => {
    const { ask: text, mode, t } = win.props
    if (!text || consumed.current === t) return
    consumed.current = t ?? ''
    wm.setProps(win.pid, { ask: '', mode: '' })
    if (Date.now() - Number(t ?? 0) > 60_000) return
    setArchived(false)
    setQuestion({ text, mode: mode === 'deep' ? 'deep' : 'quick' })
    open(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.props.t])
  // Spotlight's Continue in Agents: the quick answer's thread, opened (props.thread with a new t).
  useEffect(() => {
    const { thread: id, t } = win.props
    if (!id || !t || consumed.current === t) return
    consumed.current = t
    setArchived(false)
    if (id !== selected) open(id)
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.props.t])
  const [listError, setListError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renamingProject, setRenamingProject] = useState<number | null>(null)
  const [addingProject, setAddingProject] = useState(false)
  const [folded, setFolded] = useState<number[]>(readFolded)
  const [drag, setDrag] = useState<Drag>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)
  // Opened on a view (Settings → Agents → Memory → Show).
  useEffect(() => {
    const t = win.props.tab
    if (t === 'memory') setMain({ kind: 'memory', scope: null }), setPane('chat')
    else if (t === 'studio') setMain({ kind: 'studio' }), setPane('chat')
    else if (t === 'archived') setArchived(true), setPane('list')
    else return
    wm.setProps(win.pid, { tab: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.props.t])

  usePromptLocation()

  // Closing while threads are answering: stop them, or let them go on on the server (they are
  // announced when done, and found again here later).
  useEffect(() => {
    setCloseGuard(win.pid, async () => {
      const busy = (await listThreads(false).catch(() => [] as Thread[])).filter((t) => t.running)
      if (!busy.length) return true
      const choice = await choose({
        title: busy.length === 1 ? `“${busy[0].title}” is still answering` : `${busy.length} threads are still answering`,
        body: 'They can keep going on the server while Agents is closed, even with this tab closed, and you get a notification when an answer is in. Or stop them now.',
        buttons: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'stop', label: busy.length === 1 ? 'Stop and close' : 'Stop all and close', danger: true },
          { id: 'keep', label: 'Keep running', primary: true },
        ],
      })
      if (choice === 'stop') {
        await Promise.all(busy.map((t) => stopThread(t.id).catch(() => {})))
        return true
      }
      if (choice !== 'keep') return false
      // The click on Keep running lets the browser ask about its own notifications, once.
      void allowNotifications()
      return true
    })
    return () => setCloseGuard(win.pid, null)
  }, [win.pid])

  const refresh = useCallback(() => {
    listThreads(archived).then(
      // Running ones are announced when done, if that happens while their answer is not on screen.
      (list) => (setThreads(list), setListError(null)),
      (e: Error) => setListError(e.message),
    )
    listProjects().then(setProjects, () => {})
  }, [archived])
  useEffect(refresh, [refresh])
  // Titles being thought of arrive a moment after the answer starts, titles being checked a moment
  // after it ends, and threads answering in the background finish on their own: look again until
  // the titles are in and nothing is running.
  useEffect(() => {
    const titling = threads.some((t) => t.titling || t.checkingTitle)
    if (!titling && !threads.some((t) => t.running)) return
    const timer = setTimeout(refresh, titling ? 1500 : 3000)
    return () => clearTimeout(timer)
  }, [threads, refresh])
  const rename = (t: Thread, title: string) => {
    setRenaming(null)
    if (title.trim() && title.trim() !== t.title) updateThread(t.id, { title: title.trim() }).then(refresh, () => {})
  }

  const query = q.trim().toLowerCase()
  // Earlier titles count too: a thread is found by the name it had when you last saw it.
  const shown = useMemo(() => threads.filter((t) => threadMatches(t, query)), [threads, query])
  const inProject = (t: Thread) => t.projectId !== null && projects.some((p) => p.id === t.projectId)
  const loose = pinnedFirst(shown.filter((t) => archived || !inProject(t)))
  const loosePinned = loose.filter((t) => t.pinned)
  const looseByDay = useMemo(() => byDay(loose.filter((t) => !t.pinned)), [loose])

  const remove = async (t: Thread) => {
    if (!(await ask({ title: `Delete “${t.title}”?`, body: 'The thread and everything in it is gone for good. Archive it instead to keep it out of the way.', confirm: 'Delete', danger: true }))) return
    await deleteThread(t.id).catch(() => {})
    dropDraft(t.id)
    if (selected === t.id) open(null)
    refresh()
  }
  const archive = async (t: Thread, value: boolean) => {
    await updateThread(t.id, { archived: value }).catch(() => {})
    if (selected === t.id) open(null)
    refresh()
  }
  const pin = (t: Thread) => void updateThread(t.id, { pinned: !t.pinned }).then(refresh, () => {})
  // A fresh title from the title model, shown as being thought of until it lands.
  const regenerate = (t: Thread) => {
    setThreads((list) => list.map((x) => (x.id === t.id ? { ...x, titling: true } : x)))
    regenerateTitle(t.id).then(refresh, (e: Error) => (refresh(), void tell({ title: 'No new title', body: e.message })))
  }
  const move = (t: Thread, projectId: number | null) => void updateThread(t.id, { projectId }).then(refresh, () => {})
  const menu = (t: Thread): MenuItem[] => [
    { label: 'Open', onSelect: () => open(t.id) },
    { label: t.pinned ? 'Unpin' : 'Pin', onSelect: () => pin(t) },
    {
      label: 'Move to project',
      submenu: tidyMenu([
        ...projects.map((p) => ({ label: p.name, checked: t.projectId === p.id, onSelect: () => move(t, p.id) })),
        { separator: true },
        { label: 'No project', checked: !inProject(t), onSelect: () => move(t, null) },
      ]),
    },
    { label: 'Rename…', onSelect: () => setRenaming(t.id) },
    { label: 'Regenerate title', hint: regenerateHint(t), disabled: t.titling, onSelect: () => regenerate(t) },
    { label: 'Copy as Markdown', onSelect: () => void getThread(t.id).then((r) => copy(threadMarkdown(r.thread.title, r.messages)), () => {}) },
    { label: 'Share thread…', onSelect: () => void openShareDialog(t) },
    { separator: true },
    t.archived ? { label: 'Move back to threads', onSelect: () => archive(t, false) } : { label: 'Archive', onSelect: () => archive(t, true) },
    { label: 'Delete…', danger: true, onSelect: () => remove(t) },
  ]

  // Projects: fold them, rename, reorder by dragging, delete (their threads stay).
  const toggleFold = (id: number) =>
    setFolded((f) => {
      const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id]
      try {
        accountStorage.set(FOLDED_PROJECTS, JSON.stringify(next))
      } catch {
        /* not remembered */
      }
      return next
    })
  const removeProject = async (p: Project) => {
    if (!(await ask({ title: `Delete the project “${p.name}”?`, body: 'Its threads stay, outside any project. What the agent remembers about this project is deleted.', confirm: 'Delete project', danger: true }))) return
    await deleteProject(p.id).catch(() => {})
    if (main.kind === 'memory' && main.scope === p.id) setMain({ kind: 'memory', scope: null })
    refresh()
  }
  const projectMenu = (p: Project): MenuItem[] => [
    { label: 'New thread in this project', onSelect: () => open(null, p.id) },
    { label: 'Project memory', onSelect: () => openMemory(p.id) },
    { label: 'Always-on skills…', onSelect: () => (showProjectSkills(p.id), showAgentsSection('skills'), openSettings()) },
    { label: 'Rename…', onSelect: () => setRenamingProject(p.id) },
    { separator: true },
    { label: 'Delete project…', danger: true, onSelect: () => void removeProject(p) },
  ]
  const reorder = (moved: number, before: number) => {
    if (moved === before) return
    const ids = projects.map((p) => p.id).filter((id) => id !== moved)
    ids.splice(ids.indexOf(before), 0, moved)
    setProjects(ids.map((id) => projects.find((p) => p.id === id)!))
    void orderProjects(ids).then(setProjects, () => {})
  }
  // A project drags before another project; a thread drags into a project, or out (onto Threads).
  const dropZone = (key: string, accept: (d: NonNullable<Drag>) => boolean, onDrop: (d: NonNullable<Drag>) => void) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!drag || !accept(drag)) return
      e.preventDefault()
      setDropAt(key)
    },
    onDragLeave: () => setDropAt((k) => (k === key ? null : k)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      if (drag && accept(drag)) onDrop(drag)
      setDrag(null)
      setDropAt(null)
    },
  })
  const dragging = (d: Drag) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', d!.kind === 'project' ? `project ${d!.id}` : `thread ${d!.id}`)
      setDrag(d)
    },
    onDragEnd: () => (setDrag(null), setDropAt(null)),
  })

  // The sidebar folds to a rail of icons; remembered on this device. In a narrow window the list
  // and the conversation take turns instead, so there is nothing to fold.
  const root = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = root.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width <= 620))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return accountStorage.get(SIDEBAR_KEY) === 'collapsed'
    } catch {
      return false
    }
  })
  const fold = (c: boolean) => {
    setCollapsed(c)
    try {
      accountStorage.set(SIDEBAR_KEY, c ? 'collapsed' : 'open')
    } catch {
      /* not remembered */
    }
  }
  const rail = collapsed && !narrow
  const newThread = () => {
    setArchived(false)
    open(null)
  }
  const openSettings = () => {
    setMain({ kind: 'settings' })
    setPane('chat')
  }
  const openMemory = (scope: number | null = null) => {
    setMain({ kind: 'memory', scope })
    setPane('chat')
  }
  const openStudio = () => {
    setMain({ kind: 'studio' })
    setPane('chat')
  }
  const toggleArchived = () => {
    setArchived((a) => !a)
    fold(false)
    setPane('list')
  }
  const newProject = () => {
    setArchived(false)
    fold(false)
    setPane('list')
    setAddingProject(true)
  }

  // Right-clicks nobody nearer handled: text fields get cut/copy/paste, a selection or a link its
  // own items, and the rest no browser menu.
  const rootMenu = (e: React.MouseEvent) => {
    if (e.shiftKey) return
    const el = e.target as Element
    const field = isField(el)
    if (field) return openContextMenu(e, fieldMenu(field))
    const items = textItems(e.currentTarget, el)
    if (items.length) openContextMenu(e, items)
    else e.preventDefault()
  }
  const sideMenu = (e: React.MouseEvent) => {
    const el = e.target as Element
    if (e.shiftKey || isField(el) || el.closest('.agt-item, .agt-project-head')) return
    openContextMenu(
      e,
      tidyMenu([
        ...textItems(e.currentTarget, el),
        { separator: true },
        { label: 'New thread', onSelect: newThread },
        { label: 'New project…', onSelect: newProject },
        { separator: true },
        { label: 'Archived', checked: archived, onSelect: toggleArchived },
        { label: 'Memory', onSelect: () => openMemory(null) },
        { label: 'Image Studio', onSelect: openStudio },
        { label: 'Settings…', onSelect: openSettings },
        ...(narrow ? [] : [{ separator: true as const }, { label: rail ? 'Show the sidebar' : 'Hide the sidebar', onSelect: () => fold(!rail) }]),
      ]),
    )
  }

  const row = (t: Thread) => (
    <li key={t.id} className="agt-row">
      {renaming === t.id ? (
        <div className="agt-item is-active">
          <RenameBox thread={t} onSave={(title) => rename(t, title)} onCancel={() => setRenaming(null)} />
        </div>
      ) : (
        <button
          className={`agt-item ${t.id === selected && main.kind === 'thread' ? 'is-active' : ''}`}
          onClick={() => open(t.id)}
          onContextMenu={(e) => openContextMenu(e, menu(t))}
          title={[t.title, alsoKnownAs(t), `${t.mode === 'deep' ? 'Deep research' : 'Quick'} · ${t.model}`].filter(Boolean).join('\n')}
          {...(archived ? {} : dragging({ kind: 'thread', id: t.id }))}
        >
          <span className={`agt-dot-mode is-${t.mode} ${t.running ? 'is-running' : ''}`} aria-label={t.mode === 'deep' ? 'Deep research' : 'Quick'} />
          <span className="agt-item-title">
            <Scramble text={t.title} pending={titlePending(t)} />
          </span>
          {t.pinned && (
            <span className="agt-pin" title="Pinned" aria-label="Pinned">
              <Icon name="pin" size={11} />
            </span>
          )}
          <span className="agt-item-when">{t.running ? '…' : shortWhen(t.updatedAt)}</span>
        </button>
      )}
      {renaming !== t.id && (
        <button className="agt-icon agt-mini agt-item-more" onClick={(e) => openMenuAt(e.currentTarget, menu(t))} title="More" aria-label={`${t.title}: more`}>
          <Icon name="more" size={13} />
        </button>
      )}
    </li>
  )

  return (
    <div ref={root} className={`nb agt is-${pane} ${rail ? 'is-rail' : ''}`} onContextMenu={rootMenu}>
      {rail ? (
        <nav className="agt-rail" aria-label="Agents" onContextMenu={sideMenu}>
          <button className="agt-icon" onClick={() => fold(false)} title="Show the sidebar" aria-label="Show the sidebar">
            <Icon name="sidebar" />
          </button>
          <button className="agt-icon is-accent" onClick={newThread} title="New thread" aria-label="New thread">
            <Icon name="plus" />
          </button>
          <span className="agt-grow" />
          <button className="agt-icon" onClick={toggleArchived} title="Archived threads" aria-label="Archived threads">
            <Icon name="archive" />
          </button>
          <button className={`agt-icon ${main.kind === 'memory' ? 'is-on' : ''}`} onClick={() => openMemory(null)} title="Memory" aria-label="Memory">
            <Icon name="memory" />
          </button>
          <button className={`agt-icon ${main.kind === 'studio' ? 'is-on' : ''}`} onClick={openStudio} title="Image Studio" aria-label="Image Studio">
            <Icon name="studio" />
          </button>
          <button className={`agt-icon ${main.kind === 'settings' ? 'is-on' : ''}`} onClick={openSettings} title="Settings" aria-label="Settings">
            <Icon name="gear" />
          </button>
        </nav>
      ) : (
        <aside className="nb-side agt-side" onContextMenu={sideMenu}>
          {archived && (
            <div className="agt-side-title">
              <button className="agt-icon" onClick={() => setArchived(false)} aria-label="Back to threads" title="Back to threads">
                <Icon name="back" />
              </button>
              <strong>Archived</strong>
            </div>
          )}
          <div className="agt-side-head">
            <label className="agt-search">
              <Icon name="search" />
              <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && q && (e.stopPropagation(), setQ(''))} placeholder={archived ? 'Search archived' : 'Search threads'} aria-label="Search threads" spellCheck={false} />
              {q && (
                <button type="button" className="agt-search-clear" onClick={() => setQ('')} title="Clear the search" aria-label="Clear the search">
                  <Icon name="close" size={12} />
                </button>
              )}
            </label>
            {!narrow && (
              <button className="agt-icon" onClick={() => fold(true)} title="Hide the sidebar" aria-label="Hide the sidebar">
                <Icon name="sidebar" />
              </button>
            )}
          </div>
          <div className="agt-list">
            {!archived && (
              <button className={`agt-item agt-studio-link ${main.kind === 'studio' ? 'is-active' : ''}`} onClick={openStudio} title="Generate pictures with your ComfyUI by hand, without an agent">
                <Icon name="studio" />
                <span className="agt-item-title">Image Studio</span>
              </button>
            )}
            {!archived && (
              <section>
                <h4 className="agt-group agt-group-row">
                  <span>Projects</span>
                  <button className="agt-icon agt-mini" onClick={newProject} title="New project" aria-label="New project">
                    <Icon name="plus" size={13} />
                  </button>
                </h4>
                {addingProject && (
                  <InlineName
                    placeholder="Project name"
                    onDone={(name) => {
                      setAddingProject(false)
                      if (name) void createProject(name).then(refresh, () => {})
                    }}
                  />
                )}
                {projects.map((p) => {
                  const list = pinnedFirst(shown.filter((t) => t.projectId === p.id))
                  if (query && !list.length) return null
                  const isFolded = folded.includes(p.id) && !query
                  return (
                    <div key={p.id} className={`agt-project ${dropAt === `p${p.id}` ? 'is-drop' : ''} ${drag?.kind === 'project' && drag.id === p.id ? 'is-dragged' : ''}`}>
                      <div
                        className="agt-project-head"
                        onContextMenu={(e) => openContextMenu(e, projectMenu(p))}
                        {...dragging({ kind: 'project', id: p.id })}
                        {...dropZone(
                          `p${p.id}`,
                          (d) => (d.kind === 'project' ? d.id !== p.id : threads.find((t) => t.id === d.id)?.projectId !== p.id),
                          (d) => (d.kind === 'project' ? reorder(d.id, p.id) : move(threads.find((t) => t.id === d.id)!, p.id)),
                        )}
                      >
                        {renamingProject === p.id ? (
                          <InlineName
                            value={p.name}
                            onDone={(name) => {
                              setRenamingProject(null)
                              if (name && name !== p.name) void renameProject(p.id, name).then(refresh, () => {})
                            }}
                          />
                        ) : (
                          <button className="agt-project-toggle" onClick={() => toggleFold(p.id)} onDoubleClick={() => setRenamingProject(p.id)} aria-expanded={!isFolded}>
                            <span className={`agt-chev ${isFolded ? 'is-folded' : ''}`}>
                              <Icon name="chevron" size={12} />
                            </span>
                            <span className="agt-project-name">{p.name}</span>
                            <span className="agt-project-count">{list.length || ''}</span>
                          </button>
                        )}
                        <button className="agt-icon agt-mini" onClick={() => open(null, p.id)} title={`New thread in ${p.name}`} aria-label={`New thread in ${p.name}`}>
                          <Icon name="plus" size={13} />
                        </button>
                        <button className="agt-icon agt-mini" onClick={(e) => openMenuAt(e.currentTarget, projectMenu(p))} title="More" aria-label={`${p.name}: more`}>
                          <Icon name="more" size={13} />
                        </button>
                      </div>
                      {!isFolded && (
                        <ul className="agt-project-threads">
                          {list.map(row)}
                          {!list.length && <li className="agt-hint muted">No threads yet: + starts one, or drag one here.</li>}
                        </ul>
                      )}
                    </div>
                  )
                })}
                {!projects.length && !addingProject && <p className="agt-hint muted">Projects group threads that belong together, each with a memory of its own.</p>}
              </section>
            )}
            <section
              className={dropAt === 'loose' ? 'agt-drop-loose is-drop' : 'agt-drop-loose'}
              {...dropZone(
                'loose',
                (d) => d.kind === 'thread' && inProject(threads.find((t) => t.id === d.id)!),
                (d) => move(threads.find((t) => t.id === d.id)!, null),
              )}
            >
              <h4 className="agt-group agt-group-row">
                <span>{archived ? 'Archived' : 'Threads'}</span>
                {!archived && (
                  <button className="agt-icon agt-mini" onClick={newThread} title="New thread" aria-label="New thread">
                    <Icon name="plus" size={13} />
                  </button>
                )}
              </h4>
              {loosePinned.length > 0 && <ul>{loosePinned.map(row)}</ul>}
              {looseByDay.map((g) => (
                <div key={g.label}>
                  <h5 className="agt-day">{g.label}</h5>
                  <ul>{g.items.map(row)}</ul>
                </div>
              ))}
              {!loose.length && <p className="agt-list-empty muted">{listError ?? (q ? 'Nothing matches.' : archived ? 'Nothing archived.' : 'No threads yet. Ask something to start one.')}</p>}
            </section>
          </div>
          <div className="agt-side-foot">
            <button className={archived ? 'is-on' : ''} onClick={toggleArchived} title="Archived threads">
              <Icon name="archive" /> <span>Archived</span>
            </button>
            <button className={main.kind === 'memory' ? 'is-on' : ''} onClick={() => openMemory(null)} title="What the agent remembers">
              <Icon name="memory" /> <span>Memory</span>
            </button>
            <button className={main.kind === 'settings' ? 'is-on' : ''} onClick={openSettings} title="Agents settings">
              <Icon name="gear" /> <span>Settings</span>
            </button>
          </div>
        </aside>
      )}
      <section className="nb-main">
        {main.kind === 'settings' ? (
          <SettingsPane onBack={() => (setMain({ kind: 'thread' }), setPane('list'))} />
        ) : main.kind === 'studio' ? (
          <ImageStudio
            threads={threads}
            onBack={() => (setMain({ kind: 'thread' }), setPane('list'))}
            onOpenThread={(id) => (setArchived(false), open(id))}
            onSettings={() => (openSettings(), showAgentsSection('images'))}
          />
        ) : main.kind === 'memory' ? (
          <MemoryView scope={main.scope} projects={projects} onScope={(scope) => setMain({ kind: 'memory', scope })} onBack={() => (setMain({ kind: 'thread' }), setPane('list'))} />
        ) : (
          <Conversation
            key={view}
            listThread={threads.find((t) => t.id === selected)}
            id={selected}
            draftProject={draftProject}
            projects={projects}
            ask={view.startsWith('new') ? question : null}
            onAsked={() => setQuestion(null)}
            onBack={() => setPane('list')}
            onCreated={(t) => {
              setArchived(false)
              setSelected(t.id)
            }}
            onChanged={refresh}
            onArchive={archive}
            onDelete={remove}
          />
        )}
      </section>
    </div>
  )
}

/** A one-line name field: Enter or leaving it keeps the name, Escape drops it. */
function InlineName({ value = '', placeholder, onDone }: { value?: string; placeholder?: string; onDone: (name: string | null) => void }) {
  const done = useRef(false)
  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onDone(name?.trim() || null)
  }
  return (
    <input
      className="agt-inline-name"
      defaultValue={value}
      placeholder={placeholder}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => (e.key === 'Enter' ? finish(e.currentTarget.value) : e.key === 'Escape' && finish(null))}
      onClick={(e) => e.stopPropagation()}
      aria-label={placeholder ?? 'Name'}
    />
  )
}

/** A category path's tree: "People/Friends" sits under "People". */
type CatNode = { name: string; path: string; items: Memory[]; children: CatNode[] }
function catTree(list: Memory[]): CatNode {
  const root: CatNode = { name: '', path: '', items: [], children: [] }
  for (const m of list) {
    let node = root
    for (const part of m.category ? m.category.split('/') : []) {
      const path = node.path ? `${node.path}/${part}` : part
      let next = node.children.find((c) => c.name === part)
      if (!next) node.children.push((next = { name: part, path, items: [], children: [] }))
      node = next
    }
    node.items.push(m)
  }
  const sort = (n: CatNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name))
    n.children.forEach(sort)
  }
  sort(root)
  return root
}
const countIn = (n: CatNode): number => n.items.length + n.children.reduce((s, c) => s + countIn(c), 0)

/**
 * The memory, in the main pane: the user's or one project's, as a tree of categories. Memories can
 * be added, edited (text, category, which memory they belong to) and forgotten.
 */
function MemoryView({ scope, projects, onScope, onBack }: { scope: number | null; projects: Project[]; onScope: (scope: number | null) => void; onBack: () => void }) {
  const [items, setItems] = useState<Memory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [observations, setObservations] = useState(false)
  const load = useCallback(() => listMemories().then(setItems, (e: Error) => setError(e.message)), [])
  useEffect(() => void load(), [load])
  const project = projects.find((p) => p.id === scope) ?? null
  const query = q.trim().toLowerCase()
  const mine = (items ?? []).filter((m) => m.projectId === scope)
  const list = mine.filter((m) => !query || `${m.category} ${m.text}`.toLowerCase().includes(query))
  const tree = catTree(list)
  const categories = [...new Set((items ?? []).map((m) => m.category).filter(Boolean))].sort()
  const count = (s: number | null) => (items ?? []).filter((m) => m.projectId === s).length
  const scopeValue = scope === null ? 'user' : `p${scope}`
  const save = async (m: Memory | null, input: { text: string; category: string; projectId: number | null }) => {
    try {
      if (m) await updateMemory(m.id, input)
      else await addMemory(input)
      setEditing(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const forget = (m: Memory) => void deleteMemory(m.id).then(load, () => {})
  // Image observations show as fields, not their stored text; profile memories name the profiles.
  const profileNames = new Map((items ?? []).flatMap((m) => { const name = m.imageProfile && /^Image profile · (.+?) · (?:user|suggestion)\n/.exec(m.text)?.[1]; return name ? [[m.id, name] as const] : [] }))
  const observation = (m: Memory) => readObservation({ id: m.id, threadId: m.threadId, createdAt: m.createdAt, updatedAt: m.updatedAt }, m.text)
  const learnings = list.filter((m) => m.imageLearning).length
  const itemMenu = (e: React.MouseEvent, m: Memory) =>
    !e.shiftKey &&
    openContextMenu(
      e,
      tidyMenu([
        ...textItems(e.currentTarget, e.target as Element),
        { separator: true },
        { label: 'Edit…', disabled: m.imageLearning || m.imageProfile, onSelect: () => setEditing(m.id) },
        { label: 'Copy', onSelect: () => copy(m.text) },
        {
          label: 'Move to',
          disabled: m.imageLearning || m.imageProfile,
          submenu: [
            { label: 'You (user memory)', checked: m.projectId === null, onSelect: () => void save(m, { text: m.text, category: m.category, projectId: null }) },
            ...projects.map((p) => ({ label: p.name, checked: m.projectId === p.id, onSelect: () => void save(m, { text: m.text, category: m.category, projectId: p.id }) })),
          ],
        },
        { separator: true },
        { label: 'Forget', danger: true, onSelect: () => forget(m) },
      ]),
    )

  const node = (n: CatNode, depth: number): ReactNode => (
    <Fragment key={n.path || 'root'}>
      {n.items.map((m) =>
        editing === m.id ? (
          <MemoryForm key={m.id} memory={m} scope={m.projectId} projects={projects} categories={categories} onSave={(input) => void save(m, input)} onCancel={() => setEditing(null)} />
        ) : (
          <div key={m.id} className="agt-mem" onContextMenu={(e) => itemMenu(e, m)} onDoubleClick={() => { if (!m.imageLearning && !m.imageProfile) setEditing(m.id) }}>
            {m.imageLearning ? (
              <div className="agt-mem-text">
                {(() => {
                  const o = observation(m)
                  return <ObservationLine o={o} profile={o.profileId === null ? 'No profile' : profileNames.get(o.profileId) ?? `Profile ${o.profileId}`} />
                })()}
              </div>
            ) : (
              <span className="agt-mem-text">{m.text}</span>
            )}
            <span className="agt-mem-actions">
              <button className="agt-icon agt-mini" disabled={m.imageLearning || m.imageProfile} onClick={() => setEditing(m.id)} title={m.imageLearning || m.imageProfile ? 'Structured image memory: edit profiles in Images; revise observations with image learning tools' : 'Edit'} aria-label="Edit">
                <Icon name="edit" size={13} />
              </button>
              <button className="agt-icon agt-mini" onClick={() => forget(m)} title="Forget" aria-label="Forget">
                <Icon name="close" size={13} />
              </button>
            </span>
          </div>
        ),
      )}
      {n.children.map((c) => (
        <details key={c.path} className="agt-cat" open={depth < 1 || !!query}>
          <summary>
            <span className="agt-chev">
              <Icon name="chevron" size={12} />
            </span>
            {c.name} <span className="muted">{countIn(c)}</span>
          </summary>
          <div className="agt-cat-body">
            {c.path === 'Images/Learnings' && (
              <button type="button" className="btn btn-small agt-mem-obs-open" onClick={() => setObservations(true)}>
                Overview with filters and profiles…
              </button>
            )}
            {node(c, depth + 1)}
          </div>
        </details>
      ))}
    </Fragment>
  )

  return (
    <>
      <div className="nb-toolbar agt-toolbar">
        <button className="btn btn-small agt-back" onClick={onBack} aria-label="Back to threads">
          ‹
        </button>
        <span className="agt-title">{project ? `${project.name}: memory` : 'Memory'}</span>
        <span className="nb-spacer" />
        <Select
          value={scopeValue}
          onChange={(v) => onScope(v === 'user' ? null : Number(String(v).slice(1)))}
          aria-label="Whose memory"
          options={[{ value: 'user', label: 'You', note: String(count(null)) }, ...projects.map((p) => ({ value: `p${p.id}`, label: p.name, note: String(count(p.id)) }))]}
        />
        <button className="btn btn-small btn-primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={13} /> Add
        </button>
      </div>
      <div className="agt-scroll agt-memory-view">
        <p className="muted agt-mem-help">
          {project
            ? `Facts that only matter to ${project.name}. Threads in this project read them, next to what the agent knows about you.`
            : 'What the agent knows about you. Image profiles and observations are retrieved only for image tasks; edit profiles in Images, or forget them here. The Images/Learnings marker identifies cautious image observations, not proven facts or rankings. Other memories follow every thread.'}
        </p>
        <label className="agt-search agt-mem-search">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memory" aria-label="Search memory" spellCheck={false} />
        </label>
        {editing === 'new' && <MemoryForm scope={scope} projects={projects} categories={categories} onSave={(input) => void save(null, input)} onCancel={() => setEditing(null)} />}
        {items && !mine.length && editing !== 'new' && <p className="muted">{project ? `Nothing remembered about ${project.name} yet.` : 'Nothing remembered yet. Ask the agent to remember something, or add it here.'}</p>}
        {items && mine.length > 0 && !list.length && <p className="muted">Nothing matches.</p>}
        {query && learnings > 0 && (
          <p className="muted agt-mem-obs-hint">
            {learnings === list.length ? `All ${learnings} matches are image observations.` : `${learnings} of ${list.length} matches are image observations.`}{' '}
            <button type="button" className="btn btn-small" onClick={() => setObservations(true)}>
              Open the overview
            </button>
          </p>
        )}
        <div className="agt-mem-tree">{node(tree, 0)}</div>
        {error && <p className="t-red copyable">{error}</p>}
      </div>
      {observations && <ObservationsDialog onClose={() => setObservations(false)} onChanged={() => void load()} />}
    </>
  )
}

/** Adding or editing one memory: its text, category path and whose memory it is. */
function MemoryForm({ memory, scope, projects, categories, onSave, onCancel }: { memory?: Memory; scope: number | null; projects: Project[]; categories: string[]; onSave: (input: { text: string; category: string; projectId: number | null }) => void; onCancel: () => void }) {
  const [text, setText] = useState(memory?.text ?? '')
  const [category, setCategory] = useState(memory?.category ?? '')
  const [whose, setWhose] = useState<string>(scope === null ? 'user' : `p${scope}`)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (text.trim()) onSave({ text: text.trim(), category, projectId: whose === 'user' ? null : Number(whose.slice(1)) })
  }
  const close = categories.filter((c) => c.toLowerCase().startsWith(category.toLowerCase()) && c !== category).slice(0, 6)
  return (
    <form className="agt-mem-form" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="One fact, in a sentence" rows={2} autoFocus aria-label="Memory" />
      <div className="agt-mem-form-row">
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category, like People/Friends" aria-label="Category" spellCheck={false} />
        <Select value={whose} onChange={(v) => setWhose(String(v))} aria-label="Whose memory" options={[{ value: 'user', label: 'You' }, ...projects.map((p) => ({ value: `p${p.id}`, label: p.name }))]} />
        <button type="button" className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-small btn-primary" disabled={!text.trim()}>
          Save
        </button>
      </div>
      {category && close.length > 0 && (
        <div className="agt-mem-cats">
          {close.map((c) => (
            <button type="button" key={c} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
    </form>
  )
}

/** The agent's plan for a long job: "3/12" with the step it is on; tap for the whole list. */
function TodoChip({ todos, running, onDismiss }: { todos: Todo[]; running: boolean; onDismiss: () => void }) {
  const [open, setOpen] = useState(false)
  const done = todos.filter((t) => t.status === 'done').length
  const active = todos.find((t) => t.status === 'active') ?? todos.find((t) => t.status === 'pending')
  return (
    <div className={`agt-todos ${open ? 'is-open' : ''}`}>
      {open && (
        <ol className="agt-todo-list">
          {todos.map((t, i) => (
            <li key={i} className={`is-${t.status}`}>
              <span className={`agt-todo-mark ${t.status === 'active' && running ? 'is-live' : ''}`} aria-label={t.status}>
                {t.status === 'done' ? '✓' : t.status === 'active' ? '●' : '○'}
              </span>
              {t.text}
            </li>
          ))}
        </ol>
      )}
      <button type="button" className="agt-todo-bar" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? 'Hide the plan' : 'Show the plan'}>
        <span className="agt-todo-count">
          {done}/{todos.length}
        </span>
        <span className="agt-todo-track" aria-hidden>
          <span style={{ width: `${(done / Math.max(1, todos.length)) * 100}%` }} />
        </span>
        <span className="agt-todo-now">{done === todos.length ? 'All done' : active?.text}</span>
        <span className={`agt-chev ${open ? '' : 'is-up'}`}>
          <Icon name="chevron" size={12} />
        </span>
      </button>
      <button type="button" className="agt-todo-dismiss" onClick={onDismiss} aria-label="Dismiss the plan" title="Dismiss the plan (the agent forgets it too)">
        ×
      </button>
    </div>
  )
}

/**
 * Messages waiting to be sent, in order, over the composer: each can be edited (in the message
 * box), sent now (stopping the agent if it works) or removed. After a stop or an error they wait
 * for the user: Send queued sends the first.
 */
function QueueList({ queue, answering, editing, onEdit, onSend, onRemove }: { queue: QueuedMessage[]; answering: boolean; editing: string | null; onEdit: (q: QueuedMessage) => void; onSend: (q: QueuedMessage) => void; onRemove: (q: QueuedMessage) => void }) {
  return (
    <div className="agt-queue" aria-label="Queued messages">
      <div className="agt-queue-head">
        <span>{answering ? `Queued, sent one by one when it is done (${queue.length})` : `Waiting to be sent (${queue.length})`}</span>
        <span className="agt-grow" />
        {!answering && (
          <button type="button" className="btn btn-small" onClick={() => onSend(queue[0])} title="Send the first queued message now; the rest follow">
            Send queued
          </button>
        )}
      </div>
      <ol>
        {queue.map((q, i) => (
          <li key={q.id} className={editing === q.id ? 'is-editing' : ''}>
            <span className="agt-queue-n">{i + 1}</span>
            <span className="agt-queue-text" title={q.text}>
              {q.text || <span className="muted">{q.attachments.map((a) => a.name).join(', ')}</span>}
            </span>
            {q.attachments.length > 0 && (
              <span className="agt-queue-files muted" title={q.attachments.map((a) => a.name).join('\n')}>
                <Icon name="clip" size={12} /> {q.attachments.length}
              </span>
            )}
            {editing === q.id ? <span className="agt-queue-state">editing</span> : q.editing && <span className="agt-queue-state muted">editing elsewhere</span>}
            <button type="button" onClick={() => onEdit(q)} disabled={!!editing} title="Edit it in the message box (↑ in an empty box edits the last one)">
              Edit
            </button>
            <button type="button" onClick={() => onSend(q)} title={answering ? 'Stop the agent and send this now, ahead of the rest' : 'Send this now'}>
              Send now
            </button>
            <button type="button" className="agt-queue-x" onClick={() => onRemove(q)} aria-label="Remove from the queue" title="Remove from the queue">
              ×
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

type ConversationProps = {
  id: string | null
  /** The project a new thread goes into */
  draftProject: number | null
  projects: Project[]
  /** The thread as the list last saw it: a title set there (or thought of later) shows here too */
  listThread?: Thread
  /** A question to send as soon as the conversation opens (from Spotlight) */
  ask: { text: string; mode: Mode } | null
  onAsked: () => void
  onBack: () => void
  onCreated: (t: Thread) => void
  onChanged: () => void
  onArchive: (t: Thread, archived: boolean) => void
  onDelete: (t: Thread) => void
}

function Conversation({ id, draftProject, projects, listThread, ask, onAsked, onBack, onCreated, onChanged, onArchive, onDelete }: ConversationProps) {
  const [thread, setThread] = useState<Thread | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  // The currencies the answers mention, offered when you open an amount in one (src/os/MoneyAmount.tsx).
  const threadCurrencies = useMemo(() => currenciesIn(messages.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content)), [messages])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [draftMode, setDraftMode] = useState<Mode>(() => ask?.mode ?? agentSettings().mode)
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  // The message box starts from what was left there last time (src/data/agentDrafts.ts).
  const [photoPicker, setPhotoPicker] = useState(false)
  const [files, setFiles] = useState<Attachment[]>(() => getDraft(id ?? 'new')?.files ?? [])
  const latestFiles = useRef(files)
  latestFiles.current = files
  const [reading, setReading] = useState(0)
  const settingsNow = useAgentSettings()
  const [draftTools, setDraftTools] = useState<ToolGroup[]>(settingsNow.tools)
  const account = useAccount()
  const { accounts: mailAccounts } = useMailAccounts()
  const pcFiles = useRef<HTMLInputElement>(null)
  const [draftModel, setDraftModel] = useState<string | null>(null)
  const [draftWorkdir, setDraftWorkdir] = useState<Workdir | null>(null)
  // New threads start in Auto: like Ask first, but web addresses it builds are checked for you.
  const [draftPermission, setDraftPermission] = useState<Permission>('auto')
  // Always-on skills switched off with their chips before the thread exists.
  const [draftSkillsOff, setDraftSkillsOff] = useState<string[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [mentionTools, setMentionTools] = useState<MentionTool[]>([])
  const [loras, setLoras] = useState<LoraDetail[] | null>(null)
  const [loraManager, setLoraManager] = useState(false)
  const phone = useIsMobile()
  const [loraError, setLoraError] = useState('')
  const [loraLoading, setLoraLoading] = useState(false)
  const [caret, setCaret] = useState(0)
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
  useEffect(() => { listMentionTools().then(setMentionTools, () => {}) }, [])
  const [text, setText] = useState(() => getDraft(id ?? 'new')?.text ?? '')
  const [live, setLive] = useState<Live | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [ctxOpen, setCtxOpen] = useState(false)
  const ctxId = useId()
  useEffect(() => setCtxOpen(false), [thread?.id])
  const [openingImages, setOpeningImages] = useState(false)
  // A compaction under way (asked for, or by itself in the middle of a turn): shown in place of the reply.
  const [compacting, setCompacting] = useState<{ auto: boolean } | null>(null)
  // A queued message being edited in the message box, and what was in the box before (back after).
  const [editingQ, setEditingQ] = useState<{ id: string; stash: { text: string; files: Attachment[] } } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const input = useRef<HTMLTextAreaElement>(null)
  const emoji = useEmojiTyping(input, text)

  // A thread created by the first message keeps streaming into this view: don't reload it then.
  const streamed = useRef<string | null>(null)
  useEffect(() => {
    if (!id || streamed.current === id) return
    getThread(id).then(
      (r) => (setThread(r.thread), setMessages(r.messages), setApprovals(r.pending)),
      (e: Error) => setError(e.message),
    )
  }, [id])
  // Kept for coming back: per thread, or for the new thread while there is none yet. A queued
  // message being edited is not a draft.
  useEffect(() => void (!editingQ && setDraft(id ?? 'new', text, files)), [id, text, files, editingQ])
  useEffect(() => {
    agentModels().then(setModels, () => {})
    if (mayTakeFocus()) input.current?.focus()
    return () => abort.current?.abort()
  }, [])

  useEffect(() => {
    if (!listThread) return
    setThread((t) =>
      t && t.id === listThread.id && (t.title !== listThread.title || t.titling !== listThread.titling || t.aliases.length !== listThread.aliases.length || t.titleSource !== listThread.titleSource)
        ? { ...t, title: listThread.title, titling: listThread.titling, aliases: listThread.aliases, titleSource: listThread.titleSource, checkingTitle: listThread.checkingTitle }
        : t,
    )
  }, [listThread?.title, listThread?.titling, listThread?.aliases.length, listThread?.titleSource])

  // Mail reads always allowed or not, changed in Settings or on a card: open threads show it at once.
  useEffect(() => {
    const on = (e: Event) => setThread((t) => (t ? { ...t, mailReadsAlways: (e as CustomEvent<string>).detail === 'always' } : t))
    window.addEventListener(MAIL_READS_EVENT, on)
    return () => window.removeEventListener(MAIL_READS_EVENT, on)
  }, [])

  // What a turn streams, whether this window started it or joined it later.
  const onEvent = (e: TurnEvent) => {
    if (e.type === 'snapshot') {
      setThread(e.thread)
      setMessages(e.messages)
      // A picture being drawn: its start on this window's clock, from how long it has been going.
      setApprovals(e.pending.map((p) => (p.gpt ? { ...p, gpt: { ...p.gpt, startedAt: Date.now() - (p.gpt.elapsed ?? 0) } } : p)))
      setLive(e.live)
      found(e.messages)
    } else if (e.type === 'delta') setLive((l) => ({ content: (l?.content ?? '') + (e.content ?? ''), thinking: (l?.thinking ?? '') + (e.thinking ?? '') }))
    else if (e.type === 'imageGeneration') setApprovals((a) => [...a, { callId: e.callId, messageId: e.messageId, index: e.index, kind: 'image', width: e.width, height: e.height, ...(e.gpt ? { gpt: { ...e.gpt, startedAt: Date.now() } } : {}) }])
    else if (e.type === 'gptPreview') setApprovals((a) => a.map((x) => (x.callId === e.callId && x.gpt ? { ...x, gpt: { ...x.gpt, previews: e.previews } } : x)))
    else if (e.type === 'imageProgress') setApprovals((a) => a.map((x) => (x.callId === e.callId ? { ...x, progress: e.progress } : x)))
    else if (e.type === 'approval') setApprovals((a) => [...a, { callId: e.callId, messageId: e.messageId, index: e.index, kind: 'approval', call: e.call, summary: e.summary, check: e.check }])
    else if (e.type === 'client') setApprovals((a) => [...a, { callId: e.callId, messageId: e.messageId, index: e.index, kind: 'client', call: e.call }])
    else if (e.type === 'question') setApprovals((a) => [...a, { callId: e.callId, messageId: e.messageId, index: e.index, kind: 'question', form: e.form }])
    else if (e.type === 'answered' || e.type === 'approved' || e.type === 'clientDone' || e.type === 'imageGenerationDone') setApprovals((a) => a.filter((x) => x.callId !== e.callId))
    else if (e.type === 'compact') setCompacting(e.state === 'start' ? { auto: e.auto } : null)
    else if (e.type === 'message') {
      setMessages((ms) => [...ms, e.message])
      if (e.message.role === 'compact') setCompacting(null)
      // The agent changed the Notebook on the server: fetch it now rather than at the next sync.
      if (e.message.role === 'tool' && /^(create|update|delete)_note$/.test(e.message.toolName ?? '')) void pullAll()
      // A user message mid-stream is the next queued one: what a stopped turn left unsaved goes.
      if (e.message.role === 'assistant' || e.message.role === 'user') setLive({ content: '', thinking: '' })
    } else if (e.type === 'thread') {
      setThread(e.thread)
      // At rest now (the last thing a chain of turns says): no reply is being written any more.
      if (!e.thread.running) (setLive(null), setCompacting(null))
      onChanged()
    } else if (e.type === 'queue') setThread((t) => (t ? { ...t, queue: e.queue } : t))
    // A failed turn: the thread's `interrupted` says so when it ends, with Retry (see below).
  }

  // A stream that drops (the network, or the server restarting for an update) is not the end of
  // the turn: the follow effect below finds it again, trying for a minute, and only then says the
  // connection dropped. `lostAt` is when it went; `unsent` a message that may not have got there.
  const lostAt = useRef<number | null>(null)
  const tries = useRef(0)
  const [reconnecting, setReconnecting] = useState(false)
  const [dropped, setDropped] = useState(false)
  const unsent = useRef<{ text: string; files: Attachment[]; sent: string } | null>(null)
  const lose = () => {
    if (lostAt.current === null) (lostAt.current = Date.now()), (tries.current = 0)
    setReconnecting(true)
    setDropped(false)
  }
  /** The thread answered again: back in touch. A message the drop swallowed goes back in the box. */
  const found = (msgs: AgentMessage[]) => {
    lostAt.current = null
    setReconnecting(false)
    setDropped(false)
    const u = unsent.current
    unsent.current = null
    if (u && [...msgs].reverse().find((m) => m.role === 'user')?.content !== u.sent) {
      setText((t) => t || u.text)
      setFiles((f) => (f.length ? f : u.files))
      setError('The connection dropped before your message got there: it is back in the box')
    }
  }

  // Answering, but not from this window (opened again later, or another tab): join the turn and
  // follow it live. When the stream ends, the saved thread says whether it is really done; a
  // broken stream to a turn still running joins again.
  const [rejoin, setRejoin] = useState(0)
  useEffect(() => {
    if (!id || busy || !(thread?.running || lostAt.current !== null)) return
    const ctl = new AbortController()
    followThread(id, onEvent, ctl.signal)
      .catch(() => {})
      .finally(() => {
        if (ctl.signal.aborted) return
        getThread(id).then(
          (r) => {
            if (ctl.signal.aborted) return
            setThread(r.thread)
            setMessages(r.messages)
            setApprovals(r.pending)
            setLive(null)
            found(r.messages)
            onChanged()
            if (r.thread.running) setTimeout(() => setRejoin((n) => n + 1), 2000)
          },
          () => {
            if (ctl.signal.aborted) return
            // No answer: the server may be restarting. Look again, a little slower each time, for a minute.
            lose()
            if (Date.now() - (lostAt.current ?? Date.now()) > 60_000) {
              lostAt.current = null
              setReconnecting(false)
              setDropped(true)
              setLive(null)
              // Not known to be running any more: what the window offers is Retry and Look again.
              setThread((t) => (t ? { ...t, running: false } : t))
              return
            }
            setTimeout(() => setRejoin((n) => n + 1), Math.min(5000, 1000 * 2 ** tries.current++))
          },
        )
      })
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, busy, thread?.running, rejoin])

  // Follow the answer as it grows, unless scrolled up to read; then offer a jump back down instead.
  const [scrolledUp, setScrolledUp] = useState(false)
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, live])
  // Growth that is not a new message (an image frame, a tool card, progress text) follows too.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const follow = () => { if (pinned.current) el.scrollTop = el.scrollHeight }
    const sizes = new ResizeObserver(follow)
    const watch = () => { sizes.disconnect(); for (const child of Array.from(el.children)) sizes.observe(child) }
    const children = new MutationObserver(() => { watch(); follow() })
    watch()
    children.observe(el, { childList: true })
    return () => { sizes.disconnect(); children.disconnect() }
  }, [id])
  useEffect(() => { pinned.current = true; setScrolledUp(false) }, [id])

  const mode = thread?.mode ?? draftMode
  const model = thread?.model ?? draftModel ?? ''
  const usualModel = (draftMode === 'deep' ? settingsNow.deepModel : settingsNow.quickModel) ?? null

  const setMode = (m: Mode) => {
    setAgentSettings({ mode: m })
    if (thread) updateThread(thread.id, { mode: m }).then((t) => (setThread(t), onChanged()), (e: Error) => setError(e.message))
    else (setDraftMode(m), setDraftModel(null))
  }
  const setModel = (name: string) => {
    if (thread) updateThread(thread.id, { model: name }).then((t) => (setThread(t), onChanged()), (e: Error) => setError(e.message))
    else setDraftModel(name)
  }

  // The work folder (a Seafile folder its file tools work in) and how changes are allowed.
  const workdir = thread ? thread.workdir : draftWorkdir
  const permission = thread ? thread.permission : draftPermission
  const setWorkdir = (w: Workdir | null) => {
    if (thread) updateThread(thread.id, { workdir: w }).then((t) => (setThread(t), onChanged()), (e: Error) => setError(e.message))
    else {
      setDraftWorkdir(w)
      if (w && !draftTools.includes('files')) setDraftTools((t) => [...t, 'files'])
    }
  }
  const setPermission = (p: Permission) => {
    if (thread) updateThread(thread.id, { permission: p }).then((t) => (setThread(t), onChanged()), (e: Error) => setError(e.message))
    else setDraftPermission(p)
  }
  const chooseFolder = async () => {
    const sf = await pickFolder({ title: 'Work folder', start: null })
    const at = sf ? parseSf(sf) : null
    if (!sf || !at) return
    const posix = posixOf(sf)
    setWorkdir({ repo: at.repo, path: at.p || '/', label: posix ? prettyPath(posix) : `${libraryName(at.repo)}${at.p === '/' ? '' : at.p}` })
  }
  const folderMenu = (e: React.MouseEvent) =>
    openMenuAt(e.currentTarget, [
      { label: 'Choose a folder…', hint: 'In Seafile: the agent reads, searches and edits files there', disabled: !account.seafile, onSelect: () => void chooseFolder() },
      { label: 'No work folder', checked: !workdir, onSelect: () => setWorkdir(null) },
    ])
  const permissionMenu = (e: React.MouseEvent) =>
    openMenuAt(e.currentTarget, PERMISSIONS.map((p) => ({ label: PERMISSION_LABEL[p], hint: PERMISSION_HELP[p], checked: permission === p, onSelect: () => setPermission(p) })))
  useEffect(() => {
    listSkills(thread ? { thread: thread.id } : { folder: workdir }).then(setSkills, () => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id, workdir?.repo, workdir?.path])

  // A ref, not `busy`: two sends in one render (a double Enter, a re-run effect) must not both go.
  // `sending` is the turn this window streams, `queueing` a message going to the queue (or
  // answering what it asked, or an edit saved) while one streams.
  const sending = useRef(false)
  const queueing = useRef(false)
  // Edit on a gpt_image picture: what should change, then a message asking the agent to draw it
  // again from that picture (its id goes along, so gpt_image gets it as a reference).
  const editPicture = async (name: string, ref: string) => {
    const change = await askText({ title: 'Edit picture', body: <>What should change in “{name}”?</>, label: 'What should change?', placeholder: 'Make the sky orange and the title bigger', confirm: 'Redraw', validate: (t) => (t.trim() ? null : 'Say what should change') })
    if (change?.trim()) void send(`Change the picture “${name}” (${ref}): ${change.trim()}`)
  }
  const send = async (asked?: string) => {
    const typed = (asked ?? text).trim()
    let attached = asked === undefined ? files : []
    const toQueue = asked === undefined && (!!editingQ || (answering && !!thread))
    if ((!typed && !attached.length) || (toQueue ? queueing.current : sending.current) || reading) return
    // Too long to send as typed text: it goes along as a file instead.
    let message = typed
    if (typed.length > MAX_MESSAGE) {
      if (attached.length >= 10) return setError('That message is too long to send with 10 attachments: remove one first')
      try {
        attached = [...attached, textAttachment(typed, 'Message.txt')]
      } catch (e) {
        return setError((e as Error).message)
      }
      message = ''
    }
    // Editing a queued message: Enter saves it back in its place.
    if (editingQ && asked === undefined) return saveEdit(message, attached)
    // /compact summarises the thread so far: a thread not made yet has nothing to summarise.
    if (isCompact(message) && !attached.length && !hasConversation) return setError('There is nothing to compact yet: /compact summarises the conversation so far')
    // While it works, a message waits in the queue; while it waits on you (changes to allow, a
    // plan, a form), it answers all of that instead.
    if (answering && thread && asked === undefined) {
      queueing.current = true
      setError(null)
      try {
        const r = waiting ? await overrideTurn(thread.id, message, attached) : await queueMessage(thread.id, message, attached)
        setThread(r.thread)
        setText('')
        setFiles([])
        dropDraft(thread.id)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        queueing.current = false
      }
      return
    }
    sending.current = true
    setError(null)
    setBusy(true)
    pinned.current = true
    let target = thread
    try {
      if (!target) {
        target = await createThread({ mode: draftMode, tools: draftTools, projectId: draftProject, workdir: draftWorkdir, permission: draftPermission, skillsOff: draftSkillsOff, ...(draftModel ? { model: draftModel } : {}) })
        streamed.current = target.id
        setThread(target)
        onCreated(target)
      }
      // Asked from Spotlight: what is in the box stays there.
      if (asked === undefined) {
        setText('')
        setFiles([])
        dropDraft('new')
        dropDraft(target.id)
      }
      setLive({ content: '', thinking: '' })
      const ctl = new AbortController()
      abort.current = ctl
      let accepted = false
      try {
        await sendMessage(target.id, message, attached, (e) => ((accepted ||= (e.type === 'message' && e.message.role === 'user') || e.type === 'compact'), onEvent(e)), ctl.signal)
      } catch (e) {
        // Dropped on the way, not refused: the turn may well go on (or the server is restarting).
        if (!isDropped(e) || ctl.signal.aborted) throw e
        if (!accepted && asked === undefined) unsent.current = { text: typed, files, sent: message }
        lose()
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError((e as Error).message)
        // A compaction from the thread's menu was never in the box.
        if (asked === undefined || !isCompact(typed)) {
          setText((t) => t || typed)
          setFiles((f) => (f.length ? f : asked === undefined ? files : []))
        }
      }
    } finally {
      abort.current = null
      sending.current = false
      setBusy(false)
      setLive(null)
      setCompacting(null)
      setApprovals([])
      onChanged()
    }
  }

  // Compact: the model summarises the thread so far and works from the summary from then on (all
  // messages stay here). Optional instructions say what the summary should keep. While it works,
  // the compaction waits in the queue like a message.
  const compactNow = (focus = '') => {
    if (!thread) return
    const text = `/compact ${focus.trim()}`.trim()
    if (!answering) return void send(text)
    queueMessage(thread.id, text, []).then(
      (r) => setThread(r.thread),
      (e: Error) => setError(e.message),
    )
  }
  const compactDialog = async () => {
    if (!thread) return
    let focus = ''
    const ok = await confirmDialog({
      title: 'Compact this conversation?',
      body: (
        <>
          <p>The model writes a summary of the conversation so far and works from that from now on, which frees up its context window. Every message stays here to read.</p>
          <label className="agt-compact-focus">
            <span className="muted">What should the summary keep in particular? (optional)</span>
            <textarea rows={3} placeholder="For example: the API details and the open bugs" onChange={(e) => (focus = e.target.value)} />
          </label>
          {answering && <p className="muted">It is working now: the compaction waits in the queue until it is done.</p>}
        </>
      ),
      confirm: 'Compact',
    })
    if (ok) compactNow(focus)
  }

  // Asked from Spotlight: send it once the window is up (once, even when effects run twice).
  const askSent = useRef(false)
  useEffect(() => {
    if (!ask || askSent.current) return
    askSent.current = true
    onAsked()
    void send(ask.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Retry: the last turn again (what it left goes), streamed into this window like a message.
  const retry = async () => {
    if (!thread || sending.current) return
    sending.current = true
    setError(null)
    setDropped(false)
    setBusy(true)
    pinned.current = true
    // A /compact cut short is compacted again: nothing goes.
    const at = thread.interrupted?.compact ? -1 : messages.map((m) => m.role).lastIndexOf('user')
    setMessages((ms) => (at >= 0 ? ms.slice(0, at) : ms))
    setThread((t) => (t ? { ...t, interrupted: null } : t))
    setLive({ content: '', thinking: '' })
    const ctl = new AbortController()
    abort.current = ctl
    try {
      await retryTurn(thread.id, onEvent, ctl.signal)
    } catch (e) {
      if (isDropped(e) && !ctl.signal.aborted) lose()
      else if ((e as Error).name !== 'AbortError') {
        setError((e as Error).message)
        void getThread(thread.id).then((r) => (setThread(r.thread), setMessages(r.messages), setApprovals(r.pending)), () => {})
      }
    } finally {
      abort.current = null
      sending.current = false
      setBusy(false)
      setLive(null)
      setCompacting(null)
      setApprovals([])
      onChanged()
    }
  }

  const branchFrom = async (message: AgentMessage) => {
    if (!thread || answering || sending.current) return
    sending.current = true
    try {
      const result = await branchThread(thread.id, message.id)
      onCreated(result.thread)
      onChanged()
    } catch (e) { setError((e as Error).message) }
    finally { sending.current = false }
  }
  const again = async (imageId: string, operation?: UpscaleImageInput | RefineImageInput | MaskedEditInput) => {
    if (!thread || answering || sending.current) return
    sending.current = true
    setError(null); setDropped(false); setBusy(true); pinned.current = true
    const ctl = new AbortController()
    abort.current = ctl
    try { await (operation ? operation.operation === 'inpaint' || operation.operation === 'remove' ? inpaintImage(thread.id, operation, onEvent, ctl.signal) : operation.operation === 'refine' ? refineImage(thread.id, operation, onEvent, ctl.signal) : upscaleImage(thread.id, operation, onEvent, ctl.signal) : generateAnother(thread.id, imageId, onEvent, ctl.signal)) }
    catch (e) {
      if (isDropped(e) && !ctl.signal.aborted) lose()
      else if ((e as Error).name !== 'AbortError') setError((e as Error).message)
    } finally {
      abort.current = null; sending.current = false; setBusy(false); setLive(null); setApprovals([]); onChanged()
    }
  }
  // Where Retry sits when the last turn ended well: in the row of its last answer, or of its last
  // image when it drew one after (or instead of) writing. Null: nothing to put it under.
  const retryAt = (() => {
    if (messages.at(-1)?.role === 'compact') return null
    let at: number | null = null
    for (let i = messages.length - 1; i >= 0 && messages[i].role !== 'user'; i--) {
      const m = messages[i]
      if ((m.role === 'assistant' && m.content.trim()) || (m.role === 'tool' && m.toolName === 'generate_image' && generatedImage(m.content))) { at = m.id; break }
    }
    return at
  })()
  /** A message's own actions (Branch off; Generate another for an image unless its row has it). */
  const messageActions = (message: AgentMessage, inRow = false): MenuItem[] => {
    const image = !inRow && message.toolName === 'generate_image' ? generatedImage(message.content) : null
    return [
      { label: 'Branch off from here', hint: answering ? 'Wait for this thread to finish' : 'Continue in a new thread; keep the original', disabled: answering, onSelect: () => void branchFrom(message) },
      ...(image ? [{ label: image.settings?.operation === 'upscale' ? 'Upscale again' : image.settings?.operation === 'refine' ? 'Refine again' : 'Generate another', hint: !image.settings ? 'This image has no recorded generation settings' : !tools.includes('images') ? 'Turn on Images in Tools first' : answering ? 'Wait for this thread to finish' : image.settings?.operation === 'upscale' ? 'Repeat the upscale from its original source and recorded settings' : image.settings?.operation === 'refine' ? 'Refine the original source again with a fresh seed' : 'Draw this image again with the same prompt and settings', disabled: answering || !tools.includes('images') || !image.settings, onSelect: () => void again(image.id) }] : []),
    ]
  }

  // Rewind to one of your messages: it and everything after it go (asked first, saying what is not
  // undone), and it comes back into the message box to edit and send again.
  const rewindTo = async (m: AgentMessage, edit: boolean) => {
    if (!thread) return
    const after = messages.filter((x) => x.id > m.id && x.role !== 'compact')
    const mine = after.filter((x) => x.role === 'user').length
    const theirs = after.length - mine
    const parts = [mine ? `${mine} more of yours` : '', theirs ? `${theirs} from the agent (replies and tool results)` : ''].filter(Boolean).join(' and ')
    // A compaction after it summarised messages that go: it goes too.
    const compactions = messages.filter((x) => x.id > m.id && x.role === 'compact').length
    const ok = await confirmDialog({
      title: edit ? 'Edit and send this message again?' : 'Rewind to this message?',
      body: (
        <>
          <p>
            This message {after.length ? `and the ${after.length} after it (${parts})` : ''} {after.length ? 'leave' : 'leaves'} the thread, and it goes back into the message box{text.trim() || files.length ? ', in place of what is there now' : ''}.
            {answering ? ' The agent is stopped first.' : ''}
          </p>
          {compactions > 0 && <p className="muted">{compactions === 1 ? 'The compaction after it goes too' : `The ${compactions} compactions after it go too`}: the agent works from the messages before it again.</p>}
          <p className="muted">What its tools did is not undone: memories, the plan, notes and calendar events stay as they are, and files it changed in the work folder are not restored. Queued messages stay queued.</p>
        </>
      ),
      confirm: edit ? 'Rewind and edit' : 'Rewind',
      danger: true,
    })
    if (!ok) return
    try {
      const r = await rewindThread(thread.id, m.id)
      if (editingQ) cancelEdit()
      const fresh = await getThread(thread.id).catch(() => null)
      setThread(fresh?.thread ?? r.thread)
      setMessages(fresh?.messages ?? messages.filter((x) => x.id < m.id))
      setApprovals([])
      setLive(null)
      setError(null)
      setDropped(false)
      setText(r.message.text)
      setFiles(r.message.attachments)
      onChanged()
      requestAnimationFrame(() => {
        const el = input.current
        if (!el) return
        el.focus()
        if (edit) el.setSelectionRange(el.value.length, el.value.length)
      })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const decide = (callId: string, allow: boolean, extra?: Parameters<typeof answerApproval>[3]) => {
    if (!thread) return
    setApprovals((a) => a.filter((x) => x.callId !== callId))
    answerApproval(thread.id, callId, allow, extra).catch((e: Error) => setError(e.message))
  }
  const respond = (callId: string, answers: Record<string, unknown> | null) => {
    if (!thread) return
    setApprovals((a) => a.filter((x) => x.callId !== callId))
    answerForm(thread.id, callId, answers).catch((e: Error) => setError(e.message))
  }

  const stop = () => {
    abort.current?.abort()
    if (thread) stopThread(thread.id).catch(() => {})
  }

  // The queue: messages written while it works, kept by the server and sent one by one after it.
  // Editing one takes it into the message box (files too) and holds the queue until it is saved or
  // put back, so it is never sent halfway through a change.
  const queue = thread?.queue ?? []
  const waiting = approvals.some((a) => a.kind !== 'client')
  const startEdit = async (q: QueuedMessage) => {
    if (!thread || editingQ) return
    try {
      const r = await editQueued(thread.id, q.id)
      setEditingQ({ id: q.id, stash: { text, files } })
      setText(r.item.text)
      setFiles(r.item.attachments)
      setThread(r.thread)
      setError(null)
      requestAnimationFrame(() => {
        const el = input.current
        el?.focus()
        el?.setSelectionRange(el.value.length, el.value.length)
      })
    } catch (e) {
      setError((e as Error).message)
    }
  }
  /** Back to what was in the box before the edit. */
  const endEdit = () => {
    if (!editingQ) return
    setText(editingQ.stash.text)
    setFiles(editingQ.stash.files)
    setEditingQ(null)
  }
  const cancelEdit = () => {
    if (editingQ && thread) releaseQueued(thread.id, editingQ.id).then((r) => setThread(r.thread), () => {})
    endEdit()
  }
  const saveEdit = async (message: string, attached: Attachment[]) => {
    if (!thread || !editingQ) return false
    queueing.current = true
    try {
      setThread((await saveQueued(thread.id, editingQ.id, { text: message, attachments: attached })).thread)
      endEdit()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      queueing.current = false
    }
  }
  const sendNow = async (q: QueuedMessage) => {
    if (!thread) return
    // The one being edited goes as it is in the box now.
    if (editingQ?.id === q.id && !(await saveEdit(text.trim(), files))) return
    sendQueuedNow(thread.id, q.id).then(
      (r) => (setThread(r.thread), onChanged()),
      (e: Error) => setError(e.message),
    )
  }
  const removeQueue = (q: QueuedMessage) => {
    if (!thread) return
    if (editingQ?.id === q.id) endEdit()
    removeQueued(thread.id, q.id).then((r) => setThread(r.thread), (e: Error) => setError(e.message))
  }
  // An editing window says it is still there, so the queue keeps waiting (the server lets it go on
  // two minutes after the last word); closing the window mid-edit lets it go on straight away.
  const editingNow = useRef<{ thread: string; id: string } | null>(null)
  editingNow.current = editingQ && thread ? { thread: thread.id, id: editingQ.id } : null
  useEffect(() => {
    if (!editingQ || !thread) return
    const t = setInterval(() => void editQueued(thread.id, editingQ.id).catch(() => {}), 60_000)
    return () => clearInterval(t)
  }, [editingQ?.id, thread?.id])
  useEffect(
    () => () => {
      const e = editingNow.current
      if (e) void releaseQueued(e.thread, e.id).catch(() => {})
    },
    [],
  )
  // Sent or removed from elsewhere while being edited: what was written stays in the box.
  useEffect(() => {
    if (editingQ && thread && !queue.some((q) => q.id === editingQ.id)) {
      setEditingQ(null)
      setError('That queued message was sent or removed meanwhile; what you wrote is still in the box')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, editingQ?.id])

  const regenerate = () => {
    if (!thread) return
    setThread({ ...thread, titling: true })
    regenerateTitle(thread.id).then(
      (r) => (setThread(r.thread), onChanged()),
      (e: Error) => (setThread((t) => (t ? { ...t, titling: false } : t)), setError(e.message)),
    )
  }
  const rename = (title: string) => {
    setRenaming(false)
    title = title.trim()
    if (thread && title.trim() && title.trim() !== thread.title) updateThread(thread.id, { title }).then((t) => (setThread(t), onChanged()), () => {})
  }

  // A thread can be shared once the agent has answered something in it (server/shares.ts).
  const hasAnswer = messages.some((m) => m.role === 'assistant' && m.content.trim())
  // A thread can be compacted once something was said in it.
  const hasConversation = messages.some((m) => m.role === 'user' || m.role === 'assistant')

  // Right-click menus in the conversation: what is under the pointer (a link, the selection, code,
  // a tool call, a message) first, then the thread's own items.
  const quote = (text: string) => {
    setText((t) => `${t ? `${t.trimEnd()}\n\n` : ''}${text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`)
    requestAnimationFrame(() => {
      const el = input.current
      el?.focus()
      el?.setSelectionRange(el.value.length, el.value.length)
    })
  }
  const threadItems = (): MenuItem[] =>
    thread
      ? [
          { label: 'Copy thread as Markdown', disabled: !messages.length, onSelect: () => copy(threadMarkdown(thread.title, messages)) },
          { label: 'Share thread…', disabled: !hasAnswer, onSelect: () => void openShareDialog(thread) },
          { label: thread.pinned ? 'Unpin' : 'Pin', onSelect: () => void updateThread(thread.id, { pinned: !thread.pinned }).then((t) => (setThread(t), onChanged()), () => {}) },
          ...(projects.length
            ? [
                {
                  label: 'Move to project',
                  submenu: tidyMenu([
                    ...projects.map((p) => ({ label: p.name, checked: thread.projectId === p.id, onSelect: () => void updateThread(thread.id, { projectId: p.id }).then((t) => (setThread(t), onChanged()), () => {}) })),
                    { separator: true },
                    { label: 'No project', checked: thread.projectId === null, onSelect: () => void updateThread(thread.id, { projectId: null }).then((t) => (setThread(t), onChanged()), () => {}) },
                  ]),
                },
              ]
            : []),
          { label: 'Rename…', onSelect: () => setRenaming(true) },
          { label: 'Regenerate title', hint: regenerateHint(thread), disabled: thread.titling, onSelect: regenerate },
          { label: 'Compact conversation…', hint: 'Summarise it so far, to free up the context window', disabled: !hasConversation, onSelect: () => void compactDialog() },
          thread.archived ? { label: 'Move back to threads', onSelect: () => onArchive(thread, false) } : { label: 'Archive', onSelect: () => onArchive(thread, true) },
          { label: 'Delete…', danger: true, onSelect: () => onDelete(thread) },
        ]
      : []
  const convMenu = (e: React.MouseEvent) => {
    if (e.shiftKey) return
    const el = e.target as Element
    const items: MenuItem[] = [...textItems(e.currentTarget, el, quote), { separator: true }]
    const code = el.closest('pre')
    if (code && !el.closest('[data-tool]')) items.push({ label: 'Copy code', onSelect: () => copy(code.textContent ?? '') }, { separator: true })
    const tool = el.closest<HTMLElement>('[data-tool]')?.dataset.tool?.split(':')
    const msg = messages.find((m) => m.id === Number(tool?.[0] ?? el.closest<HTMLElement>('[data-msg]')?.dataset.msg))
    if (tool && msg?.toolCalls) {
      const call = msg.toolCalls[Number(tool[1])]
      const result = messages.slice(messages.indexOf(msg) + 1).filter((m) => m.role === 'tool')[Number(tool[1])]
      items.push(
        { label: 'Copy what it was given', onSelect: () => copy(JSON.stringify(call.arguments, null, 2)) },
        { label: 'Copy the result', disabled: !result, onSelect: () => result && copy(result.content) },
        { separator: true },
      )
    } else if (msg?.role === 'compact') items.push({ label: 'Copy summary', onSelect: () => copy(msg.content) }, { separator: true })
    else if (msg?.role === 'user')
      items.push(
        { label: 'Copy message', onSelect: () => copy(msg.content) },
        { label: 'Use as a new message', disabled: answering, onSelect: () => (setText(msg.content), input.current?.focus()) },
        { label: 'Edit & resend…', onSelect: () => void rewindTo(msg, true) },
        { label: 'Rewind to here…', onSelect: () => void rewindTo(msg, false) },
        { separator: true },
      )
    else if (msg?.role === 'assistant')
      items.push(
        { label: 'Copy answer', onSelect: () => copy(msg.content) },
        ...(thread && msg.content.trim() ? [{ label: 'Share this answer…', onSelect: () => void openShareDialog(thread, msg) }] : []),
        { label: selectionIn(e.currentTarget) ? 'Quote the whole answer' : 'Quote in reply', onSelect: () => quote(msg.content) },
        ...(msg.thinking ? [{ label: 'Copy thoughts', onSelect: () => copy(msg.thinking!) }] : []),
        { separator: true },
      )
    if (msg) {
      const target = tool ? messages.slice(messages.indexOf(msg) + 1).filter((m) => m.role === 'tool')[Number(tool[1])] ?? msg : msg
      items.push(...messageActions(target), { separator: true })
    }
    items.push({
      label: 'Select all',
      shortcut: 'Ctrl A',
      onSelect: () => {
        const box = scroller.current
        if (!box) return
        const range = document.createRange()
        range.selectNodeContents(box)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
      },
    })
    items.push({ separator: true }, ...threadItems())
    openContextMenu(e, tidyMenu(items))
  }
  const composerMenu = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    if (e.shiftKey) return
    openContextMenu(
      e,
      tidyMenu([
        ...fieldMenu(e.currentTarget),
        { separator: true },
        ...(account.seafile ? [{ label: 'Attach from Files (Seafile)…', onSelect: () => void pickFiles({ title: 'Attach files' }).then((p) => void (p?.length && fromPaths(p))) }] : []),
        { label: 'Attach from Photos…', onSelect: () => setPhotoPicker(true) },
        { label: 'Attach from this computer…', onSelect: () => pcFiles.current?.click() },
        { separator: true },
        { label: 'Quick', checked: mode === 'quick', disabled: answering, onSelect: () => setMode('quick') },
        { label: 'Deep research', checked: mode === 'deep', disabled: answering, onSelect: () => setMode('deep') },
        { separator: true },
        ...(answering ? [{ label: 'Stop', onSelect: stop }] : []),
        { label: editingQ ? 'Save queued message' : waiting ? 'Send instead' : answering ? 'Queue' : 'Send', shortcut: 'Enter', disabled: (!text.trim() && !files.length) || reading > 0, onSelect: () => void send() },
      ]),
    )
  }

  // The message box grows with what is typed, up to its CSS max-height (four lines), and shrinks
  // again once sent.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const answering = busy || !!thread?.running
  // Messages left in the queue after a stop: another window (or the terminal) may send, edit or
  // drop them, and nothing streams while the thread is at rest, so look now and then.
  useEffect(() => {
    if (!thread || answering || !thread.queue.length) return
    const t = setInterval(() => void getThread(thread.id).then((r) => setThread((now) => (now?.id === r.thread.id ? r.thread : now)), () => {}), 4000)
    return () => clearInterval(t)
  }, [thread?.id, answering, thread?.queue.length])
  const projectName = projects.find((p) => p.id === (thread ? thread.projectId : draftProject))?.name ?? null
  const modelOptions = models.length ? models : model ? [{ name: model, thinking: false, vision: false, contextLength: null }] : []
  const tools = thread?.tools ?? draftTools
  const activeMention = mentionAt(text, caret)
  const slashAt = /^\/([\w.-]*)$/.exec(text.slice(0, caret))
  const completion = activeMention ?? (slashAt ? { start: 0, sigil: '/', query: slashAt[1].toLowerCase() } : null)
  useEffect(() => {
    if (activeMention?.sigil !== '#' || loras !== null || loraLoading || loraError) return
    setLoraLoading(true)
    getLoraDetails().then((result) => { setLoras(result.loras); setLoraManager(result.manager) }, () => setLoraError('Connect ComfyUI in Settings → Agents → Images.')).finally(() => setLoraLoading(false))
  }, [activeMention?.sigil, loras, loraLoading, loraError])
  useEffect(() => { setSuggestionIndex(0); setSuggestionsDismissed(false) }, [text, caret])
  const suggestions: { name: string; hint: string; lora?: LoraDetail }[] = !completion ? [] : (completion.sigil === '#'
    ? (loras ?? []).map((l) => ({ name: l.name, hint: l.title, lora: l }))
    : completion.sigil === '@'
      ? mentionTools.map((t) => ({ name: t.name, hint: `${TOOL_GROUPS.find((g) => g.id === t.group)?.name ?? 'Always available'} · ${!t.group || tools.includes(t.group) ? 'on' : 'off'}` }))
      : [...(completion.sigil === '/' && hasConversation ? [{ name: 'compact', hint: 'Summarise the conversation to free context' }] : []), ...skills.filter((sk) => sk.enabled).map((sk) => ({ name: sk.name, hint: sk.description }))])
    .filter((s: { name: string; hint: string; lora?: LoraDetail }) => (s.lora ? `${s.name} ${s.lora.title}` : s.name).toLowerCase().includes(completion!.query)).slice(0, 50)
  const showSuggestions = !!completion && !suggestionsDismissed
  const acceptSuggestion = (name: string) => {
    if (!completion) return
    const inserted = `${mentionText(completion.sigil, name)} `
    const end = caret + (text.slice(caret).match(/^[^\s]*/)?.[0].length ?? 0)
    const nextCaret = completion.start + inserted.length
    setText(text.slice(0, completion.start) + inserted + text.slice(end)); setCaret(nextCaret)
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(nextCaret, nextCaret) })
  }
  useEffect(() => { composerBox.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [suggestionIndex])
  const visionless = files.some((f) => f.kind === 'image') && !models.find((m) => m.name === model)?.vision

  // Tools: one group at a time, for this thread (and new threads start with the last choice).
  const toggleTool = (g: ToolGroup) => {
    const next = tools.includes(g) ? tools.filter((t) => t !== g) : ALL_TOOLS.filter((t) => t === g || tools.includes(t))
    setAgentSettings({ tools: next })
    if (thread) updateThread(thread.id, { tools: next }).then((t) => setThread(t), (e: Error) => setError(e.message))
    else setDraftTools(next)
  }
  const toolMenu = (e: React.MouseEvent) =>
    openMenuAt(e.currentTarget, [
      ...TOOL_GROUPS.map((g) => {
        const on = tools.includes(g.id)
        const blocked = (g.seafile && !account.seafile) || (g.calendar && !hasCalendar(account)) || (g.mail && !mailAccounts?.length) || (g.id === 'files' && !workdir) || g.id === 'terminal'
        const { hint, muted } = toolState(g, on, !!blocked)
        // Greyed but clickable while it is on, so it can be switched off; off and blocked it cannot be switched on.
        return { label: g.name, checked: on, muted: muted && on, disabled: muted && !on, hint, onSelect: () => toggleTool(g.id) }
      }),
      { separator: true },
      { label: tools.length === ALL_TOOLS.length ? 'Turn all off (just the model)' : 'Turn all on', onSelect: () => (tools.length === ALL_TOOLS.length ? setTools([]) : setTools(ALL_TOOLS)) },
    ], 'above')
  const setTools = (next: ToolGroup[]) => {
    setAgentSettings({ tools: next })
    if (thread) updateThread(thread.id, { tools: next }).then((t) => setThread(t), () => {})
    else setDraftTools(next)
  }
  const modeMenu = (e: React.MouseEvent) =>
    openMenuAt(
      e.currentTarget,
      (['quick', 'deep'] as Mode[]).map((m) => ({ label: m === 'quick' ? 'Quick' : 'Deep research', hint: MODE_HELP[m], checked: mode === m, onSelect: () => setMode(m) })),
      'above',
    )
  const modelMenu = (e: React.MouseEvent) =>
    openMenuAt(
      e.currentTarget,
      [
        ...(thread ? [] : [{ label: 'The usual one', hint: usualModel ? `${usualModel}, as set in Settings` : 'Picked for the mode (Settings can choose)', checked: !model, onSelect: () => setDraftModel(null) }]),
        ...modelOptions.map((m) => ({
          label: m.name,
          checked: m.name === model,
          shortcut: [m.vision ? 'sees' : '', m.contextLength ? tokenCount(m.contextLength) : ''].filter(Boolean).join(' · '),
          onSelect: () => setModel(m.name),
        })),
      ],
      'above',
    )

  // Attachments: from Seafile (the desktop's own picker, or dragged from Files) or this computer.
  const addFiles = async (load: () => Promise<Attachment>[]) => {
    const jobs = load()
    setReading((n) => n + jobs.length)
    const done = await Promise.allSettled(jobs)
    setReading((n) => n - jobs.length)
    const ok = done.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const failed = done.flatMap((r) => (r.status === 'rejected' ? [(r.reason as Error).message] : []))
    setFiles((f) => [...f, ...ok].slice(0, 10))
    setError(failed.length ? failed.join(' · ') : null)
    input.current?.focus()
  }
  // Files from Seafile or this browser (the picker, or dragged from Files and the desktop).
  const fromPaths = (paths: string[]) =>
    addFiles(() =>
      paths.map(async (p) => {
        const at = parseSf(p)
        const name = (at ? at.p : p).split('/').pop() || 'file'
        return toAttachment(await readBytes(p), name, at ? `Seafile: ${libraryName(at.repo)} ${at.p}` : `Files: ${p}`)
      }),
    )
  // A drop on the composer: files attach like the button and paste do, a launcher is typed in as
  // its address, and a folder is said no to, since it has nothing to read.
  const composerBox = useRef<HTMLFormElement>(null)
  useDropTarget(composerBox, {
    accept: (d) => (d.os || d.items.some((i) => i.kind === 'file' || i.kind === 'launcher') ? 'copy' : null),
    drop: (d) => void dropOnComposer(d),
  })
  const dropOnComposer = async (d: DropDrag) => {
    const paths: string[] = []
    const urls: string[] = []
    let folders = 0
    for (const i of d.items) {
      const l = i.kind === 'launcher' ? i : i.kind === 'file' ? i.launcher : undefined
      if (l?.url) urls.push(l.url)
      else if (i.kind === 'file') i.dir ? folders++ : paths.push(i.path)
    }
    const fromPc = d.os ? await d.files() : []
    folders += new Set(fromPc.filter((p) => p.rel).map((p) => p.rel.split('/')[0])).size
    if (urls.length) setText((t) => `${t}${t && !t.endsWith('\n') ? '\n' : ''}${urls.join('\n')}`)
    if (paths.length) void fromPaths(paths)
    if (fromPc.some((p) => !p.rel)) void fromComputer(fromPc.filter((p) => !p.rel).map((p) => p.file))
    if (folders) notify({ title: folders > 1 ? 'Folders cannot be attached' : 'A folder cannot be attached', body: 'Attach the files inside it, or zip the folder first.', transient: true })
    input.current?.focus()
  }
  const fromComputer = (list: FileList | File[]) => addFiles(() => [...list].map((f) => toAttachment(f, f.name, 'This computer')))
  const attachMenu = (e: React.MouseEvent) =>
    openMenuAt(e.currentTarget, [
      ...(account.seafile ? [{ label: 'From Files (Seafile)…', onSelect: () => void pickFiles({ title: 'Attach files' }).then((p) => void (p?.length && fromPaths(p))) }] : []),
      { label: 'From Photos…', onSelect: () => setPhotoPicker(true) },
      { label: 'From this computer…', onSelect: () => pcFiles.current?.click() },
    ], 'above')

  const sessionImages = async () => {
    setOpeningImages(true)
    try {
      let target = thread
      if (!target) {
        target = await createThread({ mode: draftMode, tools: draftTools, projectId: draftProject, workdir: draftWorkdir, permission: draftPermission, skillsOff: draftSkillsOff, ...(draftModel ? { model: draftModel } : {}) })
        streamed.current = target.id
        setThread(target)
        onCreated(target)
      }
      await openSessionImages(target.id)
    } catch (e) { setError((e as Error).message) } finally { setOpeningImages(false) }
  }

  return (
    <>
      {photoPicker && <PhotoPicker limit={Math.max(0, 10 - files.length)} onClose={() => setPhotoPicker(false)} onAttach={(added) => {
        const combined = [...latestFiles.current, ...added]
        checkPhotoAttachmentBudget(combined)
        latestFiles.current = combined
        setFiles(combined)
        setError(null)
      }} />}
      <div className="agt-bar">
      <div className="nb-toolbar agt-toolbar" onContextMenu={(e) => thread && !e.shiftKey && !isField(e.target as Element) && openContextMenu(e, tidyMenu(threadItems()))}>
        <button className="btn btn-small agt-back" onClick={onBack} aria-label="Back to threads">
          ‹
        </button>
        {projectName && <span className="agt-crumb" title={`In the project ${projectName}`}>{projectName}</span>}
        {thread && renaming ? (
          <RenameBox thread={thread} onSave={rename} onCancel={() => setRenaming(false)} />
        ) : (
          <button className="agt-title" onDoubleClick={() => thread && setRenaming(true)} title={thread ? [alsoKnownAs(thread), 'Double-click to rename'].filter(Boolean).join('\n') : undefined}>
            {thread ? <Scramble text={thread.title} pending={titlePending(thread) || (busy && thread.title === NEW_TITLE)} /> : 'New thread'}
          </button>
        )}
        <span className="nb-spacer" />
        <div className="agt-bar-chips">
        {(account.seafile || workdir) && (
          <button className={`agt-chip ${workdir ? 'is-on' : ''}`} onClick={folderMenu} disabled={answering} title={workdir ? `Work folder: ${workdir.label}` : 'Give it a folder to work in'}>
            <Icon name="folder" size={13} /> <span className="agt-chip-label">{workdir ? workdir.label : 'No folder'}</span>
          </button>
        )}
        <button type="button" className="agt-chip" disabled={answering || openingImages} onClick={() => void sessionImages()} title="Image models and generation defaults for this session">Images</button>
        {thread && <MailReadsChip thread={thread} onChange={setThread} onError={setError} />}
        <button className={`agt-chip is-${permission}`} onClick={permissionMenu} title={PERMISSION_HELP[permission]}>
          {PERMISSION_LABEL[permission]}
        </button>
        </div>
        {thread && <ContextMeter thread={thread} models={models} open={ctxOpen} panelId={ctxId} onToggle={() => setCtxOpen((o) => !o)} />}
        {thread && (
          <button
            className="agt-icon agt-more"
            aria-label="More"
            onClick={(e) =>
              openContextMenu(e, [
                { label: 'Rename…', onSelect: () => setRenaming(true) },
                { label: 'Regenerate title', hint: regenerateHint(thread), disabled: thread.titling || !messages.length, onSelect: regenerate },
                { label: 'Share thread…', disabled: !hasAnswer, onSelect: () => void openShareDialog(thread) },
                { label: 'Compact conversation…', hint: 'Summarise it so far, to free up the context window', disabled: !hasConversation, onSelect: () => void compactDialog() },
                thread.archived ? { label: 'Move back to threads', onSelect: () => onArchive(thread, false) } : { label: 'Archive', onSelect: () => onArchive(thread, true) },
                { separator: true },
                { label: 'Delete…', danger: true, onSelect: () => onDelete(thread) },
              ])
            }
          >
            <Icon name="more" />
          </button>
        )}
      </div>
      </div>

      {thread && ctxOpen && <ContextPanel panelId={ctxId} id={thread.id} version={messages.length} onClose={() => setCtxOpen(false)} onCompact={hasConversation ? () => void compactDialog() : undefined} />}

      <div
        className="agt-scroll selectable"
        ref={scroller}
        onContextMenu={convMenu}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          setScrolledUp(!pinned.current)
        }}
      >
        {!messages.length && !live && (
          <div className="agt-empty">
            <p className="agt-empty-title">{mode === 'deep' ? 'What should it research?' : 'What do you want to know?'}</p>
            <p className="muted">{MODE_HELP[mode]}</p>
            <p className="muted agt-empty-tools">Tools on: {tools.length ? TOOL_GROUPS.filter((g) => tools.includes(g.id)).map((g) => g.name).join(', ') : 'none, just the model'}.</p>
          </div>
        )}
        <MoneyThread currencies={threadCurrencies}>
          <Messages mailAlways={!!thread?.mailReadsAlways} threadId={thread?.id ?? null} messages={messages} answering={answering} approvals={approvals} onDecide={decide} onAnswer={respond} onRewind={(m, edit) => void rewindTo(m, edit)} onShare={(m) => thread && void openShareDialog(thread, m)} retry={retryAt !== null && !answering && !reconnecting && !dropped && !thread?.interrupted ? { at: retryAt, onRetry: () => void retry() } : undefined} actions={messageActions} onInpaint={(input) => void again(input.source_image_id, input)} onRefine={(input) => void again(input.source_image_id, input)} onUpscale={(input) => void again(input.source_image_id, input)} onAgain={(imageId) => void again(imageId)} imagesOn={tools.includes('images')} onEditPicture={tools.includes('gpt_images') ? (name, ref) => void editPicture(name, ref) : undefined} onEditImage={(name, sourceId) => {
            if (files.filter((f) => f.source !== 'Image-to-image source').length >= 10) { setError('Remove an attachment before selecting an image source (10 attachments maximum).'); return }
            const reference = `The user selected “${name}” as the source for an image-to-image edit. source_image_id: ${sourceId}. Use this exact owned reference with generate_image, not a URL or a new text-to-image recreation. Apply only the change requested in the user's message; this is a whole-image edit, not masked inpainting.`
            setFiles((current) => [...current.filter((f) => f.source !== 'Image-to-image source'), { name: `${name} (image source)`, source: 'Image-to-image source', kind: 'text', mime: 'text/plain', size: reference.length, text: reference }])
            setText((t) => t.startsWith('Edit this image: ') ? t : `Edit this image: ${t}`)
            input.current?.focus()
          }} onMaskSaved={(saved) => {
            // The hand-off back: the saved mask rides along with the next message, which the user sends when ready.
            if (files.filter((f) => f.source !== 'Edited mask').length >= 10) { setError('Remove an attachment before handing back the mask (10 attachments maximum).'); return }
            const what = saved.from.target ? ` for “${saved.from.target}”` : ''
            const reference = `The user edited the mask${what} in the mask editor and saved it. mask_id: ${saved.mask_id}, source_image_id: ${saved.source_image_id}${saved.coverage !== undefined ? `, coverage ${Math.round(saved.coverage * 1000) / 10}%` : ''}. Continue the requested edit with this exact mask_id and source_image_id (generate_image operation remove, or inpaint for a replacement). Do not make a new mask.`
            setFiles((current) => [...current.filter((f) => f.source !== 'Edited mask'), { name: 'Edited mask', source: 'Edited mask', kind: 'text', mime: 'text/plain', size: reference.length, text: reference }])
            setText((t) => t.trim() ? t : 'Continue with my edited mask.')
            input.current?.focus()
          }} />
        </MoneyThread>
        {reconnecting ? (
          <p className="agt-wait muted">Reconnecting… the connection dropped, or the server is restarting for an update.</p>
        ) : compacting ? (
          <p className="agt-wait muted agt-compacting">{compacting.auto ? 'The context is nearly full: compacting the conversation…' : 'Compacting the conversation…'}</p>
        ) : live ? (
          <MoneyThread currencies={threadCurrencies}>
            <LiveReply live={live} />
          </MoneyThread>
        ) : (
          answering && <p className="agt-wait muted">Working…</p>
        )}
        {/* Not under a compaction that went well: Retry would answer the message before it again. A
            turn that ended well has Retry in its last answer's (or image's) row; this line is for
            a dropped or interrupted turn, or one that left nothing to put it under. */}
        {!answering && !reconnecting && thread && messages.some((m) => m.role === 'user') && (dropped || !!thread.interrupted || (messages.at(-1)?.role !== 'compact' && retryAt === null)) && (
          <div className={`agt-cut ${dropped || thread.interrupted ? 'is-error' : ''}`}>
            {dropped ? <span>The connection dropped</span> : thread.interrupted && <span>{interruptionText(thread.interrupted)}</span>}
            <button type="button" className={dropped || thread.interrupted ? 'btn btn-small' : 'agt-retry'} onClick={() => void retry()} title="Run your last message again; what the agent wrote for it goes">
              ↻ Retry
            </button>
            {dropped && (
              <button type="button" className="btn btn-small" onClick={() => (lose(), setRejoin((n) => n + 1))} title="Look for the turn again">
                Look again
              </button>
            )}
          </div>
        )}
        {error && <p className="agt-error t-red copyable">{error}</p>}
        {scrolledUp && (
          <button type="button" className="btn btn-small agt-jump-latest" onClick={() => { const el = scroller.current; if (el) { pinned.current = true; setScrolledUp(false); el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }) } }}>
            ↓ Jump to latest
          </button>
        )}
      </div>

      {!!thread?.todos.length && (
        <TodoChip
          todos={thread.todos}
          running={answering}
          onDismiss={() => void updateThread(thread.id, { todos: null }).then((t) => (setThread(t), onChanged()), (e: Error) => setError(e.message))}
        />
      )}
      <AlwaysChips thread={thread} draft={{ projectId: draftProject, mode: draftMode, permission: draftPermission, off: draftSkillsOff, setOff: setDraftSkillsOff }} onThread={(t) => (setThread(t), onChanged())} onError={setError} />
      {thread && queue.length > 0 && <QueueList queue={queue} answering={answering} editing={editingQ?.id ?? null} onEdit={(q) => void startEdit(q)} onSend={(q) => void sendNow(q)} onRemove={removeQueue} />}
      <form
        ref={composerBox}
        className="agt-composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <div className="agt-box" onClick={(e) => e.target === e.currentTarget && input.current?.focus()}>
          {(files.length > 0 || reading > 0) && (
            <AttachedFiles files={files} pictureOf={(f) => memoryPicture(f as Attachment)} onRemove={(i) => setFiles((list) => list.filter((_, j) => j !== i))} more={reading > 0 && <li className="muted">Reading {reading}…</li>} />
          )}
          {emoji.popup}
          {showSuggestions && (() => {
            // LoRAs get a detail pane for the highlighted one: beside the list, or on a phone under its row
            // (a first tap there shows it, a second inserts it, or Use in the detail).
            const highlighted = suggestions[Math.min(suggestionIndex, suggestions.length - 1)]?.lora
            const list = <ul className="agt-slash" role="listbox" aria-label="Commands and mentions">
              {suggestions.map((s, i) => <li key={s.name} role="option" aria-selected={i === suggestionIndex} onMouseEnter={s.lora && !phone ? () => setSuggestionIndex(i) : undefined}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => (s.lora && phone && i !== suggestionIndex ? setSuggestionIndex(i) : acceptSuggestion(s.name))}>{s.lora ? <LoraRow lora={s.lora} /> : <><b>{completion.sigil}{s.name}</b> <span className="muted">{s.hint}</span></>}</button>
                {s.lora && phone && i === suggestionIndex && <LoraDetailPane lora={s.lora} manager={loraManager} onUse={() => acceptSuggestion(s.name)} />}
              </li>)}
              {!suggestions.length && <li className="muted">{completion.sigil === '#' ? loraLoading ? 'Loading LoRAs…' : loraError || 'No installed LoRAs match.' : 'No matches.'}{loraError && completion.sigil === '#' && <button type="button" onClick={() => setLoraError('')}>Retry</button>}</li>}
            </ul>
            return highlighted && !phone ? <div className="agt-slash-split">{list}<LoraDetailPane lora={highlighted} manager={loraManager} /></div> : list
          })()}
          {editingQ && (
            <div className="agt-editing">
              <span>
                Editing queued message {queue.findIndex((q) => q.id === editingQ.id) + 1} <span className="muted">· Enter saves · Esc puts it back as it was</span>
              </span>
              <button type="button" className="btn btn-small" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          )}
          <textarea
            ref={input}
            value={text}
            onChange={(e) => emoji.change(e, (v, c) => { setText(v); setCaret(c) })}
            onSelect={(e) => { setCaret(e.currentTarget.selectionStart); emoji.select(e.currentTarget) }}
            onKeyDown={(e) => {
              if (emoji.keyDown(e)) return
              if (showSuggestions && !e.nativeEvent.isComposing) {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSuggestionsDismissed(true); return }
                if (suggestions.length && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); setSuggestionIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return }
                // Right accepts too, like Tab and Enter: only with a list open (this branch), no modifier, and the
                // caret at the end of the word, so moving through a word already written still moves the caret.
                if (suggestions.length && (e.key === 'Tab' || e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey || e.key === 'ArrowRight' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !/^\S/.test(text.slice(caret)))) { e.preventDefault(); acceptSuggestion(suggestions[Math.min(suggestionIndex, suggestions.length - 1)].name); return }
              }
              // Up in an empty box edits the last queued message, Esc puts an edit back.
              if (e.key === 'ArrowUp' && !text && !files.length && !editingQ && queue.length && !e.shiftKey) {
                e.preventDefault()
                void startEdit(queue[queue.length - 1])
                return
              }
              if (e.key === 'Escape' && editingQ) {
                e.preventDefault()
                e.stopPropagation()
                cancelEdit()
                return
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                // Ctrl+Enter always sends, also from inside a code block.
                if (e.ctrlKey || e.metaKey || !codeBlockEnter(e.currentTarget)) void send()
              }
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault()
                void fromComputer(e.clipboardData.files)
                return
              }
              // A long paste (logs, raw data) goes along as a file, so the message box stays readable.
              const pasted = e.clipboardData.getData('text/plain')
              if (pasted.length >= PASTE_AS_FILE) {
                e.preventDefault()
                const n = files.filter((f) => f.source === 'Pasted').length
                void addFiles(() => [Promise.resolve().then(() => textAttachment(pasted, n ? `Pasted text ${n + 1}.txt` : 'Pasted text.txt'))])
              }
            }}
            onContextMenu={composerMenu}
            placeholder={editingQ ? 'The queued message' : waiting ? 'Tell it what to do instead…' : answering ? 'Queue a message for when it is done…' : mode === 'deep' ? 'What should it research?' : 'Ask anything'}
            rows={1}
            aria-label="Message"
          />
          <div className="agt-box-bar">
            <button type="button" className="agt-icon" onClick={attachMenu} disabled={answering} aria-label="Attach files" title="Attach files">
              <Icon name="clip" />
            </button>
            <button type="button" className="agt-pill" onClick={modeMenu} disabled={answering} title={MODE_HELP[mode]}>
              <Icon name={mode === 'deep' ? 'deep' : 'bolt'} size={13} />
              <span className="agt-pill-label">{mode === 'deep' ? 'Deep' : 'Quick'}</span>
              <Icon name="chevron" size={12} />
            </button>
            <button type="button" className={`agt-pill ${tools.length < ALL_TOOLS.length ? 'is-limited' : ''}`} onClick={toolMenu} disabled={answering} title={`Tools it may use: ${tools.length} of ${ALL_TOOLS.length}`}>
              <Icon name="tools" size={13} />
              <span className="agt-pill-label">Tools</span>
              <span className="agt-count">{tools.length}</span>
            </button>
            <span className="agt-grow" />
            <button type="button" className="agt-pill agt-model-pill" onClick={modelMenu} disabled={answering} title="Model">
              <span className="agt-model-name">{model || usualModel || 'Automatic'}</span>
              <Icon name="chevron" size={12} />
            </button>
            {answering && (
              <button type="button" className="agt-send is-stop" onClick={stop} aria-label="Stop" title="Stop (the queue waits)">
                <Icon name="stop" size={14} />
              </button>
            )}
            {editingQ ? (
              <button className="agt-send has-label" disabled={(!text.trim() && !files.length) || reading > 0} title="Save the queued message (Enter)">
                Save
              </button>
            ) : !answering ? (
              <button className="agt-send" disabled={(!text.trim() && !files.length) || reading > 0} aria-label="Send" title="Send (Enter; Shift+Enter for a new line)">
                <Icon name="send" size={16} />
              </button>
            ) : waiting ? (
              <button className="agt-send has-label" disabled={(!text.trim() && !files.length) || reading > 0} title="Send instead (Enter): declines the changes it asks for, or answers its question, with this message">
                <Icon name="send" size={14} /> Send instead
              </button>
            ) : (
              (text.trim() || files.length > 0) && (
                <button className="agt-send has-label" disabled={reading > 0} title="Queue (Enter): sent when it is done">
                  <Icon name="send" size={14} /> Queue
                </button>
              )
            )}
          </div>
        </div>
        {visionless && <p className="agt-warn">{model} can't see pictures: pick a model that sees, or the pictures go as names only.</p>}
        <input
          ref={pcFiles}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void fromComputer(e.target.files)
            e.target.value = ''
          }}
        />
      </form>
    </>
  )
}

/** The conversation, with each assistant step's tool calls shown as cards beside their results. */
function Messages({ threadId, messages, answering, approvals, onDecide, onAnswer, onRewind, onShare, mailAlways, actions, onAgain, onUpscale, onRefine, onInpaint, imagesOn, retry, onEditImage, onEditPicture, onMaskSaved }: { onEditImage: (name: string, sourceId: string) => void; /** Edit on a gpt_image picture (its name and id), when GPT images is on in this thread */ onEditPicture?: (name: string, ref: string) => void; /** A mask fixed by hand in the editor, handed back to the agent through the message box */ onMaskSaved: (saved: SavedMask) => void; /** Retry the last turn, offered in the row of message `at` (its last answer or image) */ retry?: { at: number; onRetry: () => void }; actions: (m: AgentMessage, inRow?: boolean) => MenuItem[]; onAgain: (imageId: string) => void; onUpscale: (input: UpscaleImageInput) => void; onInpaint: (input: MaskedEditInput) => void; onRefine: (input: RefineImageInput) => void; imagesOn: boolean; /** Mail reads are always allowed already: their cards don't offer it again */ mailAlways?: boolean; /** For the pictures you sent, which load from the thread */ threadId: string | null; messages: AgentMessage[]; answering: boolean; approvals: PendingApproval[]; onDecide: (callId: string, allow: boolean, extra?: Parameters<typeof answerApproval>[3]) => void; onAnswer: (callId: string, answers: Record<string, unknown> | null) => void; /** Rewind to one of your messages; `edit`: then edit it (the box takes focus) */ onRewind: (m: AgentMessage, edit: boolean) => void; /** Share one answer (the dialog) */ onShare: (m: AgentMessage) => void }) {
  const [maskSource, setMaskSource] = useState<InpaintSource | null>(null)
  // Every message and card ends in the same action row (AgentsActions.tsx): its own buttons, then More.
  const row = (m: AgentMessage, label: string, own: MenuItem[] = [], buttons: ReactNode[] = []) => (
    <ActionRow label={`${label} actions`}>{[...buttons, <MoreButton key="more" label={label} items={tidy([...own, { separator: true }, ...actions(m, true)])} />]}</ActionRow>
  )
  const retryButton = (id: number) => retry?.at === id ? <button key="retry" type="button" className={ACTION} onClick={retry.onRetry} title="Run your last message again; what the agent wrote for it goes">Retry</button> : null
  const out: ReactNode[] = []
  // A turn's answer is its last message with text: Share sits under it, once the turn is done.
  const answers = new Set<number>()
  let last: number | null = null
  for (const m of messages) {
    if (m.role === 'user') {
      if (last !== null) answers.add(last)
      last = null
    } else if (m.role === 'assistant' && m.content.trim()) last = m.id
  }
  if (last !== null && !answering) answers.add(last)
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user') {
      out.push(
        <div key={m.id} className="agt-user-wrap agt-act-host" data-msg={m.id}>
          <div className="agt-user">
            {m.content && (
              <div className="zed-preview agt-user-text">
                <MarkdownPreview text={m.content} breaks />
              </div>
            )}
            {!!m.attachments?.length && <AttachedFiles files={m.attachments} pictureOf={threadId ? sentPicture(threadId, m) : () => null} sent />}
          </div>
          {row(m, 'Your message', [
            ...(imagesOn && threadId ? (m.attachments ?? []).flatMap((f, i) => f.kind === 'image' ? [{ label: `Edit image: ${f.name}`, disabled: answering, onSelect: () => onEditImage(f.name, `attachment:${m.id}:${i}`) },
              { label: `Edit selected area: ${f.name}`, disabled: answering, onSelect: () => setMaskSource({ id: `attachment:${m.id}:${i}`, name: f.name, url: `/api/agents/threads/${threadId}/messages/${m.id}/attachments/${i}` }) }] : []) : []),
            ...(m.content ? [{ label: 'Copy', hint: 'Copy the message', onSelect: () => copy(m.content) }] : []),
            { label: 'Edit & resend…', hint: 'Take the thread back to this message and edit it to send again', onSelect: () => onRewind(m, true) },
            { label: 'Rewind to here…', hint: 'Remove this message and everything after it; it goes back into the message box', onSelect: () => onRewind(m, false) },
          ])}
        </div>,
      )
      continue
    }
    if (m.role === 'tool') continue // drawn with the call that asked for it
    if (m.role === 'compact') {
      out.push(<div key={m.id} className="agt-act-host" data-msg={m.id}><CompactDivider m={m} />{row(m, 'Summary', [{ label: 'Copy summary', onSelect: () => copy(m.content) }])}</div>)
      continue
    }
    const calls = m.toolCalls ?? []
    const results = messages.slice(i + 1, i + 1 + calls.length).filter((r) => r.role === 'tool')
    out.push(
      <Fragment key={m.id}>
        {m.thinking && (
          <div data-msg={m.id}>
            <Thinking text={m.thinking} />
          </div>
        )}
        {m.content.trim() && (
          <div className="agt-answer-wrap agt-act-host" data-msg={m.id}>
            <article className="zed-preview agt-answer">
              <MarkdownPreview text={m.content} money />
            </article>
            {row(m, 'Answer', [{ label: 'Copy answer', onSelect: () => copy(m.content) }], [...(answers.has(m.id) ? [<button key="share" type="button" className={ACTION} onClick={() => onShare(m)} title="Share this answer and the message it answers as a link">Share</button>] : []), retryButton(m.id)])}
          </div>
        )}
        {!m.content.trim() && !calls.length && <div className="agt-act-host" data-msg={m.id}>{row(m, 'Message')}</div>}
        {calls.map((c, j) => {
          const wait = approvals.find((a) => a.messageId === m.id && a.index === j)
          if (wait?.kind === 'question' && wait.form) return <QuestionForm key={wait.callId} form={wait.form} onAnswer={(answers) => onAnswer(wait.callId, answers)} />
          if (c.name === 'ask_user' && results[j]) return <div key={j} className="agt-act-host" data-tool={`${m.id}:${j}`}><AnsweredForm tag={`${m.id}:${j}`} call={c} result={results[j].content} />{row(results[j], 'Answered question')}</div>
          const image = c.name === 'generate_image' ? generatedImage(results[j]?.content) : null
          if (image || c.name !== 'gpt_image' && wait?.kind === 'image' && wait.width && wait.height) return (
            <div key={j} className="agt-act-host" data-tool={`${m.id}:${j}`}>
              <ImageCard inpaint={image && imagesOn && threadId ? { threadId, disabled: answering, onSubmit: onInpaint } : undefined} refine={image && imagesOn && threadId ? { threadId, disabled: answering, onSubmit: onRefine } : undefined} operation={c.arguments?.operation === 'remove' ? 'remove' : c.arguments?.operation === 'inpaint' ? 'inpaint' : c.arguments?.operation === 'upscale' ? 'upscale' : c.arguments?.operation === 'refine' ? 'refine' : 'generate'} upscale={image && imagesOn ? { disabled: answering, onSubmit: onUpscale } : undefined} retry={results[j] ? retryButton(results[j].id) : null} image={image ?? undefined} width={image?.width ?? wait!.width!} height={image?.height ?? wait!.height!} pending={!image} progress={wait?.progress} edit={image && imagesOn ? { disabled: answering, onClick: () => onEditImage(image.name, image.id) } : undefined} more={actions(results[j] ?? m, true)}
                again={image ? { disabled: answering || !imagesOn || !image.settings, hint: !image.settings ? 'This image has no recorded generation settings' : !imagesOn ? 'Turn on Images in Tools first' : answering ? 'Wait for this thread to finish' : image.settings?.operation === 'upscale' ? 'Repeat the upscale from its original source and recorded settings' : image.settings?.operation === 'refine' ? 'Refine the original source again with a fresh seed' : 'Draw this image again with the same prompt and settings', onClick: () => onAgain(image.id) } : undefined} />
            </div>
          )
          // Masks the agent made or listed show as tinted pictures, each with Edit mask.
          const masks = (c.name === 'make_image_mask' || c.name === 'list_image_masks') && results[j] ? agentMasks(results[j].content) : []
          return <div key={j} className="agt-act-host" data-tool={`${m.id}:${j}`}><ToolCard tag={`${m.id}:${j}`} call={c} result={results[j]?.content} checked={results[j]?.checked} pending={!results[j] && answering} inTerminal={wait?.kind === 'client'} summary={wait?.summary} check={wait?.check} mailAlways={mailAlways} approval={wait?.kind === 'approval' ? (allow, extra) => onDecide(wait.callId, allow, extra) : undefined} />{masks.length > 0 && <MaskCards masks={masks} threadId={imagesOn ? threadId : null} disabled={answering} onSaved={onMaskSaved} />}{c.name === 'gpt_image' && !results[j] && wait?.gpt && threadId && wait.width && wait.height && <GptImageDrawing threadId={threadId} callId={wait.callId} width={wait.width} height={wait.height} drawing={wait.gpt} infographic={c.arguments?.mode === 'infographic'} />}{c.name === 'gpt_image' && results[j] && <GptImageResult threadId={threadId} result={results[j]} onEdit={onEditPicture && !answering ? onEditPicture : undefined} />}{results[j] && row(results[j], 'Tool', [{ label: 'Copy the result', onSelect: () => copy(results[j].content) }])}</div>
        })}
      </Fragment>,
    )
  }
  return <>{out}{maskSource && threadId && <InpaintDialog image={maskSource} threadId={threadId} disabled={answering} onClose={() => setMaskSource(null)} onInpaint={input => { setMaskSource(null); onInpaint(input) }} />}</>
}

/**
 * Where the thread was compacted: a divider across the conversation saying how, which opens to the
 * summary the agent works from since. The messages above it stay as they were.
 */
function CompactDivider({ m }: { m: AgentMessage }) {
  const c = m.compact
  return (
    <details className="agt-compact" data-msg={m.id}>
      <summary>
        <span className="agt-compact-label">
          {compactionText(c)}
          {c?.instructions && <span className="muted"> · {c.instructions}</span>}
        </span>
        <span className="agt-compact-more muted">Summary</span>
      </summary>
      <div className="agt-compact-body">
        <p className="muted">
          From here on the agent works from this summary instead of the {c ? `${c.messages} ${c.messages === 1 ? 'message' : 'messages'}` : 'messages'} above it
          {c ? ` (about ${tokenCount(c.before)} tokens down to ${tokenCount(c.after)})` : ''}. They stay here for you to read.
        </p>
        <article className="zed-preview agt-answer">
          <MarkdownPreview text={m.content} money />
        </article>
      </div>
    </details>
  )
}

/** The model's thoughts: one small grey line to tap, showing the latest thought while it thinks. */
function Thinking({ text, live = false }: { text: string; live?: boolean }) {
  const words = text.trim().split(/\s+/).length
  const latest = live ? text.trim().split('\n').filter(Boolean).pop()?.slice(-140) : null
  return (
    <details className={`agt-think ${live ? 'is-live' : ''}`}>
      <summary>
        <span className="agt-think-chevron" aria-hidden>
          ›
        </span>
        {live ? 'Thinking…' : `Thoughts · ${words} ${words === 1 ? 'word' : 'words'}`}
        {latest && <span className="agt-think-latest"> {latest}</span>}
      </summary>
      <p>{text.trim()}</p>
    </details>
  )
}

function LiveReply({ live }: { live: Live }) {
  if (!live.content && !live.thinking) return <p className="agt-wait muted">Working…</p>
  return (
    <>
      {live.thinking && <Thinking text={live.thinking} live={!live.content} />}
      {live.content && (
        <article className="zed-preview agt-answer">
          <MarkdownPreview text={live.content} money />
        </article>
      )}
    </>
  )
}

/**
 * Enter in the message box while writing a code block: on a line that opens one (``` or ```lang)
 * it adds the closing ``` and puts the cursor between the two; inside a block it is a new line.
 * Answers false when Enter should send. Typed with insertText, so Ctrl+Z takes it back.
 */
function codeBlockEnter(el: HTMLTextAreaElement): boolean {
  const FENCE = /^\s*```/
  const pos = el.selectionStart
  const before = el.value.slice(0, pos).split('\n')
  const line = before.pop() ?? ''
  const open = before.filter((l) => FENCE.test(l)).length % 2 === 1
  const insert = (text: string, cursorBack = 0) => {
    if (!document.execCommand('insertText', false, text)) el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end')
    if (cursorBack) el.setSelectionRange(el.selectionStart - cursorBack, el.selectionStart - cursorBack)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (!open && /^\s*```[\w+#.-]*\s*$/.test(line) && el.selectionEnd === pos) {
    // The rest of the line goes inside; a block that is closed further down already is left alone.
    const after = el.value.slice(pos).split('\n').slice(1)
    if (after.some((l) => FENCE.test(l))) insert('\n')
    else insert('\n\n```', 4)
    return true
  }
  if (open) {
    insert('\n')
    return true
  }
  return false
}

type SearchHit = { title: string; url: string; snippet?: string }
/** An event as calendar_list_events gives it to the model (server/agentCalendar.ts). */
type CalendarHit = { id?: string; title: string; when: string; calendar: string }
/** A conversation as mail_search gives it to the model (server/agentMail.ts). */
type MailHit = { message_id?: string; subject: string; from: string; date: string }

/** One tool call: what it did in a line, and when opened, what it was given and what came back. */
function ToolCard({ tag, call, result, checked, pending, approval, inTerminal, summary, check, mailAlways }: { /** Mail reads are always allowed already */ mailAlways?: boolean; tag: string; call: ToolCall; result?: string; /** Why it ran without asking (a checked web read) */ checked?: string; pending: boolean; approval?: (allow: boolean, extra?: Parameters<typeof answerApproval>[3]) => void; inTerminal?: boolean; summary?: CallSummary; /** What Auto's check said about a web read it would not clear */ check?: string }) {
  let parsed: unknown = null
  try {
    parsed = result ? JSON.parse(result) : null
  } catch {
    parsed = result
  }
  const failed = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed
  const hits = call.name === 'web_search' && Array.isArray(parsed) ? (parsed as SearchHit[]) : null
  const events = call.name === 'calendar_list_events' && parsed && typeof parsed === 'object' && Array.isArray((parsed as { events?: unknown }).events) ? (parsed as { events: CalendarHit[]; more?: number }) : null
  const mails = call.name === 'mail_search' && parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results) ? (parsed as { results: { account: string; conversations?: MailHit[] }[] }).results.flatMap((r) => r.conversations ?? []) : null
  if (approval)
    return (
      <div className="agt-tool is-asking" role="group" aria-label="Allow this change?" data-tool={tag}>
        <p className="agt-ask-title">
          <span className="agt-tool-icon" aria-hidden>
            ?
          </span>
          <span className="agt-tool-label">{summary?.title ?? toolLabel(call)}</span>
        </p>
        {summary?.image && /^\/api\/agents\/(?:images\/[0-9a-f-]{36}|threads\/[0-9a-f-]{36}\/messages\/[0-9]+\/attachments\/[0-9])$/.test(summary.image.url) && <Thumbnails pictures={[{ name: summary.image.name, src: summary.image.url, source: 'Image-to-image source', size: summary.image.size, preview: true }]} />}
        {summary && (
          <dl className="agt-answers agt-ask-summary">
            {summary.rows.map(([label, value], i) => (
              <div key={i}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {summary?.body !== undefined && <pre className="agt-tool-body agt-ask-mail">{summary.body || '(no text)'}</pre>}
        {call.name.startsWith('mail_') && (
          <p className="muted agt-ask-why">{MAIL_READ_TOOLS.has(call.name) ? 'Mail asks you first, in every mode: what it reads is private. You can let it search and read mail in this thread for 15 minutes, or always; sending and changes still ask.' : 'Mail always asks you first, in every mode: what it reads and sends is private.'}</p>
        )}
        {call.name === 'generate_image' && !summary && <pre className="agt-tool-body">{JSON.stringify(call.arguments, null, 2)}</pre>}
        {call.name === 'seafile_write' && typeof call.arguments.content === 'string' && <pre className="agt-tool-body">{call.arguments.content.slice(0, 4000)}</pre>}
        {call.name === 'update_note' && typeof call.arguments.text === 'string' && <pre className="agt-tool-body">{call.arguments.text.slice(0, 4000)}</pre>}
        {call.name === 'web_fetch' && typeof call.arguments.url === 'string' && (
          <>
            <p className="muted agt-ask-why">This address did not come from your messages, a search result or a page it read. Allow it only if it looks right: an address can carry what the agent knows to someone else's site.</p>
            <pre className="agt-tool-body agt-ask-url">{call.arguments.url.slice(0, 2000)}</pre>
            {check && <p className="muted agt-ask-why agt-ask-check">{check}</p>}
          </>
        )}
        <ApprovalPreview call={call} />
        <ApprovalActions call={call} decide={approval} mailAlways={mailAlways} />
      </div>
    )
  return (
    <details className={`agt-tool ${failed ? 'is-failed' : ''}`} data-tool={tag}>
      <summary>
        <span className="agt-tool-icon" aria-hidden>
          {pending ? '◌' : failed ? '✕' : '✓'}
        </span>
        <span className="agt-tool-label">{toolLabel(call, result)}</span>
        {inTerminal && <span className="muted"> · running in your terminal…</span>}
        {checked && (
          <span className="muted agt-tool-checked" title={checked}>
            {' '}
            · {checked}
          </span>
        )}
        {hits && <span className="muted"> · {hits.length} results</span>}
        {events && (
          <span className="muted">
            {' '}
            · {events.events.length + (events.more ?? 0)} {events.events.length + (events.more ?? 0) === 1 ? 'event' : 'events'}
          </span>
        )}
        {mails && (
          <span className="muted">
            {' '}
            · {mails.length} {mails.length === 1 ? 'conversation' : 'conversations'}
          </span>
        )}
        {failed && <span className="t-red"> · {String((parsed as { error: unknown }).error)}</span>}
      </summary>
      {hits ? (
        <ul className="agt-hits">
          {hits.map((h) => (
            <li key={h.url}>
              {/* Results come from a search provider: only web links are links. */}
              {/^https?:\/\//i.test(h.url) ? (
                <a href={h.url} target="_blank" rel="noopener noreferrer">
                  {h.title || h.url}
                </a>
              ) : (
                <span>{h.title || h.url}</span>
              )}
              <span className="muted"> {h.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}</span>
            </li>
          ))}
        </ul>
      ) : mails?.length ? (
        <ul className="agt-hits">
          {mails.map((m, i) => (
            <li key={m.message_id ?? i}>
              <span>{m.subject || '(no subject)'}</span>
              <span className="muted">
                {' '}
                {m.from} · {m.date}
              </span>
            </li>
          ))}
        </ul>
      ) : events?.events.length ? (
        <ul className="agt-hits">
          {events.events.map((e, i) => (
            <li key={e.id ?? i}>
              <span>{e.title}</span>
              <span className="muted">
                {' '}
                {e.when} · {e.calendar}
              </span>
            </li>
          ))}
          {!!events.more && <li className="muted">and {events.more} more</li>}
        </ul>
      ) : (
        <pre className="agt-tool-body">{[`${call.name}(${JSON.stringify(call.arguments)})`, result ? (typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)).slice(0, 6000) : pending ? 'Running…' : 'No result (the turn stopped).'].join('\n\n')}</pre>
      )}
    </details>
  )
}

const PERMISSION_LABEL: Record<Permission, string> = { default: 'Ask first', auto: 'Auto', acceptEdits: 'Edits allowed', plan: 'Plan', bypass: 'Bypass' }
const PERMISSION_HELP: Record<Permission, string> = {
  default: 'Each change, and each web address it made up, waits for you to allow it',
  auto: 'Web addresses it made up are checked for you (rules, then the safety check model); changes still ask',
  acceptEdits: 'File edits in the work folder go through and web reads are checked like Auto; deleting and commands still ask',
  plan: 'Read only: it looks around, then shows you a plan to approve',
  bypass: 'Nothing asks: edits, deletes, commands and web reads all run. Calendar changes, mail, and AGENTS.md, CLAUDE.md, .agents/ and .claude/ still ask',
}
const FILE_EDITS = new Set(['write_file', 'edit_file', 'multi_edit', 'make_dir', 'move_path'])

/** What a change looks like: a diff for an edit, the text for a write, the command, the plan. */
function ApprovalPreview({ call }: { call: ToolCall }) {
  const a = call.arguments ?? {}
  if (call.name === 'edit_file' || call.name === 'multi_edit') {
    const edits = call.name === 'multi_edit' && Array.isArray(a.edits) ? (a.edits as Record<string, unknown>[]) : [a]
    return (
      <pre className="agt-tool-body agt-diff">
        {edits.flatMap((e, k) => [
          ...(k ? [<span key={`s${k}`} className="muted">⋯{'\n'}</span>] : []),
          ...diffLines(String(e.old_string ?? ''), String(e.new_string ?? '')).map((d, i) => (
            <span key={`${k}-${i}`} className={d.kind === '-' ? 't-red' : d.kind === '+' ? 't-green' : 'muted'}>
              {`${d.kind} ${d.text}\n`}
            </span>
          )),
        ])}
      </pre>
    )
  }
  if (call.name === 'write_file' && typeof a.content === 'string') return <pre className="agt-tool-body">{a.content.slice(0, 6000)}</pre>
  if (call.name === 'terminal' && typeof a.command === 'string')
    return (
      <>
        <pre className="agt-tool-body agt-ask-command">{a.command.slice(0, 4000)}</pre>
        {typeof a.description === 'string' && <p className="muted agt-ask-why">{a.description}</p>}
      </>
    )
  if (call.name === 'exit_plan_mode' && typeof a.plan === 'string')
    return (
      <article className="zed-preview agt-answer agt-plan">
        <MarkdownPreview text={a.plan} />
      </article>
    )
  return null
}

/**
 * Mail reads the user allowed in this thread for a while, with the minutes left and an × to end it
 * early; gone when it runs out (the server stops honouring it then, whatever this shows). With
 * mail reads always allowed, says so instead, and opens Settings → Agents → Permissions to change it.
 */
function MailReadsChip({ thread, onChange, onError }: { thread: Thread; onChange: (t: Thread) => void; onError: (e: string) => void }) {
  const wm = useWM()
  // Ticks to count the minutes down; the time itself is read as it draws.
  const [, tick] = useState(0)
  const until = thread.mailReadsUntil ?? 0
  useEffect(() => {
    if (until <= Date.now()) return
    const timer = window.setInterval(() => tick((n) => n + 1), 10_000)
    // And once more right when it runs out, so the chip goes on time.
    const end = window.setTimeout(() => tick((n) => n + 1), until - Date.now() + 50)
    return () => (window.clearInterval(timer), window.clearTimeout(end))
  }, [until])
  const left = mailReadsLeft(thread)
  if (thread.mailReadsAlways)
    return (
      <button
        className="agt-chip agt-chip-grant"
        title="Mail searches and reads run without asking in every thread. Drafts, sends and changes still ask. Click to change it in Settings → Agents → Permissions."
        onClick={() => (showAgentsSection('permissions'), wm.open('settings', { section: 'agents', t: String(Date.now()) }))}
      >
        <span className="agt-chip-label">Mail reads always allowed</span>
      </button>
    )
  if (!left) return null
  return (
    <span className="agt-chip agt-chip-grant" title="Mail searches and reads run without asking in this thread until then. Drafts, sends and changes still ask.">
      <span className="agt-chip-label">Mail reads allowed · {left} min</span>
      <button className="agt-chip-x" aria-label="Stop allowing mail reads" title="Stop allowing mail reads now" onClick={() => revokeMailReads(thread.id).then(onChange, (e: Error) => onError(e.message))}>
        ×
      </button>
    </span>
  )
}

/** Allow, allow from now on, or decline (with what to do instead), by what is asked. `mailAlways`: mail reads are always allowed already. */
function ApprovalActions({ call, decide, mailAlways }: { call: ToolCall; decide: (allow: boolean, extra?: Parameters<typeof answerApproval>[3]) => void; mailAlways?: boolean }) {
  const [feedback, setFeedback] = useState('')
  const plan = call.name === 'exit_plan_mode'
  return (
    <>
      <div className="agt-ask-actions">
        {plan ? (
          <>
            <button className="btn btn-small btn-primary" onClick={() => decide(true, { mode: 'acceptEdits' })}>
              Start, edits allowed
            </button>
            <button className="btn btn-small" onClick={() => decide(true, { mode: 'auto' })} title="Goes on in Auto: each edit asks, web addresses it makes up are checked for you">
              Start, ask for each edit
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-small btn-primary" onClick={() => decide(true)}>
              Allow
            </button>
            {FILE_EDITS.has(call.name) && (
              <button className="btn btn-small" onClick={() => decide(true, { always: 'edits' })} title="File edits in the work folder go through from now on">
                Allow all edits
              </button>
            )}
            {call.name === 'web_fetch' && typeof call.arguments?.url === 'string' && siteOf(call.arguments.url) && (
              <button className="btn btn-small" onClick={() => decide(true, { always: 'domain' })} title={`Reads on ${siteOf(call.arguments.url)} go through without asking from now on, in all your threads (Settings → Agents → Permissions)`}>
                Allow {siteOf(call.arguments.url)}
              </button>
            )}
            {MAIL_READ_TOOLS.has(call.name) && !mailAlways && (
              <button className="btn btn-small" onClick={() => decide(true, { always: 'mail_reads' })} title="Searches and reads of your mail run without asking in this thread for 15 minutes. Drafts, sends and changes still ask every time.">
                Allow mail reads for 15 min
              </button>
            )}
            {call.name === 'terminal' && typeof call.arguments?.command === 'string' && canAlwaysAllow(call.arguments.command) && (
              <button className="btn btn-small" onClick={() => decide(true, { always: 'command' })} title="Commands like this one run without asking in this thread">
                Always allow this command
              </button>
            )}
          </>
        )}
        <button className="btn btn-small" onClick={() => decide(false, feedback.trim() ? { feedback: feedback.trim() } : {})}>
          {plan ? 'Keep planning' : 'Decline'}
        </button>
        {MAIL_READ_TOOLS.has(call.name) && !mailAlways && (
          <button className="btn btn-small btn-ghost agt-ask-quiet" onClick={() => (decide(true, { always: 'mail_reads_always' }), window.dispatchEvent(new CustomEvent(MAIL_READS_EVENT, { detail: 'always' })))} title="Searches and reads of your mail run without asking from now on, in every thread and mode (change it in Settings → Agents → Permissions). Drafts, sends and changes still ask every time.">
            Always allow mail reads
          </button>
        )}
      </div>
      <input
        className="agt-ask-feedback"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && feedback.trim()) decide(false, { feedback: feedback.trim() })
        }}
        placeholder={plan ? 'What should change in the plan? (Enter sends)' : 'Or tell it what to do instead (Enter sends)'}
        aria-label="What to do instead"
      />
    </>
  )
}

// --- right-click menus ------------------------------------------------------------------------

const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {})
const short = (text: string, n = 28) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const isField = (el: Element) => el.closest<HTMLInputElement | HTMLTextAreaElement>('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), textarea')

/** A link under the pointer and the selected text, for any menu in the app. */
function textItems(root: Element, target: Element, quote?: (text: string) => void): MenuItem[] {
  const href = linkAt(target)
  const sel = selectionIn(root)
  return tidyMenu([
    ...(href ? linkMenu(href) : []),
    { separator: true },
    ...(sel
      ? [
          { label: 'Copy', shortcut: 'Ctrl C', onSelect: () => copy(sel) },
          ...(quote ? [{ label: 'Quote in reply', onSelect: () => quote(sel) }] : []),
          { label: `Search the web for “${short(sel)}”`, onSelect: () => searchWeb(sel) },
        ]
      : []),
  ])
}

/** The whole thread as Markdown: questions, answers, and what each tool call did. */
function threadMarkdown(title: string, messages: AgentMessage[]): string {
  const out = [`# ${title}`]
  for (const m of messages) {
    if (m.role === 'user') out.push(`## You\n\n${m.content}${m.attachments?.length ? `\n\nAttached: ${m.attachments.map((a) => a.name).join(', ')}` : ''}`)
    else if (m.role === 'assistant') {
      const results = messages.slice(messages.indexOf(m) + 1).filter((r, k, rest) => r.role === 'tool' && rest.slice(0, k).every((x) => x.role === 'tool'))
      const steps = (m.toolCalls ?? []).map((c, j) => `- ${toolLabel(c, results[j]?.content)}`).join('\n')
      if (m.content.trim() || steps) out.push(`## Agent\n\n${[steps, m.content.trim()].filter(Boolean).join('\n\n')}`)
    } else if (m.role === 'compact') out.push(`---\n\n*${compactionText(m.compact)}. The summary the agent works from since:*\n\n${m.content.split('\n').map((l) => `> ${l}`).join('\n')}\n\n---`)
  }
  return out.join('\n\n') + '\n'
}

// --- the sidebar's pieces ---------------------------------------------------------------------

const SIDEBAR_KEY = 'mvlos.agents.sidebar'

/** "now", "5m", "3h", "Tue", "12 Oct": as short as the one line allows. */
function shortWhen(ms: number, now = Date.now()) {
  const s = (now - ms) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  const d = new Date(ms)
  if (new Date(now).toDateString() === d.toDateString()) return `${Math.floor(s / 3600)}h`
  if (s < 6 * 86400) return d.toLocaleDateString('en-GB', { weekday: 'short' })
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** Threads under Today, Yesterday, This week, This month and Older (newest first). */
function byDay(threads: Thread[]): { label: string; items: Thread[] }[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const t0 = today.getTime()
  const label = (ms: number) => (ms >= t0 ? 'Today' : ms >= t0 - 864e5 ? 'Yesterday' : ms >= t0 - 6 * 864e5 ? 'This week' : ms >= t0 - 30 * 864e5 ? 'This month' : 'Older')
  const out: { label: string; items: Thread[] }[] = []
  for (const t of threads) {
    const l = label(t.updatedAt)
    if (out[out.length - 1]?.label === l) out[out.length - 1].items.push(t)
    else out.push({ label: l, items: [t] })
  }
  return out
}

const ICONS: Record<string, ReactNode> = {
  folder: <path d="M3 6h6l2 2h10v11H3z" />,
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" />
      <path d="M9 4v16" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  archive: (
    <>
      <path d="M3 5h18v4H3zM5 9v10h14V9M10 13h4" />
    </>
  ),
  memory: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  studio: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 16l-5-5-9 9" />
    </>
  ),
  clip: <path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 7" />,
  bolt: <path d="M13 2L5 14h6l-1 8 8-12h-6z" />,
  deep: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="M20 20l-5.5-5.5M10 7v6M7 10h6" />
    </>
  ),
  tools: <path d="M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-2.3-2.3a4 4 0 0 0-5-5L4 12l2.7-2.7a4 4 0 0 0 5-5L14 2z" />,
  chevron: <path d="M7 10l5 5 5-5" />,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" fill="currentColor" />,
  pin: <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
}

function Icon({ name, size = 15 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="agt-svg">
      {ICONS[name]}
    </svg>
  )
}

// --- modes -----------------------------------------------------------------------------------

const MODE_HELP: Record<Mode, string> = {
  quick: 'Answers straight away, searching the web or your files only when it needs to, in a few seconds. Up to 6 rounds of tools.',
  deep: 'Researches first: searches from several angles, reads the sources, compares them, then writes a structured answer with citations. Takes a minute or a few; up to 24 rounds of tools.',
}

// --- titles ----------------------------------------------------------------------------------

const NEW_TITLE = 'New thread'
/** Regenerate title's second line: only when it changes more than the title (one you named goes back to automatic). */
const regenerateHint = (t: Thread) => (t.titleSource === 'user' ? 'You named it: titles keep up to date again after this' : undefined)
/** Still waiting for the title model. */
const titlePending = (t: Thread) => t.titling || (t.title === NEW_TITLE && t.running)

const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'
const noise = (n: number) => Array.from({ length: n }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join('')
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * A title that is still being thought of rains Matrix glyphs in its one line, then decodes into
 * the real title from the left once it arrives.
 */
function Scramble({ text, pending, length = 16 }: { text: string; pending: boolean; length?: number }) {
  const [shown, setShown] = useState(() => (pending ? noise(length) : text))
  const wasPending = useRef(pending)
  useEffect(() => {
    const before = wasPending.current
    wasPending.current = pending
    if (calm()) return setShown(pending ? 'Naming…' : text)
    if (pending) {
      const timer = setInterval(() => setShown(noise(length)), 70)
      return () => clearInterval(timer)
    }
    if (!before) return setShown(text)
    // A timer, not animation frames: those stop in a hidden tab, and the title must still land.
    const start = Date.now()
    const timer = setInterval(() => {
      const p = Math.min(1, (Date.now() - start) / 650)
      const n = Math.floor(p * text.length)
      setShown(p < 1 ? text.slice(0, n) + noise(Math.min(length, text.length - n)) : text)
      if (p >= 1) clearInterval(timer)
    }, 40)
    return () => clearInterval(timer)
  }, [pending, text, length])
  return (
    <span className={`agt-matrix ${pending ? 'is-pending' : ''}`} aria-label={pending ? 'Thinking of a title' : text}>
      {shown}
    </span>
  )
}

/** Renaming in place, with a fresh suggestion from the title model one click away. */
function RenameBox({ thread, onSave, onCancel }: { thread: Thread; onSave: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(thread.title === NEW_TITLE ? '' : thread.title)
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const [asking, setAsking] = useState(true)
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    if (save) onSave(input.current?.value ?? value)
    else onCancel()
  }
  useEffect(() => {
    input.current?.select()
    let live = true
    suggestTitle(thread.id).then(
      (r) => live && (setSuggestion(r.title), setAsking(false)),
      () => live && setAsking(false),
    )
    return () => {
      live = false
    }
  }, [thread.id])
  return (
    <div className="agt-rename">
      <input
        ref={input}
        autoFocus
        value={value}
        placeholder={thread.title}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => (e.key === 'Enter' ? finish(true) : e.key === 'Escape' && finish(false))}
        aria-label="Thread title"
      />
      {(asking || suggestion) && (
        <button
          className="agt-suggest"
          disabled={!suggestion}
          // Keep the input focused, so choosing the suggestion doesn't end the rename.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => suggestion && (setValue(suggestion), input.current?.focus())}
          title="Use this title"
        >
          <span aria-hidden>✦ </span>
          <Scramble text={suggestion ?? ''} pending={asking} length={14} />
        </button>
      )}
    </div>
  )
}

// --- the context window ------------------------------------------------------------------------

const PART_COLORS = ['var(--magenta)', 'var(--muted)', 'var(--yellow)', 'var(--orange)', 'var(--blue)', 'var(--green)', 'var(--fg)', 'var(--cyan)']

/** How full the model's context was after the last reply, as a small ring in the thread's top bar; opens and closes the breakdown. */
function ContextMeter({ thread, models, open, panelId, onToggle }: { thread: Thread; models: ModelInfo[]; open: boolean; panelId: string; onToggle: () => void }) {
  const size = models.find((m) => m.name === thread.model)?.contextLength ?? null
  const used = thread.contextTokens
  const share = used !== null && size ? Math.min(1, used / size) : 0
  const C = 2 * Math.PI * 7
  const label = used !== null ? `${used.toLocaleString()}${size ? ` of ${size.toLocaleString()}` : ''} tokens in context (${share < 0.01 && used ? '<1' : Math.round(share * 100)}%)` : 'Context window'
  return (
    <button type="button" className={`agt-ring ${open ? 'is-on' : ''} ${share > 0.8 ? 'is-full' : ''}`} onClick={onToggle} aria-expanded={open} aria-controls={open ? panelId : undefined} title={label} aria-label={label}>
      <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden>
        <circle cx="9" cy="9" r="7" className="agt-ring-track" />
        <circle cx="9" cy="9" r="7" className="agt-ring-fill" strokeDasharray={`${Math.max(share, used ? 0.03 : 0) * C} ${C}`} transform="rotate(-90 9 9)" />
      </svg>
    </button>
  )
}

/**
 * What the next message sends the model, part by part, against the window's size, with where it
 * compacts by itself (a mark on the bar) and the last compaction, if any. `onCompact`: Compact now.
 */
function ContextPanel({ panelId, id, version, onCompact, onClose }: { panelId: string; id: string; version: number; onCompact?: () => void; onClose: () => void }) {
  const phone = useIsMobile()
  const [info, setInfo] = useState<ContextInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    getContext(id).then(setInfo, (e: Error) => setError(e.message))
  }, [id, version])
  // Esc closes it (when focus is in this window, or nowhere); on a phone or touch screen a tap anywhere
  // else does too (the ring toggles it itself). Several Agents windows each have their own panel.
  useEffect(() => {
    const panel = () => document.getElementById(panelId)
    const key = (e: KeyboardEvent) => {
      const focus = document.activeElement
      const mine = !focus || focus === document.body || !!panel()?.closest('.agt')?.contains(focus)
      if (e.key === 'Escape' && !e.defaultPrevented && mine && !document.querySelector('.dlg-modal, .ctx-menu')) onClose()
    }
    const touch = phone || window.matchMedia('(pointer: coarse)').matches
    const away = (e: PointerEvent) => {
      const el = e.target as Element | null
      if (!panel()?.contains(el) && el?.closest?.('.agt-ring')?.getAttribute('aria-controls') !== panelId && !el?.closest?.('.dlg-modal, .ctx-menu')) onClose()
    }
    window.addEventListener('keydown', key)
    if (touch) document.addEventListener('pointerdown', away)
    return () => (window.removeEventListener('keydown', key), document.removeEventListener('pointerdown', away))
  }, [phone, onClose, panelId])
  const scale = info ? info.contextLength ?? Math.max(info.estimate, info.measured ?? 0) : 1
  return (
    <div className="agt-ctx-panel" id={panelId} role="region" aria-label="Context window">
      <p className="agt-ctx-head">
        <span className="agt-ctx-title">
          <strong>Context window</strong>
          {info && (
            <span className="muted">
              {' '}
              · {info.model}
              {info.contextLength ? ` · ${tokenCount(info.contextLength)} tokens` : ''}
            </span>
          )}
        </span>
        <button type="button" className="agt-icon agt-ctx-close" onClick={onClose} aria-label="Close context window" title="Close (Esc)">
          <Icon name="close" size={14} />
        </button>
      </p>
      {error ? (
        <p className="t-red copyable agt-ctx-note">{error}</p>
      ) : !info ? (
        <p className="muted agt-ctx-note">Adding it up…</p>
      ) : (
        <>
          <div className="agt-ctx-bar" aria-hidden>
            {info.parts.map((p, i) => (
              <span key={p.label} style={{ width: `${(p.tokens / scale) * 100}%`, background: p.label.startsWith('Summary') ? 'var(--accent)' : PART_COLORS[i % PART_COLORS.length] }} />
            ))}
            {info.autoCompact !== null && info.contextLength && <i className="agt-ctx-mark" style={{ left: `${info.autoCompact}%` }} />}
          </div>
          <ul className="agt-ctx-parts">
            {info.parts.map((p, i) => (
              <li key={p.label}>
                <span className="agt-ctx-swatch" style={{ background: p.label.startsWith('Summary') ? 'var(--accent)' : PART_COLORS[i % PART_COLORS.length] }} />
                <span>{p.label}</span>
                <span className="muted">≈ {tokenCount(p.tokens)}</span>
              </li>
            ))}
          </ul>
          <p className="muted agt-ctx-note">
            {info.measured !== null ? `Ollama counted ${info.measured.toLocaleString()} tokens after the last reply. ` : ''}
            The parts are estimates (about 4 characters a token) of what the next message sends: ≈ {tokenCount(info.estimate)} in all. Older tool results go in shortened.
          </p>
          <p className="muted agt-ctx-note agt-ctx-compact">
            {info.compaction
              ? `Compacted ${info.compaction.times === 1 ? 'once' : `${info.compaction.times} times`}, last ${info.compaction.auto ? 'by itself' : 'on request'} at ${new Date(info.compaction.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: the summary stands in for the ${info.compaction.hidden} messages before it. `
              : ''}
            {info.autoCompact !== null ? `It compacts by itself at ${info.autoCompact}% of the window (the mark on the bar).` : 'Compacting by itself is off (Settings → Agents → New threads).'}
            {onCompact && (
              <>
                {' '}
                <button type="button" className="btn btn-small" onClick={onCompact}>
                  Compact now…
                </button>
              </>
            )}
          </p>
        </>
      )}
    </div>
  )
}

// --- settings ---------------------------------------------------------------------------------

/** The app's settings (the same as Settings → Agents), with the window's own back button. */
function SettingsPane({ onBack }: { onBack: () => void }) {
  return (
    <>
      <div className="nb-toolbar agt-toolbar">
        <button className="btn btn-small agt-back" onClick={onBack} aria-label="Back to threads">
          ‹
        </button>
        <span className="agt-title">Agents settings</span>
      </div>
      <div className="agt-settings-host">
        <AgentsSettings layout="sidebar" />
      </div>
    </>
  )
}

// --- forms the agent asks (ask_user) ----------------------------------------------------------

type FieldProps = { q: Question; value: unknown; set: (v: unknown) => void; submitWith: (v: unknown) => void; alone: boolean }

const OTHER = '\u0000other'

/** One renderer per question type; a type not listed here gets a text field. Add a type: add a renderer. */
const FIELDS: Record<string, (p: FieldProps) => ReactNode> = {
  choice: ({ q, value, set, submitWith, alone }) => {
    const known = q.options?.some((o) => o.value === value)
    const other = q.allowOther && typeof value === 'string' && !known ? value : null
    return (
      <div className="agt-q-options" role="radiogroup" aria-label={q.label}>
        {q.options?.map((o) => (
          <button type="button" key={o.value} role="radio" aria-checked={value === o.value} className={`agt-q-opt ${value === o.value ? 'is-on' : ''}`} onClick={() => (alone && !q.allowOther ? submitWith(o.value) : set(o.value))}>
            <span className="agt-q-mark" aria-hidden>
              {value === o.value ? '●' : '○'}
            </span>
            <span className="agt-q-opt-text">
              {o.label}
              {o.hint && <small>{o.hint}</small>}
            </span>
          </button>
        ))}
        {q.allowOther && (
          <label className={`agt-q-opt agt-q-other ${other !== null ? 'is-on' : ''}`}>
            <span className="agt-q-mark" aria-hidden>
              {other !== null ? '●' : '○'}
            </span>
            <input value={other === OTHER ? '' : (other ?? '')} placeholder="Something else…" onFocus={() => other === null && set(OTHER)} onChange={(e) => set(e.target.value || OTHER)} />
          </label>
        )}
      </div>
    )
  },
  multi: ({ q, value, set }) => {
    const list = Array.isArray(value) ? (value as string[]) : []
    const known = list.filter((v) => q.options?.some((o) => o.value === v))
    const other = list.find((v) => !q.options?.some((o) => o.value === v)) ?? null
    const toggle = (v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
    return (
      <div className="agt-q-options" role="group" aria-label={q.label}>
        {q.options?.map((o) => (
          <button type="button" key={o.value} role="checkbox" aria-checked={list.includes(o.value)} className={`agt-q-opt ${list.includes(o.value) ? 'is-on' : ''}`} onClick={() => toggle(o.value)}>
            <span className="agt-q-mark is-box" aria-hidden>
              {list.includes(o.value) ? '✓' : ''}
            </span>
            <span className="agt-q-opt-text">
              {o.label}
              {o.hint && <small>{o.hint}</small>}
            </span>
          </button>
        ))}
        {q.allowOther && (
          <label className={`agt-q-opt agt-q-other ${other ? 'is-on' : ''}`}>
            <span className="agt-q-mark is-box" aria-hidden>
              {other ? '✓' : ''}
            </span>
            <input value={other ?? ''} placeholder="Something else…" onChange={(e) => set([...known, ...(e.target.value ? [e.target.value] : [])])} />
          </label>
        )}
        {(q.min !== undefined || q.max !== undefined) && <small className="muted">{q.min !== undefined && q.max !== undefined ? `Pick ${q.min} to ${q.max}` : q.min !== undefined ? `Pick at least ${q.min}` : `Pick up to ${q.max}`}</small>}
      </div>
    )
  },
  confirm: ({ value, set, submitWith, alone }) => (
    <div className="agt-q-yesno">
      {[true, false].map((v) => (
        <button type="button" key={String(v)} className={`btn btn-small ${value === v ? 'btn-primary' : ''}`} onClick={() => (alone ? submitWith(v) : set(v))}>
          {v ? 'Yes' : 'No'}
        </button>
      ))}
    </div>
  ),
  text: ({ q, value, set }) =>
    q.multiline ? (
      <textarea className="agt-q-input" rows={3} value={String(value ?? '')} placeholder={q.placeholder} onChange={(e) => set(e.target.value)} aria-label={q.label} />
    ) : (
      <input className="agt-q-input" value={String(value ?? '')} placeholder={q.placeholder} onChange={(e) => set(e.target.value)} aria-label={q.label} />
    ),
  number: ({ q, value, set }) => (
    <span className="agt-q-number">
      <input className="agt-q-input" type="number" value={value === undefined || value === null ? '' : String(value)} min={q.min} max={q.max} step={q.step} placeholder={q.placeholder} onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} aria-label={q.label} />
      {q.unit && <span className="muted">{q.unit}</span>}
    </span>
  ),
  scale: ({ q, value, set }) => {
    const min = q.min ?? 1
    const max = q.max ?? 5
    const steps = Array.from({ length: Math.min(11, max - min + 1) }, (_, i) => min + i)
    return (
      <div className="agt-q-scale">
        {q.minLabel && <span className="muted">{q.minLabel}</span>}
        <span className="agt-q-scale-row" role="radiogroup" aria-label={q.label}>
          {steps.map((n) => (
            <button type="button" key={n} role="radio" aria-checked={value === n} className={value === n ? 'is-on' : ''} onClick={() => set(n)}>
              {n}
            </button>
          ))}
        </span>
        {q.maxLabel && <span className="muted">{q.maxLabel}</span>}
      </div>
    )
  },
  date: ({ q, value, set }) => <input className="agt-q-input agt-q-date" type="date" value={String(value ?? '')} onChange={(e) => set(e.target.value)} aria-label={q.label} />,
  info: () => null,
}

const answered = (q: Question, v: unknown) => {
  if (q.type === 'info') return true
  if (Array.isArray(v)) return v.length >= Math.max(1, q.min ?? 1)
  return v !== undefined && v !== null && v !== '' && v !== OTHER
}

/** A form the agent is waiting on: answer it, or say "Not now". */
function QuestionForm({ form, onAnswer }: { form: Form; onAnswer: (answers: Record<string, unknown> | null) => void }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(form.questions.filter((q) => q.default !== undefined).map((q) => [q.id, q.default])))
  const asked = form.questions.filter((q) => q.type !== 'info')
  const alone = asked.length === 1 && (asked[0].type === 'confirm' || (asked[0].type === 'choice' && !asked[0].allowOther))
  const missing = asked.filter((q) => q.required !== false && !answered(q, values[q.id]))
  const clean = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === OTHER ? '' : x]))
  const submit = (extra: Record<string, unknown> = {}) => onAnswer(clean({ ...values, ...extra }))
  return (
    <form
      className="agt-tool agt-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!missing.length) submit()
      }}
    >
      <p className="agt-form-title">
        <span className="agt-tool-icon" aria-hidden>
          ?
        </span>
        <strong>{form.title}</strong>
      </p>
      {form.intro && (
        <div className="zed-preview agt-form-intro">
          <MarkdownPreview text={form.intro} />
        </div>
      )}
      {form.questions.map((q) => {
        const render = FIELDS[q.type] ?? FIELDS.text
        return (
          <div key={q.id} className={`agt-q is-${q.type}`}>
            {q.type === 'info' ? (
              <div className="zed-preview agt-form-intro">
                <MarkdownPreview text={q.label} />
              </div>
            ) : (
              <p className="agt-q-label">
                {q.label}
                {q.required === false && <span className="muted"> (optional)</span>}
              </p>
            )}
            {q.hint && <p className="agt-q-hint muted">{q.hint}</p>}
            {render({ q, value: values[q.id], set: (v) => setValues((all) => ({ ...all, [q.id]: v })), submitWith: (v) => submit({ [q.id]: v }), alone })}
          </div>
        )
      })}
      <div className="agt-form-actions">
        {!alone && (
          <button className="btn btn-small btn-primary" disabled={missing.length > 0} title={missing.length ? `Still to answer: ${missing.map((q) => q.label).join('; ')}` : undefined}>
            {form.submit || 'Send answers'}
          </button>
        )}
        <button type="button" className="btn btn-small" onClick={() => onAnswer(null)}>
          Not now
        </button>
      </div>
    </form>
  )
}

/** A form that was answered: the questions with what was chosen, folded into one line. */
function AnsweredForm({ tag, call, result }: { tag: string; call: ToolCall; result: string }) {
  let summary = ''
  let skipped = false
  let error = ''
  let said = ''
  try {
    const r = JSON.parse(result) as { summary?: string; skipped?: boolean; error?: string; said?: string }
    summary = r.summary ?? ''
    skipped = !!r.skipped
    said = r.said ?? ''
    error = r.error ?? ''
  } catch {
    summary = result
  }
  return (
    <details className={`agt-tool ${error ? 'is-failed' : ''}`} data-tool={tag}>
      <summary>
        <span className="agt-tool-icon" aria-hidden>
          {error ? '✕' : skipped ? '–' : '✓'}
        </span>
        <span className="agt-tool-label">{toolLabel(call)}</span>
        <span className="muted"> · {error || (said ? `you wrote instead: ${said}` : skipped ? 'not answered' : 'answered')}</span>
      </summary>
      {summary && (
        <dl className="agt-answers">
          {summary.split('\n').map((line, i) => {
            const at = line.indexOf(': ')
            return (
              <div key={i}>
                <dt>{at > 0 ? line.slice(0, at) : line}</dt>
                <dd>{at > 0 ? line.slice(at + 2) : ''}</dd>
              </div>
            )
          })}
        </dl>
      )}
    </details>
  )
}
