import { sharedRead } from './sharedRead'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { dayKey, eventsOn, eventTime, fetchEvents, openEvent, startOfDay, useCalendarVersion, useCalendarList, useEventMarks, useHiddenCalendars, useShownCalendarIds } from '../../data/calendar'
import { completeTask, currentTask, dueDay, openTask, useTaskPrefs, useTasks } from '../../data/tasks'
import { dimension, fetchMinecraft, MC_ADDRESS, vitals, type McStatus } from '../../data/minecraft'
import { inboxData, statusData } from './brokerData'
import { timeAgo } from '../../data/recents'
import { api, connectGoogle, getAccount, hasCalendar, signIn, useAccount } from '../../os/account'
import { accountGuard } from '../../os/accountSpace'
import { openLink } from '../../data/links'
import { gitProps, repoApi, routeToView } from '../../apps/git/route'
import { useWM } from '../../os/wm'
import { useWidgetConfig } from '../config'
import type { Capability } from './package'
import type { AgendaProjection, BrokerPresentation, BrokerResource, InboxProjection, PageInfo, StatusProjection, MinecraftProjection } from './brokerTypes'
export type DomainKind = 'agenda' | 'inbox' | 'status' | 'minecraft'
export type BrokerProps = { kind: DomainKind; id: string; lifecycle: string; page: number; tick: number; capabilities: readonly Capability[]; eligible: () => boolean; present: (value: BrokerPresentation | null) => void }
const text = (value: unknown, max = 256) => typeof value === 'string' ? value.length>max?value.slice(0,max-15)+'… [truncated]':value : ''
const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const errors = (values: unknown) => Array.isArray(values) ? values.slice(0,8).map(value => text(value,160).replace(/(Bearer\s+|(?:token|api[-_]?key|password)[=:]\s*)[^\s,;]+/gi,'$1[redacted]').replace(/https?:\/\/[^/\s]*@/gi,'https://[redacted]@')) : []
const url = (value: unknown) => { try { const u=new URL(String(value));return ['https:','http:'].includes(u.protocol) && !u.username && !u.password ? u.href : undefined } catch { return undefined } }
const pageOf = (total: number, requested: number, size: number): PageInfo => { const pages=Math.max(1,Math.ceil(total/size)),page=Math.max(0,Math.min(Math.floor(requested)||0,pages-1));return {total,shown:Math.min(size,Math.max(0,total-page*size)),page,pages,truncated:total>size} }
function authority() { const a=getAccount();return JSON.stringify([a.status,a.user?.id,a.google,a.caldav,a.forges,a.integrations]) }
function useScope(props: BrokerProps) {
  const account = useAccount(), wm=useWM()
  const key=authority()
  const valid=()=>props.eligible() && accountGuard() && authority()===key
  const resources=new Map<string,BrokerResource>()
  const add=(value:BrokerResource)=>{const id=crypto.randomUUID();resources.set(id,{...value,valid:()=>valid() && (value.valid?.() ?? true)});return id}
  const act=props.capabilities.includes(`${props.kind}.${props.kind==='inbox'||props.kind==='status'?'navigate':'act'}` as Capability)
  const action=(label:string,run:()=>void|Promise<void>,extra:Partial<BrokerResource>={})=>act?add({kind:'action',label,run:()=>{if(valid() && (extra.valid?.()??true))return run()},...extra}):''
  const link=(label:string,href:unknown,run?:()=>void|Promise<void>,check?:()=>boolean)=>{const safe=url(href);return act?add({kind:'link',label,href:safe,valid:check,run:()=>{if(valid()&&(check?.()??true)){if(run)return run();if(safe)openLink(safe)}}}):''}
  const color=(raw:unknown)=>add({kind:'color',label:'Calendar color',color:typeof raw==='string'&&/^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(raw)?raw:'var(--accent)'})
  const controls = { ...(account.status==='anon'?{signIn:action('Sign in',signIn)}:{}), ...(account.status==='user'?{settings:action('Open integration settings',()=>wm.open('settings',{section:'integrations',sub:props.kind==='agenda'?'calendars':'',t:String(Date.now())})),...(props.kind==='agenda'&&account.googleEnabled?{google:action('Connect Google Calendar',connectGoogle)}:{})}:{}), open:props.kind==='agenda'?action('Open Calendar',()=>wm.open('calendar',{t:String(Date.now())})):props.kind==='inbox'?link('Open GitHub notifications','https://github.com/notifications'):props.kind==='status'?link('Open updown.io','https://updown.io/checks'):action('Open Minecraft server',()=>wm.open('mcserver',{t:String(Date.now())})) }
  return {account,wm,key,valid,resources,add,action,link,color,controls}
}
function useLoad<T>(load:(signal:AbortSignal,first:boolean)=>Promise<T>, key:string, enabled:boolean, interval:number, eligible:()=>boolean) {
  const [state,set]=useState<{key:string;value:T|null;error:string}>({key:'',value:null,error:''})
  useLayoutEffect(()=>{
    if(!enabled)return
    let live=true,timer:ReturnType<typeof setTimeout>|undefined
    const abort=new AbortController()
    let first=true
    const again=async()=>{
      if(!live||abort.signal.aborted||!eligible())return
      try { const value=await load(abort.signal,first);first=false;if(live&&!abort.signal.aborted&&eligible())set({key,value,error:''}) }
      catch (error) { if(live&&!abort.signal.aborted&&eligible())set({key,value:null,error:errors([error instanceof Error ? error.message : 'Request unavailable'])[0] || 'Request unavailable'}) }
      if(live&&!abort.signal.aborted&&eligible())timer=setTimeout(()=>void again(),interval)
    }
    void again()
    return()=>{live=false;abort.abort();clearTimeout(timer)}
  },[key,enabled])
  return state.key===key?state:{key,value:null,error:''}
}
function usePublish(props:BrokerProps,value:BrokerPresentation) {
  useLayoutEffect(()=>{props.present(value);return()=>props.present(null)},[value])
}
function AgendaBroker(props:BrokerProps) {
  const config=useWidgetConfig(props.id,{calendars:null as string[]|null,days:3})
  const calendars=useCalendarList().calendars,shown=useShownCalendarIds(),hidden=useHiddenCalendars(),version=useCalendarVersion(),markOf=useEventMarks()
  const tasks=useTasks(),prefs=useTaskPrefs(),scope=useScope(props)
  const days=[1,3,7].includes(config.days)?config.days:3
  const allowed=new Set((calendars??[]).map(c=>c.id))
  const ids=Array.isArray(config.calendars)?calendars?config.calendars.filter(id=>typeof id==='string'&&allowed.has(id)&&!hidden.includes(id)):null:shown
  const ready=scope.account.status==='user'&&hasCalendar(scope.account)
  const key=JSON.stringify([props.lifecycle,scope.key,ids,days,version,props.tick])
  const result=useLoad((signal,first)=>fetchEvents(startOfDay(new Date()),startOfDay(new Date(),days),ids,props.tick>0&&first,signal).then(value=>{signal.throwIfAborted();return value}),key,ready&&!!ids,5*60_000,scope.valid)
  const [minute,setMinute]=useState(0)
  useEffect(()=>{const t=setInterval(()=>{if(scope.valid())setMinute(n=>n+1)},60_000);return()=>clearInterval(t)},[props.lifecycle,scope.key])
  const value=useMemo<BrokerPresentation>(()=>{
    const s=scope
    const today=dayKey(new Date()),now=Date.now(),colors=new Map((tasks.lists??[]).map(list=>[list.id,list.color]))
    const todays=(ready?tasks.tasks:[]).filter(task=>!task.completed&&task.due&&dueDay(task)!<=today&&colors.has(task.list)&&!prefs.hiddenInCalendar.includes(task.list)&&!hidden.includes(task.list))
    const grouped=Array.from({length:days},(_,i)=>{const date=startOfDay(new Date(),i),key=dayKey(date);return {key,label:i===0?'Today':i===1?'Tomorrow':date.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'short'}),events:eventsOn(ready?result.value?.events??[]:[],key),tasks:i===0?todays:[]}})
    const total=grouped.reduce((n,day)=>n+day.events.length+day.tasks.length,0),page=pageOf(total,props.page,8)
    let at=0
    const visible=(index:number)=>index>=page.page*8&&index<(page.page+1)*8
    const projected:AgendaProjection={state:scope.account.status!=='user'?'signed-out':!ready?'connect':result.value?'ready':result.error?'error':'loading',today,now,page,errors:errors([...(result.value?.errors??[]),...tasks.errors]),days:grouped.map(day=>({...day,tasks:day.tasks.filter(()=>visible(at++)).map(task=>{
      const fingerprint=JSON.stringify(task),valid=()=>JSON.stringify(currentTask(task.id))===fingerprint
      return {title:text(task.title,512),notes:text(task.notes,1024),due:dueDay(task)??'',time:dueDay(task)!==today?'overdue':task.allDay?'today':new Date(task.due!).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),allDay:!!task.allDay,color:s.color(colors.get(task.list)),open:s.link('Open task',new URL('/?open=tasks',location.origin).href,()=>openTask(task.id),valid),complete:s.action('Complete task',async()=>{await completeTask(task)}, {valid})}
    }),events:day.events.filter(()=>visible(at++)).map(event=>{
      const mark=markOf(event)
      return {title:text(event.title,512),time:eventTime(event),calendar:text(event.calendar),location:text(event.location,512),start:new Date(event.start).getTime(),end:new Date(event.end).getTime(),allDay:event.allDay,color:s.color(event.color),open:s.link('Open calendar event',event.url??new URL('/?open=calendar',location.origin).href,()=>openEvent(event)),...(event.meet?{meet:s.link('Join video call',event.meet)}:{}),...(mark?{mark:{glyph:text(mark.glyph,16),title:text(mark.title,256),...(mark.open?{open:s.action('Open linked note',mark.open)}:{})}}:{})}
    })}))}
    return {input:{agenda:projected,controls:scope.controls,...(result.error?{error:result.error}:{})},resources:s.resources}
  },[key,result.value,result.error,tasks,prefs,hidden,props.page,minute,markOf])
  usePublish(props,value)
  return null
}
function InboxBroker(props:BrokerProps) {
  const config=useWidgetConfig(props.id,{hidden:[] as string[]}),scope=useScope(props)
  const key=JSON.stringify([props.lifecycle,scope.key,props.tick])
  const result=useLoad((signal,first)=>sharedRead(`inbox:${scope.key}`,60_000,shared=>api<unknown>(`/api/inbox${props.tick&&first?'?fresh':''}`,{signal:shared}).then(inboxData),signal,props.tick>0&&first),key,scope.account.status==='user',2*60_000,scope.valid)
  const value=useMemo<BrokerPresentation>(()=>{
    const sections=([['review','Waiting for your review','Nobody is waiting on you'],['mine','Your pull requests','No open pull requests'],['assigned','Assigned to you','Nothing assigned']] as const).filter(([key])=>!(Array.isArray(config.hidden)?config.hidden:[]).includes(key))
    const total=sections.reduce((n,[key])=>n+(result.value?.[key]?.length??0),0)
    const pages=Math.max(1,...sections.map(([key])=>Math.ceil((result.value?.[key]?.length??0)/5))),selected=Math.max(0,Math.min(Math.floor(props.page)||0,pages-1))
    const page:PageInfo={total,page:selected,pages,shown:sections.reduce((n,[key])=>n+Math.min(5,Math.max(0,(result.value?.[key]?.length??0)-selected*5)),0),truncated:pages>1}
    const projection:InboxProjection={state:scope.account.status!=='user'?'signed-out':result.value?'ready':result.error?'error':'loading',count:(result.value?.review.length??0)+(result.value?.assigned.length??0),errors:errors(result.value?.errors),page,sections:sections.map(([key,title,empty])=>({key,title,empty,total:result.value?.[key].length??0,items:(result.value?.[key]??[]).slice(page.page*5,(page.page+1)*5).map(hit=>({title:text(hit.title,512),repo:text(hit.repo),number:number(hit.number),kind:hit.kind,draft:!!hit.draft,state:text(hit.state,16),ago:timeAgo(hit.updatedAt),source:text(hit.sourceLabel),open:scope.link('Open code item',hit.url,async()=>{
      const target=gitProps(hit.source,hit.repo,{kind:hit.kind,number:hit.number}),view=routeToView(target.route)
      let available=false
      if(view&&view.v!=='list')try{await api(`${repoApi(view)}/${hit.kind==='pr'?'pulls':'issues'}/${hit.number}`,{signal:AbortSignal.timeout(4000)});available=true}catch{/* fall back to the bound provider URL */}
      if(!scope.valid())return
      if(available)scope.wm.open('git',target);else {const href=url(hit.url);if(href)openLink(href)}
    })}))}))}
    return {input:{inbox:projection,controls:scope.controls,...(result.error?{error:result.error}:{})},resources:scope.resources}
  },[key,result.value,result.error,JSON.stringify(config.hidden),props.page])
  usePublish(props,value);return null
}

