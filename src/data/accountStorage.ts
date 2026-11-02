import { api } from '../os/account'

// Settings → Sync's storage figures: the signed-in account's own, as its quota counts them
// (server/quota.ts storageReport). Read on demand, never kept in the browser.

export type StoragePart = { id: string; label: string; purpose: string; unit: string; bytes: number | null; count: number | null }
/** `used`/`remaining` are null when a part could not be read: unknown, not zero. */
export type StorageReport = { used: number | null; limit: number; remaining: number | null; over: boolean; complete: boolean; parts: StoragePart[] }

export const getStorage = (signal?: AbortSignal) => api<StorageReport>('/api/account/storage', { signal })

/** Bytes as people read them, in the binary units the limit is set in: 812 KB, 3.4 MB, 1.2 GB. */
export function storageSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}
