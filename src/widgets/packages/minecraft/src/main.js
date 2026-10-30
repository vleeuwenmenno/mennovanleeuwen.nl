import {column,row,text,action,image,details,card} from '@mvlos/widget';
export function render(input){
  const m=input.minecraft;
  if(!m)return column(text('Minecraft','accent'),text('Checking…','muted'));
  const meta=[m.software||(m.version?'Java':''),m.version,m.difficulty,m.latency!==null?`${m.latency} ms`:''].filter(Boolean).join(' · ');
  return card(m.open,column(row(text('Minecraft','accent'),text(m.state==='loading'?'Checking…':m.state==='error'?'Unknown':m.online?'Online':'Offline',m.online?'success':m.state==='ready'?'danger':'muted')),
    ...(m.online&&m.motd&&m.motd!=='A Minecraft Server'?[text(m.motd)]:[]),action(`${m.address} · Copy`,m.copy),
    ...(m.online?[row(text(`${m.players.online}/${m.players.max}`),...(m.players.list.length?m.players.list.map(p=>details(row(...(p.head?[image(p.head,p.name)]:[]),text(p.name)),text(p.name,'accent'),...(p.dimension?[text(p.dimension)]:[]),...(p.vitals?[text(p.vitals)]:[]))):[text(m.players.online?'names hidden':'nobody on','muted')]),...(m.players.totalNamed>m.players.list.length?[text(`+${m.players.totalNamed-m.players.list.length}`,'muted')]:[])),
      ...(m.world?[text(`${({day:'☀',dusk:'◐',night:'☾',dawn:'◑'})[m.world.phase]||''} Day ${m.world.day} · ${m.world.clock}`)]:[]),...(meta?[text(meta,'muted')]:[])]:[]),action('Connect / server window',m.open)));
}
export function event(){return null;}
