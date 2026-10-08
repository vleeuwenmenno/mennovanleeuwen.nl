// The calculator behind Spotlight and `calc`: arithmetic, percentages, units and currencies in one
// expression, e.g. "5 ft 11 in to cm", "1 TB in GiB", "€20 + 15 USD in GBP", "15% of 80".
// A small recursive-descent parser over quantities; no eval. Currencies are only recognised as
// ALL-CAPS ISO codes or symbols, so ordinary words never turn into money.

type Dim = 'length' | 'mass' | 'volume' | 'area' | 'speed' | 'time' | 'data' | 'temp' | 'currency'
type Unit = { dim: Dim; factor: number; label: string; offset?: number }

const U = (dim: Dim, factor: number, label: string, ...aliases: string[]) => ({ dim, factor, label, aliases })
const UNIT_LIST = [
  // length (metre)
  U('length', 1e-6, 'µm', 'µm', 'um', 'micrometer', 'micrometre'),
  U('length', 1e-3, 'mm', 'mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'),
  U('length', 1e-2, 'cm', 'cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'),
  U('length', 1, 'm', 'm', 'meter', 'meters', 'metre', 'metres'),
  U('length', 1e3, 'km', 'km', 'kilometer', 'kilometers', 'kilometre', 'kilometres'),
  U('length', 0.0254, 'in', 'in', 'inch', 'inches', '"', '″'),
  U('length', 0.3048, 'ft', 'ft', 'foot', 'feet', "'", '′'),
  U('length', 0.9144, 'yd', 'yd', 'yard', 'yards'),
  U('length', 1609.344, 'mi', 'mi', 'mile', 'miles'),
  U('length', 1852, 'nmi', 'nmi'),
  // mass (kilogram)
  U('mass', 1e-6, 'mg', 'mg'),
  U('mass', 1e-3, 'g', 'g', 'gram', 'grams'),
  U('mass', 1, 'kg', 'kg', 'kilo', 'kilos', 'kilogram', 'kilograms'),
  U('mass', 1e3, 't', 't', 'tonne', 'tonnes'),
  U('mass', 0.028349523125, 'oz', 'oz', 'ounce', 'ounces'),
  U('mass', 0.45359237, 'lb', 'lb', 'lbs', 'pound', 'pounds'),
  U('mass', 6.35029318, 'st', 'st', 'stone'),
  // volume (litre)
  U('volume', 1e-3, 'ml', 'ml', 'mL', 'milliliter', 'millilitre'),
  U('volume', 1e-2, 'cl', 'cl'),
  U('volume', 1e-1, 'dl', 'dl'),
  U('volume', 1, 'l', 'l', 'L', 'liter', 'liters', 'litre', 'litres'),
  U('volume', 1e3, 'm³', 'm3', 'm³'),
  U('volume', 0.00492892159375, 'tsp', 'tsp'),
  U('volume', 0.01478676478125, 'tbsp', 'tbsp'),
  U('volume', 0.2365882365, 'cup', 'cup', 'cups'),
  U('volume', 0.0295735295625, 'fl oz', 'floz'),
  U('volume', 0.473176473, 'pt', 'pt', 'pint', 'pints'),
  U('volume', 0.946352946, 'qt', 'qt', 'quart', 'quarts'),
  U('volume', 3.785411784, 'gal', 'gal', 'gallon', 'gallons'),
  // area (square metre)
  U('area', 1e-4, 'cm²', 'cm2', 'cm²'),
  U('area', 1, 'm²', 'm2', 'm²', 'sqm'),
  U('area', 1e6, 'km²', 'km2', 'km²'),
  U('area', 1e4, 'ha', 'ha', 'hectare', 'hectares'),
  U('area', 4046.8564224, 'acre', 'acre', 'acres'),
  U('area', 0.09290304, 'ft²', 'ft2', 'ft²', 'sqft'),
  U('area', 0.00064516, 'in²', 'in2', 'in²'),
  U('area', 2589988.110336, 'mi²', 'mi2', 'mi²'),
  // speed (metre per second)
  U('speed', 1, 'm/s', 'm/s', 'mps'),
  U('speed', 1 / 3.6, 'km/h', 'km/h', 'kmh', 'kph'),
  U('speed', 0.44704, 'mph', 'mph'),
  U('speed', 1852 / 3600, 'kn', 'kn', 'knot', 'knots'),
  U('speed', 0.3048, 'ft/s', 'ft/s', 'fps'),
  // time (second)
  U('time', 1e-3, 'ms', 'ms', 'millisecond', 'milliseconds'),
  U('time', 1, 's', 's', 'sec', 'secs', 'second', 'seconds'),
  U('time', 60, 'min', 'min', 'mins', 'minute', 'minutes'),
  U('time', 3600, 'h', 'h', 'hr', 'hrs', 'hour', 'hours'),
  U('time', 86400, 'd', 'd', 'day', 'days'),
  U('time', 604800, 'wk', 'wk', 'week', 'weeks'),
  U('time', 2629800, 'mo', 'mo', 'month', 'months'),
  U('time', 31557600, 'yr', 'yr', 'year', 'years'),
  // data (byte). Capital B is bytes, lower-case b is bits; "gb"/"mb" typed in lower case mean bytes.
  U('data', 0.125, 'bit', 'bit', 'bits', 'b'),
  U('data', 125, 'kbit', 'kbit', 'Kbit', 'Kb', 'kbps'),
  U('data', 125e3, 'Mbit', 'Mbit', 'Mb', 'Mbps'),
  U('data', 125e6, 'Gbit', 'Gbit', 'Gb', 'Gbps'),
  U('data', 125e9, 'Tbit', 'Tbit', 'Tb'),
  U('data', 1, 'B', 'B', 'byte', 'bytes'),
  U('data', 1e3, 'KB', 'KB', 'kB', 'kb'),
  U('data', 1e6, 'MB', 'MB', 'mb'),
  U('data', 1e9, 'GB', 'GB', 'gb'),
  U('data', 1e12, 'TB', 'TB', 'tb'),
  U('data', 1e15, 'PB', 'PB', 'pb'),
  U('data', 2 ** 10, 'KiB', 'KiB', 'kib'),
  U('data', 2 ** 20, 'MiB', 'MiB', 'mib'),
  U('data', 2 ** 30, 'GiB', 'GiB', 'gib'),
  U('data', 2 ** 40, 'TiB', 'TiB', 'tib'),
  U('data', 2 ** 50, 'PiB', 'PiB', 'pib'),
]

