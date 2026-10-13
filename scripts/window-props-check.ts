// Checks that one-shot requests to an app (an event, task or contact to open, a day to show, files
// to import, a message to write) are kept out of the saved window layout (src/os/windowProps.ts,
// used by serialize and restored in src/os/wm.tsx): saved layouts sync across devices, and a
// window restored from one must not open that editor again after a reload.
//
//   node scripts/window-props-check.ts
//
// Exits 1 on any failure.

import { readFileSync } from 'node:fs'
import { persistentProps } from '../src/os/windowProps.ts'
import { check, finish } from './empires-harness.ts'

const props = (app: Parameters<typeof persistentProps>[0], p: Record<string, string | undefined>) => persistentProps(app, p)

const cal = props('calendar', { event: 'uid@x', occurrence: '2026-10-13T10:00', compose: 'k', import: 'k2', date: '2026-10-09', view: 'week', t: '1' })
check('Calendar: event, occurrence, compose, import, date, view and t are not saved', Object.keys(cal).length === 0)
check('Tasks: the task to open is not saved', !('task' in props('tasks', { task: 'l|u', t: '1' })))
const contacts = props('contacts', { contact: 'c1', email: 'a@b.c', name: 'A', import: 'k', t: '1' })
check('Contacts: contact, email, name and import are not saved', Object.keys(contacts).length === 0)
check('Mail: compose, email and search are not saved', Object.keys(props('mail', { compose: 'k', email: 'm', search: 'q', account: '2' })).join() === 'account')
check('Notebook: the note shown (id) is kept, the stamp is not', JSON.stringify(props('notebook', { id: 'n1', t: '1' })) === '{"id":"n1"}')
check('Terminal: run and under are not saved, others are', JSON.stringify(props('terminal', { run: 'ls', under: '3', cwd: '/x' })) === '{"cwd":"/x"}')

// serialize and restored must go through it.
const wm = readFileSync(new URL('../src/os/wm.tsx', import.meta.url), 'utf8')
check('wm.tsx saves windows with persistentProps', /props: persistentProps\(w\.app, w\.props\),\n\s*\}\)\)/.test(wm))
check('wm.tsx filters old saved layouts when restoring', /props: persistentProps\(w\.app, w\.props\), pid: pid\+\+/.test(wm))
finish()
