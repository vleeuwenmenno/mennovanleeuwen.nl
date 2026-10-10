import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ALL_TOOLS,
  TOOL_GROUPS,
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
  fileSize,
  toAttachment,
  type Attachment,
  type ToolGroup,
  createThread,
  deleteMemory,
  deleteThread,
  getContext,
  getThread,
  listMemories,
  listThreads,
  sendMessage,
  agentSettings,
  setAgentSettings,
  stopThread,
  suggestTitle,
  tokenCount,
  toolLabel,
  updateThread,
  useAgentSettings,
  type ContextInfo,
  type AgentMessage,
  type Memory,
  type Mode,
  type ModelInfo,
  type PendingApproval,
  type Thread,
  type ToolCall,
} from '../data/agents'
import { DRAG_FILES, fileLink as seafileLink, getDragged, libraryName, parseSf } from '../data/seafile'
import { pickFiles } from '../os/FolderPicker'
import { Select } from '../os/Select'
import { signIn, useAccount } from '../os/account'
import { fieldMenu, linkAt, linkMenu, openContextMenu, openMenuAt, selectionIn, tidyMenu, type MenuItem } from '../os/ContextMenu'
import { searchWeb } from '../data/searchEngine'
import { ask } from '../os/Dialogs'
import { useWM, type WinState } from '../os/wm'
import { AgentsSettings, usePromptLocation } from './AgentsSettings'
import { MarkdownPreview } from './Zed'

// Agents: a research assistant on Ollama Cloud (server/agents.ts). Threads on the left (and the
// archived ones, and what the agent remembers), the conversation on the right with each tool call
// as a card. Quick answers fast with a search or two; Deep searches from several angles and reads
// the sources before it writes.

type Live = { content: string; thinking: string }

export function Agents({ win }: { win: WinState }) {
  const account = useAccount()
  const wm = useWM()
  if (account.status === 'loading') return <div className="nb-blank muted">Loading…</div>
  if (account.status !== 'user')
    return (
      <div className="nb-blank">
        <p className="muted">Agents is the owner's research assistant.</p>
        {account.status === 'anon' && (
          <button className="btn btn-primary" onClick={signIn}>
            Sign in with GitHub
          </button>
        )}
      </div>
    )
  if (!account.integrations.ollama)
    return (
      <div className="nb-blank">
        <p className="muted">Agents runs on Ollama Cloud. Add an API key from your Ollama account to start.</p>
        <button className="btn btn-primary" onClick={() => wm.open('settings', { section: 'integrations', t: String(Date.now()) })}>
          Open Settings → Integrations
        </button>
      </div>
    )
  return <AgentsApp win={win} />
}

/** What the main pane shows: a conversation, the settings, or the memory (the owner's or a project's). */
type Main = { kind: 'thread' } | { kind: 'settings' } | { kind: 'memory'; scope: number | null }
type Drag = { kind: 'project'; id: number } | { kind: 'thread'; id: string } | null

