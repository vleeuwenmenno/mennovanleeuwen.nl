// When an agent task runs (server/agentTasks.ts, the Agents app's Tasks tab and the agents TUI's
// /tasks): once (now or at a time), every day, on weekdays, on some days of the week at a time, or
// by a cron line. Times are wall-clock times in the task's time zone, worked out with Intl (no
// time zone data of our own). Shared by the browser and the server: no DOM or Node APIs here.
//
// Daylight saving time, pinned in scripts/agents-tasks-check.ts:
// - a time that does not exist (the clocks jump from 02:00 to 03:00) runs at the first minute
//   that does (03:00), once, however many times of the gap the schedule names;
// - a time that happens twice (the clocks go back from 03:00 to 02:00) runs at its first
//   occurrence only.

export type Schedule =
  /** One run: at a moment (ms), or as soon as it is saved (null) */
  | { kind: 'once'; at: number | null }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  /** `days`: 0 is Sunday, 6 Saturday */
  | { kind: 'weekly'; time: string; days: number[] }
  | { kind: 'cron'; expr: string }

/** Repeating tasks run at most this often (cron included). */
export const MIN_INTERVAL_MS = 15 * 60_000

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** A parsed cron line: the values each field allows, and whether day of month and day of week were both narrowed (then either matches, as in Vixie cron). */
export type Cron = { minutes: number[]; hours: number[]; days: Set<number>; months: Set<number>; weekdays: Set<number>; anyDay: boolean; anyWeekday: boolean }

