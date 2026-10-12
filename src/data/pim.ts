import { api } from '../os/account'
import type { CalendarEvent } from './calendar'
import type { ThreadRow } from './mail'
import type { Task } from './tasks'

// Where Mail, Contacts, Calendar and Tasks meet, for the browser (server/pim.ts does the work; the
// wiring between the apps is src/os/pimLinks.tsx): invitations answered where the event lives,
// a contact's recent mail and upcoming events, tasks made from a message, and the links that lead
// back to a message from a task or an event.

export type Status = 'accepted' | 'tentative' | 'declined' | 'needs-action'
export type Guest = { email: string; name: string | null; status: Status; organizer?: boolean }
export type InviteState = {
  method: string
  uid: string
  me: string | null
  status: Status | null
  where: { source: 'caldav' | 'google'; calendarId: string; calendar: string; start: string | null; allDay: boolean; cancelled: boolean; organizer: string | null; guests: Guest[] } | null
  organiser: boolean
  replies: (Guest & { current: Status | null; fromSender: boolean })[]
  canAnswer: boolean
}

export const inviteState = (account: number, email: string) => api<InviteState>(`/api/pim/invite?account=${account}&email=${encodeURIComponent(email)}`)

export const inviteAction = (body: { account: number; email: string; action: 'answer' | 'remove' | 'apply'; answer?: 'accepted' | 'tentative' | 'declined'; calendar?: string }) =>
  api<{ state: InviteState; via?: 'caldav' | 'google' | 'email'; added?: string | null }>('/api/pim/invite', { method: 'POST', json: body })

/** The latest conversations with any of these addresses, across the linked mail accounts. */
export const mailWith = (emails: string[], limit = 5) => api<{ messages: (ThreadRow & { account: number })[]; errors: string[] }>(`/api/pim/mail-with?emails=${encodeURIComponent(emails.join(','))}&limit=${limit}`)

/** Events in the next `days` days where any of these addresses is a guest or the organiser. */
export const eventsWith = (emails: string[], days = 60) => api<{ events: CalendarEvent[]; errors: string[] }>(`/api/pim/events-with?emails=${encodeURIComponent(emails.join(','))}&days=${days}`)

/** A message by its Message-ID, in whichever linked account has it. */
export const findMail = (messageId: string) => api<{ account: number; id: string; threadId: string }>(`/api/pim/find-mail?messageId=${encodeURIComponent(messageId)}`)

/** A task from a message (its subject, sender and a snippet, and a link back), due on `due` ("YYYY-MM-DD") or not at all. */
export const taskFromMail = (account: number, email: string, due: string | null) =>
  api<{ task: Task }>('/api/pim/task-from-mail', { method: 'POST', json: { account, email, due, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } })

// ---------------------------------------------------------------------------------------------
// Links back to a message: Apple's message: links (a task's URL: Reminders and Mail on a Mac or
// an iPhone open them too), and this site's own address of one (an event's notes, which Google
// Calendar on a phone shows as a link).

/** The Message-ID in a link to a message (message:%3Cid%3E, or /?open=mail&message=id on this site), or null. */
export function messageIdOf(url: string): string | null {
  try {
    if (/^message:/i.test(url)) return decodeURIComponent(url.replace(/^message:(\/\/)?/i, '')).replace(/^<|>$/g, '').trim() || null
    const u = new URL(url, location.origin)
    if (u.origin !== location.origin || u.searchParams.get('open') !== 'mail') return null
    return u.searchParams.get('message')
  } catch {
    return null
  }
}

/** This site's address of a message, by its Message-ID, for notes and links elsewhere. */
export const mailLink = (messageId: string) => `${location.origin}/?open=mail&message=${encodeURIComponent(messageId)}`
