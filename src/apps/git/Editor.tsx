import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { MarkdownPreview } from '../../data/markdown/MarkdownPreview'
import { ask } from '../../os/Dialogs'
import { htmlToMarkdown } from './markdown'
import type { At } from './route'
import { Tabs } from './ui'

// Writing in the Git app: a new comment, or a description or comment of your own being edited.
// One Markdown editor with Write and Preview, Ctrl/Cmd+Enter to send. What is typed is kept as a
// draft per pull request or issue: in memory for this page, and in sessionStorage when the browser
// allows it (so a reload doesn't lose it either). Git.tsx asks before leaving an item, or closing
// the window, while one of its drafts holds unsent text.

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

const drafts = new Map<string, string>()
const STORE = 'mvlos.git.draft:'

/** The start of every draft key of one pull request or issue (they share numbers on both hosts). */
export const itemKey = (at: At, number: number) => `${at.src}/${at.owner}/${at.repo}#${number}:`.toLowerCase()

function loadDraft(key: string): string {
  if (drafts.has(key)) return drafts.get(key) ?? ''
  try {
    const text = sessionStorage.getItem(STORE + key) ?? ''
    if (text) drafts.set(key, text)
    return text
  } catch {
    return ''
  }
}

function saveDraft(key: string, text: string) {
  if (text.trim()) drafts.set(key, text)
  else drafts.delete(key)
  try {
    if (text.trim()) sessionStorage.setItem(STORE + key, text)
    else sessionStorage.removeItem(STORE + key)
  } catch {
    // Storage blocked or full: the draft lives in memory only.
  }
}

/** Whether any draft under `prefix` (an itemKey) has text that wasn't sent. */
export const hasUnsent = (prefix: string) => [...drafts.entries()].some(([k, v]) => k.startsWith(prefix) && !!v.trim())

/** Asks before text that wasn't sent is left behind; true to go on. */
export async function confirmLeave(what: string): Promise<boolean> {
  return ask({
    title: 'Leave without sending?',
    body: `What you wrote on ${what} isn't sent yet. It stays here as a draft for now.`,
    confirm: 'Leave',
    cancel: 'Keep writing',
  })
}

export function MarkdownEditor({
  draftKey,
  original,
  label,
  placeholder,
  submitLabel,
  busyLabel,
  allowEmpty = false,
  disabled = false,
  disabledHint,
  autoFocus = false,
  resolve,
  onSubmit,
  onCancel,
}: {
  draftKey: string
  /** Editing: the text as it is now (no draft is kept while nothing changed) */
  original?: string
  label: string
  placeholder?: string
  submitLabel: string
  busyLabel: string
  allowEmpty?: boolean
  disabled?: boolean
  /** Why writing is off, shown in place of the field's buttons */
  disabledHint?: ReactNode
  autoFocus?: boolean
  resolve: (url: string) => string
  /** Sends the text; throws to show its message */
  onSubmit: (text: string) => Promise<void>
  onCancel?: () => void
}) {
  const editing = original !== undefined
  const [text, setText] = useState(() => loadDraft(draftKey) || (original ?? ''))
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const preview = useMemo(() => (tab === 'preview' ? htmlToMarkdown(text) : ''), [tab, text])

  useEffect(() => {
    if (autoFocus) field.current?.focus({ preventScroll: true })
  }, [autoFocus])

  const change = (next: string) => {
    setText(next)
    setError(null)
    saveDraft(draftKey, editing && next === original ? '' : next)
  }
  const empty = !text.trim()
  const unchanged = editing && text === original
  const canSend = !disabled && !busy && !unchanged && (allowEmpty || !empty)

  const submit = async () => {
    if (!canSend) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(text)
      saveDraft(draftKey, '')
      if (!editing) {
        setText('')
        setTab('write')
      }
    } catch (e) {
      setError((e as Error).message || 'That did not work')
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (!onCancel) return
    if (!unchanged && !(await ask({ title: 'Discard your changes?', body: 'What you changed here is not saved.', confirm: 'Discard', cancel: 'Keep editing', danger: true }))) return
    saveDraft(draftKey, '')
    onCancel()
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className={`git-editor ${disabled ? 'is-off' : ''}`}>
      <div className="git-editor-tabs">
        <Tabs<'write' | 'preview'>
          small
          value={tab}
          onChange={setTab}
          options={[
            { id: 'write', label: 'Write' },
            { id: 'preview', label: 'Preview' },
          ]}
        />
        <span className="git-editor-note muted">Markdown</span>
      </div>
      {tab === 'write' ? (
        <textarea
          ref={field}
          id={id}
          className="git-input git-editor-field"
          aria-label={label}
          placeholder={placeholder}
          value={text}
          disabled={disabled || busy}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKey}
          rows={editing ? 10 : 5}
          spellCheck
        />
      ) : (
        <div className="git-md git-editor-preview selectable">{text.trim() ? <MarkdownPreview text={preview} resolveUrl={resolve} /> : <p className="muted">Nothing to preview.</p>}</div>
      )}
      {error && (
        <p className="git-editor-error" role="alert">
          {error}
        </p>
      )}
      <div className="git-editor-bar">
        {disabled && disabledHint ? (
          <span className="git-editor-hint">{disabledHint}</span>
        ) : (
          <span className="git-editor-hint git-editor-keys muted">{busy ? '' : `${MAC ? '⌘' : 'Ctrl'}+Enter to ${editing ? 'save' : 'send'}`}</span>
        )}
        <span className="git-editor-actions">
          {onCancel && (
            <button className="git-btn" onClick={() => void cancel()} disabled={busy}>
              Cancel
            </button>
          )}
          <button className="git-btn is-primary" onClick={() => void submit()} disabled={!canSend}>
            {busy ? busyLabel : submitLabel}
          </button>
        </span>
      </div>
    </div>
  )
}
