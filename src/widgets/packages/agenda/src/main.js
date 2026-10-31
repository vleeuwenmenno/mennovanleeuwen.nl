import {column,row,text,action,link,dot} from '@mvlos/widget';
export function render(input) {
  const a=input.agenda,c=input.controls||{};
  if(!a)return column(text('Agenda','accent'),text('Loading calendar…','muted'));
  if(a.state==='signed-out')return column(text('Agenda','accent'),text('Your calendar shows here once you sign in.'),action('Sign in with GitHub',c.signIn));
  if(a.state==='connect')return column(text('Agenda','accent'),text('Connect a calendar to see what is coming up.'),action('Google Calendar',c.google),action('Fastmail / CalDAV',c.settings));
  return column(text('Agenda','accent'),...(a.errors||[]).map(e=>text(e,'danger')),
    ...(a.state==='loading'?[text('Opening your calendar…','muted')]:a.state==='error'?[text(input.error||'Calendar unavailable','danger')]:a.days.map(day=>column(text(day.label,'accent'),
      ...(!day.tasks.length&&!day.events.length?[text(a.page.truncated?'No items on this page':'Nothing planned','muted')]:[]),
      ...day.tasks.map(t=>row(dot(t.color),action('☐',t.complete,{checked:false,hint:`Complete "${t.title}"`}),text(t.time,t.due!==a.today?'danger':'muted'),link(t.title,t.open,{hint:t.notes}))),
      ...day.events.map(e=>row(dot(e.color),text(e.time,'muted'),link(e.title,e.open,{hint:`${e.calendar}${e.location?' · '+e.location:''}`,tone:!e.allDay&&e.end<a.now?'muted':!e.allDay&&e.start<=a.now?'accent':'normal'}),...(e.mark?[e.mark.open?action(e.mark.glyph,e.mark.open,{hint:e.mark.title}):text(e.mark.glyph)]:[]),...(e.meet?[link('🎥',e.meet,{hint:'Join the video call'})]:[])))
    ))),action('Open Calendar',c.open));
}
export function event(){return null;}
