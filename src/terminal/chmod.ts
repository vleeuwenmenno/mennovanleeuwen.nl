import { lookup, setMode, walk } from './fs'
import { applyMode, modeOf, rwx } from './modes'
import { CmdError, type Ctx } from './types'
import { resolvePath } from './vfs'
import type { Completion } from './commands'

// chmod: sets the permission bits of files and folders where the filesystem can keep them: /tmp,
// the files in this browser and the Seafile libraries you can write to (modes.ts says how they are
// kept). The site's own files stay as they are.

type Command = { desc: string; usage?: string; man?: string; run: (ctx: Ctx) => string | void | Promise<string | void>; complete?: (args: string[], word: string) => Completion[] }

const c = (color: string, s: string) => `{c:${color}}${s}{/}`

/** The mode as GNU chmod -v prints it: 0644 (rw-r--r--). */
const shown = (mode: number) => `${(mode & 0o7777).toString(8).padStart(4, '0')} (${rwx(mode)})`

export const CHMOD_MAN = `${c('bold', 'NAME')}
       chmod - change file mode bits

${c('bold', 'SYNOPSIS')}
       chmod [-Rcfv] MODE[,MODE]... FILE...
       chmod [-Rcfv] OCTAL-MODE FILE...

${c('bold', 'DESCRIPTION')}
       chmod changes the permission bits of each FILE. Three things look at them: ls -l shows
       them, find tests them (-perm, -executable, %M), and the shell checks them when it runs a
       file. A script needs an x bit to run as a command:

              $ ./hello.msh
              msh: ./hello.msh: Permission denied
              $ chmod +x hello.msh
              $ ./hello.msh
              hello

       source and msh hello.msh read a script without it, like a real shell. Games (*.game) and
       folders need no chmod.

${c('bold', 'MODES')}
       Octal: three or four digits, owner then group then other. r is 4, w is 2, x is 1, so 755 is
       rwxr-xr-x and 644 is rw-r--r--.

       Symbolic: [ugoa]*[-+=][rwxX]*, joined with commas.
              u  the owner     g  the group     o  everyone else     a  all (the default)
              +  add     -  remove     =  set exactly
              X  x, but only for folders and files that can already run
       chmod +x file, chmod u+w file, chmod go=r file, chmod a-rx file, chmod u=rwx,go=rx dir

${c('bold', 'OPTIONS')}
       -R, --recursive   change a folder and everything in it
       -c, --changes     report only the files whose mode changed
       -v, --verbose     report every file
       -f, --silent      keep quiet about errors (the exit status still says)

${c('bold', 'WHAT STAYS OF IT')}
       Modes are kept with the file: in /tmp as long as the file is there, for files in this browser
       inside the file's own record, and for Seafile in a table in this browser (Seafile itself has
       no modes), per account. Renaming or moving a file keeps its mode; deleting it, or creating
       a new file, starts from the default again. Writing to a file keeps its mode.

       Reading and writing are only refused when chmod set the mode (chmod a-r file, then cat file
       says Permission denied). Files that were never chmod-ed keep working as before, whatever
       ls -l shows for them. sudo ignores the bits.

       The site's own files, /bin, /etc and read-only libraries cannot be changed.

${c('bold', 'EXIT STATUS')}
       0 when everything changed, 1 when something could not.

${c('bold', 'SEE ALSO')}
       ls(1), find(1), msh(1)`

const LONG_FLAGS: Record<string, string> = { '--recursive': 'R', '--verbose': 'v', '--changes': 'c', '--silent': 'f', '--quiet': 'f' }

async function chmod(ctx: Ctx): Promise<string | void> {
  const flag = new Set<string>()
  const rest: string[] = []
  let spec: string | null = null
  let optionsOver = false
  for (const a of ctx.args) {
    if (!optionsOver && a === '--') optionsOver = true
    else if (!optionsOver && LONG_FLAGS[a]) flag.add(LONG_FLAGS[a])
    else if (!optionsOver && /^-[Rcfv]+$/.test(a)) for (const ch of a.slice(1)) flag.add(ch)
    else if (!optionsOver && a.startsWith('--')) throw new CmdError(`chmod: unrecognized option '${a}'\nTry 'chmod --help' for more information.`)
    // -x, -rw and the like are modes, as in the real chmod; the first word that is not an option is the mode.
    else if (spec === null) spec = a
    else rest.push(a)
  }
  if (spec === null) throw new CmdError(`chmod: missing operand\nTry 'chmod --help' for more information.`)
  if (!rest.length) throw new CmdError(`chmod: missing operand after '${spec}'\nTry 'chmod --help' for more information.`)
  if (applyMode(spec, 0, false) === null) throw new CmdError(`chmod: invalid mode: '${spec}'\nTry 'chmod --help' for more information.`)

  const lines: string[] = []
  const errors: string[] = []
  const fail = (msg: string) => void errors.push(flag.has('f') ? '' : msg)
  for (const arg of rest) {
    const root = resolvePath(ctx.cwd, arg)
    if (!lookup(root)) {
      fail(`chmod: cannot access '${arg}': No such file or directory`)
      continue
    }
    for (const abs of flag.has('R') ? walk(root) : [root]) {
      const node = lookup(abs)
      if (!node) continue
      const was = modeOf(abs, node)
      const to = applyMode(spec, was, node.type === 'dir')!
      const name = abs === root ? arg : `${arg.replace(/\/+$/, '')}${abs.slice(root.length)}`
      try {
        if (to !== was || node.mode === undefined) await setMode(abs, to, !!ctx.root)
        if (flag.has('v') || (flag.has('c') && to !== was)) lines.push(to === was ? `mode of '${name}' retained as ${shown(to)}` : `mode of '${name}' changed from ${shown(was)} to ${shown(to)}`)
      } catch (e) {
        fail((e as Error).message.replace(`'${abs}'`, `'${name}'`))
      }
    }
  }
  if (errors.length) {
    if (lines.length) ctx.print(lines.join('\n'))
    throw new CmdError(errors.filter(Boolean).join('\n'))
  }
  return lines.join('\n')
}

export const chmodCommands: Record<string, Command> = {
  chmod: {
    desc: 'change file permissions (in /tmp, your browser files and Seafile)',
    usage: 'chmod [-R] <mode> <file>...   (e.g. chmod +x script.msh, chmod 755 dir)',
    man: CHMOD_MAN,
    run: chmod,
    complete: (_args, word) => (word.startsWith('-') ? [{ value: '-R', label: '-R', hint: 'recursive' }].filter((o) => o.value.startsWith(word)) : []),
  },
}
