// Small pure helpers for words on a command line, apart from commands.ts so scripts can load them.

/** One argument the way msh reads it back: bare when it is plain, otherwise in single quotes. */
export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** Paths for a command line: each quoted, separated by spaces (what dropping files on a terminal pastes). */
export const quotePaths = (paths: string[]) => paths.map(shellQuote).join(' ')

/** Whether `open <word>` means a file or folder rather than the app of that name. */
export const meansPath = (word: string, existsHere: boolean) => /[/.]/.test(word) || existsHere