const FOLDED_PROJECTS = 'mvlos.agents.folded'
const readFolded = (): number[] => {
  try {
    return JSON.parse(localStorage.getItem(FOLDED_PROJECTS) ?? '[]') as number[]
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
    else if (t === 'archived') setArchived(true), setPane('list')
    else return
    wm.setProps(win.pid, { tab: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.props.t])

  usePromptLocation()

  const refresh = useCallback(() => {
    listThreads(archived).then(
      (list) => (setThreads(list), setListError(null)),
      (e: Error) => setListError(e.message),
    )
    listProjects().then(setProjects, () => {})
  }, [archived])
  useEffect(refresh, [refresh])
  // Titles being thought of arrive a moment after the answer starts: look again until they are in.
  useEffect(() => {
    if (!threads.some((t) => t.titling)) return
    const timer = setTimeout(refresh, 1500)
    return () => clearTimeout(timer)
  }, [threads, refresh])
  const rename = (t: Thread, title: string) => {
    setRenaming(null)
    if (title.trim() && title.trim() !== t.title) updateThread(t.id, { title: title.trim() }).then(refresh, () => {})
  }

  const query = q.trim().toLowerCase()
  const shown = useMemo(() => threads.filter((t) => !query || t.title.toLowerCase().includes(query)), [threads, query])
  const inProject = (t: Thread) => t.projectId !== null && projects.some((p) => p.id === t.projectId)
  const loose = pinnedFirst(shown.filter((t) => archived || !inProject(t)))
  const loosePinned = loose.filter((t) => t.pinned)
  const looseByDay = useMemo(() => byDay(loose.filter((t) => !t.pinned)), [loose])

  const remove = async (t: Thread) => {
    if (!(await ask({ title: `Delete “${t.title}”?`, body: 'The thread and everything in it is gone for good. Archive it instead to keep it out of the way.', confirm: 'Delete', danger: true }))) return
    await deleteThread(t.id).catch(() => {})
    if (selected === t.id) open(null)
    refresh()
  }
  const archive = async (t: Thread, value: boolean) => {
    await updateThread(t.id, { archived: value }).catch(() => {})
    if (selected === t.id) open(null)
    refresh()
  }
  const pin = (t: Thread) => void updateThread(t.id, { pinned: !t.pinned }).then(refresh, () => {})
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
    { label: 'Copy as Markdown', onSelect: () => void getThread(t.id).then((r) => copy(threadMarkdown(r.thread.title, r.messages)), () => {}) },
    { separator: true },
    t.archived ? { label: 'Move back to threads', onSelect: () => archive(t, false) } : { label: 'Archive', onSelect: () => archive(t, true) },
    { label: 'Delete…', danger: true, onSelect: () => remove(t) },
  ]

  // Projects: fold them, rename, reorder by dragging, delete (their threads stay).
  const toggleFold = (id: number) =>
    setFolded((f) => {
      const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id]
      try {
        localStorage.setItem(FOLDED_PROJECTS, JSON.stringify(next))
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
      return localStorage.getItem(SIDEBAR_KEY) === 'collapsed'
    } catch {
      return false
    }
  })
  const fold = (c: boolean) => {
    setCollapsed(c)
    try {
      localStorage.setItem(SIDEBAR_KEY, c ? 'collapsed' : 'open')
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
        { label: 'Settings…', onSelect: openSettings },
        ...(narrow ? [] : [{ separator: true as const }, { label: rail ? 'Show the sidebar' : 'Hide the sidebar', onSelect: () => fold(!rail) }]),
      ]),
    )
  }

  const row = (t: Thread) => (
    <li key={t.id}>
      {renaming === t.id ? (
        <div className="agt-item is-active">
          <RenameBox thread={t} onSave={(title) => rename(t, title)} onCancel={() => setRenaming(null)} />
        </div>
      ) : (
        <button
          className={`agt-item ${t.id === selected && main.kind === 'thread' ? 'is-active' : ''}`}
          onClick={() => open(t.id)}
          onContextMenu={(e) => openContextMenu(e, menu(t))}
          title={`${t.title}\n${t.mode === 'deep' ? 'Deep research' : 'Quick'} · ${t.model}`}
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
 * The memory, in the main pane: the owner's or one project's, as a tree of categories. Memories can
 * be added, edited (text, category, which memory they belong to) and forgotten.
 */
function MemoryView({ scope, projects, onScope, onBack }: { scope: number | null; projects: Project[]; onScope: (scope: number | null) => void; onBack: () => void }) {
  const [items, setItems] = useState<Memory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<number | 'new' | null>(null)
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
  const itemMenu = (e: React.MouseEvent, m: Memory) =>
    !e.shiftKey &&
    openContextMenu(
      e,
      tidyMenu([
        ...textItems(e.currentTarget, e.target as Element),
        { separator: true },
        { label: 'Edit…', onSelect: () => setEditing(m.id) },
        { label: 'Copy', onSelect: () => copy(m.text) },
        {
          label: 'Move to',
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
          <div key={m.id} className="agt-mem" onContextMenu={(e) => itemMenu(e, m)} onDoubleClick={() => setEditing(m.id)}>
            <span className="agt-mem-text">{m.text}</span>
            <span className="agt-mem-actions">
              <button className="agt-icon agt-mini" onClick={() => setEditing(m.id)} title="Edit" aria-label="Edit">
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
          <div className="agt-cat-body">{node(c, depth + 1)}</div>
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
            : 'What the agent knows about you, in every thread. It files new things under categories itself (People/Friends, Work/Tools…) and keeps them up to date; you can too.'}
        </p>
        <label className="agt-search agt-mem-search">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memory" aria-label="Search memory" spellCheck={false} />
        </label>
        {editing === 'new' && <MemoryForm scope={scope} projects={projects} categories={categories} onSave={(input) => void save(null, input)} onCancel={() => setEditing(null)} />}
        {items && !mine.length && editing !== 'new' && <p className="muted">{project ? `Nothing remembered about ${project.name} yet.` : 'Nothing remembered yet. Ask the agent to remember something, or add it here.'}</p>}
        {items && mine.length > 0 && !list.length && <p className="muted">Nothing matches.</p>}
        <div className="agt-mem-tree">{node(tree, 0)}</div>
        {error && <p className="t-red">{error}</p>}
      </div>
    </>
  )
}

/** Adding or editing one memory: its text, category path and whose memory it is. */
function MemoryForm({ memory, scope, projects, categories, onSave, onCancel }: { memory?: Memory; scope: number | null; projects: Project[]; categories: string[]; onSave: (input: { text: string; category: string; projectId: number | null }) => void; onCancel: () => void }) {
  const [text, setText] = useState(memory?.text ?? '')
  const [category, setCategory] = useState(memory?.category ?? '')
  const [owner, setOwner] = useState<string>(scope === null ? 'user' : `p${scope}`)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (text.trim()) onSave({ text: text.trim(), category, projectId: owner === 'user' ? null : Number(owner.slice(1)) })
  }
  const close = categories.filter((c) => c.toLowerCase().startsWith(category.toLowerCase()) && c !== category).slice(0, 6)
  return (
    <form className="agt-mem-form" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="One fact, in a sentence" rows={2} autoFocus aria-label="Memory" />
      <div className="agt-mem-form-row">
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category, like People/Friends" aria-label="Category" spellCheck={false} />
        <Select value={owner} onChange={(v) => setOwner(String(v))} aria-label="Whose memory" options={[{ value: 'user', label: 'You' }, ...projects.map((p) => ({ value: `p${p.id}`, label: p.name }))]} />
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
function TodoChip({ todos, running }: { todos: Todo[]; running: boolean }) {
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
  const [models, setModels] = useState<ModelInfo[]>([])
  const [draftMode, setDraftMode] = useState<Mode>(() => ask?.mode ?? agentSettings().mode)
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [files, setFiles] = useState<Attachment[]>([])
  const [reading, setReading] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const settingsNow = useAgentSettings()
  const [draftTools, setDraftTools] = useState<ToolGroup[]>(settingsNow.tools)
  const account = useAccount()
  const pcFiles = useRef<HTMLInputElement>(null)
  const [draftModel, setDraftModel] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [live, setLive] = useState<Live | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [ctxOpen, setCtxOpen] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const input = useRef<HTMLTextAreaElement>(null)

  // A thread created by the first message keeps streaming into this view: don't reload it then.
  const streamed = useRef<string | null>(null)
  useEffect(() => {
    if (!id || streamed.current === id) return
    getThread(id).then(
      (r) => (setThread(r.thread), setMessages(r.messages), setApprovals(r.pending)),
      (e: Error) => setError(e.message),
    )
  }, [id])
  useEffect(() => {
    agentModels().then(setModels, () => {})
    input.current?.focus()
    return () => abort.current?.abort()
  }, [])

  useEffect(() => {
    if (!listThread) return
    setThread((t) => (t && t.id === listThread.id && (t.title !== listThread.title || t.titling !== listThread.titling) ? { ...t, title: listThread.title, titling: listThread.titling } : t))
  }, [listThread?.title, listThread?.titling])

  // Answering in another window or tab: look again every few seconds until it is done.
  useEffect(() => {
    if (!id || busy || !thread?.running) return
    const t = setInterval(() => getThread(id).then((r) => (setThread(r.thread), setMessages(r.messages), setApprovals(r.pending), !r.thread.running && onChanged()), () => {}), 2500)
    return () => clearInterval(t)
  }, [id, busy, thread?.running, onChanged])

  // Follow the answer as it grows, unless scrolled up to read.
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, live])

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

  // A ref, not `busy`: two sends in one render (a double Enter, a re-run effect) must not both go.
  const sending = useRef(false)
  const send = async (asked?: string) => {
    const message = (asked ?? text).trim()
    const attached = asked === undefined ? files : []
    if ((!message && !attached.length) || sending.current || reading) return
    sending.current = true
    setError(null)
    setBusy(true)
    pinned.current = true
    let target = thread
    try {
      if (!target) {
        target = await createThread({ mode: draftMode, tools: draftTools, projectId: draftProject, ...(draftModel ? { model: draftModel } : {}) })
        streamed.current = target.id
        setThread(target)
        onCreated(target)
      }
      setText('')
      setFiles([])
      setLive({ content: '', thinking: '' })
      const ctl = new AbortController()
      abort.current = ctl
      await sendMessage(
        target.id,
        message,
        attached,
        (e) => {
          if (e.type === 'delta') setLive((l) => ({ content: (l?.content ?? '') + (e.content ?? ''), thinking: (l?.thinking ?? '') + (e.thinking ?? '') }))
          else if (e.type === 'approval') setApprovals((a) => [...a, { callId: e.callId, messageId: e.messageId, index: e.index, kind: 'approval' }])
          else if (e.type === 'question') setApprovals((a) => [...a, { callId: e.callId, messageId: e.messageId, index: e.index, kind: 'question', form: e.form }])
          else if (e.type === 'answered') setApprovals((a) => a.filter((x) => x.callId !== e.callId))
          else if (e.type === 'approved') setApprovals((a) => a.filter((x) => x.callId !== e.callId))
          else if (e.type === 'message') {
            setMessages((ms) => [...ms, e.message])
            if (e.message.role === 'assistant') setLive({ content: '', thinking: '' })
          } else if (e.type === 'thread') {
            setThread(e.thread)
            onChanged()
          } else if (e.type === 'error') setError(e.error)
        },
        ctl.signal,
      )
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError((e as Error).message)
        setText((t) => t || message)
        setFiles((f) => (f.length ? f : attached))
      }
    } finally {
      abort.current = null
      sending.current = false
      setBusy(false)
      setLive(null)
      setApprovals([])
      onChanged()
    }
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

  const decide = (callId: string, allow: boolean) => {
    if (!thread) return
    setApprovals((a) => a.filter((x) => x.callId !== callId))
    answerApproval(thread.id, callId, allow).catch((e: Error) => setError(e.message))
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

  const rename = (title: string) => {
    setRenaming(false)
    title = title.trim()
    if (thread && title.trim() && title.trim() !== thread.title) updateThread(thread.id, { title }).then((t) => (setThread(t), onChanged()), () => {})
  }

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
    } else if (msg?.role === 'user')
      items.push(
        { label: 'Copy message', onSelect: () => copy(msg.content) },
        { label: 'Use as a new message', disabled: answering, onSelect: () => (setText(msg.content), input.current?.focus()) },
        { separator: true },
      )
    else if (msg?.role === 'assistant')
      items.push(
        { label: 'Copy answer', onSelect: () => copy(msg.content) },
        { label: selectionIn(e.currentTarget) ? 'Quote the whole answer' : 'Quote in reply', onSelect: () => quote(msg.content) },
        ...(msg.thinking ? [{ label: 'Copy thoughts', onSelect: () => copy(msg.thinking!) }] : []),
        { separator: true },
      )
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
        { label: 'Attach from Files (Seafile)…', disabled: !account.seafile, onSelect: () => void pickFiles({ title: 'Attach files' }).then((p) => void (p?.length && fromSeafile(p))) },
        { label: 'Attach from this computer…', onSelect: () => pcFiles.current?.click() },
        { separator: true },
        { label: 'Quick', checked: mode === 'quick', disabled: answering, onSelect: () => setMode('quick') },
        { label: 'Deep research', checked: mode === 'deep', disabled: answering, onSelect: () => setMode('deep') },
        { separator: true },
        answering ? { label: 'Stop', onSelect: stop } : { label: 'Send', shortcut: 'Enter', disabled: (!text.trim() && !files.length) || reading > 0, onSelect: () => void send() },
      ]),
    )
  }

  // The message box grows with what is typed, up to a point, and shrinks again once sent.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  const answering = busy || !!thread?.running
  const projectName = projects.find((p) => p.id === (thread ? thread.projectId : draftProject))?.name ?? null
  const modelOptions = models.length ? models : model ? [{ name: model, thinking: false, vision: false, contextLength: null }] : []
  const tools = thread?.tools ?? draftTools
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
      ...TOOL_GROUPS.map((g) => ({
        label: g.name,
        hint: g.detail,
        checked: tools.includes(g.id),
        disabled: g.seafile && !account.seafile,
        onSelect: () => toggleTool(g.id),
      })),
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
  const fromSeafile = (paths: string[]) =>
    addFiles(() =>
      paths.map(async (p) => {
        const at = parseSf(p)!
        const name = at.p.split('/').pop() || 'file'
        const res = await fetch(await seafileLink(p, 'download'))
        if (!res.ok) throw new Error(`${name}: Seafile answered ${res.status}`)
        return toAttachment(await res.blob(), name, `Seafile: ${libraryName(at.repo)} ${at.p}`)
      }),
    )
  const fromComputer = (list: FileList | File[]) => addFiles(() => [...list].map((f) => toAttachment(f, f.name, 'This computer')))
  const attachMenu = (e: React.MouseEvent) =>
    openMenuAt(e.currentTarget, [
      { label: 'From Files (Seafile)…', disabled: !account.seafile, onSelect: () => void pickFiles({ title: 'Attach files' }).then((p) => void (p?.length && fromSeafile(p))) },
      { label: 'From this computer…', onSelect: () => pcFiles.current?.click() },
    ], 'above')

  return (
    <>
      <div className="nb-toolbar agt-toolbar" onContextMenu={(e) => thread && !e.shiftKey && !isField(e.target as Element) && openContextMenu(e, tidyMenu(threadItems()))}>
        <button className="btn btn-small agt-back" onClick={onBack} aria-label="Back to threads">
          ‹
        </button>
        {projectName && <span className="agt-crumb" title={`In the project ${projectName}`}>{projectName}</span>}
        {thread && renaming ? (
          <RenameBox thread={thread} onSave={rename} onCancel={() => setRenaming(false)} />
        ) : (
          <button className="agt-title" onDoubleClick={() => thread && setRenaming(true)} title={thread ? 'Double-click to rename' : undefined}>
            {thread ? <Scramble text={thread.title} pending={titlePending(thread) || (busy && thread.title === NEW_TITLE)} /> : 'New thread'}
          </button>
        )}
        <span className="nb-spacer" />
        {thread && (
          <button
            className="agt-icon"
            aria-label="More"
            onClick={(e) =>
              openContextMenu(e, [
                { label: 'Rename…', onSelect: () => setRenaming(true) },
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

      <div
        className="agt-scroll"
        ref={scroller}
        onContextMenu={convMenu}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {!messages.length && !live && (
          <div className="agt-empty">
            <p className="agt-empty-title">{mode === 'deep' ? 'What should it research?' : 'What do you want to know?'}</p>
            <p className="muted">{MODE_HELP[mode]}</p>
            <p className="muted agt-empty-tools">Tools on: {tools.length ? TOOL_GROUPS.filter((g) => tools.includes(g.id)).map((g) => g.name).join(', ') : 'none, just the model'}.</p>
          </div>
        )}
        <Messages messages={messages} answering={answering} approvals={approvals} onDecide={decide} onAnswer={respond} />
        {live && <LiveReply live={live} />}
        {error && <p className="agt-error t-red">{error}</p>}
      </div>

      {!!thread?.todos.length && <TodoChip todos={thread.todos} running={answering} />}
      {thread && ctxOpen && <ContextPanel id={thread.id} version={messages.length} />}
      <form
        className={`agt-composer ${dragOver ? 'is-drop' : ''}`}
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].some((t) => t === 'Files' || t === DRAG_FILES)) {
            e.preventDefault()
            setDragOver(true)
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false)
          const dragged = e.dataTransfer.types.includes(DRAG_FILES) ? getDragged() : null
          if (!dragged?.length && !e.dataTransfer.files.length) return
          e.preventDefault()
          if (dragged?.length) void fromSeafile(dragged)
          else void fromComputer(e.dataTransfer.files)
        }}
      >
        <div className="agt-box" onClick={(e) => e.target === e.currentTarget && input.current?.focus()}>
          {(files.length > 0 || reading > 0) && (
            <ul className="agt-files">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} title={f.source}>
                  <span aria-hidden>{f.kind === 'image' ? '🖼' : '📄'}</span> {f.name} <span className="muted">{fileSize(f.size)}</span>
                  <button type="button" onClick={() => setFiles((list) => list.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                    ×
                  </button>
                </li>
              ))}
              {reading > 0 && <li className="muted">Reading {reading}…</li>}
            </ul>
          )}
          <textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault()
                void fromComputer(e.clipboardData.files)
              }
            }}
            onContextMenu={composerMenu}
            placeholder={mode === 'deep' ? 'What should it research?' : 'Ask anything'}
            rows={1}
            aria-label="Message"
          />
          <div className="agt-box-bar">
            <button type="button" className="agt-icon" onClick={attachMenu} aria-label="Attach files" title="Attach files">
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
            {thread && <ContextMeter thread={thread} models={models} open={ctxOpen} onToggle={() => setCtxOpen((o) => !o)} />}
            {answering ? (
              <button type="button" className="agt-send is-stop" onClick={stop} aria-label="Stop" title="Stop">
                <Icon name="stop" size={14} />
              </button>
            ) : (
              <button className="agt-send" disabled={(!text.trim() && !files.length) || reading > 0} aria-label="Send" title="Send (Enter; Shift+Enter for a new line)">
                <Icon name="send" size={16} />
              </button>
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
function Messages({ messages, answering, approvals, onDecide, onAnswer }: { messages: AgentMessage[]; answering: boolean; approvals: PendingApproval[]; onDecide: (callId: string, allow: boolean) => void; onAnswer: (callId: string, answers: Record<string, unknown> | null) => void }) {
  const out: ReactNode[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user') {
      out.push(
        <div key={m.id} className="agt-user" data-msg={m.id}>
          {m.content}
          {!!m.attachments?.length && (
            <ul className="agt-files is-sent">
              {m.attachments.map((f, i) => (
                <li key={i} title={f.source}>
                  <span aria-hidden>{f.kind === 'image' ? '🖼' : '📄'}</span> {f.name}
                </li>
              ))}
            </ul>
          )}
        </div>,
      )
      continue
    }
    if (m.role === 'tool') continue // drawn with the call that asked for it
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
          <article className="zed-preview agt-answer" data-msg={m.id}>
            <MarkdownPreview text={m.content} />
          </article>
        )}
        {calls.map((c, j) => {
          const wait = approvals.find((a) => a.messageId === m.id && a.index === j)
          if (wait?.kind === 'question' && wait.form) return <QuestionForm key={wait.callId} form={wait.form} onAnswer={(answers) => onAnswer(wait.callId, answers)} />
          if (c.name === 'ask_user' && results[j]) return <AnsweredForm key={j} tag={`${m.id}:${j}`} call={c} result={results[j].content} />
          return <ToolCard key={j} tag={`${m.id}:${j}`} call={c} result={results[j]?.content} pending={!results[j] && answering} approval={wait?.kind === 'approval' ? (allow) => onDecide(wait.callId, allow) : undefined} />
        })}
      </Fragment>,
    )
  }
  return <>{out}</>
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
          <MarkdownPreview text={live.content} />
        </article>
      )}
    </>
  )
}

