import type { ReactNode } from 'react'
import { CalendarApp } from '../apps/calendar/Calendar'
import { Contact } from '../apps/Contact'
import { Cv } from '../apps/Cv'
import { Games } from '../apps/games/Games'
import { KeysNote } from '../apps/KeysNote'
import { Notebook } from '../apps/Notebook'
import { Notes } from '../apps/Notes'
import { LinkForge } from '../apps/LinkForge'
import { McServer } from '../apps/McServer'
import { Projects } from '../apps/Projects'
import { Settings } from '../apps/Settings'
import { WidgetHost } from '../widgets/registry'
import { Recents } from '../apps/Recents'
import { Terminal } from '../apps/Terminal'
import { Files } from '../apps/Files'
import { Viewer } from '../apps/Viewer'
import { Preview, previewTitle } from '../apps/Preview'
import { Player, playerTitle } from '../apps/Player'
import { PdfViewer, pdfTitle } from '../apps/PdfViewer'
import { Office, officeTitle } from '../apps/Office'
import { Zed } from '../apps/Zed'
import type { AppId, WinState } from './wm'

export type AppMeta = {
  title: string
  dock: string
  /** One line for the launcher and Spotlight */
  blurb: string
  size: [number, number]
  chrome?: 'note'
  /** The window's own title, when it shows one file (its name) */
  titleOf?: (w: WinState) => string
  render: (w: WinState) => ReactNode
}

export const APP_META: Record<AppId, AppMeta> = {
  terminal: { title: 'menno@mvlos: ~', dock: 'Terminal', blurb: 'A shell that actually works', size: [760, 500], render: (w) => <Terminal win={w} /> },
  files: { title: 'Files', dock: 'Files', blurb: 'Browse the filesystem', size: [940, 600], render: (w) => <Files win={w} /> },
  zed: { title: 'Zed', dock: 'Zed', blurb: 'Edit Markdown and text files', size: [960, 620], render: (w) => <Zed win={w} /> },
  preview: { title: 'Preview', dock: 'Preview', blurb: 'Pictures: zoom, rotate, slideshow', size: [900, 620], titleOf: previewTitle, render: (w) => <Preview win={w} /> },
  player: { title: 'Player', dock: 'Player', blurb: 'Video and music', size: [800, 484], titleOf: playerTitle, render: (w) => <Player win={w} /> },
  pdf: { title: 'PDF', dock: 'PDF', blurb: 'PDFs: pages, search, zoom', size: [860, 680], titleOf: pdfTitle, render: (w) => <PdfViewer win={w} /> },
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
  games: { title: 'Games', dock: 'Games', blurb: 'Tetris, Pac-Man, Snake, Minesweeper, Pool, Gladiator, Breakout', size: [720, 640], render: (w) => <Games win={w} /> },
  calendar: { title: 'Calendar', dock: 'Calendar', blurb: 'Your Google and CalDAV calendars: plan, move and invite', size: [1000, 660], render: (w) => <CalendarApp win={w} /> },
  notebook: { title: 'Notebook', dock: 'Notebook', blurb: 'Your notes, in Markdown, on any device', size: [860, 560], render: (w) => <Notebook win={w} /> },
  // A desktop widget (props.kind, props.id): a sticky note, the weather... See src/widgets.
  widget: { title: 'Widget', dock: 'Widget', blurb: 'Notes, weather and more on the desktop', size: [280, 260], chrome: 'note', render: (w) => <WidgetHost win={w} /> },
  mcserver: { title: 'Minecraft server', dock: 'Minecraft', blurb: 'Who is on, uptime and who played most', size: [760, 660], render: (w) => <McServer win={w} /> },
  // Opened from Settings → Code hosts; not listed anywhere else.
  linkforge: { title: 'Link a code host', dock: 'Link a code host', blurb: 'Link a Gitea or Forgejo instance', size: [520, 470], render: (w) => <LinkForge win={w} /> },
  settings: { title: 'Settings', dock: 'Settings', blurb: 'Appearance, dock, launchers, code hosts and more', size: [860, 620], render: (w) => <Settings win={w} /> },
  // Never rendered: the window manager opens Trash as a view in Files. Kept for the dock icon and name.
  trash: { title: 'Trash', dock: 'Trash', blurb: 'Trashed desktop items, in Files', size: [940, 600], render: () => null },
}

