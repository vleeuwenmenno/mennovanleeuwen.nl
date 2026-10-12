import type { ReactNode } from 'react'
import { CalendarApp } from '../apps/calendar/Calendar'
import { ContactsApp } from '../apps/contacts/Contacts'
import { Contact } from '../apps/Contact'
import { Cv } from '../apps/Cv'
import { gameLinkItems, Games } from '../apps/games/Games'
import { gameInfo } from '../apps/games/catalog'
import { KeysNote } from '../apps/KeysNote'
import { Notebook } from '../apps/Notebook'
import { Notes } from '../apps/Notes'
import { LinkForge } from '../apps/LinkForge'
import { McServer } from '../apps/McServer'
import { Projects } from '../apps/Projects'
import { Settings } from '../apps/Settings'
import { WidgetHost } from '../widgets/registry'
import { Recents } from '../apps/Recents'
import { Terminal, terminalMenu, terminalTitle } from '../apps/Terminal'
import { Files } from '../apps/Files'
import { Viewer } from '../apps/Viewer'
import { Preview, previewTitle } from '../apps/Preview'
import { Player, playerTitle } from '../apps/Player'
import { Amp, ampTitle } from '../apps/Amp'
import { PdfViewer, pdfTitle } from '../apps/PdfViewer'
import { Office, officeTitle } from '../apps/Office'
import { Archive, archiveTitle } from '../apps/Archive'
import { Zed } from '../apps/Zed'
import { Agents } from '../apps/Agents'
import { TasksApp } from '../apps/tasks/Tasks'
import type { MenuItem } from './ContextMenu'
import { HANDLE } from './identity'
import type { AppId, useWM, WinState } from './wm'

export type AppMeta = {
  title: string
  dock: string
  /** One line for the launcher and Spotlight */
  blurb: string
  size: [number, number]
  chrome?: 'note'
  /** The window's own title, when it shows one file (its name), or a program set one (undefined: the usual) */
  titleOf?: (w: WinState) => string | undefined
  /** A size for a window opened with these props, when it differs from `size` (a game's window) */
  sizeOf?: (props: WinState['props']) => [number, number] | undefined
  render: (w: WinState) => ReactNode
  /** The app's own items at the top of its window menu */
  menu?: (w: WinState, wm: ReturnType<typeof useWM>) => MenuItem[]
}

/**
 * "<App> settings…" at the top of an app's window menu: its pane in Settings → Apps. `sub` picks
 * a part of the pane (a game's section); without one for this window, there is no item.
 */
const settingsMenu =
  (label: string | ((w: WinState) => string), section: string, sub?: (w: WinState) => string | null) =>
  (w: WinState, wm: ReturnType<typeof useWM>): MenuItem[] => {
    const part = sub?.(w)
    if (part === null) return []
    return [{ label: `${typeof label === 'string' ? label : label(w)} settings…`, onSelect: () => wm.open('settings', { section, sub: part, t: String(Date.now()) }) }]
  }
/** The games with settings of their own, in Settings → Apps → Games. */
const GAMES_WITH_SETTINGS = new Set(['pool', 'gladiator', 'empires'])
/** A game window's menu: its settings, and its direct link to play it without MvL OS. */
const gamesMenu = (w: WinState, wm: ReturnType<typeof useWM>): MenuItem[] => {
  const settings = settingsMenu((w) => gameInfo(w.props.game)?.name ?? 'Game', 'games', (w) => (w.props.game && GAMES_WITH_SETTINGS.has(w.props.game) ? w.props.game : null))(w, wm)
  const game = gameInfo(w.props.game)
  return game ? [...settings, ...(settings.length ? [{ separator: true as const }] : []), ...gameLinkItems(game.id)] : settings
}