function field(raw: string, min: number, max: number, names: string[] | null, what: string): { values: number[]; any: boolean } {
  const out = new Set<number>()
  const value = (s: string) => {
    const lower = s.toLowerCase()
    const named = names ? names.indexOf(lower) : -1
    if (named >= 0) return named + (names === MONTH_NAMES ? 1 : 0)
    if (!/^\d{1,2}$/.test(s)) throw new Error(`${what}: "${s}" is not a number`)
    return Number(s)
  }
  for (const part of raw.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1 || step > max) throw new Error(`${what}: bad step "${stepRaw}"`)
    let lo: number
    let hi: number
    if (range === '*') (lo = min), (hi = max)
    else if (range.includes('-')) {
      const [a, b] = range.split('-')
      lo = value(a)
      hi = value(b)
    } else {
      lo = value(range)
      hi = stepRaw === undefined ? lo : max
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`${what}: ${range} is outside ${min}–${max}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return { values: [...out].sort((a, b) => a - b), any: raw === '*' || raw === '*/1' }
}

/** A five-field cron line (minute hour day-of-month month day-of-week), or an error saying what is wrong. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('A cron line has five fields: minute, hour, day of month, month, day of week')
  const [mi, h, d, mo, wd] = parts
  const minutes = field(mi, 0, 59, null, 'Minute')
  const hours = field(h, 0, 23, null, 'Hour')
  const days = field(d, 1, 31, null, 'Day of month')
  const months = field(mo, 1, 12, MONTH_NAMES, 'Month')
  const weekdays = field(wd, 0, 7, DAY_NAMES, 'Day of week')
  return { minutes: minutes.values, hours: hours.values, days: new Set(days.values), months: new Set(months.values), weekdays: new Set(weekdays.values.map((v) => v % 7)), anyDay: days.any, anyWeekday: weekdays.any }
}

/** The cron line a picked schedule stands for (null for once). */
export function cronOf(s: Schedule): Cron | null {
  if (s.kind === 'once') return null
  if (s.kind === 'cron') return parseCron(s.expr)
  const m = TIME.exec(s.time)
  if (!m) throw new Error('Pick a time like 08:30')
  const at = `${Number(m[2])} ${Number(m[1])}`
  if (s.kind === 'daily') return parseCron(`${at} * * *`)
  if (s.kind === 'weekdays') return parseCron(`${at} * * 1-5`)
  const days = [...new Set(s.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
  if (!days.length) throw new Error('Pick at least one day')
  return parseCron(`${at} * * ${days.join(',')}`)
}

// --- wall clock and time zones -------------------------------------------------------------------

const formats = new Map<string, Intl.DateTimeFormat>()
function formatter(zone: string) {
  let f = formats.get(zone)
  if (!f) formats.set(zone, (f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })))
  return f
}

/** Whether a zone is one Intl knows. */
export function validZone(zone: string): boolean {
  try {
    formatter(zone)
    return true
  } catch {
    return false
  }
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number }
/** The wall clock in a zone at a moment. */
export function wallAt(ms: number, zone: string): Wall {
  const parts = formatter(zone).formatToParts(new Date(ms))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute') }
}
const wallKey = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi)
/** How far a zone is ahead of UTC at a moment, in ms (whole minutes). */
const offsetAt = (ms: number, zone: string) => wallKey(wallAt(ms, zone)) - Math.floor(ms / 60_000) * 60_000

/**
 * The moment a wall-clock minute happens in a zone: its first occurrence when the clocks go back,
 * and the first minute after the gap when it falls in one (the clocks went forward over it).
 */
export function fromWall(w: Wall, zone: string): number {
  const naive = wallKey(w)
  const before = naive - offsetAt(naive - 14 * 3600_000, zone)
  const after = naive - offsetAt(naive + 14 * 3600_000, zone)
  const valid = [before, after].filter((t) => wallKey(wallAt(t, zone)) === naive)
  if (valid.length) return Math.min(...valid)
  // In a gap: the change happened between `after` (still on the old clock) and `before`; the
  // first minute on the new clock is the first valid one.
  let lo = Math.min(before, after)
  let hi = Math.max(before, after)
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000
    if (wallKey(wallAt(mid, zone)) - mid === wallKey(wallAt(lo, zone)) - lo) lo = mid
    else hi = mid
  }
  return hi
}

const DAY = 86400_000

function matchesDay(c: Cron, y: number, mo: number, d: number): boolean {
  if (!c.months.has(mo)) return false
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  const dayOk = c.days.has(d)
  const wdOk = c.weekdays.has(wd)
  // Both narrowed: either is enough. One narrowed: that one.
  if (!c.anyDay && !c.anyWeekday) return dayOk || wdOk
  return dayOk && wdOk
}

/** The first run of a cron line after `after` (ms), in a zone; null when there is none within five years. */
export function nextCron(c: Cron, zone: string, after: number): number | null {
  const start = wallAt(after, zone)
  let day = Date.UTC(start.y, start.mo - 1, start.d)
  for (let i = 0; i < 366 * 5; i++, day += DAY) {
    const dt = new Date(day)
    const y = dt.getUTCFullYear()
    const mo = dt.getUTCMonth() + 1
    const d = dt.getUTCDate()
    if (!matchesDay(c, y, mo, d)) continue
    let best: number | null = null
    for (const h of c.hours)
      for (const mi of c.minutes) {
        const t = fromWall({ y, mo, d, h, mi }, zone)
        // A time in a gap lands on the gap's end, which can be on this day's later minutes too: the earliest wins, once.
        if (t > after && (best === null || t < best)) best = t
      }
    if (best !== null) return best
  }
  return null
}

/** The next run of a schedule after `after`, or null (a one-off that has run, a cron line that never matches). */
export function nextRun(s: Schedule, zone: string, after: number): number | null {
  if (s.kind === 'once') return s.at === null ? null : s.at > after ? s.at : null
  return nextCron(cronOf(s)!, zone, after)
}

/** The next `n` runs after `after`. */
export function upcoming(s: Schedule, zone: string, after: number, n: number): number[] {
  const out: number[] = []
  let t = after
  for (let i = 0; i < n; i++) {
    const next = nextRun(s, zone, t)
    if (next === null) break
    out.push(next)
    t = next
  }
  return out
}

/** The shortest time between two runs over the next few hundred, for the 15-minute floor (Infinity for once). */
export function shortestGap(s: Schedule, zone: string, from: number): number {
  if (s.kind === 'once') return Infinity
  const runs = upcoming(s, zone, from, 300)
  let gap = Infinity
  for (let i = 1; i < runs.length; i++) gap = Math.min(gap, runs[i] - runs[i - 1])
  return gap
}

/** A schedule as sent, checked (or an error to show). */
export function cleanSchedule(v: unknown): Schedule {
  const s = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const time = typeof s.time === 'string' ? s.time : ''
  switch (s.kind) {
    case 'once': {
      const at = s.at === null || s.at === undefined ? null : Number(s.at)
      if (at !== null && !Number.isFinite(at)) throw new Error('Pick when it runs')
      return { kind: 'once', at }
    }
    case 'daily':
    case 'weekdays':
      if (!TIME.test(time)) throw new Error('Pick a time like 08:30')
      return { kind: s.kind, time }
    case 'weekly': {
      if (!TIME.test(time)) throw new Error('Pick a time like 08:30')
      const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : []
      if (!days.length) throw new Error('Pick at least one day')
      return { kind: 'weekly', time, days }
    }
    case 'cron': {
      const expr = String(s.expr ?? '').trim().replace(/\s+/g, ' ').slice(0, 120)
      parseCron(expr)
      return { kind: 'cron', expr }
    }
  }
  throw new Error('Pick when it runs: once, daily, on weekdays, weekly or a cron line')
}

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "Every weekday at 08:00", "Once, 3 Nov 14:00", "Cron: 0 9 * * 1". */
export function describeSchedule(s: Schedule, zone: string): string {
  switch (s.kind) {
    case 'once':
      return s.at === null ? 'Once, right away' : `Once, ${new Date(s.at).toLocaleString('en-GB', { timeZone: zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    case 'daily':
      return `Every day at ${s.time}`
    case 'weekdays':
      return `Every weekday at ${s.time}`
    case 'weekly':
      return `Every ${s.days.map((d) => WEEKDAY_LABELS[d]).join(', ')} at ${s.time}`
    case 'cron':
      return `Cron: ${s.expr}`
  }
}
