import { installations } from './installations'
import { defaultFiles } from './defaults'
import { CUSTOM_KIND } from './package'

/** Whether a built-in kind's own package says it works on a phone (its manifest's `phone`). Read from the bundled source folder, so it is known before any build. */
const builtinPhone = new Map<string, boolean>()
export function builtinRunsOnPhone(kind: string): boolean {
  let known = builtinPhone.get(kind)
  if (known === undefined) {
    try { known = (JSON.parse(defaultFiles(kind)['manifest.json'] ?? 'null') as { phone?: unknown } | null)?.phone === true } catch { known = false }
    builtinPhone.set(kind, known)
  }
  return known
}

/**
 * Whether a placed widget runs and shows on a phone-sized screen: only when the manifest of its
 * ACTIVE revision says `phone: true`. An installed revision (a fork, or a built-in activated on
 * purpose) decides for itself, even when the built-in it came from says true; a built-in without an
 * installation record uses its default package. Anything unknown stays hidden, as before.
 */
export function widgetRunsOnPhone(kind: string | undefined, id: string | undefined): boolean {
  if (!kind) return false
  const record = id ? installations.get()[id] : undefined
  if (record) return record.active.snapshot.manifest.phone === true
  return kind !== CUSTOM_KIND && builtinRunsOnPhone(kind)
}
