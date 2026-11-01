import type { IssueHit } from '../../data/code'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nullableNumber = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value)
const nullableText = (value: unknown) => value === null || typeof value === 'string'
function rows<T>(value: unknown, valid: (row: Record<string, unknown>) => boolean): T[] {
  if (!Array.isArray(value) || value.length > 10_000 || !value.every(row => object(row) && valid(row))) throw new Error('Invalid or oversized widget data response')
  return value as T[]
}
export type InboxData = { review: IssueHit[]; mine: IssueHit[]; assigned: IssueHit[]; errors: string[] }
export function inboxData(value: unknown): InboxData {
  if (!object(value)) throw new Error('Invalid inbox response')
  const hit = (row: Record<string, unknown>) => ['title','repo','source','sourceLabel','url'].every(key => typeof row[key] === 'string') && (row.kind === 'pr' || row.kind === 'issue') && Number.isSafeInteger(row.number) && Number(row.number) > 0 && (typeof row.updatedAt === 'string' || typeof row.updatedAt === 'number')
  return { review: rows(value.review, hit), mine: rows(value.mine, hit), assigned: rows(value.assigned, hit), errors: Array.isArray(value.errors) ? value.errors.filter((error): error is string => typeof error === 'string') : [] }
}
export type StatusCheck = { token: string; name: string; url: string; down: boolean; enabled: boolean; error: string | null; downSince: string | null; uptime: number | null; responseTime: number | null; sslExpiresAt: string | null; sslValid: boolean | null }
export function statusData(value: unknown): StatusCheck[] {
  return rows(value, row => ['token','name','url'].every(key => typeof row[key] === 'string') && typeof row.down === 'boolean' && typeof row.enabled === 'boolean' && ['error','downSince','sslExpiresAt'].every(key => nullableText(row[key])) && ['uptime','responseTime'].every(key => nullableNumber(row[key])) && (row.sslValid === null || typeof row.sslValid === 'boolean'))
}
