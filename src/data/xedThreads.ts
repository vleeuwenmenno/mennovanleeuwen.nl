import type { browserStoreIdentity } from './browserfs'
import { localPref } from '../os/localPref'

/** Browser-local bindings, also used when opening the same ordinary thread in Agents. */
export type XedThreadBinding = { id: string; account: number; root: string; backing: string | null; browser?: ReturnType<typeof browserStoreIdentity> }
export const xedThreads = localPref<XedThreadBinding[]>('mvlos.xed.threads.v1', raw => {
  const v: unknown = raw ? JSON.parse(raw) : []
  return Array.isArray(v) ? v.filter((x): x is XedThreadBinding => !!x && typeof x.id === 'string' && typeof x.account === 'number' && typeof x.root === 'string' && (x.backing === null || typeof x.backing === 'string')).slice(-50) : []
}, JSON.stringify, { account: true })
export function rememberXedThread(binding: XedThreadBinding) {
  xedThreads.set(all => [...all.filter(x => x.id !== binding.id), binding].slice(-50))
}
