import { column, row, grid, box, text, action, link, icon, badge } from '@mvlos/widget';

// Code inbox: pull requests and issues that need you. One grid: kind icon, then title with
// "repo#number · draft · age" beneath; section headers carry their counts.
const heading = (...more) => row({ gap: 'sm', align: 'center' }, text('Code inbox', 'normal', { size: 'lg', weight: 'bold' }), ...more);

function item(h) {
  const meta = `${h.repo.split('/').pop()}#${h.number}${h.draft && h.state === 'open' ? ' · draft' : ''} · ${h.ago}`;
  const draft = h.draft && h.state === 'open';
  return link('', h.open, { fallback: 'row', hint: `${h.repo}#${h.number} · ${h.source} · opens in Git`, children: [
    icon(h.kind === 'pr' ? (draft ? 'draft' : 'pr') : 'issue', h.kind === 'pr' ? (draft ? 'muted' : 'success') : 'accent'),
    column({ gap: 'none' }, text(h.title, 'normal', { clamp: 2 }), text(meta, 'muted', { size: 'xs' })),
  ] });
}

function section(s, index) {
  return [
    row({ gap: 'xs', align: 'center', span: 'all' }, text(s.title, index ? 'muted' : 'accent', { size: 'xs', weight: 'bold' }), ...(s.total ? [badge(String(s.total), 'muted', { size: 'xs' })] : [])),
    ...(!s.items.length ? [text(s.total ? 'No items on this page' : s.empty, 'muted', { size: 'sm', span: 'all' })] : s.items.map(item)),
  ];
}

export function render(input) {
  const b = input.inbox, c = input.controls || {};
  if (!b) return column({ gap: 'md' }, heading(), text('Checking GitHub…', 'muted'));
  if (b.state === 'signed-out') return column({ gap: 'md' }, heading(), text('Your pull requests and issues show here once you sign in.'), action('Sign in with GitHub', c.signIn));
  if (b.state === 'loading') return column({ gap: 'md' }, heading(), text('Checking GitHub…', 'muted'));
  if (b.state === 'error') return column({ gap: 'md' }, heading(), box({ tone: 'danger' }, text(input.error || 'Code inbox unavailable', 'danger')));
  return column({ gap: 'md' },
    heading(badge(String(b.count), b.count ? 'accent' : 'muted')),
    grid(['auto', '1fr'], { gap: 'sm', align: 'start' }, ...b.sections.flatMap(section)),
    ...b.errors.map((e) => text(e, 'danger', { size: 'sm' })),
    action('GitHub notifications ↗', c.open, { children: [icon('bell', 'muted', { size: 'sm' })] }));
}
export function event() { return null; }
