import type { QuickJSWASMModule } from 'quickjs-emscripten-core'
import { LIMITS, relativePath, type Snapshot, type WidgetInput } from './package.ts'
/** The only module supplied by the host. No functions or prototypes cross the VM boundary. */
const SDK = `const split=(a)=>a.length&&a[0]&&typeof a[0]==='object'&&a[0].type===undefined?[a[0],a.slice(1)]:[{},a];
export const text=(text,tone='normal',options={})=>({type:'text',text:String(text),tone,...options});
export const column=(...a)=>{const [o,children]=split(a);return {type:'column',...o,children}};
export const row=(...a)=>{const [o,children]=split(a);return {type:'row',...o,children}};
export const grid=(columns,...a)=>{const [o,children]=split(a);return {type:'grid',columns,...o,children}};
export const box=(...a)=>{const [o,children]=split(a);return {type:'box',...o,children}};
export const button=(text,event)=>({type:'button',text,event});
export const editor=()=>({type:'editor'});
export const badge=(text,tone='normal',options={})=>({type:'badge',text:String(text),tone,...options});
export const icon=(name,tone='normal',options={})=>({type:'icon',name,tone,...options});
export const progress=(value,tone='accent',options={})=>({type:'progress',value,tone,...options});
export const divider=(options={})=>({type:'divider',...options});
export const spacer=(options={})=>({type:'spacer',...options});
const resourceNode=(type,text,resource,options)=>{const {fallback,...rest}=options;return resource?({type,text,resource,...rest}):({type:fallback==='row'?'row':'column',...(fallback==='row'?{align:'center'}:{}),children:[...(text?[{type:'text',text,tone:'muted'}]:[]),...(rest.children||[])]})};
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
    if (result.error) {
      // The author's own message (an exception's name and text, or "interrupted" for the CPU limit), so a broken widget can be fixed.
      let detail = ''
      try { const e = context.dump(result.error) as { name?: unknown; message?: unknown } | string; detail = typeof e === 'string' ? e : `${String(e?.name ?? 'Error')}: ${String(e?.message ?? '')}` } catch { /* generic message only */ }
      result.error.dispose()
      throw new Error(`Widget execution failed (exception, memory or CPU limit)${detail ? `: ${detail.replace(/[^\x20-\x7e]/g, ' ').slice(0, 160)}` : ''}`)
    }
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