type SearchHit = { title: string; url: string; snippet?: string }

/** One tool call: what it did in a line, and when opened, what it was given and what came back. */
function ToolCard({ tag, call, result, pending, approval }: { tag: string; call: ToolCall; result?: string; pending: boolean; approval?: (allow: boolean) => void }) {
  let parsed: unknown = null
  try {
    parsed = result ? JSON.parse(result) : null
  } catch {
    parsed = result
  }
  const failed = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed
  const hits = call.name === 'web_search' && Array.isArray(parsed) ? (parsed as SearchHit[]) : null
  if (approval)
    return (
      <div className="agt-tool is-asking" role="group" aria-label="Allow this change?" data-tool={tag}>
        <p className="agt-ask-title">
          <span className="agt-tool-icon" aria-hidden>
            ?
          </span>
          <span className="agt-tool-label">{toolLabel(call)}</span>
        </p>
        {call.name === 'seafile_write' && typeof call.arguments.content === 'string' && <pre className="agt-tool-body">{call.arguments.content.slice(0, 4000)}</pre>}
        <div className="agt-ask-actions">
          <button className="btn btn-small btn-primary" onClick={() => approval(true)}>
            Allow
          </button>
          <button className="btn btn-small" onClick={() => approval(false)}>
            Decline
          </button>
        </div>
      </div>
    )
  return (
    <details className={`agt-tool ${failed ? 'is-failed' : ''}`} data-tool={tag}>
      <summary>
        <span className="agt-tool-icon" aria-hidden>
          {pending ? '◌' : failed ? '✕' : '✓'}
        </span>
        <span className="agt-tool-label">{toolLabel(call)}</span>
        {hits && <span className="muted"> · {hits.length} results</span>}
        {failed && <span className="t-red"> · {String((parsed as { error: unknown }).error)}</span>}
      </summary>
      {hits ? (
        <ul className="agt-hits">
          {hits.map((h) => (
            <li key={h.url}>
              <a href={h.url} target="_blank" rel="noopener noreferrer">
                {h.title || h.url}
              </a>
              <span className="muted"> {h.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}</span>
            </li>
          ))}
        </ul>
      ) : (
        <pre className="agt-tool-body">{[`${call.name}(${JSON.stringify(call.arguments)})`, result ? (typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)).slice(0, 6000) : pending ? 'Running…' : 'No result (the turn stopped).'].join('\n\n')}</pre>
      )}
    </details>
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
      const steps = (m.toolCalls ?? []).map((c) => `- ${toolLabel(c)}`).join('\n')
      if (m.content.trim() || steps) out.push(`## Agent\n\n${[steps, m.content.trim()].filter(Boolean).join('\n\n')}`)
    }
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
  quick: 'Answers straight away, searching the web or your files only when it needs to, in a few seconds. Up to 4 rounds of tools.',
  deep: 'Researches first: searches from several angles, reads the sources, compares them, then writes a structured answer with citations. Takes a minute or a few; up to 24 rounds of tools.',
}

