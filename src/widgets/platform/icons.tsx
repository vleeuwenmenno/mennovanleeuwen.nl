import type { ReactNode } from 'react'
import type { IconName } from './package'

// The closed glyph set for the descriptor `icon` node and the widget chrome. Outline shapes drawn
// with currentColor, so every theme, accent and tone applies. Paths follow the Lucide icon set
// (ISC licence, https://lucide.dev), redrawn here on a 24-unit grid with a 2-unit stroke.
const CLOUD = 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242'
const path = (d: string) => <path d={d} />

const SHAPES: Record<IconName, ReactNode> = {
  sun: <><circle cx="12" cy="12" r="4" />{path('M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41')}</>,
  moon: path('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'),
  'cloud-sun': path('M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41M15.947 12.65a4 4 0 0 0-5.925-4.128M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z'),
  'cloud-moon': path('M10.188 8.5A6 6 0 0 1 16 4a1 1 0 0 0 6 6 6 6 0 0 1-3 5.197M13 16a3 3 0 1 1 0 6H7a5 5 0 1 1 4.9-6Z'),
  cloud: path('M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z'),
  fog: path(`${CLOUD}M16 17H7M17 21H9`),
  drizzle: path(`${CLOUD}M8 19v1M8 14v1M16 19v1M16 14v1M12 21v1M12 16v1`),
  rain: path(`${CLOUD}M16 14v6M8 14v6M12 16v6`),
  snow: path(`${CLOUD}M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01`),
  storm: path('M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973M13 12l-3 5h4l-3 5'),
  sunrise: path('M12 2v8M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M8 6l4-4 4 4M16 18a4 4 0 0 0-8 0'),
  sunset: path('M12 10V2M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M16 6l-4 4-4-4M16 18a4 4 0 0 0-8 0'),
  wind: path('M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2M9.6 4.6A2 2 0 1 1 11 8H2M12.6 19.4A2 2 0 1 0 14 16H2'),
  droplet: path('M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z'),
  thermometer: path('M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z'),
  pr: <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />{path('M13 6h3a2 2 0 0 1 2 2v7M6 9v12')}</>,
  draft: <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />{path('M18 6V5M18 11v-1M6 9v12')}</>,
  issue: <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="1" /></>,
  check: <><circle cx="12" cy="12" r="10" />{path('m9 12 2 2 4-4')}</>,
  alert: path('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01'),
  down: <><circle cx="12" cy="12" r="10" />{path('m15 9-6 6M9 9l6 6')}</>,
  pause: <><circle cx="12" cy="12" r="10" />{path('M10 15V9M14 15V9')}</>,
  calendar: <><rect width="18" height="18" x="3" y="4" rx="2" />{path('M8 2v4M16 2v4M3 10h18')}</>,
  clock: <><circle cx="12" cy="12" r="10" />{path('M12 6v6l4 2')}</>,
  video: <><rect width="14" height="12" x="2" y="6" rx="2" />{path('m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5')}</>,
  note: path('M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8'),
  external: path('M7 7h10v10M7 17 17 7'),
  server: <><rect width="20" height="8" x="2" y="2" rx="2" /><rect width="20" height="8" x="2" y="14" rx="2" />{path('M6 6h.01M6 18h.01')}</>,
  users: <><circle cx="9" cy="7" r="4" />{path('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75')}</>,
  heart: path('M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z'),
  bell: path('M10.268 21a2 2 0 0 0 3.464 0M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'),
  zap: path('M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'),
  shield: path('M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'),
  cube: path('M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16ZM3.3 7 12 12l8.7-5M12 22V12'),
  copy: <><rect width="14" height="14" x="8" y="8" rx="2" />{path('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2')}</>,
  refresh: path('M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5'),
  code: path('m16 18 6-6-6-6M8 6l-6 6 6 6'),
  book: path('M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20'),
  pin: <>{path('M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z')}<circle cx="12" cy="10" r="3" /></>,
  square: <rect width="18" height="18" x="3" y="3" rx="2" />,
  'square-check': <><rect width="18" height="18" x="3" y="3" rx="2" />{path('m9 12 2 2 4-4')}</>,
  'chevron-left': path('m15 18-6-6 6-6'),
  'chevron-right': path('m9 18 6-6-6-6'),
}

/** A glyph from the closed set. Decorative: it carries no text, so the surrounding text or label names it. */
export function Icon({ name, className = 'wp-icon', title, size, span }: { name: IconName; className?: string; title?: string; size?: string; span?: string | number }) {
  return <svg className={className} data-size={size} data-span={span} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} aria-label={title} focusable="false">{SHAPES[name]}</svg>
}

/** The icon for a WMO weather code (as used by Open-Meteo), day or night. */
export function weatherIcon(code: number, day: boolean): IconName {
  if (code === 0 || code === 1) return day ? 'sun' : 'moon'
  if (code === 2) return day ? 'cloud-sun' : 'cloud-moon'
  if (code === 3) return 'cloud'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 57) return 'drizzle'
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain'
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow'
  if (code >= 95) return 'storm'
  return 'cloud'
}
