import { parseMarkdown, type Block, type Inline } from './markdown/parse.ts'
import { KNOWN_CURRENCIES, SYMBOLS } from '../os/smartcalc.ts'

// Amounts of money in text, for the Agents app's replies: "€180", "¥60,000", "$300", "180 EUR",
// "USD 12.50", "1.234,56 €", "60,000円", "$1.2M", and both ends of a range ("~¥167–170/L",
// "€0.94–0.96", "1,000–2,000円"). MarkdownPreview (with `money`) makes each one a button that
// opens its exchange rates (src/os/MoneyAmount.tsx). No React and no DOM here, so
// `node scripts/money-check.ts` can test it.
//
// Only what is clearly money: a sign or an ISO code right next to the number. Signs that mean
// more than one currency (kr, R) count only with a code. "$" is read as US dollars and "¥" as yen,
// as Spotlight does; the specific forms (A$, C$, HK$, CN¥, RMB, 元…) name the others.
//
// Numbers: "1,234.56" and "1.234,56" both work. With both separators the last one is the decimal
// point, and the same separator more than once groups thousands ("1.234.567", "1,234,567"). A
// single separator is where the currency matters (readNumber):
//   - a comma followed by exactly three digits groups thousands ("$1,234", "€1,234");
//   - a dot followed by exactly three digits is a decimal point for currencies written with a
//     decimal dot, the dollars, the pound, the yuan, the rupee and so on ("$3.459/gal" is 3.459),
//     and groups thousands for the rest: the euro and other continental styles ("€1.234" is 1234)
//     and currencies without minor units ("¥1.234" is 1234);
//   - after a leading 0 it is always a fraction ("€0.945"), since thousands never start with 0;
//   - with one, two or four and more digits after it, it is a decimal point ("€1,5", "$1.50").
//
// A year is not an amount: "in 2026 USD", "since 1999 EUR", "October 2026 USD" (a 4-digit year,
// 1900–2099, written plainly, with only a code next to it, after a month, a date or a word like
// in, since, from, until, by, of, tot, sinds, vanaf). "2000 USD" and "costs 2026 USD" still count,
// and so does "$2026": a sign always means money.

export type MoneyHit = {
  /** Where the amount is in the text: [start, end) */
  start: number
  end: number
  /** The amount as written, e.g. "¥167" or "170" (the second end of a range) */
  text: string
  /** Its value, sign and magnitude ("k", "M", 万) included */
  value: number
  /** ISO 4217 code */
  currency: string
}

/** Signs written before the number. Longer first, so "US$" wins over "$". */
const PREFIX: Record<string, string> = {
  ...Object.fromEntries(Object.entries(SYMBOLS).filter(([s]) => s !== 'zł')),
  'US$': 'USD',
  'A$': 'AUD',
  'AU$': 'AUD',
  'C$': 'CAD',
  'CA$': 'CAD',
  'NZ$': 'NZD',
  'HK$': 'HKD',
  'S$': 'SGD',
  'SG$': 'SGD',
  'R$': 'BRL',
  'MX$': 'MXN',
  'NT$': 'TWD',
  'CN¥': 'CNY',
  'JP¥': 'JPY',
  '₫': 'VND',
  '₴': 'UAH',
  '₦': 'NGN',
  Rp: 'IDR',
}

/** Signs written after the number: "1.234,56 €", "60,000円", "100 zł". */
const SUFFIX: Record<string, string> = { '€': 'EUR', '円': 'JPY', '元': 'CNY', zł: 'PLN', Kč: 'CZK', '₽': 'RUB', '₺': 'TRY', '₫': 'VND', '₴': 'UAH', '₩': 'KRW' }

/**
 * ISO codes taken as currencies next to a number (any the exchange-rate sources publish), minus
 * the ones that are also everyday capitalised words or names (ALL, TOP, CUP, AMD…).
 */