// --- titles ----------------------------------------------------------------------------------

const NEW_TITLE = 'New thread'
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

/** How full the model's context was after the last reply, as a small ring; opens the breakdown. */
function ContextMeter({ thread, models, open, onToggle }: { thread: Thread; models: ModelInfo[]; open: boolean; onToggle: () => void }) {
  const size = models.find((m) => m.name === thread.model)?.contextLength ?? null
  const used = thread.contextTokens
  const share = used !== null && size ? Math.min(1, used / size) : 0
  const C = 2 * Math.PI * 7
  const label = used !== null ? `${used.toLocaleString()}${size ? ` of ${size.toLocaleString()}` : ''} tokens in context (${share < 0.01 && used ? '<1' : Math.round(share * 100)}%)` : 'Context window'
  return (
    <button type="button" className={`agt-ring ${open ? 'is-on' : ''} ${share > 0.8 ? 'is-full' : ''}`} onClick={onToggle} aria-expanded={open} title={label} aria-label={label}>
      <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden>
        <circle cx="9" cy="9" r="7" className="agt-ring-track" />
        <circle cx="9" cy="9" r="7" className="agt-ring-fill" strokeDasharray={`${Math.max(share, used ? 0.03 : 0) * C} ${C}`} transform="rotate(-90 9 9)" />
      </svg>
    </button>
  )
}

