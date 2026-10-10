import { AGENTS_MD } from '../data/agentsPrompt'
import { GAME_CATALOG } from '../apps/games/catalog'
import { contributions, education, experience, headlines, hobbies, profile, projects, skills } from '../data/profile'
import { PICTURES } from './pictures'
import { revealEmail } from '../data/email'
import { BUILT, COMMIT, SHORT_VERSION, VERSION } from '../version'

// A read-only, in-memory filesystem built from profile.ts. Nothing here touches the real
// machine; "files" are strings and a few of them point at an app or URL for `open`.

export type FileNode = {
  type: 'file'
  name: string
  content: () => string
  open?: { app?: string; props?: Record<string, string>; url?: string }
  /** Display size in bytes for files whose content is only a stand-in (an ISO, a FLAC). */
  size?: number
  mtime?: number
  /** Where it really is, for files that live in Seafile (terminal/fs.ts) */
  sf?: string
  /** Read-only: a read-only library or mount */
  ro?: boolean
  /** A program (the commands in /bin) */
  exec?: boolean
}
export type DirNode = { type: 'dir'; name: string; children: Map<string, Node>; mtime?: number; sf?: string; ro?: boolean }
export type Node = FileNode | DirNode

export const HOME = `/home/${profile.handle}`

const file = (name: string, content: string | (() => string), open?: FileNode['open']): FileNode => ({
  type: 'file',
  name,
  content: typeof content === 'string' ? () => content : content,
  open,
})
const dir = (name: string, children: Node[]): DirNode => ({ type: 'dir', name, children: new Map(children.map((c) => [c.name, c])) })
const big = (name: string, size: number, note: string, daysAgo: number): FileNode => ({ type: 'file', name, content: () => note, size, mtime: Date.now() - daysAgo * 864e5 })

const bullets = (items: string[]) => items.map((i) => `  - ${i}`).join('\n')

