import { contributions, education, experience, headlines, hobbies, profile, projects, skills } from '../data/profile'

// A read-only, in-memory filesystem built from profile.ts. Nothing here touches the real
// machine; "files" are strings and a few of them point at an app or URL for `open`.

export type FileNode = { type: 'file'; name: string; content: () => string; open?: { app?: string; props?: Record<string, string>; url?: string } }
export type DirNode = { type: 'dir'; name: string; children: Map<string, Node> }
export type Node = FileNode | DirNode

export const HOME = `/home/${profile.handle}`

const file = (name: string, content: string | (() => string), open?: FileNode['open']): FileNode => ({
  type: 'file',
  name,
  content: typeof content === 'string' ? () => content : content,
  open,
})
const dir = (name: string, children: Node[]): DirNode => ({ type: 'dir', name, children: new Map(children.map((c) => [c.name, c])) })

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
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n')
}

function contributionReadme(c: (typeof contributions)[number]) {
  return [`# ${c.name}  (${c.owner}/${c.slug})`, '', c.description, '', '## What I worked on', bullets(c.work), '', `Source: ${c.repo}`, c.url ? `Site:   ${c.url}` : '']
    .join('\n')
    .trimEnd()
}

function cv() {
  return [
    `# ${profile.name}`,
    `${profile.role} @ ${profile.company} · ${profile.location}`,
    '',
    profile.summary,
    '',
    '## Experience',
    ...experience.map((e) => `  ${e.role}, ${e.company} (${e.period})\n${e.notes.map((n) => `    ${n}`).join('\n')}`),
    '',
    '## Projects',
    ...projects.map((p) => `  ${p.name.padEnd(12)} ${p.tagline}`),
    '',
    '## Open source',
    ...contributions.map((c) => `  ${`${c.owner}/${c.slug}`.padEnd(26)} ${c.description.split(':')[0]}`),
    '',
    '## Education',
    ...education.map((e) => `  ${e.title}, ${e.school} (${e.period})`),
    '',
    '## Skills',
    ...Object.entries(skills).map(([k, v]) => `  ${k.padEnd(16)} ${v.join(', ')}`),
    '',
    '## Off the clock',
    ...hobbies.map((h) => `  ${h.name.padEnd(19)} ${h.note}`),
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

export const root: DirNode = dir('', [
  dir('home', [
    dir(profile.handle, [
      file('README.md', () =>
        [
          `Hi, I'm ${profile.name}.`,
          '',
          profile.summary,
          '',
          'Things worth reading here:',
          '  cv.md            the short version of me',
          '  projects/        things I built and run',
          '  contributions/   other people\'s projects I help with',
          '  contact.txt      how to reach me',
          '  hobbies.txt      what I do when the laptop is closed',
          '',
          'Try `open projects/boltwarden` or `recent | head -5`.',
        ].join('\n'),
      ),
      file('cv.md', cv, { app: 'cv' }),
      file('hobbies.txt', hobbies.map((h) => `${h.name}\n  ${h.note}${h.url ? `\n  ${h.url}` : ''}`).join('\n\n')),
      file('headlines.txt', headlines.join('\n'), { app: 'notes' }),
      file(
        'contact.txt',
        [`email   ${profile.email}`, ...profile.links.map((l) => `${l.label.toLowerCase().padEnd(8)}${l.url}`)].join('\n'),
        { app: 'contact' },
      ),
      dir(
        'projects',
        projects.map((p) =>
          dir(p.slug, [
            file('README.md', () => projectReadme(p), { app: 'projects', props: { slug: p.slug } }),
            ...(p.url ? [file('website.url', p.url, { url: p.url })] : []),
            ...(p.repo ? [file('source.url', p.repo, { url: p.repo })] : []),
          ]),
        ),
      ),
      dir(
        'contributions',
        contributions.map((c) =>
          dir(c.slug, [
            file('README.md', () => contributionReadme(c), { app: 'projects', props: { slug: c.slug } }),
            file('source.url', c.repo, { url: c.repo }),
          ]),
        ),
      ),
      file('.bashrc', ['# not actually bash, but it reads like it', "alias ll='ls -la'", 'export EDITOR=nvim', 'export PAGER=cat'].join('\n')),
      file('.plan', 'Ship Boltwarden 1.0.\nGet Pepper to a first stable release.\nSleep at some point.'),
    ]),
  ]),
  dir('etc', [
    file('os-release', 'NAME="MvL OS"\nPRETTY_NAME="MvL OS 1.0 (Vaporwave Penguin)"\nID=mvlos\nID_LIKE=arch\nHOME_URL="https://mennovanleeuwen.nl"'),
    file('hostname', 'mvlos'),
    file('motd', 'Welcome to MvL OS. Nothing in here can hurt you, or me.'),
  ]),
  dir('proc', [file('uptime', () => `${uptimeSeconds()}.00 0.00`), file('version', 'MvL OS 1.0 (react 19, vite) #1 SMP PREEMPT_DYNAMIC')]),
  dir('tmp', []),
  dir('bin', []),
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

/** Every file path under a directory, for find/grep -r. */
export function walk(path: string, node: Node = lookup(path)!): string[] {
  if (!node) return []
  if (node.type === 'file') return [path]
  const out: string[] = [path]
  for (const child of node.children.values()) out.push(...walk(`${path === '/' ? '' : path}/${child.name}`, child))
  return out
}
