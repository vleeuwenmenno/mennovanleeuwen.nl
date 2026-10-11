// The agents TUI's prompt: a small multi-line editor with readline's keys, history and pastes that
// fold into a placeholder ([Pasted text #1 +12 lines]) until the message goes out.

const HISTORY_KEY = 'mvlos.agents.history'

function loadHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-200) : []
  } catch {
    return []
  }
}

export class Editor {
  text = ''
  cursor = 0
  private history = loadHistory()
  private histIdx: number | null = null
  private draft = ''
  private pastes = new Map<number, string>()
  private pasteN = 0

  set(text: string) {
    this.text = text
    this.cursor = text.length
  }

  clear() {
    this.set('')
    this.histIdx = null
  }

  insert(s: string) {
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor)
    this.cursor += s.length
    this.histIdx = null
  }

  /** A paste: short ones go in as typed, long or multi-line ones as a placeholder. */
  paste(s: string) {
    const text = s.replace(/\r\n?/g, '\n')
    const n = text.split('\n').length
    if (n <= 2 && text.length <= 600) return this.insert(text)
    const id = ++this.pasteN
    this.pastes.set(id, text)
    this.insert(`[Pasted text #${id} +${n} lines]`)
  }

  /** The text with placeholders replaced by what was pasted. */
  expanded(): string {
    return this.text.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (m, id: string) => this.pastes.get(Number(id)) ?? m)
  }

  backspace() {
    if (!this.cursor) return
    // A placeholder goes in one piece.
    const before = this.text.slice(0, this.cursor)
    const ph = /\[Pasted text #\d+ \+\d+ lines\]$/.exec(before)
    const n = ph ? ph[0].length : 1
    this.text = before.slice(0, -n) + this.text.slice(this.cursor)
    this.cursor -= n
  }

  del() {
    this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1)
  }

  left() {
    this.cursor = Math.max(0, this.cursor - 1)
  }
  right() {
    this.cursor = Math.min(this.text.length, this.cursor + 1)
  }

  private lineStart() {
    return this.text.lastIndexOf('\n', this.cursor - 1) + 1
  }
  private lineEnd() {
    const i = this.text.indexOf('\n', this.cursor)
    return i < 0 ? this.text.length : i
  }
  home() {
    this.cursor = this.lineStart()
  }
  end() {
    this.cursor = this.lineEnd()
  }
  wordLeft() {
    const m = /\S+\s*$/.exec(this.text.slice(0, this.cursor))
    this.cursor = m ? m.index : 0
  }
  wordRight() {
    const m = /^\s*\S+/.exec(this.text.slice(this.cursor))
    this.cursor = m ? this.cursor + m[0].length : this.text.length
  }
  killToEnd() {
    const end = this.lineEnd()
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end === this.cursor ? end + 1 : end)
  }
  killToStart() {
    const start = this.lineStart()
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor)
    this.cursor = start
  }
  killWord() {
    const m = /\S+\s*$|\s+$/.exec(this.text.slice(0, this.cursor))
    const from = m ? m.index : 0
    this.text = this.text.slice(0, from) + this.text.slice(this.cursor)
    this.cursor = from
  }

  /** ↑: up a line, or back through history on the first line. */
  up(): void {
    const start = this.lineStart()
    if (start > 0) {
      const col = this.cursor - start
      const prevStart = this.text.lastIndexOf('\n', start - 2) + 1
      this.cursor = Math.min(prevStart + col, start - 1)
      return
    }
    if (!this.history.length) return
    if (this.histIdx === null) {
      this.draft = this.text
      this.histIdx = this.history.length
    }
    if (this.histIdx === 0) return
    this.histIdx--
    this.text = this.history[this.histIdx]
    this.cursor = this.text.length
  }

  /** ↓: down a line, or forward through history on the last line. */
  down(): void {
    const end = this.lineEnd()
    if (end < this.text.length) {
      const col = this.cursor - this.lineStart()
      const nextEnd = this.text.indexOf('\n', end + 1)
      this.cursor = Math.min(end + 1 + col, nextEnd < 0 ? this.text.length : nextEnd)
      return
    }
    if (this.histIdx === null) return
    this.histIdx++
    if (this.histIdx >= this.history.length) {
      this.histIdx = null
      this.text = this.draft
    } else this.text = this.history[this.histIdx]
    this.cursor = this.text.length
  }

  /** Remembers a sent message for ↑. */
  remember(text: string) {
    if (!text.trim() || this.history[this.history.length - 1] === text) return
    this.history = [...this.history, text].slice(-200)
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history))
    } catch {
      /* history just won't last */
    }
  }

  /** The word at the cursor, when it starts with one of `marks` (/ or @), for completion. */
  wordAtCursor(): { word: string; start: number } | null {
    const before = this.text.slice(0, this.cursor)
    const m = /(^|\s)([/@][^\s]*)$/.exec(before)
    if (!m) return null
    return { word: m[2], start: before.length - m[2].length }
  }

  /** Puts a completion in place of the word at the cursor. */
  complete(start: number, value: string) {
    const end = this.cursor
    this.text = this.text.slice(0, start) + value + this.text.slice(end)
    this.cursor = start + value.length
  }
}
