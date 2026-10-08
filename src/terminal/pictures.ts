import { THEMES } from '../os/omarchyThemes'

// Images for ~/Pictures, drawn as SVG so they are real, viewable files without shipping any
// binaries: one wallpaper per Omarchy theme, the logo, and a sketch of this desktop.

function wallpaper(name: string) {
  const p = THEMES[name]
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000">
  <defs>
    <radialGradient id="a" cx="15%" cy="10%" r="60%"><stop offset="0" stop-color="${p.accent}" stop-opacity=".55"/><stop offset="1" stop-color="${p.accent}" stop-opacity="0"/></radialGradient>
    <radialGradient id="b" cx="90%" cy="95%" r="65%"><stop offset="0" stop-color="${p.magenta}" stop-opacity=".45"/><stop offset="1" stop-color="${p.magenta}" stop-opacity="0"/></radialGradient>
    <pattern id="d" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="${p.foreground}" fill-opacity=".12"/></pattern>
  </defs>
  <rect width="1600" height="1000" fill="${p.darkerBackground}"/>
  <rect width="1600" height="1000" fill="url(#a)"/>
  <rect width="1600" height="1000" fill="url(#b)"/>
  <rect width="1600" height="1000" fill="url(#d)"/>
  <text x="1540" y="930" text-anchor="end" font-family="monospace" font-weight="700" font-size="96" fill="${p.foreground}" fill-opacity=".08">menno<tspan fill="${p.accent}" fill-opacity=".3">@</tspan>mvlos</text>
</svg>`
}

const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1a1b26"/><path d="M14 46V18l18 16 18-16v28" fill="none" stroke="#7aa2f7" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`

function desktopSketch(name: string) {
  const p = THEMES[name]
  const win = (x: number, y: number, w: number, h: number, active = false, body = '') =>
    `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${p.background}" stroke="${active ? p.accent : '#595959'}" stroke-width="3"/><rect x="${x}" y="${y}" width="${w}" height="22" fill="${p.darkBackground}"/>${body}</g>`
  const lines = (x: number, y: number, n: number, colors: string[]) =>
    Array.from({ length: n }, (_, i) => `<rect x="${x}" y="${y + i * 16}" width="${120 + ((i * 53) % 160)}" height="7" fill="${colors[i % colors.length]}" fill-opacity=".8"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 750">
  <rect width="1200" height="750" fill="${p.darkerBackground}"/>
  <rect width="1200" height="26" fill="${p.background}"/>
  <text x="600" y="18" text-anchor="middle" font-family="monospace" font-size="13" fill="${p.foreground}">Thu 8 Oct 20:45</text>
  ${win(60, 70, 260, 280, false, `<rect x="60" y="92" width="260" height="258" fill="#fde27a"/>${lines(80, 120, 7, ['#3b2f05'])}`)}
  ${win(360, 60, 560, 380, true, lines(380, 100, 14, [p.green, p.blue, p.foreground, p.yellow]))}
  ${win(500, 320, 520, 330, false, lines(520, 360, 10, [p.foreground, p.magenta, p.cyan]))}
  <rect x="420" y="680" width="360" height="52" rx="18" fill="${p.background}" stroke="${p.muted}"/>
  ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<rect x="${434 + i * 48}" y="688" width="36" height="36" rx="9" fill="${[p.accent, p.blue, p.red, p.lighterBackground, p.green, p.yellow, p.magenta][i]}"/>`).join('')}
</svg>`
}

export const PICTURES: { name: string; svg: () => string }[] = [
  { name: 'wallpaper-flexoki-light.svg', svg: () => wallpaper('flexoki-light') },
  { name: 'wallpaper-tokyo-night.svg', svg: () => wallpaper('tokyo-night') },
  { name: 'wallpaper-catppuccin.svg', svg: () => wallpaper('catppuccin') },
  { name: 'wallpaper-gruvbox.svg', svg: () => wallpaper('gruvbox') },
  { name: 'wallpaper-rose-pine.svg', svg: () => wallpaper('rose-pine') },
  { name: 'mvlos-logo.svg', svg: () => logo },
  { name: 'screenshot-mvlos-day.svg', svg: () => desktopSketch('flexoki-light') },
  { name: 'screenshot-mvlos-night.svg', svg: () => desktopSketch('tokyo-night') },
]
