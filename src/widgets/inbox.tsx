import type { CSSProperties } from 'react'
import type { MenuItem } from '../os/ContextMenu'
import { openLink } from '../data/links'
import { createWithTilt, setWidgetConfig, tiltMenu, useWidgetConfig } from './config'
import type { WidgetDef } from './types'
import { PackageHost } from './platform/Host'

// The Code inbox widget: pull requests waiting for your review, your own open pull requests and
// issues assigned to you, on GitHub and every linked Gitea/Forgejo instance (server/inbox.ts).

type Section = 'review' | 'mine' | 'assigned'
type Config = { tilt: number; hidden: Section[] }
const DEFAULTS: Config = { tilt: 0, hidden: [] }

const SECTIONS: [Section, string, string][] = [
  ['review', 'Waiting for your review', 'Nobody is waiting on you'],
  ['mine', 'Your pull requests', 'No open pull requests'],
  ['assigned', 'Assigned to you', 'Nothing assigned'],
]

function useInboxFrame(id: string): CSSProperties {
  const { tilt } = useWidgetConfig<Config>(id, DEFAULTS)
  return { ['--widget-bg' as string]: 'var(--panel)', ['--widget-fg' as string]: 'var(--fg)', ['--widget-tilt' as string]: `${tilt}deg` }
}

function useInboxMenu(id: string): MenuItem[] {
  const config = useWidgetConfig<Config>(id, DEFAULTS)
  return [
    {
      label: 'Show',
      submenu: SECTIONS.map(([key, title]) => ({
        label: title,
        checked: !config.hidden.includes(key),
        onSelect: () => setWidgetConfig(id, { hidden: config.hidden.includes(key) ? config.hidden.filter((k) => k !== key) : [...config.hidden, key] }),
      })),
    },
    { label: 'Open GitHub notifications ↗', onSelect: () => openLink('https://github.com/notifications') },
    tiltMenu(id, config.tilt),
  ]
}

export const inboxWidget: WidgetDef = {
  kind: 'inbox',
  name: 'Code inbox',
  blurb: 'Reviews waiting for you, your pull requests and assigned issues',
  glyph: '📬',
  size: [320, 340],
  resizable: true,
  Component: PackageHost,
  useFrame: useInboxFrame,
  useMenu: useInboxMenu,
  create: createWithTilt,
}
