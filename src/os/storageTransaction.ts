/** One origin-wide readwrite scope serializes synchronous shared-storage critical sections.
 * IndexedDB stores no account data here. No await is permitted inside the callback: the IDB
 * request event stays active until the localStorage merge/write/receipt cleanup has finished.
 * This is mutual exclusion, not a claim that IndexedDB rolls back localStorage on abort. */
export const WIDGET_STORAGE_KEY = 'mvlos.sync.widgets:state:v2'
export const WIDGET_JOURNAL_PREFIX = 'mvlos.widgets.pending:v2'
const active = new Set<IDBTransaction>()
if (typeof window !== 'undefined') for (const event of ['mvlos:forget', 'mvlos:account-changed']) window.addEventListener(event, () => {
  for (const tx of active) try { tx.abort() } catch { /* already completed */ }
})
let connection: Promise<IDBDatabase> | undefined
function database(): Promise<IDBDatabase> {
  if (connection) return connection
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Transactional widget storage unavailable; pending changes retained')); return }
    let request: IDBOpenDBRequest, settled = false
    const fail = (message: string) => { settled = true; clearTimeout(timeout); reject(new Error(message)) }
    const timeout = setTimeout(() => fail('Transactional widget storage timed out; pending changes retained'), 5000)
    try { request = indexedDB.open('mvlos-storage-serialization-v1', 1) }
    catch { fail('Transactional widget storage blocked; pending changes retained'); return }
    request.onupgradeneeded = () => request.result.createObjectStore('exclusive')
    request.onerror = () => fail('Transactional widget storage blocked; pending changes retained')
    request.onblocked = () => fail('Transactional widget storage busy; pending changes retained')
    request.onsuccess = () => {
      const db = request.result
      if (settled) { db.close(); return }
      settled = true
      clearTimeout(timeout)
      db.onversionchange = () => { db.close(); connection = undefined }
      resolve(db)
    }
  }).catch(error => { connection = undefined; throw error })
  return connection
}
export async function storageTransaction<T>(run: () => T): Promise<T> {
  const db = await database()
  return new Promise<T>((resolve, reject) => {
    let result: T, failure: unknown
    let tx: IDBTransaction
    try { tx = db.transaction('exclusive', 'readwrite') }
    catch { connection = undefined; reject(new Error('Transactional widget storage unavailable; pending changes retained')); return }
    active.add(tx)
    const timeout = setTimeout(() => { failure = new Error('Widget storage transaction timed out; pending changes retained'); try { tx.abort() } catch { /* already completed */ } }, 5000)
    const finish = () => { clearTimeout(timeout); active.delete(tx) }
    tx.oncomplete = () => { finish(); resolve(result) }
    tx.onabort = () => { finish(); reject(failure ?? new Error('Widget storage transaction aborted; pending changes retained')) }
    tx.onerror = () => { /* onabort reports the terminal result */ }
    const request = tx.objectStore('exclusive').get('gate')
    request.onsuccess = () => {
      try {
        result = run()
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Storage transaction callbacks must be synchronous')
      } catch (error) { failure = error; try { tx.abort() } catch { /* authority change already aborted it */ } }
    }
  })
}
