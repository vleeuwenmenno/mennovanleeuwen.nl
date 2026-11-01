import { useEffect, useMemo } from 'react'
import { ClientCalls } from './lifecycle'

/** Each rendered thread owns its executor, including pending claims. Old stream closures retain
 * the closed executor after a thread switch, so late events cannot borrow the new thread's owner. */
export function useClientCalls(thread: string | null, createdHere: string | null = null) {
  // Creating the first thread keeps its original send stream and callbacks. Adopt that ID
  // without closing their owner; navigating to a different thread still creates a new owner.
  const scope = thread === createdHere ? null : thread
  const calls = useMemo(() => new ClientCalls(), [scope])
  useEffect(() => {
    calls.activate()
    return () => calls.close()
  }, [calls])
  return calls
}
