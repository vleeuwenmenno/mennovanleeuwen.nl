import {column,row,text,action,link} from '@mvlos/widget';
export function render(input){
  const s=input.status,c=input.controls||{};
  if(!s)return column(text('Status','accent'),text('Asking updown.io…','muted'));
  if(s.state==='signed-out')return column(text('Status','accent'),text('Your uptime checks show here once you sign in.'),action('Sign in with GitHub',c.signIn));
  if(s.state==='connect')return column(text('Status','accent'),text('Connect updown.io to see your checks.'),action('Settings → Integrations',c.settings));
  return column(row(text('Status','accent'),text(s.down?`${s.down} down`:'All up',s.down?'danger':'success')),
    ...(s.state==='loading'?[text('Asking updown.io…','muted')]:s.state==='error'?[text(input.error||'Status checks unavailable','danger')]:s.checks.length?s.checks.map(c=>link('',c.open,{hint:c.address,children:[column(
      row(text(!c.enabled?'● paused':c.down?'● down':'● up',!c.enabled?'muted':c.down?'danger':'success'),text(c.name),...(c.responseTime!==null?[text(`${c.responseTime} ms`)]:[]),...(c.uptime!==null?[text(`${c.uptime>=99.995?'100':c.uptime.toFixed(2)}%`)]:[])),
      ...(c.enabled&&c.down?[text(`down${c.downSince?' '+c.downSince:''}${c.error?' · '+c.error:''}`,'danger')]:[]),
      ...(c.sslValid===false||c.sslDays!==null&&c.sslDays<14?[text(c.sslValid===false?'certificate invalid':c.sslDays<0?'certificate expired':`certificate expires in ${c.sslDays} day${c.sslDays===1?'':'s'}`,'warning')]:[])
    )]})):[text('No checks on updown.io yet.','muted')]),link('Open updown.io ↗',input.controls?.open));
}
export function event(){return null;}
