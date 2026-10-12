// A byte stream attached to a Terminal window: the port a source (SSH, the replay demo in
// demo.ts) gets from `ctx.attachStream()`. Output goes through the emulator to the screen; keys,
// pastes, mouse reports and the emulator's answers come back through onData. See the README's
// "Streams: SSH and other byte sources".

import { VT, type Line } from './screen.ts'

export type TermSize = { cols: number; rows: number }

/** What a byte source gets when it attaches to a terminal window. */
export type TermPort = {
  /** Program output: UTF-8 bytes (a character split over two writes is fine) or text. */
  write(data: Uint8Array | string): void
  /**
   * Keys, pastes, mouse reports and replies to the program's requests, as the bytes an xterm
   * sends (text; encode it as UTF-8 for the wire). Returns a function that stops listening.
   */
  onData(cb: (data: string) => void): () => void
  /** The window changed size (in characters). Returns a function that stops listening. */
  onResize(cb: (size: TermSize) => void): () => void
  /** The size now: what to ask the remote end for (a PTY's columns and rows). */
  readonly size: TermSize
  /** Hands the window back to msh. The session's output stays in the scrollback. */
  detach(): void
  /** Settles once detached, by the source or by the user (Stop command, closing the window). */
  readonly detached: Promise<void>
}

export class VtSession implements TermPort {
  readonly vt: VT
  readonly detached: Promise<void>
  private dataListeners = new Set<(data: string) => void>()
  private resizeListeners = new Set<(size: TermSize) => void>()
  private drawListeners = new Set<() => void>()
  private done!: () => void
  private ended = false
  private onEnd: (lines: Line[]) => void
  /** A size the program asked for (CSI 8 t), kept whatever the window does; and the window's own. */
  private pinned: TermSize | null = null
  private windowSize: TermSize

  constructor(size: TermSize, opts: { onEnd: (lines: Line[]) => void; onTitle?: (title: string) => void; onBell?: () => void; colors?: () => { fg: string; bg: string } }) {
    this.onEnd = opts.onEnd
    this.windowSize = size
    this.vt = new VT({ ...size, onReply: (d) => this.send(d), onTitle: opts.onTitle, onBell: opts.onBell, colors: opts.colors, onResizeRequest: (cols, rows) => this.pin(cols, rows) })
    this.detached = new Promise((resolve) => (this.done = resolve))
  }

  get size(): TermSize {
    return { cols: this.vt.cols, rows: this.vt.rows }
  }

  get attached() {
    return !this.ended
  }

  write(data: Uint8Array | string) {
    if (this.ended) return
    this.vt.write(data)
    this.drawListeners.forEach((l) => l())
  }

  onData(cb: (data: string) => void) {
    this.dataListeners.add(cb)
    return () => void this.dataListeners.delete(cb)
  }

  onResize(cb: (size: TermSize) => void) {
    this.resizeListeners.add(cb)
    return () => void this.resizeListeners.delete(cb)
  }

  detach() {
    if (this.ended) return
    this.ended = true
    this.onEnd(this.vt.contentLines())
    this.dataListeners.clear()
    this.resizeListeners.clear()
    this.drawListeners.clear()
    this.done()
  }

  // --- the terminal's side ---------------------------------------------------------------------

  /** Input for the program (keys, pastes, mouse). */
  send(data: string) {
    if (this.ended || !data) return
    for (const l of this.dataListeners) l(data)
  }

  /** The window's size in characters changed. */
  resize(size: TermSize) {
    this.windowSize = size
    if (!this.pinned) this.apply(size)
  }

  private pin(cols: number, rows: number) {
    this.pinned = cols && rows ? { cols: Math.min(500, cols), rows: Math.min(200, rows) } : null
    this.apply(this.pinned ?? this.windowSize)
  }

  private apply(size: TermSize) {
    if (this.ended || (size.cols === this.vt.cols && size.rows === this.vt.rows)) return
    this.vt.resize(size.cols, size.rows)
    this.drawListeners.forEach((l) => l())
    for (const l of this.resizeListeners) l(this.size)
  }

  /** Called after output changed the screen, for the renderer. */
  onDraw(cb: () => void) {
    this.drawListeners.add(cb)
    return () => void this.drawListeners.delete(cb)
  }
}
