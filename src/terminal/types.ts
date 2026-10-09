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
  /** On the text console: start the desktop. With `launch`, on an empty desk with just that app. */
  startx?: (launch?: { app: AppId; props?: Record<string, string> }) => void
  setAccent: (name: string) => boolean
  /** Writes a line to the screen right away (for commands that stream, like ping). */
  print: (text: string) => void
  /** True when output goes to the screen rather than into a pipe or redirect. */
  tty: boolean
  /** Running as root (sudo, for the signed-in owner): may write /etc/fstab and mount */
  root?: boolean
  /** Redraws one block of output in place (htop, watch, cmatrix); null removes it again. */
  /** `alt`: the alternate screen, like nano's: only this block shows while it is up */
  live: (text: string | null, opts?: { alt?: boolean }) => void
  /** Terminal size in characters, for full-screen programs. */
  size: { cols: number; rows: number }
  /** Receives keys typed while the command runs (q in htop); return true to swallow the key. */
  /**
   * `raw` handlers also get Ctrl and Alt combinations (as ^X and M-x), F-keys (F1…F12) and pastes
   * (key 'Paste', with the text), before the shell or the desktop sees them.
   */
  onKey: (handler: ((key: string, text?: string) => boolean) | null, opts?: { raw?: boolean }) => void
  /** Aborted by Ctrl+C. */
  signal: AbortSignal
}

