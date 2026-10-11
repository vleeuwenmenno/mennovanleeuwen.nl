import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parseMarkdown, type Block, type Inline } from './parse.ts'
import { highlight, knownLanguage } from './highlight.ts'

// Markdown as React elements, for Zed's preview, Notebook, Spotlight and the Agents app's
// answers. The parsing is in parse.ts (CommonMark with GitHub's tables, task lists and
// strikethrough) and the code colouring in highlight.ts; this file only maps the tree to elements,
// so nothing from the text is ever injected as HTML. Zed.tsx re-exports MarkdownPreview, where it
// used to live.

function inlines(nodes: Inline[], key: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`
    switch (n.type) {
      case 'text':
        return n.text
      // A plain line break is a space in a paragraph; with `breaks` the paragraph keeps it (pre-wrap).
      case 'soft':
        return '\n'
      case 'br':
        return <br key={k} />
      case 'code':
        return <code key={k}>{n.text}</code>
      case 'em':
        return <em key={k}>{inlines(n.children, k)}</em>
      case 'strong':
        return <strong key={k}>{inlines(n.children, k)}</strong>
      case 'del':
        return <del key={k}>{inlines(n.children, k)}</del>
      case 'link':
        return (
          <a key={k} href={n.href} title={n.title} target="_blank" rel="noopener noreferrer">
            {inlines(n.children, k)}
          </a>
        )
      case 'image':
        return <img key={k} className="md-img" src={n.src} alt={n.alt} title={n.title} loading="lazy" referrerPolicy="no-referrer" />
    }
  })
}

function blocks(nodes: Block[], breaks: boolean, key: string, tight = false): ReactNode[] {
  return nodes.map((b, i) => {
    const k = `${key}.${i}`
    switch (b.type) {
      case 'paragraph':
        // Items of a tight list hold their text directly, without the spacing of a paragraph.
        if (tight) return <span key={k}>{inlines(b.children, k)}</span>
        return (
          <p key={k} className={breaks ? 'md-breaks' : undefined}>
            {inlines(b.children, k)}
          </p>
        )
      case 'heading': {
        const Tag = `h${b.level}` as const
        return <Tag key={k}>{inlines(b.children, k)}</Tag>
      }
      case 'hr':
        return <hr key={k} />
      case 'code':
        return <CodeBlock key={k} lang={b.lang} code={b.text} />
      case 'quote':
        return <blockquote key={k}>{blocks(b.children, breaks, k)}</blockquote>
      case 'list': {
        const items = b.items.map((item, j) => {
          const ik = `${k}.${j}`
          const task = item.checked !== null
          const box = task && <input key="box" type="checkbox" checked={!!item.checked} readOnly tabIndex={-1} aria-hidden />
          const kids = item.children
          // The checkbox goes inside the first paragraph, so it sits on the text's line.
          if (task && kids[0]?.type === 'paragraph') {
            const [first, ...rest] = kids
            const lead = b.tight ? (
              <span key="lead">
                {box}
                {inlines(first.children, `${ik}.0`)}
              </span>
            ) : (
              <p key="lead" className={breaks ? 'md-breaks' : undefined}>
                {box}
                {inlines(first.children, `${ik}.0`)}
              </p>
            )
            return (
              <li key={j} className={`md-task ${item.checked ? 'is-done' : ''}`}>
                {lead}
                {blocks(rest, breaks, `${ik}r`, b.tight)}
              </li>
            )
          }
          return (
            <li key={j} className={task ? `md-task ${item.checked ? 'is-done' : ''}` : undefined}>
              {box}
              {blocks(kids, breaks, ik, b.tight)}
            </li>
          )
        })
        return b.ordered ? (
          <ol key={k} start={b.start !== 1 ? b.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        )
      }
      case 'table':
        return (
          <div key={k} className="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                      {inlines(c, `${k}h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, n) => (
                  <tr key={n}>
                    {r.map((c, j) => (
                      <td key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                        {inlines(c, `${k}r${n}c${j}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    }
  })
}

/** A fenced code block, coloured when its language is known, with a button that copies it. */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const tokens = useMemo(() => highlight(code, lang), [code, lang])
  const copy = () =>
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  return (
    <div className="md-code">
      <pre data-lang={lang || undefined}>
        <code className={knownLanguage(lang) ? `lang-${lang.toLowerCase()}` : undefined}>
          {tokens.map((t, i) => (t.cls ? <span key={i} className={`hl-${t.cls}`}>{t.text}</span> : t.text))}
        </code>
      </pre>
      <button type="button" className={`md-copy ${copied ? 'is-done' : ''}`} onClick={copy} title="Copy the code" aria-label={copied ? 'Copied' : 'Copy the code'}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

/**
 * Markdown as React nodes. `breaks` keeps a paragraph's line breaks and spacing, like a chat
 * message (the Agents app's own messages); otherwise its lines join into one, as Markdown does.
 */
export function MarkdownPreview({ text, breaks = false }: { text: string; breaks?: boolean }) {
  const tree = useMemo(() => parseMarkdown(text), [text])
  return <>{blocks(tree, breaks, 'b')}</>
}
