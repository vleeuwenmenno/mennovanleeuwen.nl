import type { MenuItem } from '../../os/ContextMenu'
import type { Project, Thread } from '../../data/agents'
import type { ThreadSelection } from './selection'

/** What is being dragged in the sidebar. */
export type Drag = { kind: 'project'; id: number } | { kind: 'thread'; id: string } | null

/** What the app's main pane shows (the sidebar marks Memory, Settings and the Image Studio when they do). */
export type MainKind = 'thread' | 'settings' | 'memory' | 'tasks'

/** What can be done to the selected threads at once (see select.tsx for the bar that offers it). */
export type Bulk = {
  /** An action is under way. */
  busy: boolean
  /** Archive them, or in the archived view move them back to the threads. */
  archive: () => void
  /** Ask, then delete them (a running one is stopped). */
  remove: () => void
  /** Put them in a project, or out of any (null). */
  move: (projectId: number | null) => void
  /** The projects to pick from, for a menu. */
  moveMenu: () => MenuItem[]
  /** The right-click menu of a selected row: acts on the whole selection. */
  menu: () => MenuItem[]
}

/**
 * Everything a sidebar style needs from the app: the threads and projects, what is selected, and
 * every action. The app (Agents.tsx) owns the state; the styles only draw it, so each one can be
 * removed without touching the others.
 */
export type SideCtx = {
  narrow: boolean
  archived: boolean
  q: string
  setQ: (q: string) => void
  /** The search, trimmed and lowercased ('' when there is none). */
  query: string
  listError: string | null
  /** Every thread loaded (the archived ones in the archived view). */
  threads: Thread[]
  /** The threads the search lets through. */
  shown: Thread[]
  projects: Project[]
  inProject: (t: Thread) => boolean
  selected: string | null
  mainKind: MainKind
  /** Whether a thread has an answer that has not been looked at (this browser's memory of it). */
  isUnread: (t: Thread) => boolean

  renaming: string | null
  setRenaming: (id: string | null) => void
  rename: (t: Thread, title: string) => void
  renamingProject: number | null
  setRenamingProject: (id: number | null) => void
  addingProject: boolean
  setAddingProject: (on: boolean) => void
  addProject: (name: string) => void
  renameProject: (p: Project, name: string) => void
  folded: number[]
  toggleFold: (id: number) => void

  drag: Drag
  dropAt: string | null
  dropZone: (key: string, accept: (d: NonNullable<Drag>) => boolean, onDrop: (d: NonNullable<Drag>) => void) => Record<string, unknown>
  dragging: (d: Drag) => Record<string, unknown>
  move: (t: Thread, projectId: number | null) => void
  reorder: (moved: number, before: number) => void

  menu: (t: Thread) => MenuItem[]
  selection: ThreadSelection
  bulk: Bulk
  projectMenu: (p: Project) => MenuItem[]

  open: (id: string | null, project?: number | null) => void
  newThread: () => void
  newProject: () => void
  openStudio: () => void
  /** The Tasks tab: background tasks and their runs */
  openTasks: () => void
  /** Runs going now, and runs waiting for an answer (the Tasks tab's badge) */
  taskBadge: { active: number; waiting: number }
  openMemory: (scope?: number | null) => void
  openSettings: () => void
  toggleArchived: () => void
  leaveArchived: () => void
  /** Fold the sidebar to its rail (not offered in a narrow window). */
  hide: () => void
  /** Unfold it again (from the rail). */
  show: () => void
  /** Unfold it and put the cursor in the search (from the rail). */
  findThreads: () => void
}
