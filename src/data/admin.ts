import { api } from '../os/account'

// Settings → Users, for admins (server/admin.ts): the accounts, with what they link and how
// much they store (never what), and whether new accounts may sign up.

export type AdminUser = {
  id: number
  login: string
  name: string | null
  avatar: string | null
  joinedAt: number
  lastSeenAt: number | null
  banned: { at: number; reason: string | null } | null
  admin: boolean
  services: string[]
  storageBytes: number
  threads: number
}

export type AdminStats = { count: number; max: number; open: boolean; banned: number; storageMb: number }

export const adminStats = () => api<AdminStats>('/api/admin/stats')
export const setAdminSettings = (body: { registration?: 'open' | 'closed'; maxUsers?: number; storageMb?: number }) => api<AdminStats>('/api/admin/settings', { method: 'PUT', json: body })

export function adminUsers(q: string, cursor: string | null) {
  const params = new URLSearchParams({ q, ...(cursor ? { cursor } : {}) })
  return api<{ users: AdminUser[]; next: string | null }>(`/api/admin/users?${params}`)
}

export const banUser = (id: number, reason: string) => api<AdminUser>(`/api/admin/users/${id}/ban`, { method: 'POST', json: { reason } })
export const unbanUser = (id: number) => api<AdminUser>(`/api/admin/users/${id}/unban`, { method: 'POST', json: {} })
export const signOutUser = (id: number) => api<AdminUser>(`/api/admin/users/${id}/signout`, { method: 'POST', json: {} })
export const deleteUser = (id: number) => api<{ ok: true }>(`/api/admin/users/${id}`, { method: 'DELETE' })