function projectReadme(p: (typeof projects)[number]) {
  return [
    `# ${p.name}`,
    '',
    `> ${p.tagline}`,
    '',
    p.description,
    '',
    '## Highlights',
    bullets(p.highlights),
    '',
    `Stack:  ${p.stack.join(', ')}`,
    `Status: ${p.status}`,
    p.url ? `Site:   ${p.url}` : '',
    p.repo ? `Source: ${p.repo}` : '',
    p.slug === 'pepper' ? "\nTry it right here: `pepper --help` or `pepper '*' state apply --test`" : '',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n')
}

function contributionReadme(c: (typeof contributions)[number]) {
  return [`# ${c.name}  (${c.owner}/${c.slug})`, '', c.description, '', '## What I worked on', bullets(c.work), '', `Source: ${c.repo}`, c.url ? `Site:   ${c.url}` : '']
    .join('\n')
    .trimEnd()
}

// Real Markdown, so Zed's preview renders it properly; `cat` shows the same text.
function cv() {
  return [
    `# ${profile.name}`,
    '',
    `**${profile.role}** @ ${profile.company} · ${profile.location}`,
    '',
    profile.summary,
    '',
    '## Experience',
    ...experience.flatMap((e) => ['', `### ${e.role}, ${e.company}`, '', `*${e.period}*`, '', ...e.notes.map((n) => `- ${n}`)]),
    '',
    '## Projects',
    '',
    ...projects.map((p) => `- **${p.name}**: ${p.tagline}`),
    '',
    '## Open source',
    '',
    ...contributions.map((c) => `- **${c.owner}/${c.slug}**: ${c.description.split(':')[0]}`),
    '',
    '## Education',
    '',
    ...education.map((e) => `- **${e.title}**, ${e.school} (${e.period})`),
    '',
    '## Skills',
    '',
    ...Object.entries(skills).map(([k, v]) => `- **${k}**: ${v.join(', ')}`),
    '',
    '## Off the clock',
    '',
    ...hobbies.map((h) => `- **${h.name}**: ${h.note}`),
  ].join('\n')
}

// "Uptime" is Menno's age: the system has been up since he was born.
const bootTime = new Date(`${profile.born}T00:00:00`).getTime()
export const uptimeSeconds = () => Math.floor((Date.now() - bootTime) / 1000)

/** Calendar-accurate "30 years, 19 days" since birth. */
export function age(now = new Date()) {
  const born = new Date(`${profile.born}T00:00:00`)
  let years = now.getFullYear() - born.getFullYear()
  const birthday = new Date(born)
  birthday.setFullYear(born.getFullYear() + years)
  if (birthday > now) {
    years--
    birthday.setFullYear(birthday.getFullYear() - 1)
  }
  const days = Math.floor((now.getTime() - birthday.getTime()) / 864e5)
  return { years, days }
}

const readmeNode = file('README.md', () =>
        [
          `Hi, I'm ${profile.name}.`,
          '',
          profile.summary,
          '',
          'Things worth reading here:',
          '  cv.md            the short version of me',
          '  projects/        things I built and run',
          '  contributions/   other people\'s projects I help with',
          '  games/           the arcade, one launcher per game',
          '  contact.txt      how to reach me',
          '  hobbies.txt      what I do when the laptop is closed',
          '',
          'Try `open projects/boltwarden` or `recent | head -5`.',
        ].join('\n'),
      )
const cvNode = file('cv.md', cv, { app: 'zed', props: { path: `${HOME}/cv.md`, view: 'preview' } })
const projectsNode = dir(
        'projects',
        projects.map((p) =>
          dir(p.slug, [
            file('README.md', () => projectReadme(p), { app: 'projects', props: { slug: p.slug } }),
            ...(p.url ? [file('website.url', p.url, { url: p.url })] : []),
            ...(p.repo ? [file('source.url', p.repo, { url: p.repo })] : []),
          ]),
        ),
      )
const gamesNode = dir(
        'games',
        GAME_CATALOG.map((g) =>
          file(`${g.id}.game`, [`${g.glyph} ${g.name}`, '', g.blurb, '', `Play: ./${g.id}.game   (or: games ${g.id})`].join('\n'), { app: 'games', props: { game: g.id } }),
        ),
      )
const contributionsNode = dir(
        'contributions',
        contributions.map((c) =>
          dir(c.slug, [
            file('README.md', () => contributionReadme(c), { app: 'projects', props: { slug: c.slug } }),
            file('source.url', c.repo, { url: c.repo }),
          ]),
        ),
      )

// The usual home folders, with a few believable files. Pictures are real SVG images; the large
// downloads and media files are stand-ins with a display size.
const homeFolders: Node[] = [
  // ~/Desktop shows what is on the desktop; its entries are the same nodes as in ~ (like symlinks).
  dir('Desktop', [projectsNode, contributionsNode, gamesNode, cvNode, readmeNode]),
  dir('Documents', [
    cvNode,
    file('side-project-ideas.md', ['# Ideas', '', '- [x] a password manager for my desktop (Boltwarden)', '- [x] config management without YAML (Pepper)', '- [x] a CV that is an operating system', '- [ ] sleep', '- [ ] finish one idea before starting the next'].join('\n')),
    file('astro-targets.txt', ['M31 Andromeda Galaxy      autumn, wide field', 'M42 Orion Nebula          winter, short subs for the core', 'NGC 7000 North America    summer, H-alpha', 'M51 Whirlpool Galaxy      spring, needs a longer focal length'].join('\n')),
  ]),
  dir('Downloads', [
    big('omarchy-latest-x86_64.iso', 2_253_389_824, 'An Omarchy installer image. It boots better on real hardware.', 2),
    big('boltwarden-1.0.0-rc.3-x86_64.AppImage', 38_840_320, 'Boltwarden release candidate 3. Get the real one from boltwarden.org.', 1),
    big('itzg-minecraft-server-java21.tar', 412_090_368, 'A saved container image for the Minecraft server.', 14),
    big('pepper-cli_0.22.0_linux_amd64.tar.gz', 21_495_808, 'Pepper CLI release archive.', 15),
  ]),
  dir('Music', [
    big('lossless-test-01.flac', 41_231_872, 'A lossless test track for Omasoloist.', 6),
    big('lossless-test-02.flac', 38_700_032, 'Another lossless test track for Omasoloist.', 6),
    big('lofi-coding-session.flac', 96_468_992, 'Two hours of background music for debugging.', 30),
  ]),
  dir(
    'Pictures',
    PICTURES.map((pic, i): FileNode => ({ type: 'file', name: pic.name, content: pic.svg, mtime: Date.now() - (i + 1) * 3 * 864e5 })),
  ),
  dir('Videos', [
    big('pepper-failover-demo.mp4', 184_549_376, 'A recording of a Pepper master failover.', 9),
    big('fpv-freestyle-summer.mp4', 734_003_200, 'FPV freestyle footage. Mostly crashes.', 70),
  ]),
]

const homeNode = dir(profile.handle, [
  readmeNode,
  cvNode,
  // The Agents app's system prompt as it comes (read-only here; with Seafile as home, your own).
  file('AGENTS.md', AGENTS_MD, { app: 'zed', props: { path: `${HOME}/AGENTS.md` } }),
  projectsNode,
  gamesNode,
  contributionsNode,
  ...homeFolders,
  file('hobbies.txt', hobbies.map((h) => `${h.name}\n  ${h.note}${h.url ? `\n  ${h.url}` : ''}`).join('\n\n')),
  file('headlines.txt', headlines.join('\n'), { app: 'notes' }),
  file(
    'contact.txt',
    () => [`email     ${revealEmail()}`, ...profile.links.map((l) => `${l.label.toLowerCase().padEnd(10)}${l.url}`)].join('\n'),
    { app: 'contact' },
  ),
  file('.bashrc', ['# not actually bash, but it reads like it', "alias ll='ls -la'", 'export EDITOR=nvim', 'export PAGER=cat'].join('\n')),
  file('.plan', 'Ship Boltwarden 1.0.\nGet Pepper to a first stable release.\nSleep at some point.'),
])

/**
 * Files whose contents live elsewhere: /etc/fstab and the Seafile devices in /dev come from the
 * mount table (data/mounts.ts fills these in), so Files, Zed and the terminal all see them.
 */
export const dynamic = { fstab: () => '', devices: (): string[] => [], commands: (): { name: string; desc: string }[] => [] }

/** A size that looks like a binary's, the same every time for the same name. */
const binarySize = (name: string) => {
  let h = 7
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return 18_000 + (h % 160_000)
}

/** /bin: one program per command the shell knows (commands.ts fills dynamic.commands). */
const binNode: DirNode = {
  type: 'dir',
  name: 'bin',
  get children() {
    return new Map(
      dynamic.commands().map(({ name, desc }) => [name, { type: 'file', name, exec: true, size: binarySize(name), content: () => `\x7fELF\x02\x01\x01\n${name}: ${desc}\n(built into msh; run it as ${name})\n` }] as [string, Node]),
    )
  },
}

const device = (name: string): FileNode => ({ type: 'file', name, content: () => '', size: 0 })
const devNode: DirNode = {
  type: 'dir',
  name: 'dev',
  get children() {
    const seafile: DirNode = {
      type: 'dir',
      name: 'seafile',
      get children() {
        return new Map(dynamic.devices().map((d) => [d, device(d)] as [string, Node]))
      },
    }
    return new Map<string, Node>([...['null', 'zero', 'random', 'urandom', 'nvme0n1', 'nvme0n1p1', 'nvme0n1p2'].map((n) => [n, device(n)] as [string, Node]), ['seafile', seafile]])
  },
}

export const root: DirNode = dir('', [
  dir('home', [homeNode]),
  // The site's own home, under a second name: with Seafile mounted on ~ (see /etc/fstab), this is
  // where cv.md and projects/ are.
  dir('srv', [{ type: 'dir', name: 'site', children: homeNode.children }]),
  dir('mnt', [dir('seafile', [])]),
  dir('etc', [
    file('os-release', `NAME="MvL OS"\nPRETTY_NAME="MvL OS ${SHORT_VERSION} (Vaporwave Penguin)"\nVERSION_ID="${VERSION}"\nBUILD_ID="${COMMIT.slice(0, 7)}"\nID=mvlos\nID_LIKE=arch\nHOME_URL="https://mennovanleeuwen.nl"`),
    file('hostname', 'mvlos'),
    file('motd', 'Welcome to MvL OS. Nothing in here can hurt you, or me.'),
    { type: 'file', name: 'fstab', content: () => dynamic.fstab() },
  ]),
  devNode,
  dir('proc', [file('uptime', () => `${uptimeSeconds()}.00 0.00`), file('version', `MvL OS ${VERSION} (react 19, vite) #1 SMP PREEMPT_DYNAMIC ${BUILT}`)]),
  dir('tmp', []),
  binNode,
])

/** Resolves a path against cwd, handling ~, ., .. and absolute paths. */
export function resolvePath(cwd: string, input: string): string {
  let p = input.trim() || '~'
  if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1)
  const parts = (p.startsWith('/') ? p : `${cwd}/${p}`).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

export function lookup(path: string): Node | null {
  let node: Node = root
  for (const part of path.split('/').filter(Boolean)) {
    if (node.type !== 'dir') return null
    const next = node.children.get(part)
    if (!next) return null
    node = next
  }
  return node
}

export const prettyPath = (path: string) => (path === HOME ? '~' : path.startsWith(HOME + '/') ? '~' + path.slice(HOME.length) : path)

export type FileKind = 'folder' | 'image' | 'text' | 'markdown' | 'link' | 'game' | 'audio' | 'video' | 'disc' | 'archive' | 'package' | 'pdf' | 'document' | 'file'

export const fileKind = (node: Node): FileKind => kindOfName(node.name, node.type === 'dir')

/** Text, source code, scripts and config: what Zed opens. */
const TEXT_EXTS = new Set(
  'txt conf cfg ini toml yaml yml json jsonc json5 xml csv tsv log env properties sh bash zsh fish ps1 bat cmd ts tsx js jsx mjs cjs css scss sass less html htm vue svelte py rb go rs c h cc cpp hpp cs java kt kts swift php pl lua r sql graphql proto dockerfile makefile mk cmake gradle nix tf hcl lock gitignore gitattributes editorconfig diff patch rst tex org adoc srt vtt'.split(' '),
)

/** A file's kind from its name alone (for files that are not in this filesystem, like Seafile's). */
export function kindOfName(name: string, dir = false): FileKind {
  if (dir) return 'folder'
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'ico'].includes(ext)) return 'image'
  if (['md', 'markdown'].includes(ext)) return 'markdown'
  if (ext === 'url') return 'link'
  if (ext === 'game') return 'game'
  if (['flac', 'mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac'].includes(ext)) return 'audio'
  if (['mp4', 'mkv', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video'
  if (ext === 'iso') return 'disc'
  if (['tar', 'gz', 'tgz', 'zip', 'xz', 'bz2', 'zst', '7z', 'rar'].includes(ext)) return 'archive'
  if (ext === 'appimage') return 'package'
  if (ext === 'pdf') return 'pdf'
  if (['doc', 'docx', 'odt', 'rtf', 'pages', 'xls', 'xlsx', 'ods', 'numbers', 'ppt', 'pptx', 'odp', 'key'].includes(ext)) return 'document'
  if (ext === '' || TEXT_EXTS.has(ext) || name.startsWith('.') || /^(Dockerfile|Makefile|Caddyfile|Justfile|Procfile|LICENSE|README)$/i.test(name)) return 'text'
  return 'file'
}

export const KIND_LABEL: Record<FileKind, string> = {
  folder: 'Folder',
  image: 'Image',
  text: 'Text',
  markdown: 'Markdown',
  link: 'Link',
  game: 'Game',
  audio: 'Audio',
  video: 'Video',
  disc: 'Disc image',
  archive: 'Archive',
  package: 'AppImage',
  pdf: 'PDF',
  document: 'Document',
  file: 'File',
}

// Stable, recent-looking modification times for files that do not carry one.
const BOOT = Date.now()
function pseudoTime(path: string) {
  let h = 7
  for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return BOOT - (h % (40 * 86400)) * 1000
}

export function stat(path: string, node: Node = lookup(path)!) {
  const size = node.type === 'dir' ? node.children.size : (node.size ?? new TextEncoder().encode(node.content()).length)
  return { size, mtime: (node.type === 'file' && node.mtime) || pseudoTime(path), kind: fileKind(node) }
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`
}

/** Every file path under a directory, for find/grep -r. */
export function walk(path: string, node: Node = lookup(path)!): string[] {
  if (!node) return []
  if (node.type === 'file') return [path]
  const out: string[] = [path]
  for (const child of node.children.values()) out.push(...walk(`${path === '/' ? '' : path}/${child.name}`, child))
  return out
}
