import type { AppId, WinState } from '../os/wm'
import type { TermPort } from './vt/session'

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
  /** Opens this terminal's settings sheet (not on the text console). */
  openSettings?: () => void
  setAccent: (name: string) => boolean
  /** Writes a line to the screen right away (for commands that stream, like ping). */
  print: (text: string) => void
  /** True when output goes to the screen rather than into a pipe or redirect. */
  tty: boolean
  /**
   * Writes text to the output exactly as given. A command's returned text gets a newline added when
   * it lacks one; cat, head -c and tail -c use this to pass bytes through untouched.
   */
  raw?: (text: string) => void
  /** Running as root (sudo, for the signed-in user): may write /etc/fstab and mount */
  root?: boolean
  /** Redraws one block of output in place (htop, watch, cmatrix); null removes it again. */
  /** `alt`: the alternate screen, like nano's: only this block shows while it is up */
  /** `hideInput`: the program draws its own prompt in the block, so the shell's stays out of sight */
  live: (text: string | null, opts?: { alt?: boolean; hideInput?: boolean }) => void
  /** Terminal size in characters, for full-screen programs; kept up to date while the command runs. */
  size: { cols: number; rows: number }
  /** Called when the terminal changes size while the command runs (agents redraws); null stops it. */
  onResize?: (handler: (() => void) | null) => void
  /** Receives keys typed while the command runs (q in htop); return true to swallow the key. */
  /**
   * `raw` handlers also get Ctrl and Alt combinations (as ^X and M-x), F-keys (F1…F12), pastes
   * (key 'Paste', with the text) and text typed without key presses (key 'Text': phone keyboards,
   * IME), before the shell or the desktop sees them.
   */
  /** `shift` (with raw): Shift with a key that is not a character comes as S-Tab, S-Enter, S-ArrowUp… */
  onKey: (handler: ((key: string, text?: string) => boolean) | null, opts?: { raw?: boolean; shift?: boolean }) => void
  /** Aborted by Ctrl+C. */
  signal: AbortSignal
  /**
   * Hands the window to a byte stream (SSH, `vtdemo`): its output goes through the VT emulator
   * and keys go to it as xterm sends them, until the port detaches (see src/terminal/vt/session.ts).
   * Only where the output goes to a terminal window; absent in pipes and the agents' terminal tool.
   */
  attachStream?: () => TermPort
}

