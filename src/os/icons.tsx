import type { ReactElement } from 'react'
import type { AppId } from './wm'

// Dock icons: a tinted tile with a simple line glyph, drawn at 48x48.
const tiles: Record<AppId, { bg: string; fg: string; glyph: ReactElement }> = {
  terminal: {
    bg: 'linear-gradient(160deg,#2a2f3d,#11141b)',
    fg: '#9ece6a',
    glyph: (
      <>
        <path d="M13 17l7 7-7 7" />
        <path d="M24 32h11" />
      </>
    ),
  },
  notes: {
    bg: 'linear-gradient(160deg,#ffe58a,#f6c453)',
    fg: '#6b4e00',
    glyph: (
      <>
        <path d="M14 15h20M14 22h20M14 29h13" />
        <path d="M31 33l3-3" />
      </>
    ),
  },
  keys: {
    bg: 'linear-gradient(160deg,#d6ecff,#9fcaf5)',
    fg: '#163a5f',
    glyph: (
      <>
        <rect x="9" y="15" width="30" height="19" rx="3" />
        <path d="M14 21h2M20 21h2M26 21h2M32 21h2M16 28h16" />
      </>
    ),
  },
  files: {
    bg: 'linear-gradient(160deg,#7aa2f7,#3d5bd1)',
    fg: '#fff',
    glyph: <path d="M11 16a2 2 0 0 1 2-2h7l3 3h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H13a2 2 0 0 1-2-2z" />,
  },
  projects: {
    bg: 'linear-gradient(160deg,#ffb86b,#e0782f)',
    fg: '#fff',
    glyph: (
      <>
        <path d="M24 11l13 7-13 7-13-7z" />
        <path d="M11 24l13 7 13-7" />
        <path d="M11 30l13 7 13-7" />
      </>
    ),
  },
  preview: {
    bg: 'linear-gradient(160deg,#7aa2f7,#3d59a1)',
    fg: '#fff',
    glyph: (
      <>
        <rect x="10" y="12" width="28" height="24" rx="3" />
        <path d="M10 31l8-8 6 6 4-4 10 9" />
        <circle cx="31" cy="19" r="2.5" />
      </>
    ),
  },
  player: {
    bg: 'linear-gradient(160deg,#3b3f52,#16171f)',
    fg: '#e0af68',
    glyph: (
      <>
        <circle cx="24" cy="24" r="13" />
        <path d="M21 18l9 6-9 6z" fill="currentColor" />
      </>
    ),
  },
  archive: {
    bg: 'linear-gradient(160deg,#e0af68,#9a6b1f)',
    fg: '#fff',
    glyph: (
      <>
        <rect x="11" y="14" width="26" height="22" rx="2" />
        <path d="M11 20h26M24 14v6M22 25h4M22 29h4" />
      </>
    ),
  },
  office: {
    bg: 'linear-gradient(160deg,#7aa2f7,#2f4a8a)',
    fg: '#fff',
    glyph: (
      <>
        <path d="M14 9h14l7 7v23H14z" />
        <path d="M28 9v7h7M19 22h11M19 27h11M19 32h7" />
      </>
    ),
  },
  newdoc: {
    bg: 'linear-gradient(160deg,#4a8cf7,#1f4fb8)',
    fg: '#fff',
    glyph: (
      <>
        <path d="M13 9h15l7 7v23H13z" />
        <path d="M17 21l3 11 3-8 3 8 3-11" />
      </>
    ),
  },
  newsheet: {
    bg: 'linear-gradient(160deg,#3fb27f,#1d6d4a)',
    fg: '#fff',
    glyph: (
      <>
        <path d="M13 9h15l7 7v23H13z" />
        <path d="M17 21h14v12H17zM17 27h14M24 21v12" />
      </>
    ),
  },
  newslides: {
    bg: 'linear-gradient(160deg,#f2994a,#c0571a)',
    fg: '#fff',
    glyph: (
      <>
        <path d="M13 9h15l7 7v23H13z" />
        <path d="M17 20h14v10H17zM24 30v4M21 34h6" />
      </>
    ),
  },
  pdf: {
    bg: 'linear-gradient(160deg,#f7768e,#b3364f)',
    fg: '#fff',
    glyph: (
      <>
        <path d="M14 9h14l7 7v23H14z" />
        <path d="M28 9v7h7M19 25h11M19 30h11M19 20h5" />
      </>
    ),
  },
  viewer: {
    bg: 'linear-gradient(160deg,#4fd1c5,#2c8f86)',
    fg: '#fff',
    glyph: (
      <>
        <rect x="11" y="13" width="26" height="22" rx="2" />
        <path d="M11 31l8-7 6 5 4-3 8 6" />
        <circle cx="30" cy="20" r="2" />
      </>
    ),
  },
  recents: {
    bg: 'linear-gradient(160deg,#ff8f6b,#e2483d)',
    fg: '#fff',
    glyph: (
      <>
        <path d="M10 26h6l3-8 5 15 4-11 2 4h8" />
      </>
    ),
  },
  cv: {
    bg: 'linear-gradient(160deg,#f2f2f2,#cfd3dc)',
    fg: '#2b3040',
    glyph: (
      <>
        <rect x="14" y="10" width="20" height="28" rx="2" />
        <circle cx="24" cy="19" r="3.5" />
        <path d="M18 28.5c1.5-2.5 3.5-3.5 6-3.5s4.5 1 6 3.5M18 33h12" />
      </>
    ),
  },
  contact: {
    bg: 'linear-gradient(160deg,#bb9af7,#7c5ad6)',
    fg: '#fff',
    glyph: (
      <>
        <rect x="10" y="15" width="28" height="19" rx="2.5" />
        <path d="M11 17l13 9 13-9" />
      </>
    ),
  },
  games: {
    bg: 'linear-gradient(160deg,#4fd1a5,#1f8a6b)',
    fg: '#fff',
    glyph: (
      <>
        <path d="M15 17h18a6 6 0 0 1 6 6v3a6 6 0 0 1-10.6 3.9L26 27h-4l-2.4 2.9A6 6 0 0 1 9 26v-3a6 6 0 0 1 6-6z" />
        <path d="M16 21v6M13 24h6" />
        <circle cx="31" cy="22.5" r="0.8" fill="currentColor" />
        <circle cx="34" cy="25.5" r="0.8" fill="currentColor" />
      </>
    ),
  },
  mcserver: {
    bg: 'linear-gradient(160deg,#5d9b3a,#3b6b25)',
    fg: '#fff',
    glyph: (
      <>
        <path d="M22 10Q36 12 38 26" />
        <path d="M30 18L12 36" />
      </>
    ),
  },
  linkforge: {
    bg: 'linear-gradient(160deg,#f5a65b,#d9622b)',
    fg: '#fff',
    glyph: (
      <>
        <circle cx="16" cy="13" r="3" />
        <circle cx="16" cy="35" r="3" />
        <circle cx="32" cy="18" r="3" />
        <path d="M16 16v16M32 21c0 7-9 6-16 11" />
      </>
    ),
  },
  zed: {
    bg: 'linear-gradient(160deg,#3b4a6b,#151a26)',
    fg: '#8fb4ff',
    glyph: (
      <>
        <path d="M13 13h22L13 35h22" />
        <path d="M19 24h10" />
      </>
    ),
  },
  notebook: {
    bg: 'linear-gradient(160deg,#ffd27a,#e89a3c)',
    fg: '#4a2603',
    glyph: (
      <>
        <rect x="13" y="10" width="23" height="28" rx="2" />
        <path d="M13 16h-3M13 24h-3M13 32h-3M19 17h11M19 23h11M19 29h7" />
      </>
    ),
  },
  widget: {
    bg: 'linear-gradient(160deg,#fff1a8,#fde27a)',
    fg: '#6b4e00',
    glyph: (
      <>
        <path d="M12 12h24v16l-8 8H12z" />
        <path d="M28 36v-8h8" />
      </>
    ),
  },
  agents: {
    bg: 'linear-gradient(160deg,#9d7cd8,#4b3a8c)',
    fg: '#f4efff',
    glyph: (
      <>
        <path d="M24 9l2.6 7.4L34 19l-7.4 2.6L24 29l-2.6-7.4L14 19l7.4-2.6z" />
        <path d="M34 29l1.3 3.7L39 34l-3.7 1.3L34 39l-1.3-3.7L29 34l3.7-1.3zM13 31l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z" />
      </>
    ),
  },
  calendar: {
    bg: 'linear-gradient(180deg,#f7768e 0 30%,#fbfbf8 30% 100%)',
    fg: '#2a2f3d',
    glyph: (
      <>
        <rect x="11" y="12" width="26" height="25" rx="2" />
        <path d="M17 9v6M31 9v6M11 19h26M17 25h3M23 25h3M29 25h2M17 31h3M23 31h3" />
      </>
    ),
  },
  settings: {
    bg: 'linear-gradient(160deg,#9aa5b8,#5a6478)',
    fg: '#fff',
    glyph: (
      <>
        <circle cx="24" cy="24" r="5" />
        <path d="M24 10v5M24 33v5M10 24h5M33 24h5M14 14l3.5 3.5M30.5 30.5L34 34M14 34l3.5-3.5M30.5 17.5L34 14" />
      </>
    ),
  },
  trash: {
    bg: 'linear-gradient(160deg,#3a3f4f,#1d2029)',
    fg: '#c0c6d6',
    glyph: (
      <>
        <path d="M14 17h20M20 17v-3h8v3M16 17l1.5 18h13L32 17" />
        <path d="M22 22v9M26 22v9" />
      </>
    ),
  },
}

