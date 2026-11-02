/** Private reads share only within the same account/connection authority. Last subscriber aborts. */
type Entry = { at: number; pending: boolean; users: number; controller: AbortController; value: Promise<unknown> }
const entries = new Map<string,Entry>()
export async function sharedRead<T>(key:string,ttl:number,load:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal,fresh=false):Promise<T> {
  signal.throwIfAborted()
  let entry=entries.get(key)
  if(!entry || !entry.pending && (fresh || Date.now()-entry.at>=ttl)) {
    const controller=new AbortController()
    const created:Entry={at:Date.now(),pending:true,users:0,controller,value:Promise.resolve().then(()=>load(controller.signal))}
    created.value.then(()=>{created.pending=false},()=>{created.pending=false;if(entries.get(key)===created)entries.delete(key)})
    entries.set(key,entry=created)
  }
  const captured=entry
  captured.users++
  return new Promise<T>((resolve,reject)=>{
    let ended=false
    const finish=(error:unknown,value?:T)=>{
      if(ended)return;ended=true;signal.removeEventListener('abort',cancel);captured.users--
      if(captured.pending&&captured.users===0){captured.controller.abort();if(entries.get(key)===captured)entries.delete(key)}
      if(error)reject(error);else resolve(value as T)
    }
    const cancel=()=>finish(new DOMException('Read cancelled','AbortError'))
    signal.addEventListener('abort',cancel,{once:true})
    captured.value.then(value=>signal.aborted?cancel():finish(null,value as T),error=>finish(error))
  })
}
if(typeof window!=='undefined')for(const event of ['mvlos:forget','mvlos:account-changed'])window.addEventListener(event,()=>{for(const entry of entries.values())entry.controller.abort();entries.clear()})
