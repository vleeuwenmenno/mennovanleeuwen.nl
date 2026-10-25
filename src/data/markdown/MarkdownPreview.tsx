import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parseMarkdown, type Block, type Inline } from './parse.ts'
import { highlight, knownLanguage } from './highlight.ts'
import { useFurigana } from '../furigana.ts'
import { joinText, moneyPieces } from '../money.ts'
import { MoneyAmount } from '../../os/MoneyAmount.tsx'

// Markdown as React elements, for Zed's preview, Notebook, Spotlight and the Agents app's
// answers. The parsing is in parse.ts (CommonMark with GitHub's tables, task lists and
// strikethrough) and the code colouring in highlight.ts; this file only maps the tree to elements,
// so nothing from the text is ever injected as HTML. Zed.tsx re-exports MarkdownPreview, where it
// used to live.

/**
 * Furigana, {漢字|かんじ} in the text. How it shows is Settings → Language & region (Always, On hover, Off):
 * a data attribute on the root that the rules in styles.css read. <rp> keeps "漢字(かんじ)"
 * readable where ruby is not drawn. In On hover the word can be focused, so a keyboard reaches it.
 */
function Ruby({ base, reading }: { base: string; reading: string }) {
  const hover = useFurigana() === 'hover'
  return (
    <ruby tabIndex={hover ? 0 : undefined}>
      {base}
      <rp>(</rp>
      <rt>{reading}</rt>
      <rp>)</rp>
    </ruby>
  )
}

/**
 * Where relative links and images point: a README's are relative to its repository (the Git app),
 * so it says how to make them absolute. Without one they are left as written.
 */
const ResolveUrl = createContext<((url: string, image: boolean) => string) | null>(null)

function MdLink({ href, title, children }: { href: string; title?: string; children: ReactNode }) {
  const resolve = useContext(ResolveUrl)
  return (
    <a href={resolve ? resolve(href, false) : href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

function MdImage({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const resolve = useContext(ResolveUrl)
  return <img className="md-img" src={resolve ? resolve(src, true) : src} alt={alt} title={title} loading="lazy" referrerPolicy="no-referrer" />
}

/** Amounts of money in plain text as buttons that open their exchange rates (src/data/money.ts). */
function moneyText(text: string, key: string): ReactNode {
  const pieces = moneyPieces(text)
  if (pieces.length === 1 && typeof pieces[0] === 'string') return text
  return pieces.map((p) => (typeof p === 'string' ? p : <MoneyAmount key={`${key}m${p.start}`} hit={p} />))
}

/** `money`: amounts in the text are clickable; never inside a link (its words or address) or code. */
function inlines(nodes: Inline[], key: string, money = false): ReactNode[] {
  return (money ? joinText(nodes) : nodes).map((n, i) => {
    const k = `${key}.${i}`
    switch (n.type) {
      case 'text':
        return money ? <Fragment key={k}>{moneyText(n.text, k)}</Fragment> : n.text
      // A plain line break is a space in a paragraph; with `breaks` the paragraph keeps it (pre-wrap).
      case 'soft':
        return '\n'
      case 'br':
        return <br key={k} />
      case 'code':
        return <code key={k}>{n.text}</code>
      case 'ruby':
        return <Ruby key={k} base={n.base} reading={n.reading} />
      case 'em':
        return <em key={k}>{inlines(n.children, k, money)}</em>
      case 'strong':
        return <strong key={k}>{inlines(n.children, k, money)}</strong>
      case 'del':
        return <del key={k}>{inlines(n.children, k, money)}</del>
      case 'link':
        return (
          <MdLink key={k} href={n.href} title={n.title}>
            {inlines(n.children, k)}
          </MdLink>
        )
      case 'image':
        return <MdImage key={k} src={n.src} alt={n.alt} title={n.title} />
    }
  })
}

function blocks(nodes: Block[], breaks: boolean, key: string, tight = false, money = false): ReactNode[] {
  return nodes.map((b, i) => {
    const k = `${key}.${i}`
    switch (b.type) {
      case 'paragraph':
        // Items of a tight list hold their text directly, without the spacing of a paragraph.
        if (tight) return <span key={k}>{inlines(b.children, k, money)}</span>
        return (
          <p key={k} className={breaks ? 'md-breaks' : undefined}>
            {inlines(b.children, k, money)}
          </p>
        )
      case 'heading': {
        const Tag = `h${b.level}` as const
        return <Tag key={k}>{inlines(b.children, k, money)}</Tag>
      }
      case 'hr':
        return <hr key={k} />
      case 'code':
        return <CodeBlock key={k} lang={b.lang} code={b.text} />
      case 'quote':
        return <blockquote key={k}>{blocks(b.children, breaks, k, false, money)}</blockquote>
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
                {inlines(first.children, `${ik}.0`, money)}
              </span>
            ) : (
              <p key="lead" className={breaks ? 'md-breaks' : undefined}>
                {box}
                {inlines(first.children, `${ik}.0`, money)}
              </p>
            )
            return (
              <li key={j} className={`md-task ${item.checked ? 'is-done' : ''}`}>
                {lead}
                {blocks(rest, breaks, `${ik}r`, b.tight, money)}
              </li>
            )
          }
          return (
            <li key={j} className={task ? `md-task ${item.checked ? 'is-done' : ''}` : undefined}>
              {box}
              {blocks(kids, breaks, ik, b.tight, money)}
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
                      {inlines(c, `${k}h${j}`, money)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, n) => (
                  <tr key={n}>
                    {r.map((c, j) => (
                      <td key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                        {inlines(c, `${k}r${n}c${j}`, money)}
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

/** Lines after which a code block also has a Copy button at its foot. */
const LONG_CODE_LINES = 15

/** A fenced code block, coloured when its language is known, with a button that copies it. */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const tokens = useMemo(() => highlight(code, lang), [code, lang])
  const long = useMemo(() => code.split('\n').length > LONG_CODE_LINES, [code])
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
      {/* A long block gets a second button at its foot, so copying needs no scroll back up. */}
      {long && (
        <button type="button" className={`md-copy md-copy-end ${copied ? 'is-done' : ''}`} onClick={copy} title="Copy the code" aria-label={copied ? 'Copied' : 'Copy the code'}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </div>
  )
}

/**
 * Markdown as React nodes. `breaks` keeps a paragraph's line breaks and spacing, like a chat
 * message (the Agents app's own messages); otherwise its lines join into one, as Markdown does.
 */
export function MarkdownPreview({
  text,
  breaks = false,
  money = false,
  resolveUrl,
}: {
  text: string
  breaks?: boolean
  /** Amounts of money open their exchange rates (the Agents app's answers) */
  money?: boolean
  /** Makes relative link and image addresses absolute (a README's, against its repository) */
  resolveUrl?: (url: string, image: boolean) => string
}) {
  const tree = useMemo(() => parseMarkdown(text), [text])
  const out = <>{blocks(tree, breaks, 'b', false, money)}</>
  return resolveUrl ? <ResolveUrl.Provider value={resolveUrl}>{out}</ResolveUrl.Provider> : out
}
