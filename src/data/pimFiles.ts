// Calendar and address-book files (.ics, .vcf) opened from Files, the desktop, the terminal,
// Spotlight or Mail: they open in Calendar or Contacts and bring up the same import dialog as a file
// dropped on the window. The files are read in the app (each one says how: readBytes in
// data/fileOps.ts for Files' and Seafile's, a mail attachment's own bytes), so an error shows there;
// this only hands them over and says which app takes which file.

export type PimApp = 'calendar' | 'contacts'
export type ImportFile = { name: string; read: () => Promise<Blob> }

export const isIcsName = (name: string) => /\.(ics|ical|ifb|icalendar)$/i.test(name)
export const isVcfName = (name: string) => /\.(vcf|vcard)$/i.test(name)

/** The app that opens a file by default: Calendar for iCalendar files, Contacts for vCards. */
export const pimAppFor = (name: string): PimApp | null => (isIcsName(name) ? 'calendar' : isVcfName(name) ? 'contacts' : null)

const pending = new Map<string, ImportFile[]>()

/** Opens Calendar or Contacts on files to import. */
export function openImport(app: PimApp, files: ImportFile[]) {
  const key = crypto.randomUUID()
  pending.set(key, files)
  // A moment later: opened by a double-click in Files, the window that comes forward must not catch
  // the second click's double-click (on the Calendar's grid it makes a new event).
  setTimeout(() => window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app, props: { import: key, t: String(Date.now()) } } })), 60)
}

/** The app takes the files it was opened on (once). */
export function takeImport(key: string | undefined): ImportFile[] | null {
  if (!key) return null
  const files = pending.get(key) ?? null
  pending.delete(key)
  return files
}