// The dock's Omarchy look: the same glyphs, flat and square, in the active theme's own palette.
const HUES: Record<AppId, string> = {
  terminal: 'var(--green)',
  notes: 'var(--yellow)',
  keys: 'var(--blue)',
  files: 'var(--blue)',
  projects: 'var(--orange)',
  viewer: 'var(--cyan)',
  preview: 'var(--blue)',
  pdf: 'var(--red)',
  office: 'var(--blue)',
  archive: 'var(--yellow)',
  newdoc: 'var(--blue)',
  newsheet: 'var(--green)',
  newslides: 'var(--orange)',
  player: 'var(--orange)',
  recents: 'var(--red)',
  cv: 'var(--text)',
  contact: 'var(--magenta)',
  games: 'var(--cyan)',
  mcserver: 'var(--green)',
  linkforge: 'var(--orange)',
  zed: 'var(--blue)',
  notebook: 'var(--orange)',
  widget: 'var(--yellow)',
  calendar: 'var(--red)',
  agents: 'var(--magenta)',
  settings: 'var(--text)',
  trash: 'var(--muted)',
}

/** An app's icon: a tinted tile, or with `tone`, a flat square in the theme's colours. */
export function AppIcon({ app, size = 48, tone = false }: { app: AppId; size?: number; tone?: boolean }) {
  const t = tiles[app]
  const fg = tone ? HUES[app] : t.fg
  return (
    <span
      className={`app-icon ${tone ? 'is-tone' : ''}`}
      style={{ width: size, height: size, ...(tone ? { ['--hue' as string]: fg, color: fg } : { background: t.bg, color: fg }) }}
    >
      <svg viewBox="0 0 48 48" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={tone ? 2.4 : 2.6} strokeLinecap={tone ? 'square' : 'round'} strokeLinejoin={tone ? 'miter' : 'round'} aria-hidden>
        {t.glyph}
      </svg>
    </span>
  )
}
