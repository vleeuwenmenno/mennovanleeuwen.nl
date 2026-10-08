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
        <circle cx="31" cy="22.5" r="0.8" fill="#fff" />
        <circle cx="34" cy="25.5" r="0.8" fill="#fff" />
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

export function AppIcon({ app, size = 48 }: { app: AppId; size?: number }) {
  const t = tiles[app]
  return (
    <span className="app-icon" style={{ width: size, height: size, background: t.bg }}>
      <svg viewBox="0 0 48 48" width={size} height={size} fill="none" stroke={t.fg} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {t.glyph}
      </svg>
    </span>
  )
}
