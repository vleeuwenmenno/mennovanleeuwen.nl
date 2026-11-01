import type { CSSProperties } from 'react'
import { isShown, useCalendarChoice, useCalendarList } from '../data/calendar'
import type { MenuItem } from '../os/ContextMenu'
import { useWM } from '../os/wm'
import { createWithTilt, setWidgetConfig, tiltMenu, useWidgetConfig } from './config'
import type { WidgetDef } from './types'
import { PackageHost } from './platform/Host'

// The Agenda widget: today and the coming days from Google Calendar and CalDAV accounts
// (server/calendars.ts): the calendars switched on in Settings, or its own pick. Signed-in users only: it
// needs the GitHub sign-in with a calendar connected (Settings → Integrations → Calendars). Today also lists the
// tasks due today or overdue (src/data/tasks.ts), from the lists the Calendar shows, to tick off.

type Config = { calendars: string[] | null; days: number; tilt: number }
const DEFAULTS: Config = { calendars: null, days: 3, tilt: 0 }

function useAgendaFrame(id: string): CSSProperties {
  const { tilt } = useWidgetConfig<Config>(id, DEFAULTS)
  return { ['--widget-bg' as string]: 'var(--panel)', ['--widget-fg' as string]: 'var(--fg)', ['--widget-tilt' as string]: `${tilt}deg` }
}

function useAgendaMenu(id: string): MenuItem[] {
  const wm = useWM()
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  const list = useCalendarList().calendars ?? []
  const picks = useCalendarChoice()
  const chosen = config.calendars ?? list.filter((c) => isShown(c, picks)).map((c) => c.id)
  const multiSource = new Set(list.map((c) => c.source)).size > 1
  const toggle = (cid: string) => setWidgetConfig(id, { calendars: chosen.includes(cid) ? chosen.filter((x) => x !== cid) : [...chosen, cid] })
  return [
    { label: 'Show', submenu: ([[1, 'Today'], [3, 'Three days'], [7, 'A week']] as const).map(([days, label]) => ({ label, checked: config.days === days, onSelect: () => setWidgetConfig(id, { days }) })) },
    ...(list.length
      ? [
          {
            label: 'Calendars',
            submenu: [
              ...list.map((c) => ({ label: multiSource ? `${c.name} · ${c.source}` : c.name, swatch: c.color, checked: chosen.includes(c.id), onSelect: () => toggle(c.id) })),
              { separator: true as const },
              { label: 'As in Settings', checked: config.calendars === null, onSelect: () => setWidgetConfig(id, { calendars: null }) },
            ],
          },
        ]
      : []),
    { label: 'Open Calendar', onSelect: () => wm.open('calendar', { t: String(Date.now()) }) },
    tiltMenu(id, config.tilt),
  ]
}

export const agendaWidget: WidgetDef = {
  kind: 'agenda',
  name: 'Agenda',
  blurb: 'Today and the coming days from Google Calendar, Fastmail and other CalDAV',
  glyph: '📅',
  size: [300, 320],
  resizable: true,
  Component: PackageHost,
  useFrame: useAgendaFrame,
  useMenu: useAgendaMenu,
  create: createWithTilt,
}
