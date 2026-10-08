// Everything the site says about Menno lives in this file. The terminal's
// virtual filesystem, the Projects app and the sticky note are all built from it.

export const profile = {
  name: 'Menno van Leeuwen',
  handle: 'menno',
  role: 'DevOps Engineer',
  company: 'DiscountOffice',
  location: 'The Netherlands',
  /** Shown as the system uptime in the terminal */
  born: '1996-09-19',
  email: 'menno@vleeuwen.me',
  github: 'vleeuwenmenno',
  links: [
    { label: 'GitHub', url: 'https://github.com/vleeuwenmenno' },
    { label: 'LinkedIn', url: 'https://www.linkedin.com/in/menno-v-44477b176/' },
    { label: 'Gitea', url: 'https://git.mvl.sh/vleeuwenmenno' },
    { label: 'Homepage', url: 'https://mennovanleeuwen.nl' },
  ],
  summary:
    'DevOps engineer who keeps production boring and side projects interesting. ' +
    'I build infrastructure tooling, desktop apps and the occasional web product, ' +
    'mostly in Go, Rust, TypeScript and QML, from a Linux desktop I configured myself.',
  favourites: {
    platform: 'Arch (Omarchy) / Ubuntu',
    languages: ['Go', 'TypeScript / React', 'Rust'],
  },
}

export const headlines = [
  'DevOps Engineer @ DiscountOffice',
  'Shipped Boltwarden: a desktop Bitwarden client',
  'Building Pepper: infra graphs without YAML',
  'Savuvo: personal finance, calmly',
  'Contributor to the Omarchy shell ecosystem',
]

export type Project = {
  slug: string
  name: string
  tagline: string
  description: string
  highlights: string[]
  stack: string[]
  url?: string
  repo?: string
  status: string
  accent: string
  /** GitHub "owner/name", used for live stars and activity */
  github?: string
  /** git.mvl.sh repo (or "org/" prefix) whose activity belongs to this project */
  forgejo?: string
}

export const projects: Project[] = [
  {
    slug: 'boltwarden',
    name: 'Boltwarden',
    tagline: 'Your Vaultwarden or Bitwarden vault on your desktop',
    description:
      'A free, unofficial desktop app and browser extension for Vaultwarden and Bitwarden. ' +
      'One unlock covers the desktop app and the browser, the vault stays on your machine, ' +
      'and there is no tracking, subscription or cloud copy of your data.',
    highlights: [
      'Single unlock shared by the desktop app and the browser extension',
      'Quick access popup with keyboard shortcuts',
      'Autofill for passwords, TOTP codes, cards and passkeys',
      'SSH agent backed by keys stored in the vault',
      'Vault health: weak and reused password detection',
      'Offline access through an encrypted local cache',
      'Runs on Linux, Windows 11 and macOS; extensions for Firefox and Chrome',
    ],
    stack: ['Rust', 'TypeScript', 'WebExtensions'],
    url: 'https://boltwarden.org/',
    repo: 'https://github.com/vleeuwenmenno/boltwarden',
    github: 'vleeuwenmenno/boltwarden',
    status: 'Active development',
    accent: '#5b9cff',
  },
  {
    slug: 'savuvo',
    name: 'Savuvo',
    tagline: 'A calm view of where your money is heading',
    description:
      'A personal finance tracker built around planning rather than bookkeeping. ' +
      'Budgets, planned transactions and savings goals feed a forecast of how the month ' +
      'will end, shared across a household if you want.',
    highlights: [
      'Budgets, planned transactions and savings goals',
      'Month-end and four-week forecasts',
      'Household spaces for shared finances',
      'Multi-currency accounts and subscriptions',
      'AI assistant and receipt scanning, answering only from your own data',
      'Available in English, Dutch and German',
    ],
    stack: ['React', 'TypeScript', 'PWA'],
    url: 'https://savuvo.nl/',
    status: 'Live',
    accent: '#3fcf8e',
  },
  {
    slug: 'pepper',
    name: 'Pepper',
    tagline: 'Deterministic infrastructure graphs without YAML',
    description:
      'Configuration management that turns Starlark into a deterministic per-node ' +
      'deployment graph and applies it to Linux machines through a clustered ' +
      'controller with active-passive failover.',
    highlights: [
      'State defined in Starlark instead of templated YAML',
      'Master/minion cluster with high availability and failover',
      'Secrets from 1Password, Bitwarden or age, injected by the operator',
      '"Blends" share per-node configuration across states and templates',
      'gRPC provider SDK and an extension catalog (packages, services, mounts, containers)',
      'Migration tooling from SaltStack',
    ],
    stack: ['Go', 'Starlark', 'gRPC', 'Protobuf'],
    url: 'https://pepper.mvl.sh/',
    repo: 'https://git.mvl.sh/pepper',
    forgejo: 'pepper/',
    status: 'Active development',
    accent: '#ff6b5b',
  },
  {
    slug: 'golinks',
    name: 'Go Links',
    tagline: 'Short, memorable go links, self-hosted at mvl.sh',
    description:
      'A self-hosted go-links service: give a long URL a short alias you can remember and share. ' +
      'Everyone gets their own aliases, and private links stay behind revocable access tokens. ' +
      'It runs at mvl.sh.',
    highlights: [
      'User-owned aliases with redirects through short slugs',
      'Revocable access tokens for private links (/r/{slug}?token=…)',
      'Turnstile-protected registration and SQLite-backed sessions',
      'Password reset by email',
      'Container images published from Gitea Actions on every release',
    ],
    stack: ['Rust', 'SQLite', 'Docker'],
    url: 'https://mvl.sh/',
    repo: 'https://git.mvl.sh/vleeuwenmenno/golinks',
    forgejo: 'vleeuwenmenno/golinks',
    status: 'Live',
    accent: '#bb9af7',
  },
  {
    slug: 'omasoloist',
    name: 'Omasoloist',
    tagline: 'Lossless Spotify with a tiny footprint',
    description:
      'A Spotify client for the Omarchy shell built on the new Spotify soloist daemon. ' +
      'Lossless playback without an Electron window eating your RAM and VRAM.',
    highlights: [
      'Native Quickshell / QML interface that fits the Omarchy desktop',
      'Talks to the soloist daemon for lossless playback',
      'Minimal memory and GPU usage compared to the official client',
    ],
    stack: ['QML', 'Quickshell'],
    repo: 'https://github.com/vleeuwenmenno/omasoloist',
    github: 'vleeuwenmenno/omasoloist',
    status: 'Active development',
    accent: '#1ed760',
  },
]

