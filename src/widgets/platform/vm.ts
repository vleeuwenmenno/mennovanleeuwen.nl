import type { QuickJSWASMModule } from 'quickjs-emscripten-core'
import { LIMITS, relativePath, type Snapshot, type WidgetInput } from './package.ts'
/** The only module supplied by the host. No functions or prototypes cross the VM boundary. */
const SDK = `export const text=(text,tone='normal')=>({type:'text',text:String(text),tone});
export const column=(...children)=>({type:'column',children});
export const row=(...children)=>({type:'row',children});
export const button=(text,event)=>({type:'button',text,event});
export const editor=()=>({type:'editor'});
const resourceNode=(type,text,resource,options)=>resource?({type,text,resource,...options}):({type:'column',children:[...(text?[{type:'text',text,tone:'muted'}]:[]),...(options.children||[])]});
export const action=(text,resource,options={})=>resourceNode('action',text,resource,options);
export const link=(text,resource,options={})=>resourceNode('link',text,resource,options);
export const image=(resource,text='')=>({type:'image',resource,text});
export const dot=(resource)=>resource?({type:'dot',resource}):({type:'dot'});
export const details=(...children)=>({type:'details',children});
export const card=(resource,...children)=>resource?({type:'card',resource,children}):({type:'column',children});`
export function modulePath(base: string, name: string): string {
  if (name === '@mvlos/widget') return name
  if (!name.startsWith('./') && !name.startsWith('../')) throw new Error('External imports are disabled')
  const parts = base.split('/').slice(0, -1)
  for (const part of name.split('/')) {
    if (part === '.') continue
    if (part === '..') { if (parts.length <= 1) throw new Error('Import escapes src'); parts.pop() }
    else parts.push(part)
  }
  const path = relativePath(parts.join('/'))
  if (!path.startsWith('src/') || !path.endsWith('.js')) throw new Error('Only local JS source imports are supported')
  return path
}
/** Fresh runtime per transaction: no persistent jobs, handles or authority after return. */
export function invokeVM(qjs: QuickJSWASMModule, snapshot: Snapshot, input: WidgetInput, event?: string): unknown {
  const runtime = qjs.newRuntime()
  runtime.setMemoryLimit(LIMITS.memory)
  runtime.setMaxStackSize(LIMITS.stack)
  const deadline = performance.now() + LIMITS.cpuMs
  runtime.setInterruptHandler(() => performance.now() > deadline)
  runtime.setModuleLoader(name => {
    if (name === '@mvlos/widget') return SDK
    if (!Object.prototype.hasOwnProperty.call(snapshot.files, name) || !name.startsWith('src/')) throw new Error('Module not in snapshot')
    return snapshot.files[name]
  }, modulePath)
  const context = runtime.newContext()
  const take = (result: ReturnType<typeof context.evalCode>) => {
    if (result.error) { result.error.dispose(); throw new Error('Widget execution failed (exception, memory or CPU limit)') }
    return result.value
  }
  try {
    // Serialize inside the VM: getters, toJSON and proxy traps are covered by the interrupt.
    const code = `import * as widget from './${snapshot.manifest.entry.slice(4)}';
      const input = ${JSON.stringify(input)};
      const value = ${event === undefined ? 'widget.render(input)' : `widget.event(input, ${JSON.stringify(event)})`};
      if (value && typeof value.then === 'function') throw Error('Async entrypoints are unsupported');
      globalThis.__output = JSON.stringify(value);`
    take(context.evalCode(code, 'src/__invoke.js', { type: 'module' })).dispose()
    const jobs = runtime.executePendingJobs(LIMITS.jobs)
    if (jobs.error) { jobs.error.dispose(); throw new Error('Widget promise job failed') }
    if (runtime.hasPendingJob()) throw new Error('Widget promise job limit')
    const handle = take(context.evalCode(`if (typeof __output !== 'string' || __output.length > ${LIMITS.outputBytes}) throw Error('Output limit'); __output`, 'result.js'))
    try { return JSON.parse(context.getString(handle)) } finally { handle.dispose() }
  } finally {
    context.dispose()
    runtime.dispose()
  }
}