const CODES = new Set([
  // PHP is far more often the language ("PHP 8.3") than the peso, which ₱ still names.
  ...[...KNOWN_CURRENCIES].filter((c) => c !== 'PHP'),
  ...'AED AFN ANG AOA ARS AUD AWG AZN BBD BDT BGN BHD BIF BMD BND BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MDL MGA MKD MMK MNT MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PGK PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SRD SSP STN SYP SZL THB TJS TMT TND TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW'.split(' '),
])
const CODE_ALIAS: Record<string, string> = { RMB: 'CNY' }
const codeOf = (w: string) => CODE_ALIAS[w] ?? (CODES.has(w) ? w : null)

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const alt = (signs: string[]) => signs.sort((a, b) => b.length - a.length).map(esc).join('|')
// The sign (or code) at the end of the text before a number, with at most one space between.
const BEFORE = new RegExp(`(?:^|[^A-Za-z0-9_])(${alt(Object.keys(PREFIX))}|[A-Z]{3})[ \\u00a0\\u202f]?$`)
// A sign or code right after the number (and its magnitude).
const AFTER_SIGN = new RegExp(`^[ \\u00a0\\u202f]?(${alt(Object.keys(SUFFIX))})`)
const AFTER_CODE = /^[   ]?([A-Z]{3})(?![A-Za-z0-9])/
const NUMBER = /\d+(?:[.,'   ]\d+)*/g
// "k", "M", "bn" right after the number; "million" after a space; 千, 万, 億 before 円 or 元.
const MAGNITUDE: [RegExp, (m: string) => number][] = [
  [/^(?:k|K)(?![A-Za-z])/, () => 1e3],
  [/^(?:M|mn)(?![A-Za-z])/, () => 1e6],
  [/^(?:bn|B)(?![A-Za-z])/, () => 1e9],
  [/^[  ](thousand|million|billion|trillion)\b/i, (m) => ({ thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 })[m.trim().toLowerCase()] ?? 1],
  [/^[千万億]/, (m) => ({ 千: 1e3, 万: 1e4, 億: 1e8 })[m] ?? 1],
]
// Between the two ends of a range: a dash, a tilde or 〜, with at most a space on either side.
const RANGE = /^[  ]?(?:[-–—~〜])[  ]?$/

/**
 * Currencies written with a decimal dot and a thousands comma: a lone ".xyz" after one of these is
 * a fraction ("$3.459"). Every other currency reads it as thousands ("€1.234", "¥1.234").
 */
const DOT_DECIMAL = new Set(['USD', 'GBP', 'AUD', 'CAD', 'NZD', 'HKD', 'SGD', 'TWD', 'CNY', 'INR', 'PKR', 'LKR', 'NPR', 'BDT', 'MXN', 'PHP', 'THB', 'MYR', 'ILS', 'CHF', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD', 'EGP', 'NGN', 'KES', 'GHS', 'JMD', 'TTD', 'BSD', 'BBD', 'BZD', 'BMD', 'KYD', 'XCD', 'FJD', 'PGK', 'SBD', 'WST', 'TOP'])

/**
 * A number as written, or null when its separators don't make one (a version, a date). The
 * currency decides a lone dot before three digits (see the top of this file); without one it
 * groups thousands.
 */
export function readNumber(raw: string, currency?: string | null): number | null {
  const seps = raw.match(/\D/g) ?? []
  if (!seps.length) return Number(raw)
  const groups = raw.split(/\D/)
  const last = seps[seps.length - 1]
  const tail = groups[groups.length - 1]
  let decimal = false
  if (last === '.' || last === ',') {
    const before = seps.slice(0, -1)
    if (before.includes(last)) decimal = false // 1,234,567 or 1.234.567
    else if (before.length) decimal = true // 1,234.56, 1.234,56, 1 234,56
    // 1,5 and 0.945 are fractions; 1,500 groups thousands; 3.459 is a fraction in dollars, 1.234 euros are 1234.
    else decimal = tail.length !== 3 || /^0+$/.test(groups[0]) || (last === '.' && !!currency && DOT_DECIMAL.has(currency))
  }
  const whole = decimal ? groups.slice(0, -1) : groups
  const thousands = decimal ? seps.slice(0, -1) : seps
  if (whole.length > 1) {
    if (whole[0].length > 3 || whole.slice(1).some((g) => g.length !== 3)) return null
    if (new Set(thousands).size > 1) return null
  }
  return Number(whole.join('') + (decimal ? `.${tail}` : ''))
}

const WORD = /[A-Za-z0-9_]/

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|januari|februari|maart|mei|juni|juli|augustus|oktober|mrt|okt'
const YEAR_WORDS = 'in|since|from|until|till|through|by|of|before|after|during|year|tot|sinds|vanaf|van|voor|na|jaar|t/m'
// What comes right before a year: a month (with or without its day), a date, or a word that takes one.
const YEAR_CONTEXT = new RegExp(`(?:(?:^|[^A-Za-z])(?:${MONTHS})\\.?(?:\\s+\\d{1,2}(?:st|nd|rd|th)?,?)?|(?:^|[^A-Za-z/])(?:${YEAR_WORDS})|\\d{1,2}[-/.]\\d{1,2}[-/.]?|\\d{1,2}(?:st|nd|rd|th))\\s+$|\\d{1,2}[-/]\\d{1,2}[-/]$`, 'i')

/** Every amount of money in plain text (no Markdown: see moneyInMarkdown), in order. */
export function findMoney(text: string): MoneyHit[] {
  const hits: MoneyHit[] = []
  // The number before this one that had no currency, for "1,000–2,000円".
  let loose: { start: number; end: number; raw: string; scale: number; text: string } | null = null
  /** The value once the currency is known: it decides a lone ".xyz" (readNumber). */
  const valueOf = (raw: string, scale: number, currency: string) => (readNumber(raw, currency) ?? NaN) * scale
  for (const m of text.matchAll(NUMBER)) {
    const raw = m[0]
    const numStart = m.index!
    const numEnd = numStart + raw.length
    // A trailing separator belongs to the sentence ("costs €5." / "€1,"); the regex never takes one.
    if (readNumber(raw) === null) {
      loose = null
      continue
    }
    // Magnitude.
    let after = text.slice(numEnd)
    let magEnd = numEnd
    let scale = 1
    for (const [re, mul] of MAGNITUDE) {
      const mm = re.exec(after)
      if (mm) {
        scale = mul(mm[1] ?? mm[0])
        magEnd = numEnd + mm[0].length
        break
      }
    }
    after = text.slice(magEnd)

    // A sign or code before it.
    let currency: string | null = null
    /** Named by an ISO code rather than a sign */
    let byCode = false
    let start = numStart
    const head = text.slice(Math.max(0, numStart - 6), numStart)
    const b = BEFORE.exec(head)
    if (b) {
      const c = PREFIX[b[1]] ?? (/^[A-Z]{3}$/.test(b[1]) ? codeOf(b[1]) : null)
      const signStart = numStart - (head.length - head.lastIndexOf(b[1]))
      // "USD/EUR 1.08" is a pair, not an amount.
      if (c && text[signStart - 1] !== '/') {
        currency = c
        byCode = !PREFIX[b[1]]
        start = signStart
      }
    }
    // Glued to a word on the left ("v1.2", "x86", "abc$5"): not money.
    if (start === numStart && numStart > 0 && (WORD.test(text[numStart - 1]) || text[numStart - 1] === '$')) {
      loose = null
      continue
    }
    if (start > 0 && start !== numStart && WORD.test(text[start - 1])) {
      loose = null
      continue
    }

    // A sign or code after it.
    let end = magEnd
    if (!currency) {
      const s = AFTER_SIGN.exec(after)
      const c = s ? null : AFTER_CODE.exec(after)
      if (s) {
        currency = SUFFIX[s[1]]
        end = magEnd + s[0].length
      } else if (c && codeOf(c[1]) && text[magEnd + c[0].length] !== '/') {
        currency = codeOf(c[1])
        byCode = true
        end = magEnd + c[0].length
      }
    }

    // What follows may not continue the number or glue a word to it ("$5Mbps", "€5x", "€12:30").
    const next = text.slice(end, end + 2)
    if (WORD.test(next[0] ?? '') || /^[.,:]\d/.test(next)) {
      loose = null
      continue
    }

    // A year next to a code, after a month, a date or "in"/"since"/…: "in 2026 USD" is about a year.
    if (byCode && scale === 1 && /^(?:19|20)\d\d$/.test(raw) && YEAR_CONTEXT.test(text.slice(Math.max(0, start - 40), start))) {
      loose = null
      continue
    }

    // The second end of a range takes the first one's currency ("¥167–170", "€0.94–0.96").
    const prev = hits[hits.length - 1]
    const gapPrev = prev ? text.slice(prev.end, start) : ''
    const ranged = !!prev && RANGE.test(gapPrev)
    if (!currency && ranged) currency = prev.currency
    // The first end takes the second's ("1,000–2,000円", "5-10 EUR").
    if (currency && !ranged && loose && start === numStart && RANGE.test(text.slice(loose.end, numStart))) {
      hits.push({ start: loose.start, end: loose.end, text: loose.text, value: valueOf(loose.raw, loose.scale, currency), currency })
    }

    // A minus before it, not a range's dash: "-€5", "−$300", "-5 EUR".
    const minus = text[start - 1]
    if ((minus === '-' || minus === '−') && !ranged && (start === 1 || /[\s(]/.test(text[start - 2]))) {
      start -= 1
      scale = -scale
    }

    if (!currency) {
      loose = { start, end: magEnd, raw, scale, text: text.slice(start, magEnd) }
      continue
    }
    loose = null
    hits.push({ start, end, text: text.slice(start, end), value: valueOf(raw, scale, currency), currency })
  }
  return hits
}

/** Text cut at its amounts, for rendering: plain strings between the hits. Remembered per text. */
export type MoneyPiece = string | MoneyHit
const pieces = new Map<string, MoneyPiece[]>()

export function moneyPieces(text: string): MoneyPiece[] {
  const known = pieces.get(text)
  if (known) return known
  const out: MoneyPiece[] = []
  let at = 0
  // Cheap way out for text without a digit, which is most of it.
  const hits = /\d/.test(text) ? findMoney(text) : []
  for (const h of hits) {
    if (h.start > at) out.push(text.slice(at, h.start))
    out.push(h)
    at = h.end
  }
  if (at < text.length) out.push(text.slice(at))
  // Streaming replies make a new text every token: keep the cache small.
  if (pieces.size > 400) pieces.clear()
  pieces.set(text, out)
  return out
}

/**
 * Runs of text an amount may sit in: adjacent text nodes joined (the parser can split one), and
 * nothing inside code or a link (its words or its address).
 */
export function joinText(nodes: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const n of nodes) {
    const prev = out[out.length - 1]
    if (n.type === 'text' && prev?.type === 'text') out[out.length - 1] = { type: 'text', text: prev.text + n.text }
    else out.push(n)
  }
  return out
}

function inlineHits(nodes: Inline[], out: MoneyHit[]) {
  for (const n of joinText(nodes)) {
    if (n.type === 'text') out.push(...findMoney(n.text))
    else if (n.type === 'em' || n.type === 'strong' || n.type === 'del') inlineHits(n.children, out)
  }
}

function blockHits(blocks: Block[], out: MoneyHit[]) {
  for (const b of blocks) {
    if (b.type === 'paragraph' || b.type === 'heading') inlineHits(b.children, out)
    else if (b.type === 'quote') blockHits(b.children, out)
    else if (b.type === 'list') for (const item of b.items) blockHits(item.children, out)
    else if (b.type === 'table') for (const row of [b.head, ...b.rows]) for (const cell of row) inlineHits(cell, out)
  }
}

/** The amounts in Markdown as MarkdownPreview shows them: not in code, links or their addresses. */
export function moneyInMarkdown(markdown: string): MoneyHit[] {
  const out: MoneyHit[] = []
  if (/\d/.test(markdown)) blockHits(parseMarkdown(markdown), out)
  return out
}

const threadCache = new Map<string, string[]>()

/** The currencies a set of texts mentions (an Agents thread), in order of first mention. */
export function currenciesIn(texts: string[]): string[] {
  const seen = new Set<string>()
  for (const t of texts) {
    let codes = threadCache.get(t)
    if (!codes) {
      codes = [...new Set(moneyInMarkdown(t).map((h) => h.currency))]
      if (threadCache.size > 400) threadCache.clear()
      threadCache.set(t, codes)
    }
    for (const c of codes) seen.add(c)
  }
  return [...seen]
}