export type Contribution = {
  slug: string
  name: string
  owner: string
  description: string
  repo: string
  url?: string
  github: string
  accent: string
  work: string[]
}

export const contributions: Contribution[] = [
  {
    slug: 'omarchy-spotlight',
    name: 'Omarchy Spotlight',
    owner: 'maajix',
    description:
      'Raycast-style command palette for Omarchy: apps, windows, calculator, reminders, ' +
      'calendar events, file search, web search and more.',
    repo: 'https://github.com/maajix/omarchy-spotlight',
    url: 'https://maajix.github.io/omarchy-spotlight/',
    github: 'maajix/omarchy-spotlight',
    accent: '#e0af68',
    work: [
      'In-app settings panel covering every writable key, with debounced saves',
      'Mixed-currency calculator expressions',
      'Serialized settings writes that surface save failures',
    ],
  },
  {
    slug: 'omarchy-omafile',
    name: 'Omafile',
    owner: 'chr0nzz',
    description: 'A file manager for the Omarchy shell.',
    repo: 'https://github.com/chr0nzz/omarchy-omafile',
    url: 'https://omarchy.xyzlab.dev/omafile/',
    github: 'chr0nzz/omarchy-omafile',
    accent: '#7dcfff',
    work: [
      'Redesigned properties dialog with tabs, "Opens with" and editable permissions',
      'Drag to reorder sidebar rows and sections',
      'Open-with menu with app icons and an always-open-with option',
      'Regrouped context menu with permanent delete behind Shift',
    ],
  },
]

export const skills = {
  Languages: ['Go', 'TypeScript', 'Rust', 'C# / .NET', 'PHP', 'Dart', 'Python', 'QML', 'Starlark', 'Bash'],
  Infrastructure: ['Arch Linux', 'Ubuntu', 'Docker / Podman', 'Incus / LXD', 'SaltStack', 'CI/CD', 'Networking'],
  Frameworks: ['React', 'Flutter', 'Laravel', 'Vite', 'WebExtensions', 'Quickshell'],
  'Ways of working': ['Agile / Scrum', 'Object-oriented design'],
}

export const experience = [
  {
    role: 'DevOps Engineer',
    company: 'DiscountOffice',
    period: 'Present',
    notes: ['Infrastructure, deployment pipelines and keeping production calm.'],
  },
  {
    role: 'Software Engineer',
    company: 'Sandwave / Your.Online (formerly TWS)',
    period: 'From Nov 2021',
    notes: [
      'Built complex authentication flows using modern security practices.',
      'Kept the dependency tree healthy and up to date across projects.',
      'Worked in an agile/scrum setup, sparring with smaller teams.',
    ],
  },
  {
    role: '.NET / PHP Developer',
    company: 'Minty Media',
    period: 'Nov 2020 – Oct 2021',
    notes: [
      'Built API bridges between Bol.com and WooCommerce.',
      'Set up CI/CD pipelines to streamline testing and deployment.',
      'Started a full hosting panel: DNS editor, domain purchasing, VPS options.',
    ],
  },
  {
    role: 'Flutter Developer',
    company: 'Bots.io (formerly RevenYOU)',
    period: 'Mar 2019 – Oct 2019',
    notes: ['Led development of the Bots.io app, now past 1M downloads.', 'Built the app skeleton and worked closely with the UI designers.'],
  },
  {
    role: 'All-round / Repair Technician / Sales',
    company: 'Com Today',
    period: 'Jan 2014 – Mar 2019',
    notes: [
      'Wrote an in-house PHP cashier system for sales, expenses, stock and open tasks.',
      'Repaired computers, laptops, phones and everything in between.',
      'Managed stock, sold systems and gave customers technical support.',
    ],
  },
]

export const education = [
  { title: 'MBO 4 Application & Media Developer', school: 'Nova College, Beverwijk', period: '2015 – 2019' },
  { title: 'MBO 2 IT Employee', school: 'Nova College, Beverwijk', period: '2012 – 2014', note: 'Cisco networking courses' },
]

export const hobbies = [
  { name: 'Astrophotography', note: 'Galaxies, nebulae and star fields, plus a lot of image processing.', url: 'https://www.astrobin.com/users/vleeuwenmenno/' },
  { name: 'FPV drones', note: 'Building, flying and crashing freestyle and cinematic quads, mostly in summer.' },
  { name: 'Languages & travel', note: 'Getting out of my comfort zone by speaking the local language.' },
  { name: 'Side projects', note: 'Endless test projects. Some of them turn into Boltwarden.' },
]
