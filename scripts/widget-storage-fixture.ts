// Minimal request-event FIFO for model/store fixtures. This is deliberately not an IndexedDB
// implementation: real browser transaction scheduling is exercised by widget-review2-e2e.ts.
export function widgetStorageFixture(capture: () => (callback: () => void) => void) {
  const queue: (() => void)[] = []
  let running = false
  const pump = () => {
    if (running || !queue.length) return
    running = true
    queueMicrotask(() => { queue.shift()!(); running = false; pump() })
  }
  return { open() {
    const run = capture(), request: any = {}
    request.result = { createObjectStore() {}, close() {}, transaction() {
      const tx: any = {}, get: any = {}
      let aborted = false
      tx.abort = () => { if (!aborted) { aborted = true; queueMicrotask(() => run(() => tx.onabort?.())) } }
      tx.objectStore = () => ({ get: () => get })
      queue.push(() => run(() => { if (aborted) return; get.onsuccess?.(); if (!aborted) tx.oncomplete?.() }))
      pump()
      return tx
    } }
    queueMicrotask(() => run(() => request.onsuccess?.()))
    return request
  } }
}