const UNITS = new Map<string, Unit>()
for (const u of UNIT_LIST) for (const a of u.aliases) UNITS.set(a, { dim: u.dim, factor: u.factor, label: u.label })
// Temperature has an offset: kelvin = value * factor + offset.
for (const [aliases, factor, offset, label] of [
  [['C', '°C', 'celsius'], 1, 273.15, '°C'],
  [['F', '°F', 'fahrenheit'], 5 / 9, 273.15 - (32 * 5) / 9, '°F'],
  [['K', 'kelvin'], 1, 0, 'K'],
] as [string[], number, number, string][])
  for (const a of aliases) UNITS.set(a, { dim: 'temp', factor, offset, label })

const SYMBOLS: Record<string, string> = { '€': 'EUR', $: 'USD', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₺': 'TRY', '₽': 'RUB', '₪': 'ILS', '฿': 'THB', '₱': 'PHP', zł: 'PLN' }
const CURRENCY_SIGN: Record<string, string> = Object.fromEntries(Object.entries(SYMBOLS).map(([s, c]) => [c, s]))
const KNOWN_CURRENCIES = new Set(['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'TRY', 'CNY', 'HKD', 'SGD', 'INR', 'KRW', 'BRL', 'MXN', 'ZAR', 'ILS', 'IDR', 'MYR', 'PHP', 'THB', 'ISK', 'AED', 'SAR', 'ARS', 'CLP', 'COP', 'EGP', 'NGN', 'PKR', 'TWD', 'UAH', 'VND', 'RUB'])

const FUNCS: Record<string, (x: number) => number> = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log }
const CONSTS: Record<string, number> = { pi: Math.PI, π: Math.PI, e: Math.E }

// ---------------------------------------------------------------------------------------------
// Exchange rates (units of currency per 1 EUR), cached for the visit and a few hours in storage.

export type Rates = { base: 'EUR'; date: string; source: string; rates: Record<string, number> }
const RATES_KEY = 'mvlos.fx.v1'
let ratesCache: Rates | null = null
let ratesPromise: Promise<Rates | null> | null = null

export const cachedRates = () => ratesCache

export function loadRates(): Promise<Rates | null> {
  if (ratesCache) return Promise.resolve(ratesCache)
  try {
    const raw = JSON.parse(sessionStorage.getItem(RATES_KEY) ?? 'null')
    if (raw && Date.now() - raw.at < 6 * 3600_000) return Promise.resolve((ratesCache = raw.data))
  } catch {
    /* fetch instead */
  }
  ratesPromise ??= (async () => {
    // ECB reference rates via Frankfurter, topped up with open.er-api.com for currencies the ECB does not publish.
    const [ecb, wide] = await Promise.allSettled([
      fetch('https://api.frankfurter.dev/v1/latest?base=EUR').then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch('https://open.er-api.com/v6/latest/EUR').then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
    ])
    const rates: Record<string, number> = { ...(wide.status === 'fulfilled' ? wide.value.rates : {}), ...(ecb.status === 'fulfilled' ? ecb.value.rates : {}), EUR: 1 }
    if (Object.keys(rates).length < 2) return null
    const data: Rates = {
      base: 'EUR',
      date: ecb.status === 'fulfilled' ? ecb.value.date : new Date().toISOString().slice(0, 10),
      source: ecb.status === 'fulfilled' ? 'European Central Bank' : 'exchangerate-api.com',
      rates,
    }
    ratesCache = data
    try {
      sessionStorage.setItem(RATES_KEY, JSON.stringify({ at: Date.now(), data }))
    } catch {
      /* fine */
    }
    return data
  })().catch(() => null)
  return ratesPromise
}

// ---------------------------------------------------------------------------------------------
// Tokens and parsing

type Tok = { t: 'num'; v: number } | { t: 'op'; v: string } | { t: 'unit'; v: string } | { t: 'cur'; v: string } | { t: 'word'; v: string }

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const rest = src.slice(i)
    const ch = src[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    // 1,000,000 and 1.000,50 are both read sensibly: a comma before exactly three digits groups thousands.
    const num = /^(\d[\d_]*(?:,\d{3}(?!\d))*(?:[.,]\d+)?|[.]\d+)(?:e[+-]?\d+)?/i.exec(rest)
    if (num) {
      const raw = num[0].replace(/_/g, '').replace(/,(\d{3})(?!\d)/g, '$1').replace(',', '.')
      out.push({ t: 'num', v: parseFloat(raw) })
      i += num[0].length
      continue
    }
    const sym = Object.keys(SYMBOLS).find((s) => rest.startsWith(s))
    if (sym) {
      out.push({ t: 'cur', v: SYMBOLS[sym] })
      i += sym.length
      continue
    }
    const deg = /^°\s?([CF])\b/.exec(rest)
    if (deg) {
      out.push({ t: 'unit', v: deg[1] })
      i += deg[0].length
      continue
    }
    if ('\'"′″'.includes(ch)) {
      out.push({ t: 'unit', v: ch })
      i++
      continue
    }
    if ('+-*/^%()×÷−'.includes(ch)) {
      out.push({ t: 'op', v: ch === '×' ? '*' : ch === '÷' ? '/' : ch === '−' ? '-' : ch })
      i++
      continue
    }
    const word = /^[A-Za-zµπ][A-Za-z0-9²³]*(?:\/[A-Za-z]+)?/.exec(rest)
    if (word) {
      const w = word[0]
      i += w.length
      if (/^[A-Z]{3}$/.test(w) && KNOWN_CURRENCIES.has(w)) out.push({ t: 'cur', v: w })
      else if (w === 'x' || w === 'times') out.push({ t: 'op', v: '*' })
      else if (UNITS.has(w) || UNITS.has(w.toLowerCase()) && w.length > 2) out.push({ t: 'unit', v: UNITS.has(w) ? w : w.toLowerCase() })
      else out.push({ t: 'word', v: w.toLowerCase() })
      continue
    }
    return null
  }
  return out
}

/** A value in its dimension's base unit (metre, kilogram, kelvin, EUR…), or a plain number. */
type Q = { v: number; dim: Dim | null; unit?: string; cur?: string; pct?: boolean }

class ParseError extends Error {}

function evaluate(toks: Tok[], rates: Rates | null): Q {
  let i = 0
  const peek = () => toks[i]
  const isOp = (v: string) => toks[i]?.t === 'op' && toks[i].v === v
  const fail = (msg: string): never => {
    throw new ParseError(msg)
  }

  const toBase = (value: number, unit: string): Q => {
    const u = UNITS.get(unit)!
    return { v: value * u.factor + (u.offset ?? 0), dim: u.dim, unit }
  }
  const money = (value: number, code: string): Q => {
    if (!rates) return { v: NaN, dim: 'currency', cur: code }
    const r = rates.rates[code]
    if (!r) fail(`No exchange rate for ${code}`)
    return { v: value / r, dim: 'currency', cur: code }
  }

  /** A number with its unit or currency, before or after it ("€20", "20 EUR", "5 ft"). */
  function primary(): Q {
    const tok = peek()
    if (!tok) fail('expected a value')
    if (tok.t === 'op' && tok.v === '(') {
      i++
      const inner = expr()
      if (!isOp(')')) fail('missing )')
      i++
      return attach(inner)
    }
    if (tok.t === 'cur') {
      i++
      const n = peek()
      if (n?.t !== 'num') fail(`a number after ${tok.v}`)
      i++
      return money((n as { v: number }).v, tok.v)
    }
    if (tok.t === 'word') {
      i++
      if (tok.v in CONSTS) return { v: CONSTS[tok.v], dim: null }
      if (tok.v in FUNCS) {
        if (!isOp('(')) fail(`${tok.v} needs (…)`)
        i++
        const arg = expr()
        if (!isOp(')')) fail('missing )')
        i++
        if (arg.dim) fail(`${tok.v} takes a plain number`)
        return { v: FUNCS[tok.v](arg.v), dim: null }
      }
      fail(`unknown word "${tok.v}"`)
    }
    if (tok.t === 'num') {
      i++
      return attach({ v: tok.v, dim: null })
    }
    return fail('unexpected symbol')
  }

  /** Units after a number, including compound lengths/times like "5 ft 11 in" or "1 h 30 min". */
  function attach(q: Q): Q {
    const t = peek()
    if (q.dim === null && t?.t === 'unit') {
      i++
      q = toBase(q.v, t.v)
    } else if (q.dim === null && t?.t === 'cur') {
      i++
      q = money(q.v, t.v)
    }
    while (q.dim && q.dim !== 'temp' && q.dim !== 'currency' && toks[i]?.t === 'num' && toks[i + 1]?.t === 'unit') {
      const next = toBase((toks[i] as { v: number }).v, (toks[i + 1] as { v: string }).v)
      if (next.dim !== q.dim) break
      i += 2
      q = { ...q, v: q.v + next.v }
    }
    return q
  }

  function postfix(): Q {
    const q = primary()
    if (isOp('%')) {
      i++
      if (q.dim) fail('percent of a unit')
      const pct = { v: q.v / 100, dim: null, pct: true }
      // "15% of 80"
      if (peek()?.t === 'word' && (peek() as { v: string }).v === 'of') {
        i++
        const base = unary()
        return { ...base, v: base.v * pct.v, pct: false }
      }
      return pct
    }
    return q
  }

  function unary(): Q {
    if (isOp('-')) {
      i++
      const q = unary()
      return { ...q, v: q.dim === 'temp' ? fail('negative kelvin') : -q.v }
    }
    if (isOp('+')) {
      i++
      return unary()
    }
    return postfix()
  }

  function power(): Q {
    const base = unary()
    if (isOp('^')) {
      i++
      const exp = power()
      if (base.dim || exp.dim) fail('powers of units')
      return { v: base.v ** exp.v, dim: null }
    }
    return base
  }

  function term(): Q {
    let q = power()
    while (isOp('*') || isOp('/')) {
      const op = toks[i++].v
      const r = power()
      if (q.dim && r.dim) fail('multiplying two units')
      if (q.dim === 'temp' || r.dim === 'temp') fail('scaling a temperature')
      if (op === '/' && r.dim) fail('dividing by a unit')
      // A scalar times a quantity keeps the quantity's unit, whichever side it is on.
      q = op === '*' ? { ...(q.dim ? q : r), v: q.v * r.v, pct: false } : { ...q, v: q.v / r.v, pct: false }
    }
    return q
  }

  function expr(): Q {
    let q = term()
    while (isOp('+') || isOp('-')) {
      const op = toks[i++].v
      const r = term()
      // "100 + 21%" adds 21 percent; "80 EUR - 10%" takes ten percent off.
      if (r.pct && !q.pct) {
        q = { ...q, v: q.v * (op === '+' ? 1 + r.v : 1 - r.v) }
        continue
      }
      if (q.dim !== r.dim) fail(q.dim && r.dim ? `cannot add ${q.dim} and ${r.dim}` : 'cannot add a unit and a plain number')
      if (q.dim === 'temp') fail('adding temperatures')
      q = { ...q, v: op === '+' ? q.v + r.v : q.v - r.v, cur: q.cur ?? r.cur, unit: q.unit ?? r.unit }
    }
    return q
  }

  const result = expr()
  if (i < toks.length) fail('unexpected input at the end')
  return result
}

// ---------------------------------------------------------------------------------------------
// Formatting

export function formatNumber(n: number, maxDigits = 10) {
  if (!Number.isFinite(n)) return String(n)
  const a = Math.abs(n)
  if (a !== 0 && (a >= 1e15 || a < 1e-6)) return n.toExponential(4)
  return n.toLocaleString('en-GB', { maximumSignificantDigits: Math.min(maxDigits, 15), maximumFractionDigits: 10 })
}

const fromBase = (q: Q, unit: string) => {
  const u = UNITS.get(unit)!
  return (q.v - (u.offset ?? 0)) / u.factor
}

const formatUnit = (q: Q, unit: string) => {
  const u = UNITS.get(unit)!
  const v = fromBase(q, unit)
  if (u.dim === 'temp') return `${v.toLocaleString('en-GB', { maximumFractionDigits: 2 })}${u.label === 'K' ? ' K' : u.label}`
  return `${formatNumber(v, 6)} ${u.label}`
}

/** Conversions worth showing: not the input or target unit again, and not absurdly small or large. */
const readableUnits = (q: Q, units: string[], exclude: string[]) => {
  const fresh = units.filter((u) => !exclude.includes(UNITS.get(u)!.label))
  const readable = fresh.filter((u) => {
    const v = Math.abs(fromBase(q, u))
    return q.dim === 'temp' || q.dim === 'data' || v === 0 || (v >= 0.01 && v < 1e6)
  })
  return readable.length ? readable : fresh
}

// Currencies quoted without minor units.
const NO_CENTS = new Set(['JPY', 'KRW', 'HUF', 'ISK', 'IDR', 'CLP', 'VND', 'COP'])

export function formatMoney(eur: number, code: string, rates: Rates) {
  const v = eur * (rates.rates[code] ?? NaN)
  const digits = Math.abs(v) >= 100000 || NO_CENTS.has(code) ? 0 : 2
  const num = v.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return CURRENCY_SIGN[code] && code !== 'PLN' ? `${CURRENCY_SIGN[code]}${num}` : `${num} ${code}`
}

// Sensible alternatives per dimension when no target is given.
const SUGGEST: Record<Exclude<Dim, 'currency'>, string[]> = {
  length: ['m', 'cm', 'ft', 'in', 'km', 'mi', 'mm'],
  mass: ['kg', 'g', 'lb', 'oz'],
  volume: ['l', 'ml', 'gal', 'cup', 'floz'],
  area: ['m2', 'km2', 'ha', 'ft2', 'acre'],
  speed: ['km/h', 'mph', 'm/s', 'kn'],
  time: ['h', 'min', 's', 'd', 'wk', 'yr'],
  data: [],
  temp: ['C', 'F', 'K'],
}

function bestData(bytes: number) {
  const pick = (units: string[]) => units.reduce((best, u) => (bytes / UNITS.get(u)!.factor >= 1 ? u : best), units[0])
  return [pick(['B', 'KB', 'MB', 'GB', 'TB', 'PB']), pick(['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']), pick(['bit', 'kbit', 'Mbit', 'Gbit', 'Tbit'])]
}

export type CalcResult =
  | { kind: 'pending'; expression: string }
  | { kind: 'error'; expression: string; message: string }
  | { kind: 'ok'; expression: string; value: string; copy: string; alternatives: string[]; note?: string; usesRates: boolean }

/** Returns null when the text does not look like a calculation at all (so Spotlight can ignore it). */
export function smartCalc(input: string, rates: Rates | null = ratesCache): CalcResult | null {
  const text = input.trim()
  if (!text || text.length > 200) return null
  // "… to X" / "… in X" / "… as X" / "… = X" names the target when X is a unit or currency.
  let exprText = text
  let target: { kind: 'unit' | 'cur'; v: string } | null = null
  const m = /^(.*\S)\s+(?:to|in|as|into|=|->|→)\s+(\S+(?:\s?\S+)?)$/.exec(text)
  if (m) {
    const tt = tokenize(m[2])
    if (tt && tt.length === 1 && (tt[0].t === 'unit' || tt[0].t === 'cur')) {
      exprText = m[1]
      target = { kind: tt[0].t, v: tt[0].v }
    }
  }
  const toks = tokenize(exprText)
  if (!toks || !toks.length) return null
  // Needs at least one number, and is not judged while an operator is still dangling.
  if (!toks.some((t) => t.t === 'num' || (t.t === 'word' && t.v in CONSTS))) return null
  const last = toks[toks.length - 1]
  if (last.t === 'op' && last.v !== ')' && last.v !== '%') return null
  const hasUnits = toks.some((t) => t.t === 'unit' || t.t === 'cur') || !!target
  const hasOperator = toks.some((t) => t.t === 'op' && t.v !== '(' && t.v !== ')') || toks.some((t) => t.t === 'word' && (t.v in FUNCS || t.v === 'of'))
  // A lone number is not a sum, and a sentence is not maths.
  if (!hasUnits && !hasOperator) return null
  if (toks.some((t) => t.t === 'word' && !(t.v in FUNCS) && !(t.v in CONSTS) && t.v !== 'of')) return null

  const usesRates = toks.some((t) => t.t === 'cur') || target?.kind === 'cur'
  if (usesRates && !rates) return { kind: 'pending', expression: text }

  let q: Q
  try {
    q = evaluate(toks, rates)
  } catch (err) {
    if (err instanceof ParseError) return hasUnits || toks.length > 2 ? { kind: 'error', expression: text, message: err.message } : null
    throw err
  }
  if (!Number.isFinite(q.v)) return { kind: 'error', expression: text, message: 'the result is not a finite number' }

  if (q.dim === null) {
    if (target) return { kind: 'error', expression: text, message: `a plain number has no ${target.v}` }
    const value = formatNumber(q.v)
    return { kind: 'ok', expression: text, value: `= ${value}`, copy: String(Number(q.v.toPrecision(15))), alternatives: [], usesRates }
  }

  if (q.dim === 'currency') {
    const r = rates!
    const from = q.cur ?? 'EUR'
    const to = target?.kind === 'cur' ? target.v : null
    if (target && target.kind !== 'cur') return { kind: 'error', expression: text, message: `money cannot become ${target.v}` }
    if (to && !r.rates[to]) return { kind: 'error', expression: text, message: `No exchange rate for ${to}` }
    const main = to ?? (from === 'EUR' ? 'USD' : 'EUR')
    const value = formatMoney(q.v, main, r)
    const others = ['EUR', 'USD', 'GBP', 'JPY', 'CHF'].filter((c) => c !== main && c !== from).slice(0, 3)
    const rate = r.rates[main] / (r.rates[from] ?? 1)
    return {
      kind: 'ok',
      expression: text,
      value: `= ${value}`,
      copy: (q.v * r.rates[main]).toFixed(2),
      alternatives: [...(from !== main ? [`${formatMoney(q.v, from, r)} (in ${from})`] : []), ...others.map((c) => formatMoney(q.v, c, r))],
      note: `1 ${from} = ${formatNumber(rate, 6)} ${main} · ${r.source}, ${r.date}`,
      usesRates,
    }
  }

  const inputLabel = q.unit ? UNITS.get(q.unit)!.label : ''
  const pool = q.dim === 'data' ? bestData(q.v) : SUGGEST[q.dim]

  if (target) {
    if (target.kind !== 'unit' || UNITS.get(target.v)!.dim !== q.dim) return { kind: 'error', expression: text, message: `cannot convert ${q.dim} to ${target.v}` }
    const targetLabel = UNITS.get(target.v)!.label
    const alternatives = readableUnits(q, pool, [targetLabel, inputLabel]).slice(0, 3).map((u) => formatUnit(q, u))
    if (q.dim === 'length' && targetLabel !== 'ft' && q.v > 0.3 && q.v < 3) alternatives.unshift(feetInches(q.v))
    return { kind: 'ok', expression: text, value: `= ${formatUnit(q, target.v)}`, copy: String(Number(fromBase(q, target.v).toPrecision(12))), alternatives, usesRates }
  }

  // No target: lead with the most useful conversion, then a few more.
  const list = readableUnits(q, pool, [inputLabel]).map((u) => formatUnit(q, u))
  if (q.dim === 'length' && q.v > 0.3 && q.v < 3) list.push(feetInches(q.v))
  if (!list.length) return null
  return { kind: 'ok', expression: text, value: `= ${list[0]}`, copy: list[0].replace(/[^\d.\-e]/gi, ''), alternatives: list.slice(1, 4), usesRates }
}

function feetInches(metres: number) {
  const totalIn = metres / 0.0254
  let ft = Math.floor(totalIn / 12)
  let inch = Math.round((totalIn - ft * 12) * 10) / 10
  if (inch >= 12) {
    ft++
    inch -= 12
  }
  return `${ft}′ ${formatNumber(inch, 3)}″`
}
