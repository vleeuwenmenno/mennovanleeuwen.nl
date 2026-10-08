import type { AppId, WinState } from '../os/wm'

/** A failure the shell prints as-is (in red, unless `raw` says the message is already formatted). */
export class CmdError extends Error {
  constructor(
    message: string,
    readonly raw = false,
  ) {
    super(message)
  }
}

export type Ctx = {
  args: string[]
  stdin: string | null
  cwd: string
  setCwd: (path: string) => void
  env: Record<string, string>
  history: string[]
  windows: WinState[]
  openApp: (app: AppId, props?: Record<string, string>) => void
  openNewApp: (app: AppId, props?: Record<string, string>) => void
  closeWindow: (pid: number) => void
  clear: () => void
  exit: () => void
  /** True on the detached text console reached by pausing the boot (no graphical session yet). */
  console?: boolean
  setAccent: (name: string) => boolean
  /** Writes a line to the screen right away (for commands that stream, like ping). */
  print: (text: string) => void
  /** True when output goes to the screen rather than into a pipe or redirect. */
  tty: boolean
  /** Aborted by Ctrl+C. */
  signal: AbortSignal
}

