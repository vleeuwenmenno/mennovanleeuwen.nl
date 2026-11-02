import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core'
import variant from '@jitl/quickjs-wasmfile-release-sync'
import wasmURL from '@jitl/quickjs-wasmfile-release-sync/wasm?url'
import { descriptor, mutation, verifySnapshot, type Snapshot, type WidgetInput } from './package'
import { invokeVM } from './vm'
// Static self-origin WASM URL: CSP needs wasm-unsafe-eval, never unsafe-eval or blob workers.
const engine = newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmLocation: wasmURL }))
self.onmessage = async (e: MessageEvent<{ snapshot: Snapshot; input: WidgetInput; event?: string }>) => {
  try {
    const snapshot = await verifySnapshot(e.data.snapshot)
    const result = invokeVM(await engine, snapshot, e.data.input, e.data.event)
    postMessage({ ok: true, value: e.data.event === undefined ? descriptor(result) : mutation(result) })
  } catch (error) { postMessage({ ok: false, error: error instanceof Error ? error.message : 'Widget failed' }) }
}
