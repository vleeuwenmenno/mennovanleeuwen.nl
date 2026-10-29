import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useDropTarget, type DragItem } from '../../os/dnd'
import { continueList } from './editor'
import type { Descriptor } from './package'
const linkOf = (item: DragItem) => {
  const launcher = item.kind === 'launcher' ? item : item.kind === 'file' ? item.launcher : null
  if (!launcher?.url || !/^https?:\/\//i.test(launcher.url)) return null
  return `[${launcher.label.replace(/[[\]]/g, '')}](${launcher.url})`
}
export function NativeEditor({ value, write }: { value: string; write: (text: string, expected: string) => string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const baseline = useRef(value)
  const commit = (el: HTMLTextAreaElement) => {
    const actual = write(el.value, baseline.current)
    baseline.current = actual
    if (el.value !== actual) el.value = actual
  }
  const insert = (start: number, end: number, text: string) => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(start, end)
    // Native edit transaction preserves undo and caret. Fallback is needed in some engines.
    if (!document.execCommand('insertText', false, text)) el.setRangeText(text, start, end, 'end')
    commit(el)
  }
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (composing.current) return
    if (el.value !== value) {
      const start = el.selectionStart, end = el.selectionEnd
      el.value = value
      el.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length))
    }
    baseline.current = value
    el.style.maxHeight = 'none'
    el.style.height = 'auto'
    el.style.height = `${Math.max(90, el.scrollHeight)}px`
  }, [value])
  useDropTarget(ref, {
    accept: drag => drag.items.some(linkOf) ? 'link' : null,
    drop: drag => {
      const el = ref.current
      const links = drag.items.map(linkOf).filter(Boolean).join('\n')
      if (el && links) insert(el.value.length, el.value.length, `${el.value && !el.value.endsWith('\n') ? '\n' : ''}${links}`)
    },
  })
  return <textarea ref={ref} className="wp-editor sticky-text selectable" aria-label="Note text" defaultValue={value} placeholder="Write something… (- [ ] makes a checklist)" spellCheck
    onChange={e => commit(e.currentTarget)}
    onCompositionStart={() => { composing.current = true }}
    onCompositionEnd={e => { composing.current = false; commit(e.currentTarget) }}
    onKeyDown={e => {
      if (e.key !== 'Enter' || e.nativeEvent.isComposing || composing.current || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      const el = e.currentTarget
      const transaction = continueList(el.value, el.selectionStart, el.selectionEnd)
      if (!transaction) return
      e.preventDefault()
      insert(transaction.start, transaction.end, transaction.text)
    }} />
}
export function Renderer({ view, note, write, event, actionsEnabled = true }: { view: Descriptor; note?: string; write?: (text: string, expected: string) => string; actionsEnabled?: boolean; event: (id: string) => void }) {
  const render = (node: Descriptor, path: string): ReactNode => {
    const className = `wp-${node.type} wp-${node.tone ?? 'normal'}`
    if (node.type === 'text') return <span key={path} className={className}>{node.text}</span>
    if (node.type === 'button') return <button key={path} className={className} disabled={!node.event || !actionsEnabled} onClick={() => node.event && event(node.event)}>{node.text}</button>
    if (node.type === 'editor') return null
    return <div key={path} className={className}>{node.children?.map((child, index) => render(child, `${path}.${index}`))}</div>
  }
  return <>{note !== undefined && write && <NativeEditor key="native-editor" value={note} write={write} />}{render(view, 'root')}</>
}
