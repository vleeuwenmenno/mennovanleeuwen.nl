import { reserve, singleInput, textWork } from './bounds'
import { bytesToText, textToBytes } from './bytes'
import { readError } from './devices'
import { actorOf, cachedText, lookup } from './fs'
import { allows } from './modes'
import { CmdError, type Ctx } from './types'
import { resolvePath } from './vfs'

/** A file's text for a command (cat, grep, wc…): the errors a real read would give, a device's included. */
export function readFile(ctx: Pick<Ctx, 'cwd' | 'root' | 'policy' | 'signal' | 'budget'>, path: string, cmd: string): string {
  const abs = resolvePath(ctx.cwd, path)
  // An agent's call reads inside its work folder only, whichever command is asking.
  const outside = ctx.policy?.read(abs)
  if (outside) throw new CmdError(`${cmd}: ${outside}`)
  const node = lookup(abs)
  if (!node) throw new CmdError(`${cmd}: ${path}: No such file or directory`)
  if (node.type === 'dir') throw new CmdError(`${cmd}: ${path}: Is a directory`)
  const denied = readError(cmd, path, node.dev, !!ctx.root)
  if (denied) throw denied
  if (!allows(abs, node, 'r', !!ctx.root)) throw new CmdError(`${cmd}: ${path}: Permission denied`)
  return cachedText(abs, node, actorOf(ctx))
}

/** What the commands that work on bytes read: each file (or `-`, or no file at all: stdin) as bytes. */
export function readInputs(ctx: Ctx, files: string[], cmd: string): { name: string; bytes: Uint8Array }[] {
  singleInput(ctx, files.length)
  const convert = (text: string) => { textWork(ctx, text.length); return textToBytes(text) }
  if (!files.length) {
    if (ctx.stdin === null) throw new CmdError(`${cmd}: missing file operand`)
    return [{ name: '-', bytes: convert(ctx.stdin) }]
  }
  return files.map((name) => {
    if (name === '-') {
      if (ctx.stdin === null) throw new CmdError(`${cmd}: missing file operand`)
      return { name, bytes: convert(ctx.stdin) }
    }
    return { name, bytes: convert(readFile(ctx, name, cmd)) }
  })
}

/** Gives bytes to the output as they are (no newline added), or returns the text where there is no raw output. */
export function emit(ctx: Ctx, bytes: Uint8Array): string | void {
  reserve(ctx, bytes.length * 4)
  const text = bytesToText(bytes)
  if (ctx.raw) return void ctx.raw(text)
  return text
}
