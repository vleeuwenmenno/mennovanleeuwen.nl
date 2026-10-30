import {column,row,text,action,link} from '@mvlos/widget';
function item(h){
  const meta=`${h.repo.split('/').pop()}#${h.number}${h.draft&&h.state==='open'?' · draft':''} · ${h.ago}`;
  return link('',h.open,{hint:`${h.repo}#${h.number} · ${h.source} · opens in Git`,children:[row(text(h.kind==='pr'?'⇄':'●'),column(text(h.title),text(meta,'muted')))]});
}
function section(s){return column(text(`${s.title} ${s.total||''}`,'accent'),...(!s.items.length?[text(s.total?'No items on this page':s.empty,'muted')]:s.items.map(item)));}
export function render(input){
  const b=input.inbox,c=input.controls||{};
  if(!b)return column(text('Code inbox','accent'),text('Checking GitHub…','muted'));
  if(b.state==='signed-out')return column(text('Code inbox','accent'),text('Your pull requests and issues show here once you sign in.'),action('Sign in with GitHub',c.signIn));
  const body=b.state==='loading'?[text('Checking GitHub…','muted')]:b.state==='error'?[text(input.error||'Code inbox unavailable','danger')]:b.sections.map(section);
  return column(row(text('Code inbox','accent'),text(String(b.count),'accent')),...body,...b.errors.map(e=>text(e,'danger')),link('GitHub notifications ↗',c.open));
}
export function event(){return null;}