export const APP_META: Record<AppId, AppMeta> = {
  terminal: { title: `${HANDLE}@mvlos: ~`, dock: 'Terminal', blurb: 'A shell that actually works', size: [760, 500], titleOf: terminalTitle, render: (w) => <Terminal win={w} />, menu: terminalMenu },
  files: { title: 'Files', dock: 'Files', blurb: 'Browse the filesystem', size: [940, 600], render: (w) => <Files win={w} />, menu: settingsMenu('Files', 'files') },
  zed: { title: 'Zed', dock: 'Zed', blurb: 'Edit Markdown and text files', size: [960, 620], render: (w) => <Zed win={w} /> },
  preview: { title: 'Preview', dock: 'Preview', blurb: 'Pictures: zoom, rotate, slideshow', size: [900, 620], titleOf: previewTitle, render: (w) => <Preview win={w} />, menu: settingsMenu('Preview', 'preview') },
  player: { title: 'Player', dock: 'Player', blurb: 'Video', size: [800, 484], titleOf: playerTitle, render: (w) => <Player win={w} /> },
  amp: { title: 'Omamp', dock: 'Omamp', blurb: 'Music: MP3, FLAC and more, with an equalizer and a playlist', size: [500, 660], titleOf: ampTitle, render: (w) => <Amp win={w} />, menu: settingsMenu('Omamp', 'amp') },
  pdf: { title: 'PDF', dock: 'PDF', blurb: 'PDFs: pages, search, zoom', size: [860, 680], titleOf: pdfTitle, render: (w) => <PdfViewer win={w} />, menu: settingsMenu('PDF', 'pdf') },
  archive: { title: 'Archive', dock: 'Archive', blurb: 'What is in a ZIP, without unpacking it', size: [820, 560], titleOf: archiveTitle, render: (w) => <Archive win={w} /> },
  office: { title: 'Office', dock: 'Office', blurb: 'Word, Excel and PowerPoint files, in OnlyOffice', size: [1100, 720], titleOf: officeTitle, render: (w) => <Office win={w} /> },
  newdoc: { title: 'New document', dock: 'New Document', blurb: 'A blank Word document in Seafile, to write in', size: [1100, 720], titleOf: officeTitle, render: (w) => <Office win={w} kind="docx" /> },
  newsheet: { title: 'New spreadsheet', dock: 'New Spreadsheet', blurb: 'A blank Excel spreadsheet in Seafile', size: [1100, 720], titleOf: officeTitle, render: (w) => <Office win={w} kind="xlsx" /> },
  newslides: { title: 'New presentation', dock: 'New Presentation', blurb: 'A blank PowerPoint presentation in Seafile', size: [1100, 720], titleOf: officeTitle, render: (w) => <Office win={w} kind="pptx" /> },
  viewer: { title: 'Viewer', dock: 'Viewer', blurb: 'Open text files and images', size: [720, 560], render: (w) => <Viewer win={w} /> },
  notes: { title: 'Sticky note', dock: 'Note', blurb: 'Headlines on a sticky note', size: [310, 340], chrome: 'note', render: () => <Notes /> },
  keys: { title: 'Shortcuts', dock: 'Shortcuts', blurb: 'Every keyboard and mouse shortcut', size: [310, 320], chrome: 'note', render: (w) => <KeysNote win={w} /> },
  projects: { title: 'Projects', dock: 'Projects', blurb: 'Things I built and contribute to', size: [880, 580], render: (w) => <Projects win={w} /> },
  recents: { title: 'Activity', dock: 'Activity', blurb: 'Live activity and contribution graph', size: [780, 680], render: () => <Recents /> },
  cv: { title: 'cv.md — Viewer', dock: 'CV', blurb: 'The printable version of me', size: [760, 680], render: () => <Cv /> },
  contact: { title: 'New message', dock: 'Contact', blurb: 'Get in touch', size: [560, 500], render: () => <Contact /> },
  games: { title: 'Games', dock: 'Games', blurb: 'Tetris, Pac-Man, Snake, Minesweeper, Pool, Gladiator, Empires At War, Breakout', size: [720, 640], titleOf: (w) => gameInfo(w.props.game)?.name ?? 'Games', sizeOf: (p) => gameInfo(p.game)?.size, render: (w) => <Games win={w} />, menu: gamesMenu },
  calendar: { title: 'Calendar', dock: 'Calendar', blurb: 'Your Google and CalDAV calendars: plan, move and invite', size: [1000, 660], render: (w) => <CalendarApp win={w} />, menu: settingsMenu('Calendar', 'calendar') },
  contacts: { title: 'Contacts', dock: 'Contacts', blurb: 'Your people: on this site, Fastmail, iCloud and other CardDAV', size: [920, 620], render: (w) => <ContactsApp win={w} />, menu: settingsMenu('Contacts', 'contacts') },
  tasks: { title: 'Tasks', dock: 'Tasks', blurb: 'Reminders and to-dos: your CalDAV lists, or lists on this site', size: [880, 600], render: (w) => <TasksApp win={w} /> },
  agents: { title: 'Agents', dock: 'Agents', blurb: 'Research assistant: quick answers or deep research, with memory', size: [920, 640], render: (w) => <Agents win={w} /> },
  notebook: { title: 'Notebook', dock: 'Notebook', blurb: 'Your notes, in Markdown, on any device', size: [860, 560], render: (w) => <Notebook win={w} /> },
  // A desktop widget (props.kind, props.id): a sticky note, the weather... See src/widgets.
  widget: { title: 'Widget', dock: 'Widget', blurb: 'Notes, weather and more on the desktop', size: [280, 260], chrome: 'note', render: (w) => <WidgetHost win={w} /> },
  mcserver: { title: 'Minecraft server', dock: 'Minecraft', blurb: 'Who is on, uptime and who played most', size: [760, 660], render: (w) => <McServer win={w} /> },
  // Opened from Settings → Code hosts; not listed anywhere else.
  linkforge: { title: 'Link a code host', dock: 'Link a code host', blurb: 'Link a Gitea or Forgejo instance', size: [520, 470], render: (w) => <LinkForge win={w} /> },
  settings: { title: 'Settings', dock: 'Settings', blurb: 'Appearance, dock, launchers, code hosts, apps and more', size: [860, 620], render: (w) => <Settings win={w} /> },
  // Never rendered: the window manager opens Trash as a view in Files. Kept for the dock icon and name.
  trash: { title: 'Trash', dock: 'Trash', blurb: 'Trashed desktop items, in Files', size: [940, 600], render: () => null },
}

