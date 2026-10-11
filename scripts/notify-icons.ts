// Draws the brand icons notifications carry (server/notifier.ts, pwa/sw.js) into
// public/icons/notify/: `node scripts/notify-icons.ts` (needs rsvg-convert, from librsvg).
//
// For each brand:
// - <brand>.svg / <brand>.png: the icon, 192 px, a logo on a rounded tile. Android, Windows,
//   Linux and Chrome on macOS show it next to the message; Safari and iOS always show the app icon.
// - <brand>-badge.png: 96 px, white on transparent. Android shows it in the status bar, as a mask.
//
// GitHub and Forgejo are their published marks (via simple-icons, CC0, and Forgejo's branding
// repository); the Minecraft grass block is drawn here as pixel art.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(import.meta.dirname, '..', 'public', 'icons', 'notify')

const GITHUB_MARK =
  'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'

/** Forgejo's logo (212 × 212): two arcs and three rings, orange and red. */
const forgejo = (orange: string, red: string) => `
  <g transform="translate(6 6)" fill="none" stroke-width="25">
    <path d="M58 168V70a50 50 0 0 1 50-50h20" stroke="${orange}"/>
    <path d="M58 168v-30a50 50 0 0 1 50-50h20" stroke="${red}"/>
    <circle cx="142" cy="20" r="18" stroke="${orange}"/>
    <circle cx="142" cy="88" r="18" stroke="${red}"/>
    <circle cx="58" cy="180" r="18" stroke="${red}"/>
  </g>`

// --- the grass block -----------------------------------------------------------------------------

/** A fixed pseudo-random sequence, so every run draws the same pixels. */
let seed = 7
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const pick = (colors: string[]) => colors[Math.floor(rand() * colors.length)]

const GRASS = ['#5d9b3a', '#6aab42', '#4f8a31', '#73b84a', '#58933a']
const DIRT = ['#8b5a33', '#7a4e2c', '#96643b', '#6b4426', '#86593a']
const N = 8 // pixels per edge

/** One face, N × N pixels in its own unit square; `fringe`: how many grass pixels hang down each column. */
function face(fringe?: number[]) {
  let rects = ''
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const color = !fringe || y < fringe[x] ? pick(GRASS) : pick(DIRT)
      rects += `<rect x="${x}" y="${y}" width="1.04" height="1.04" fill="${color}"/>`
    }
  return rects
}

// An isometric cube in a 192 box: the top's corners at (96,30) (153,63) (96,96) (39,63), sides 66 deep.
const fringe = () => Array.from({ length: N }, () => 1 + Math.floor(rand() * 3))
const grassBlock = () => `
  <g shape-rendering="crispEdges">
    <g transform="matrix(7.125 4.125 -7.125 4.125 96 30)">${face(Array(N).fill(N))}</g>
    <g transform="matrix(7.125 4.125 0 8.25 39 63)">${face(fringe())}<rect width="${N}" height="${N}" fill="#000" opacity=".2"/></g>
    <g transform="matrix(7.125 -4.125 0 8.25 96 96)">${face(fringe())}<rect width="${N}" height="${N}" fill="#000" opacity=".38"/></g>
  </g>`

// --- the files -----------------------------------------------------------------------------------

const svg = (size: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>\n`
const tile = (bg: string) => `<rect width="192" height="192" rx="40" fill="${bg}"/>`

const BRANDS: Record<string, { icon: string; badge: string }> = {
  github: {
    icon: svg(192, `${tile('#24292f')}<path transform="translate(42 42) scale(4.5)" fill="#fff" d="${GITHUB_MARK}"/>`),
    badge: svg(96, `<path transform="translate(12 12) scale(3)" fill="#fff" d="${GITHUB_MARK}"/>`),
  },
  forgejo: {
    icon: svg(192, `${tile('#1d2125')}<g transform="translate(43 43) scale(.5)">${forgejo('#ff6600', '#d40000')}</g>`),
    badge: svg(96, `<g transform="translate(4 4) scale(.415)">${forgejo('#fff', '#fff')}</g>`),
  },
  minecraft: {
    icon: svg(192, `${tile('#7cb8ef')}<g transform="translate(9.6 12) scale(.9)">${grassBlock()}</g>`),
    // The cube's three faces, apart by a hair so the edges read in white.
    badge: svg(
      96,
      `<g fill="#fff" transform="translate(0 2) scale(.5)">
        <path d="M96 26L157 61L96 96L35 61Z"/>
        <path d="M33 68L92 102V170L33 136Z"/>
        <path d="M100 102L159 68V136L100 170Z"/>
      </g>`,
    ),
  },
}

mkdirSync(OUT, { recursive: true })
for (const [name, { icon, badge }] of Object.entries(BRANDS)) {
  writeFileSync(join(OUT, `${name}.svg`), icon)
  execFileSync('rsvg-convert', ['-w', '192', '-h', '192', '-o', join(OUT, `${name}.png`), join(OUT, `${name}.svg`)])
  execFileSync('rsvg-convert', ['-w', '96', '-h', '96', '-o', join(OUT, `${name}-badge.png`)], { input: badge })
  console.log(`${name}: icon and badge`)
}
