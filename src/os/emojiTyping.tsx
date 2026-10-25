import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent, type RefObject } from 'react'
import { emojiReady, emojiTyping, loadEmoji, onEmojiLoaded, search, type EmojiHit } from '../data/emoji'
import { flagPref } from './localPref'

/** Settings → Language & region: replace :name: with its emoji while typing, and offer names after ":ab". Per browser. */
export const emojiTypingPref = flagPref('mvlos.emoji-typing', true)

/**
 * Emoji shortcodes in a text box (the Agents composer, the Notebook editor): after ":" and two
 * letters a list of matching names opens (arrows, Tab or Enter pick, Escape closes, a tap picks),
 * and a finished ":name:" followed by a space or punctuation turns into its emoji right away. The
 * rules about code and URLs are in src/data/emoji (emojiTyping). Use `change` from the box's
 * onChange, `keyDown` first in its onKeyDown (true: it handled the key), and render `popup` near it.
 */
export function useEmojiTyping(box: RefObject<HTMLTextAreaElement | null>, text: string) {
  const on = emojiTypingPref.use()
  const ready = useSyncExternalStore(onEmojiLoaded, emojiReady, () => false)
  const [at, setAt] = useState<{ start: number; caret: number; query: string } | null>(null)
  const [index, setIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const setter = useRef<((value: string, caret: number) => void) | null>(null)
  const pending = useRef<number | null>(null)

  // After a replacement the box is controlled, so the caret has to be put back once the new text is in.
  useLayoutEffect(() => {
    if (pending.current === null) return
    const el = box.current
    if (el) el.setSelectionRange(pending.current, pending.current)
    pending.current = null
  }, [text, box])

  const hits: EmojiHit[] = at && ready ? search(at.query, 8) : []
  const open = on && at !== null && hits.length > 0 && dismissed !== `${at.start}:${at.query}`

  const change = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>, set: (value: string, caret: number) => void) => {
      const value = e.target.value
      const caret = e.target.selectionStart
      set(value, caret)
      setter.current = set
      if (!on || !value.includes(':')) return void setAt(null)
      if (!emojiReady()) void loadEmoji()
      const t = emojiTyping(value, caret)
      if (t?.kind === 'replace') {
        const next = value.slice(0, t.start) + t.text + value.slice(t.end)
        pending.current = t.start + t.text.length
        set(next, pending.current)
        setAt(null)
      } else if (t?.kind === 'query') {
        setAt({ start: t.start, caret, query: t.query })
        setIndex(0)
      } else setAt(null)
    },
    [on],
  )

  // The names finish loading after the first colon was typed: look again at what is there now.
  useEffect(() => {
    const el = box.current
    if (!ready || !on || !el || document.activeElement !== el) return
    const t = emojiTyping(el.value, el.selectionStart)
    if (t?.kind === 'query') setAt({ start: t.start, caret: el.selectionStart, query: t.query })
    // Only when the names arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  const pick = useCallback(
    (hit: EmojiHit) => {
      const el = box.current
      if (!at || !el || !setter.current) return
      const value = el.value
      const next = value.slice(0, at.start) + hit.emoji + ' ' + value.slice(at.caret)
      pending.current = at.start + hit.emoji.length + 1
      setter.current(next, pending.current)
      setAt(null)
      el.focus()
    },
    [at, box],
  )

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setDismissed(`${at!.start}:${at!.query}`)
      return true
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length)
      return true
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey)) {
      e.preventDefault()
      pick(hits[Math.min(index, hits.length - 1)])
      return true
    }
    return false
  }

  /** Where the caret moved without typing (a click, the arrows): the list follows or closes. */
  const select = (el: HTMLTextAreaElement) => {
    if (!at) return
    if (el.selectionStart !== at.caret) setAt(null)
  }

  const popup = open ? (
    <ul className="agt-slash emoji-pop" role="listbox" aria-label="Emoji">
      {hits.map((h, i) => (
        <li key={h.name} role="option" aria-selected={i === index} onMouseEnter={() => setIndex(i)}>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)}>
            <span className="emoji-pop-glyph" aria-hidden>
              {h.emoji}
            </span>
            :{h.name}:
          </button>
        </li>
      ))}
    </ul>
  ) : null

  return { change, keyDown, select, popup, open }
}
