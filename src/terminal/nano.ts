import { lookup, MAX_TEXT, readFileText, writeFile } from './fs'
import { CmdError, type Ctx } from './types'
import { prettyPath, resolvePath } from './vfs'

// GNU nano 8.2, drawn on the terminal's alternate screen: the title bar, the text, the status line
// and the two help lines, with nano's own keys and messages. It edits /tmp, Seafile (through the
// mounts) and, with sudo, /etc/fstab. Browsers keep Ctrl+W, Ctrl+N and Ctrl+T for themselves, so
// where nano has a second key for something (F6 for Where Is, F2 for Exit…) that one works too;
// Ctrl+F searches, as in nano 8.

type Command = { desc: string; usage?: string; man?: string; run: (ctx: Ctx) => string | void | Promise<string | void> }

const VERSION = '8.2'
const c = (color: string, s: string) => `{c:${color}}${s}{/}`
/** File text can contain the terminal's own markup ({c:red}): a zero-width space defuses it. */
const esc = (s: string) => s.replace(/\{/g, '{​')

const HELP_TEXT = `Main nano help text

 The nano editor is designed to emulate the functionality and ease-of-use of the UW Pico text
 editor. There are four main sections of the editor. The top line shows the program version, the
 current filename being edited, and whether or not the file has been modified. Next is the main
 editor window showing the file being edited. The status line is the third line from the bottom
 and shows important messages. The bottom two lines show the most commonly used shortcuts in the
 editor.

 Shortcuts are written as follows: Control-key sequences are notated with a '^' and can be
 entered either by using the Ctrl key or pressing the Esc key twice. Meta-key sequences are
 notated with 'M-' and can be entered using either the Alt, Cmd, or Esc key, depending on your
 keyboard setup.

 ^G   F1    Display this help text
 ^X   F2    Close the current buffer / Exit from nano
 ^O   F3    Write the current buffer (or the marked region) to disk
 ^S         Save the file without prompting
 ^R   F5    Insert another file into current buffer (or into new buffer)

 ^F   F6    Search forward for a string or a regular expression
 ^B         Search backward for a string or a regular expression
 ^\\  M-R    Replace a string or a regular expression
 M-W        Search next occurrence forward
 M-Q        Search next occurrence backward

 ^K   F9    Cut current line (or marked region) and store it in cutbuffer
 ^U   F10   Paste the contents of cutbuffer at current cursor position
 ^C   F11   Display the position of the cursor
 ^/   M-G   Go to line and column number

 M-U        Undo the last operation
 M-E        Redo the last undone operation

 ^A   Home  Go to beginning of current line
 ^E   End   Go to end of current line
 ^Y   PgUp  Go one screenful up
 ^V   PgDn  Go one screenful down
 M-\\  ^Home Go to the first line of the file
 M-/  ^End  Go to the last line of the file

 Not here: ^W (the browser closes the tab with it; use ^F or F6), ^T Execute, ^J Justify and
 suspending with ^Z.`

const NANO_HELP = ` Usage: nano [OPTIONS] [[+LINE[,COLUMN]] FILE]...

To place the cursor on a specific line of a file, put the line number with
a '+' before the filename.  The column number can be added after a comma.
When a filename is '-', nano reads data from standard input.

 Option         Long option             Meaning
 -T <number>    --tabsize=<number>      Make a tab this number of columns wide
 -i             --autoindent            Automatically indent new lines
 -l             --linenumbers           Show line numbers in front of the text
 -v             --view                  View mode (read-only)
 -h             --help                  Show this help text and exit
 -V             --version               Print version information and exit`

const NANO_MAN = `${c('bold', 'NAME')}
       nano - Nano's ANOther editor, inspired by Pico

${c('bold', 'SYNOPSIS')}
       nano [options] [[+line[,column]] file]...

${c('bold', 'DESCRIPTION')}
       nano is a small and friendly editor. It edits files in /tmp, in your Seafile libraries
       (through the mounts in /etc/fstab: ~ and /mnt/seafile) and, with sudo, /etc/fstab itself.
       The rest of the filesystem is read-only.

${c('bold', 'OPTIONS')}
       -T number, --tabsize=number   Set the size (width) of a tab to number columns.
       -i, --autoindent              Indent new lines to the previous line's indentation.
       -l, --linenumbers             Display line numbers to the left of the text area.
       -v, --view                    View mode: read-only.
       -h, --help                    Show a summary of the command-line options and exit.
       -V, --version                 Show the current version number and exit.

${c('bold', 'KEYS')}
       ^G Help, ^X Exit, ^O Write Out, ^S Save, ^F Where Is, ^\\ Replace, ^K Cut, ^U Paste,
       ^C Location, ^/ Go To Line, M-U Undo, M-E Redo. ^G inside nano lists them all.

${c('bold', 'SEE ALSO')}
       fstab(5), sudo(8)`

type Prompt =
  | { kind: 'write'; value: string; exitAfter: boolean }
  | { kind: 'insert'; value: string }
  | { kind: 'search'; value: string; back: boolean }
  | { kind: 'replace'; value: string }
  | { kind: 'replaceWith'; value: string; find: string }
  | { kind: 'goto'; value: string }
  | { kind: 'saveModified' }
  | { kind: 'replaceThis'; find: string; with: string; count: number; from: { y: number; x: number } }

type Snapshot = { lines: string[]; cy: number; cx: number }

/** Where a mistake points, in nano's words: "Permission denied" and friends. */
function reason(err: unknown): string {
  const m = (err as Error).message ?? String(err)
  if (/permission denied/i.test(m)) return 'Permission denied'
  if (/read-only/i.test(m)) return 'Read-only file system'
  if (/is a directory/i.test(m)) return 'Is a directory'
  if (/no such file/i.test(m)) return 'No such file or directory'
  if (/transport endpoint/i.test(m)) return 'Transport endpoint is not connected'
  return m.replace(/^[^:]+: /, '')
}

async function nano(ctx: Ctx): Promise<string | void> {
  let tab = 8
  let lineNumbers = false
  let autoindent = false
  let view = false
  let startLine = 0
  let startCol = 0
  let file: string | null = null
  for (let i = 0; i < ctx.args.length; i++) {
    const a = ctx.args[i]
    if (a === '-h' || a === '--help') return NANO_HELP
    if (a === '-V' || a === '--version') return ` GNU nano, version ${VERSION}\n (C) 2024 the Free Software Foundation and various contributors\n Compiled options: --enable-utf8`
    if (a === '-l' || a === '--linenumbers') lineNumbers = true
    else if (a === '-i' || a === '--autoindent') autoindent = true
    else if (a === '-v' || a === '--view') view = true
    else if (a === '-T') tab = Math.max(1, Number(ctx.args[++i]) || 8)
    else if (a.startsWith('--tabsize=')) tab = Math.max(1, Number(a.slice(10)) || 8)
    else if (/^\+\d*(,\d+)?$/.test(a)) {
      const [l, col] = a.slice(1).split(',')
      startLine = Math.max(0, (Number(l) || 1) - 1)
      startCol = Math.max(0, (Number(col) || 1) - 1)
    } else if (a.startsWith('-') && a !== '-') throw new CmdError(`nano: invalid option -- '${a.replace(/^-+/, '')}'\nType 'nano -h' for a list of available options.`)
    else file ??= a
  }
  if (!ctx.tty) throw new CmdError('Too many errors from stdin')

  // --- the buffer ---------------------------------------------------------------------------------
  let lines: string[] = ['']
  let name = file ?? ''
  let message = ''
  let writable = true
  if (file === '-') {
    lines = (ctx.stdin ?? '').replace(/\n$/, '').split('\n')
    name = ''
    message = `[ Read ${lines.length} line${lines.length === 1 ? '' : 's'} ]`
  } else if (file) {
    const abs = resolvePath(ctx.cwd, file)
    const node = lookup(abs)
    if (node?.type === 'dir') {
      message = `[ "${file}" is a directory ]`
      name = ''
    } else if (node) {
      if (node.sf && (node.size ?? 0) > MAX_TEXT) throw new CmdError(`nano: ${file}: too big to edit here (over 2 MB)`)
      try {
        const read = await readFileText(abs)
        if (!read) throw new Error('No such file or directory')
        lines = read.text.replace(/\n$/, '').split('\n')
        writable = abs === '/etc/fstab' ? !!ctx.root : !read.ro || abs.startsWith('/tmp/')
        message = !writable ? `[ File '${file}' is unwritable ]` : `[ Read ${lines.length} line${lines.length === 1 ? '' : 's'} ]`
      } catch (e) {
        throw new CmdError(`nano: ${file}: ${reason(e)}`)
      }
    } else message = '[ New File ]'
  }
  if (view) message = message.replace(/ \]$/, ' (View mode) ]')

  let cy = Math.min(startLine, lines.length - 1)
  let cx = Math.min(startCol, lines[cy].length)
  let top = 0
  let left = 0
  let modified = false
  let prompt: Prompt | null = null
  let helpOpen = false
  let helpTop = 0
  let cut: string[] = []
  let lastWasCut = false
  let lastSearch = ''
  let wantX: number | null = null
  const undo: Snapshot[] = []
  const redo: Snapshot[] = []
  let typing = false

  const rows = Math.max(8, ctx.size.rows)
  const cols = Math.max(30, ctx.size.cols)
  const editRows = rows - 4

  const expand = (s: string) => {
    let out = ''
    for (const ch of s) out += ch === '\t' ? ' '.repeat(tab - (out.length % tab)) : ch
    return out
  }
  const colOf = (y: number, x: number) => expand(lines[y].slice(0, x)).length
  const xFromCol = (y: number, col: number) => {
    const line = lines[y]
    for (let x = 0; x <= line.length; x++) if (colOf(y, x) >= col) return x
    return line.length
  }

  const snapshot = () => {
    undo.push({ lines: lines.slice(), cy, cx })
    if (undo.length > 200) undo.shift()
    redo.length = 0
  }
  const edited = (grouped = false) => {
    if (!grouped || !typing) snapshot()
    typing = grouped
    modified = true
  }

  // --- drawing --------------------------------------------------------------------------------------
  const pad = (s: string, w = cols) => (s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length))
  const gutter = lineNumbers ? String(lines.length).length + 1 : 0

  function scroll() {
    if (cy < top) top = cy
    if (cy >= top + editRows) top = cy - editRows + 1
  }

  function bar(items: [string, string][]): string[] {
    const per = Math.ceil(items.length / 2)
    const w = Math.floor(cols / Math.max(1, per))
    const row = (part: [string, string][]) => part.map(([k, label]) => `${c('inverse', esc(k))} ${esc(pad(label, Math.max(0, w - k.length - 2)))} `).join('')
    return [row(items.slice(0, per)), row(items.slice(per))]
  }

  const MAIN: [string, string][] = [
    ['^G', 'Help'],
    ['^O', 'Write Out'],
    ['^F', 'Where Is'],
    ['^K', 'Cut'],
    ['^T', 'Execute'],
    ['^C', 'Location'],
    ['^X', 'Exit'],
    ['^R', 'Read File'],
    ['^\\', 'Replace'],
    ['^U', 'Paste'],
    ['^J', 'Justify'],
    ['^/', 'Go To Line'],
  ]

  function draw() {
    const out: string[] = []
    // Title bar.
    const title = name ? (name.startsWith('/') ? prettyPath(name) : name) : 'New Buffer'
    const right = modified ? 'Modified' : view || !writable ? '' : ''
    const head = `  GNU nano ${VERSION}`
    const mid = Math.max(head.length + 2, Math.floor((cols - title.length) / 2))
    let t = pad(head, mid) + title
    t = pad(t, cols - right.length - 2) + right
    out.push(c('inverse', esc(pad(t))))

    if (helpOpen) {
      const text = HELP_TEXT.split('\n')
      for (let i = 0; i < editRows + 1; i++) out.push(esc(pad(text[helpTop + i] ?? '')))
      out.push(...bar([['^X', 'Close'], ['^Y', 'Prev Page'], ['^V', 'Next Page'], ['^A', 'First Line'], ['^E', 'Last Line'], ['^C', 'Close']]))
      ctx.live(out.join('\n'), { alt: true })
      return
    }

    // Text.
    scroll()
    const width = cols - gutter
    const cursorCol = colOf(cy, cx)
    if (cursorCol < left || cursorCol >= left + width - 1) left = cursorCol < width - 1 ? 0 : cursorCol - width + 8
    for (let i = 0; i < editRows; i++) {
      const y = top + i
      const num = lineNumbers ? c('muted', y < lines.length ? String(y + 1).padStart(gutter - 1) + ' ' : ' '.repeat(gutter)) : ''
      if (y >= lines.length) {
        out.push(num)
        continue
      }
      const full = expand(lines[y])
      const off = y === cy ? left : 0
      let shown = full.slice(off, off + width)
      const more = full.length > off + width
      if (more) shown = `${shown.slice(0, width - 1)}>`
      if (off > 0) shown = `<${shown.slice(1)}`
      if (y === cy && !prompt) {
        const at = cursorCol - off
        const ch = shown[at] ?? ' '
        out.push(num + esc(shown.slice(0, at)) + c('inverse', esc(ch)) + esc(shown.slice(at + 1)))
      } else out.push(num + esc(shown))
    }

    // Status line: a prompt, or a message.
    if (prompt) {
      const label =
        prompt.kind === 'write'
          ? 'File Name to Write'
          : prompt.kind === 'insert'
            ? 'File to insert [from ./]'
            : prompt.kind === 'search'
              ? `Search${prompt.back ? ' Backward' : ''}${lastSearch ? ` [${lastSearch}]` : ''}`
              : prompt.kind === 'replace'
                ? `Search (to replace)${lastSearch ? ` [${lastSearch}]` : ''}`
                : prompt.kind === 'replaceWith'
                  ? 'Replace with'
                  : prompt.kind === 'goto'
                    ? 'Enter line number, column number'
                    : prompt.kind === 'saveModified'
                      ? 'Save modified buffer? '
                      : 'Replace this instance?'
      const value = 'value' in prompt ? prompt.value : ''
      const line = prompt.kind === 'saveModified' || prompt.kind === 'replaceThis' ? label : `${label}: ${value}`
      out.push(c('inverse', esc(pad(line, cols - 1))) + c('inverse', ' '))
      if (prompt.kind === 'saveModified') out.push(`${c('inverse', ' Y')} Yes`, `${c('inverse', ' N')} No           ${c('inverse', '^C')} Cancel`)
      else if (prompt.kind === 'replaceThis') out.push(`${c('inverse', ' Y')} Yes         ${c('inverse', ' A')} All`, `${c('inverse', ' N')} No          ${c('inverse', '^C')} Cancel`)
      else out.push(...bar([['^G', 'Help'], ['^C', 'Cancel'], ['M-U', 'Undo'], ['^Y', 'First Line'], ['^V', 'Last Line'], ['Tab', 'Complete']]))
    } else {
      const m = message ? `[ ${message.replace(/^\[ | \]$/g, '')} ]` : ''
      const at = Math.max(0, Math.floor((cols - m.length) / 2))
      out.push(m ? ' '.repeat(at) + c('inverse', esc(m)) : '')
      out.push(...bar(MAIN))
    }
    ctx.live(out.join('\n'), { alt: true })
  }

  // --- actions --------------------------------------------------------------------------------------
  const say = (m: string) => (message = m)

  async function save(target: string): Promise<boolean> {
    if (view) {
      say('[ Key is invalid in view mode ]')
      return false
    }
    const text = `${lines.join('\n')}\n`
    try {
      await writeFile(ctx.cwd, target, text, false, !!ctx.root, 'nano')
      name = target
      modified = false
      writable = true
      say(`[ Wrote ${lines.length} line${lines.length === 1 ? '' : 's'} ]`)
      return true
    } catch (e) {
      say(`[ Error writing ${target}: ${reason(e)} ]`)
      return false
    }
  }

  function find(needle: string, back: boolean, from: { y: number; x: number }): { y: number; x: number; wrapped: boolean } | null {
    const n = needle.toLowerCase()
    const total = lines.length
    for (let step = 0; step <= total; step++) {
      const y = back ? (from.y - step + total * 2) % total : (from.y + step) % total
      const line = lines[y].toLowerCase()
      let x: number
      if (step === 0) x = back ? line.lastIndexOf(n, from.x - 1) : line.indexOf(n, from.x + 1)
      else if (step === total) x = back ? line.lastIndexOf(n) : line.indexOf(n)
      else x = back ? line.lastIndexOf(n) : line.indexOf(n)
      if (step === 0 && x >= 0 && (back ? x >= from.x : x <= from.x)) x = -1
      if (x >= 0) return { y, x, wrapped: back ? y > from.y || (y === from.y && x >= from.x) : y < from.y || (y === from.y && x <= from.x) }
    }
    return null
  }

  function search(needle: string, back: boolean) {
    if (!needle) return say('[ Cancelled ]')
    lastSearch = needle
    const hit = find(needle, back, { y: cy, x: cx })
    if (!hit) return say(`[ "${needle}" not found ]`)
    const same = hit.y === cy && hit.x === cx
    cy = hit.y
    cx = hit.x
    say(same ? '[ This is the only occurrence ]' : hit.wrapped ? '[ Search Wrapped ]' : '')
  }

  function nextReplace(p: Extract<Prompt, { kind: 'replaceThis' }>, all: boolean) {
    let count = p.count
    for (;;) {
      const hit = find(p.find, false, { y: cy, x: cx - 1 })
      if (!hit || (hit.wrapped && (hit.y > p.from.y || (hit.y === p.from.y && hit.x >= p.from.x)) && count > 0)) break
      cy = hit.y
      cx = hit.x
      if (!all) {
        prompt = { ...p, count }
        return
      }
      lines[cy] = lines[cy].slice(0, cx) + p.with + lines[cy].slice(cx + p.find.length)
      cx += p.with.length
      count++
    }
    prompt = null
    say(`[ Replaced ${count} occurrence${count === 1 ? '' : 's'} ]`)
  }

  function location() {
    const total = lines.reduce((s, l) => s + l.length + 1, 0)
    const before = lines.slice(0, cy).reduce((s, l) => s + l.length + 1, 0) + cx
    const pct = (a: number, b: number) => Math.round((a / Math.max(1, b)) * 100)
    say(`[ line ${cy + 1}/${lines.length} (${pct(cy + 1, lines.length)}%), col ${colOf(cy, cx) + 1}/${expand(lines[cy]).length + 1} (${pct(colOf(cy, cx) + 1, expand(lines[cy]).length + 1)}%), char ${before + 1}/${total} (${pct(before + 1, total)}%) ]`)
  }

  function insertText(text: string) {
    const parts = text.replace(/\r\n?/g, '\n').split('\n')
    const line = lines[cy]
    const head = line.slice(0, cx)
    const tail = line.slice(cx)
    if (parts.length === 1) {
      lines[cy] = head + parts[0] + tail
      cx += parts[0].length
    } else {
      const added = [head + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + tail]
      lines.splice(cy, 1, ...added)
      cy += parts.length - 1
      cx = parts[parts.length - 1].length
    }
  }

  // --- keys ------------------------------------------------------------------------------------------
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      done = true
      ctx.onKey(null)
      ctx.live(null)
      resolve()
    }
    ctx.signal.addEventListener('abort', finish, { once: true })
    let busy = false

    async function onPromptKey(key: string, text?: string) {
      const p = prompt!
      if (key === '^C' || key === 'Escape') {
        prompt = null
        return say('[ Cancelled ]')
      }
      if (p.kind === 'saveModified') {
        const k = key.toLowerCase()
        if (k === 'y') {
          if (!name) prompt = { kind: 'write', value: '', exitAfter: true }
          else if (await save(name)) return finish()
          else prompt = null
        } else if (k === 'n') return finish()
        return
      }
      if (p.kind === 'replaceThis') {
        const k = key.toLowerCase()
        if (k === 'y' || k === 'a') {
          lines[cy] = lines[cy].slice(0, cx) + p.with + lines[cy].slice(cx + p.find.length)
          cx += p.with.length
          modified = true
          nextReplace({ ...p, count: p.count + 1 }, k === 'a')
        } else if (k === 'n') {
          cx += 1
          nextReplace(p, false)
        }
        return
      }
      if (key === 'Paste' && text !== undefined) p.value += text.replace(/\n/g, ' ')
      else if (key === 'Backspace') p.value = p.value.slice(0, -1)
      else if (key.length === 1) p.value += key
      else if (key === 'Enter') {
        prompt = null
        const v = p.value
        if (p.kind === 'write') {
          if (!v) return say('[ Cancelled ]')
          if ((await save(v)) && p.exitAfter) return finish()
        } else if (p.kind === 'insert') {
          if (!v) return say('[ Cancelled ]')
          const read = await readFileText(resolvePath(ctx.cwd, v)).catch((e) => {
            say(`[ Error reading ${v}: ${reason(e)} ]`)
            return undefined
          })
          if (read === null) say(`[ Error reading ${v}: No such file or directory ]`)
          if (read) {
            edited()
            insertText(read.text)
            say(`[ Read ${read.text.split('\n').length} lines ]`)
          }
        } else if (p.kind === 'search') search(v || lastSearch, p.back)
        else if (p.kind === 'replace') {
          const needle = v || lastSearch
          if (!needle) return say('[ Cancelled ]')
          lastSearch = needle
          prompt = { kind: 'replaceWith', value: '', find: needle }
        } else if (p.kind === 'replaceWith') {
          snapshot()
          const from = { y: cy, x: cx }
          cx = Math.max(0, cx)
          nextReplace({ kind: 'replaceThis', find: p.find, with: v, count: 0, from }, false)
          if (!prompt) say(`[ "${p.find}" not found ]`)
        } else if (p.kind === 'goto') {
          const [l, col] = v.split(/[,\s]+/).map((n) => Number(n))
          if (!v || Number.isNaN(l)) return say('[ Invalid line or column number ]')
          cy = Math.min(lines.length - 1, Math.max(0, (l < 0 ? lines.length + l + 1 : l) - 1))
          cx = Math.min(lines[cy].length, Math.max(0, xFromCol(cy, (col || 1) - 1)))
        }
      }
    }

    async function onKey(key: string, text?: string) {
      if (helpOpen) {
        if (key === '^X' || key === '^C' || key === 'q' || key === 'F2' || key === 'Escape') helpOpen = false
        else if (key === 'ArrowDown') helpTop = Math.min(helpTop + 1, Math.max(0, HELP_TEXT.split('\n').length - editRows))
        else if (key === 'ArrowUp') helpTop = Math.max(0, helpTop - 1)
        else if (key === '^V' || key === 'PageDown') helpTop = Math.min(helpTop + editRows, Math.max(0, HELP_TEXT.split('\n').length - editRows))
        else if (key === '^Y' || key === 'PageUp') helpTop = Math.max(0, helpTop - editRows)
        return
      }
      if (prompt) return onPromptKey(key, text)
      const wasCut = lastWasCut
      lastWasCut = false
      if (!['ArrowUp', 'ArrowDown', '^P', '^N', 'PageUp', 'PageDown', '^Y', '^V'].includes(key)) wantX = null
      if (key.length === 1 || key === 'Enter' || key === 'Tab' || key === 'Backspace' || key === 'Delete' || key === 'Paste') {
        if (view) return say('[ Key is invalid in view mode ]')
        message = ''
      }
      const line = lines[cy]
      switch (key) {
        // Moving.
        case 'ArrowLeft':
          if (cx > 0) cx--
          else if (cy > 0) cx = lines[--cy].length
          break
        case 'ArrowRight':
          if (cx < line.length) cx++
          else if (cy < lines.length - 1) {
            cy++
            cx = 0
          }
          break
        case 'ArrowUp':
        case '^P':
        case 'ArrowDown':
        case '^N': {
          wantX ??= colOf(cy, cx)
          const up = key === 'ArrowUp' || key === '^P'
          if (up ? cy > 0 : cy < lines.length - 1) cy += up ? -1 : 1
          cx = xFromCol(cy, wantX)
          break
        }
        case 'Home':
        case '^A':
          cx = 0
          break
        case 'End':
        case '^E':
          cx = line.length
          break
        case 'PageUp':
        case '^Y':
        case 'PageDown':
        case '^V': {
          wantX ??= colOf(cy, cx)
          const down = key === 'PageDown' || key === '^V'
          cy = Math.max(0, Math.min(lines.length - 1, cy + (down ? editRows - 2 : -(editRows - 2))))
          top = Math.max(0, Math.min(top + (down ? editRows - 2 : -(editRows - 2)), Math.max(0, lines.length - editRows)))
          cx = xFromCol(cy, wantX)
          break
        }
        case '^Home':
        case 'M-\\':
          cy = 0
          cx = 0
          break
        case '^End':
        case 'M-/':
          cy = lines.length - 1
          cx = lines[cy].length
          break

        // Typing.
        case 'Enter': {
          edited()
          const indent = autoindent ? (/^[ \t]*/.exec(line)?.[0] ?? '') : ''
          lines.splice(cy, 1, line.slice(0, cx), indent + line.slice(cx))
          cy++
          cx = indent.length
          break
        }
        case 'Tab':
          edited(true)
          insertText('\t')
          break
        case 'Backspace':
          edited()
          if (cx > 0) {
            lines[cy] = line.slice(0, cx - 1) + line.slice(cx)
            cx--
          } else if (cy > 0) {
            cx = lines[cy - 1].length
            lines[cy - 1] += line
            lines.splice(cy--, 1)
          }
          break
        case 'Delete':
          edited()
          if (cx < line.length) lines[cy] = line.slice(0, cx) + line.slice(cx + 1)
          else if (cy < lines.length - 1) {
            lines[cy] += lines[cy + 1]
            lines.splice(cy + 1, 1)
          }
          break
        case 'Paste':
          edited()
          insertText(text ?? '')
          break

        // Commands.
        case '^G':
        case 'F1':
          helpOpen = true
          helpTop = 0
          break
        case '^X':
        case 'F2':
          if (!modified || view) return finish()
          prompt = { kind: 'saveModified' }
          break
        case '^O':
        case 'F3':
          if (view) return say('[ Key is invalid in view mode ]')
          prompt = { kind: 'write', value: name, exitAfter: false }
          break
        case '^S':
          if (!name) prompt = { kind: 'write', value: '', exitAfter: false }
          else await save(name)
          break
        case '^R':
        case 'F5':
          if (view) return say('[ Key is invalid in view mode ]')
          prompt = { kind: 'insert', value: '' }
          break
        case '^F':
        case 'F6':
          prompt = { kind: 'search', value: '', back: false }
          break
        case '^B':
          prompt = { kind: 'search', value: '', back: true }
          break
        case 'M-w':
        case 'M-q':
          if (!lastSearch) say('[ No current search pattern ]')
          else search(lastSearch, key === 'M-q')
          break
        case '^\\':
        case 'M-r':
          if (view) return say('[ Key is invalid in view mode ]')
          prompt = { kind: 'replace', value: '' }
          break
        case '^K':
        case 'F9':
          if (view) return say('[ Key is invalid in view mode ]')
          edited()
          cut = wasCut ? [...cut, line] : [line]
          if (lines.length > 1) lines.splice(cy, 1)
          else lines[0] = ''
          cy = Math.min(cy, lines.length - 1)
          cx = 0
          lastWasCut = true
          break
        case '^U':
        case 'F10':
          if (view) return say('[ Key is invalid in view mode ]')
          if (!cut.length) return say('[ Cutbuffer is empty ]')
          edited()
          lines.splice(cy, 0, ...cut)
          cy += cut.length
          cx = 0
          break
        case '^C':
        case 'F11':
          location()
          break
        case '^/':
        case '^_':
        case 'M-g':
          prompt = { kind: 'goto', value: '' }
          break
        case 'M-u': {
          const s = undo.pop()
          if (!s) return say('[ Nothing to undo ]')
          redo.push({ lines: lines.slice(), cy, cx })
          ;({ lines, cy, cx } = s)
          modified = true
          typing = false
          say('[ Undid action ]')
          break
        }
        case 'M-e': {
          const s = redo.pop()
          if (!s) return say('[ Nothing to redo ]')
          undo.push({ lines: lines.slice(), cy, cx })
          ;({ lines, cy, cx } = s)
          modified = true
          typing = false
          say('[ Redid action ]')
          break
        }
        case '^T':
          say('[ Execute is not available here ]')
          break
        case '^J':
          say('[ Justify is not available here ]')
          break
        case '^Z':
          say('[ Suspension is not available here ]')
          break
        case '^L':
          break
        default:
          if (key.length === 1) {
            edited(true)
            insertText(key)
            return
          }
      }
      if (key !== 'Tab') typing = false
    }

    // Keys nano has a use for; anything else (F12, Ctrl+Shift+I…) is left to the browser.
    const KNOWN = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '^P', '^N', 'Home', 'End', '^A', '^E', 'PageUp', 'PageDown', '^Y', '^V', '^Home', '^End', 'M-\\', 'M-/', 'Enter', 'Tab', 'Backspace', 'Delete', 'Paste', 'Escape', '^G', 'F1', '^X', 'F2', '^O', 'F3', '^S', '^R', 'F5', '^F', 'F6', '^B', 'M-w', 'M-q', '^\\', 'M-r', '^K', 'F9', '^U', 'F10', '^C', 'F11', '^/', '^_', 'M-g', 'M-u', 'M-e', '^T', '^J', '^Z', '^L'])
    ctx.onKey(
      (key, text) => {
        if (!helpOpen && !prompt && key.length !== 1 && !KNOWN.has(key)) return false
        if (busy) return true
        busy = true
        void onKey(key, text).finally(() => {
          busy = false
          if (!done) draw()
        })
        return true
      },
      { raw: true },
    )
    draw()
  })
}

export const nanoCommands: Record<string, Command> = {
  nano: { desc: "edit text files (GNU nano, in /tmp and Seafile)", usage: 'nano [-l] [-i] [-v] [-T n] [+line[,col]] [file]', man: NANO_MAN, run: nano },
}