function StatusBroker(props:BrokerProps) {
  const scope=useScope(props),ready=scope.account.status==='user'&&!!scope.account.integrations.updown
  const key=JSON.stringify([props.lifecycle,scope.key,props.tick])
  const result=useLoad((signal,first)=>sharedRead(`status:${scope.key}`,55_000,shared=>api<unknown>('/api/updown',{signal:shared}).then(statusData),signal,props.tick>0&&first),key,ready,60_000,scope.valid)
  const value=useMemo<BrokerPresentation>(()=>{
    const all=ready?result.value??[]:[],page=pageOf(all.length,props.page,12)
    const projection:StatusProjection={state:scope.account.status!=='user'?'signed-out':!ready?'connect':result.value?'ready':result.error?'error':'loading',down:all.filter(check=>check.enabled&&check.down).length,page,checks:all.slice(page.page*12,(page.page+1)*12).map(check=>({name:text(check.name,512),address:text(check.url,1024),enabled:!!check.enabled,down:!!check.down,error:errors([check.error])[0]??'',downSince:check.downSince?timeAgo(check.downSince).replace(/ ago$/,''):'',uptime:typeof check.uptime==='number'?check.uptime:null,responseTime:typeof check.responseTime==='number'?check.responseTime:null,sslValid:typeof check.sslValid==='boolean'?check.sslValid:null,sslDays:check.sslExpiresAt?Math.floor((new Date(check.sslExpiresAt).getTime()-Date.now())/864e5):null,open:scope.link('Open status check',/^[a-z0-9]{1,40}$/i.test(check.token)?`https://updown.io/checks/${check.token}`:undefined)}))}
    return {input:{status:projection,controls:scope.controls,...(result.error?{error:result.error}:{})},resources:scope.resources}
  },[key,result.value,result.error,props.page])
  usePublish(props,value);return null
}
function MinecraftBroker(props:BrokerProps) {
  const scope=useScope(props),key=JSON.stringify([props.lifecycle,scope.key,props.tick])
  const result=useLoad((signal,first)=>sharedRead('minecraft-public',15_000,shared=>fetchMinecraft(props.tick>0&&first,shared),signal,props.tick>0&&first),key,true,30_000,scope.valid)
  const value=useMemo<BrokerPresentation>(()=>{
    const status:McStatus|null=result.value?.status??null,names=status?.players.list??[],page=pageOf(names.length,props.page,12)
    const projection:MinecraftProjection={state:status?'ready':result.error||result.value?.error?'error':'loading',online:!!status?.online,address:MC_ADDRESS,copy:scope.action('Copy address',()=>navigator.clipboard.writeText(MC_ADDRESS)),open:scope.action('Open Minecraft server',()=>scope.wm.open('mcserver',{t:String(Date.now())})),motd:text(status?.motd,80),version:text(status?.version,80),software:text(status?.settings?.software,80),difficulty:text(status?.settings?.difficulty,80),latency:typeof status?.latency==='number'?status.latency:null,...(status?.world?{world:{day:number(status.world.day),clock:text(status.world.clock,8),phase:text(status.world.phase,8)}}:{}),players:{online:number(status?.players.online),max:number(status?.players.max),totalNamed:names.length,list:names.slice(page.page*12,(page.page+1)*12).map(name=>({name:text(name,32),...(/^[a-z0-9_]{1,16}$/i.test(name)?{head:scope.add({kind:'image',label:text(name,32),href:`https://mc-heads.net/avatar/${encodeURIComponent(name)}/48`})}:{}),dimension:status?.playerInfo?.[name]?.dimension?text(dimension(status.playerInfo[name].dimension!).label,80):'',vitals:text(vitals(status?.playerInfo?.[name])??'',80)}))},page}
    return {input:{minecraft:projection,controls:scope.controls,...(result.error?{error:result.error}:{})},resources:scope.resources}
  },[key,result.value,result.error,props.page])
  usePublish(props,value);return null
}
/** Mounted only while this exact package revision has read authority and is actually visible. */
export function DomainBroker(props:BrokerProps) {
  if(props.kind==='agenda')return <AgendaBroker {...props}/>
  if(props.kind==='inbox')return <InboxBroker {...props}/>
  if(props.kind==='status')return <StatusBroker {...props}/>
  return <MinecraftBroker {...props}/>
}