/** What the next message sends the model, part by part, against the window's size. */
function ContextPanel({ id, version }: { id: string; version: number }) {
  const [info, setInfo] = useState<ContextInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    getContext(id).then(setInfo, (e: Error) => setError(e.message))
  }, [id, version])
  if (error) return <div className="agt-ctx-panel t-red">{error}</div>
  if (!info) return <div className="agt-ctx-panel muted">Adding it up…</div>
  const scale = info.contextLength ?? Math.max(info.estimate, info.measured ?? 0)
  return (
    <div className="agt-ctx-panel">
      <p className="agt-ctx-head">
        <strong>Context window</strong>
        <span className="muted">
          {' '}
          · {info.model}
          {info.contextLength ? ` · ${tokenCount(info.contextLength)} tokens` : ''}
        </span>
      </p>
      <div className="agt-ctx-bar" aria-hidden>
        {info.parts.map((p, i) => (
          <span key={p.label} style={{ width: `${(p.tokens / scale) * 100}%`, background: PART_COLORS[i % PART_COLORS.length] }} />
        ))}
      </div>
      <ul className="agt-ctx-parts">
        {info.parts.map((p, i) => (
          <li key={p.label}>
            <span className="agt-ctx-swatch" style={{ background: PART_COLORS[i % PART_COLORS.length] }} />
            <span>{p.label}</span>
            <span className="muted">≈ {tokenCount(p.tokens)}</span>
          </li>
        ))}
      </ul>
      <p className="muted agt-ctx-note">
        {info.measured !== null ? `Ollama counted ${info.measured.toLocaleString()} tokens after the last reply. ` : ''}
        The parts are estimates (about 4 characters a token) of what the next message sends: ≈ {tokenCount(info.estimate)} in all. Older tool results go in shortened.
      </p>
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
  try {
    const r = JSON.parse(result) as { summary?: string; skipped?: boolean; error?: string }
    summary = r.summary ?? ''
    skipped = !!r.skipped
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
        <span className="muted"> · {error || (skipped ? 'not answered' : 'answered')}</span>
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
