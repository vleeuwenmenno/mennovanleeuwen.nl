import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { MoneyHit } from '../data/money'
import { useHomeCurrency } from '../data/currency'
import { CURRENCY_SIGN, cachedRates, formatCurrency, formatNumber, loadRates, rateSource, type Rates } from './smartcalc'
import { openSpotlight } from './overlays'

// An amount of money in an Agents reply (found by src/data/money.ts, drawn by MarkdownPreview with
// `money`): a dotted underline that opens what it is in other currencies. The exchange rates are
// the site's shared copy (/api/fx, server/fx.ts), the same ones Spotlight's calculator uses, and
// load only when an amount is pointed at or opened.

/** The currencies the conversation mentions, offered in every amount's list. */
const ThreadCurrencies = createContext<string[]>([])

export function MoneyThread({ currencies, children }: { currencies: string[]; children: ReactNode }) {
  return <ThreadCurrencies.Provider value={currencies}>{children}</ThreadCurrencies.Provider>
}

/** Always in the list (besides the home currency, shown large, and the amount's own). */
const STANDARD = ['EUR', 'USD', 'JPY', 'GBP']

export function MoneyAmount({ hit }: { hit: MoneyHit }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`md-money ${open ? 'is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Exchange rates"
        // Pointing at it is a good moment to fetch the rates, so they are there on the click.
        onPointerEnter={() => void loadRates()}
        onFocus={() => void loadRates()}
        onClick={() => setOpen((o) => !o)}
      >
        {hit.text}
      </button>
      {open && (
        <MoneyPopover
          anchor={ref}
          hit={hit}
          onClose={(refocus) => {
            setOpen(false)
            if (refocus) ref.current?.focus()
          }}
        />
      )}
    </>
  )
}

const signOf = (code: string) => (CURRENCY_SIGN[code] && code !== 'PLN' ? CURRENCY_SIGN[code] : null)

/** What Spotlight is opened with: "¥60000 in EUR", or "60000 CHF in EUR" for a currency without a sign. */
function spotlightQuery(value: number, from: string, to: string) {
  const n = String(Number(value.toPrecision(12)))
  const sign = signOf(from)
  return `${sign ? `${sign}${n}` : `${n} ${from}`} in ${to}`
}

function MoneyPopover({ anchor, hit, onClose }: { anchor: RefObject<HTMLButtonElement | null>; hit: MoneyHit; onClose: (refocus: boolean) => void }) {
  const home = useHomeCurrency()
  const thread = useContext(ThreadCurrencies)
  const [rates, setRates] = useState<Rates | null>(cachedRates)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [copied, setCopied] = useState<string | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (rates) return
    let live = true
    setFailed(false)
    loadRates().then((r) => live && (r ? setRates(r) : setFailed(true)))
    return () => {
      live = false
    }
  }, [rates, attempt])

  // Below the amount, or above it when there is no room; inside the visible part of the screen.
  const place = () => {
    const a = anchor.current
    const el = box.current
    if (!a || !el) return
    const r = a.getBoundingClientRect()
    // Scrolled out of its window: nothing to point at any more.
    const vv = window.visualViewport
    const top = vv?.offsetTop ?? 0
    const left = vv?.offsetLeft ?? 0
    const vw = vv?.width ?? window.innerWidth
    const vh = vv?.height ?? window.innerHeight
    const width = Math.min(320, vw - 16)
    const h = el.offsetHeight
    let x = Math.min(Math.max(left + 8, r.left), left + vw - width - 8)
    let y = r.bottom + 6
    if (y + h > top + vh - 8 && r.top - 6 - h >= top + 8) y = r.top - 6 - h
    y = Math.max(top + 8, Math.min(y, top + vh - h - 8))
    x = Math.round(x)
    setPos({ left: x, top: Math.round(y), width })
  }
  useLayoutEffect(place, [rates, failed, home])

  useEffect(() => {
    box.current?.focus({ preventScroll: true })
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (box.current?.contains(t) || anchor.current?.contains(t)) return
      onClose(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose(true)
    }
    const onMove = () => place()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copy = (text: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(text),
      () => {},
    )

  const from = hit.currency
  const fromRate = rates?.rates[from]
  const eur = fromRate ? hit.value / fromRate : NaN
  const target = rates?.rates[home] ? home : 'EUR'
  const codes = rates && fromRate ? [...new Set([...STANDARD, ...thread])].filter((c) => c !== from && c !== target && rates.rates[c]) : []
  const big = rates && fromRate ? formatCurrency(from === target ? hit.value : eur * rates.rates[target], from === target ? from : target) : ''
  const original = formatCurrency(hit.value, from)
  const toSpotlight = from === target ? (target === 'USD' ? 'EUR' : 'USD') : target

  let body: ReactNode
  if (!rates)
    body = failed ? (
      <div className="fx-state">
        <p>Exchange rates are unavailable right now.</p>
        <button type="button" className="fx-btn" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    ) : (
      <p className="fx-state muted">Fetching exchange rates…</p>
    )
  else if (!fromRate) body = <p className="fx-state">There is no exchange rate for {from}.</p>
  else
    body = (
      <>
        <div className="fx-big">
          <span className="fx-big-value">{big}</span>
          <CopyButton text={big} copied={copied === big} onCopy={copy} />
        </div>
        <p className="fx-big-note muted">{from === target ? 'In your home currency' : `${original} in your home currency, ${target}`}</p>
        {codes.length > 0 && (
          <ul className="fx-rows">
            {codes.map((c) => {
              const v = formatCurrency(eur * rates.rates[c], c)
              return (
                <li key={c}>
                  <span className="fx-code">{c}</span>
                  <span className="fx-value">{v}</span>
                  <CopyButton text={v} copied={copied === v} onCopy={copy} />
                </li>
              )
            })}
          </ul>
        )}
        <p className="fx-note muted">
          1 {from} = {formatNumber(rates.rates[target === from ? toSpotlight : target] / fromRate, 6)} {target === from ? toSpotlight : target} · {rateSource(rates, from, target)}, {rates.date}
        </p>
      </>
    )

  return createPortal(
    <div
      ref={box}
      className="fx-pop"
      role="dialog"
      aria-label={`${original} in other currencies`}
      tabIndex={-1}
      style={pos ? { left: pos.left, top: pos.top, width: pos.width } : { left: -9999, top: 0 }}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="fx-head">
        <span className="fx-from">{original}</span>
        <button type="button" className="fx-close" onClick={() => onClose(true)} aria-label="Close" title="Close">
          ×
        </button>
      </div>
      {body}
      <div className="fx-actions">
        <button
          type="button"
          className="fx-btn"
          onClick={() => {
            onClose(false)
            openSpotlight(spotlightQuery(hit.value, from, toSpotlight))
          }}
        >
          Open in Spotlight
        </button>
      </div>
    </div>,
    document.body,
  )
}

function CopyButton({ text, copied, onCopy }: { text: string; copied: boolean; onCopy: (text: string) => void }) {
  return (
    <button type="button" className={`fx-copy ${copied ? 'is-done' : ''}`} onClick={() => onCopy(text)} title={`Copy ${text}`} aria-label={copied ? `Copied ${text}` : `Copy ${text}`}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
