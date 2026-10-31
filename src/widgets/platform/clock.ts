import type { ClockInput } from './package.ts'
/** The clock widget's host side: pure formatting and timer maths, no React and no storage (node checks import it). */
export type ClockConfig = { hours: 'auto' | '24' | '12'; seconds: boolean; show: ClockInput['show']; accent: boolean; tilt: number }
export const CLOCK_DEFAULTS: ClockConfig = { hours: 'auto', seconds: false, show: 'full', accent: false, tilt: 0 }
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(v as T) ? v as T : fallback
/** Saved settings can be anything (they sync): anything out of range falls back to the default. */
export function clockConfig(raw: Partial<Record<keyof ClockConfig, unknown>>): ClockConfig {
  return { hours: pick(raw.hours, ['auto', '24', '12'], 'auto'), seconds: raw.seconds === true, show: pick(raw.show, ['full', 'short', 'none'], 'full'), accent: raw.accent === true, tilt: typeof raw.tilt === 'number' && Number.isFinite(raw.tilt) ? raw.tilt : 0 }
}
const parts = (format: Intl.DateTimeFormat, at: number) => Object.fromEntries(format.formatToParts(at).map(p => [p.type, p.value])) as Record<string, string>
/** The clock as the package sees it. `locale` and `timeZone` default to this browser's own. */
export function clockInput(now: number, config: ClockConfig, locale?: string, timeZone?: string): ClockInput {
  const auto = /^h1[12]$/.test(new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle ?? '')
  const hour12 = config.hours === 'auto' ? auto : config.hours === '12'
  const t = parts(new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: hour12 ? 'h12' : 'h23' }), now)
  const hour = hour12 ? String(Number(t.hour)) : t.hour.padStart(2, '0')
  const d = parts(new Intl.DateTimeFormat(locale, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }), now)
  const long = new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'long', year: 'numeric' }).format(now)
  const short = new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'short' }).format(now)
  return {
    now,
    today: `${d.year}-${d.month}-${d.day}`,
    time: `${hour}:${t.minute}${config.seconds ? `:${t.second}` : ''}`,
    period: hour12 ? t.dayPeriod ?? '' : '',
    weekday: new Intl.DateTimeFormat(locale, { timeZone, weekday: 'long' }).format(now),
    weekdayShort: new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short' }).format(now),
    date: long,
    dateShort: short,
    seconds: config.seconds,
    hour12,
    show: config.show,
    tone: config.accent ? 'accent' : 'normal',
  }
}
/** Milliseconds until the next tick: the next full second, or the next full minute without seconds. Never zero, so a timer cannot spin. */
export const clockDelay = (now: number, seconds: boolean) => { const step = seconds ? 1000 : 60_000; return step - (now % step) + 20 }
