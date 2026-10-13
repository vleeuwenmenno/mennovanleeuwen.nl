// A look into a .vcf (dropped on Contacts, or opened from Files) before it is imported: who is in it,
// so the import dialog can list them. The server reads the cards for real (server/vcard.ts); this only
// needs a name and one line of detail per card, and is as forgiving: lowercase names, folded lines,
// a card that never closes.

export type VcfCard = { name: string; detail: string; uid: string }

const unescape = (v: string) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim()

/** The people in a vCard text, in order. Group cards (KIND:group, Apple's and Nextcloud's) are not counted. */
export function readVcf(text: string): VcfCard[] {
  const logical: string[] = []
  for (const line of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    if (/^[ \t]/.test(line) && logical.length) logical[logical.length - 1] += line.slice(1)
    else logical.push(line)
  }
  const out: VcfCard[] = []
  let card: { prop: string; params: string; value: string }[] | null = null
  const finish = () => {
    if (!card) return
    const get = (name: string) => card!.find((p) => p.prop === name)?.value ?? ''
    const group = get('KIND').toLowerCase() === 'group' || get('X-ADDRESSBOOKSERVER-KIND').toLowerCase() === 'group'
    const given = get('N').split(';')
    const name = unescape(get('FN')) || unescape([given[3], given[1], given[2], given[0]].filter(Boolean).join(' ')) || unescape(get('ORG').split(';')[0])
    if (!group) {
      const email = card.find((p) => p.prop === 'EMAIL')?.value
      const phone = card.find((p) => p.prop === 'TEL')?.value
      const org = unescape(get('ORG').split(';')[0])
      out.push({ name: name || email || '(No name)', detail: [org && org !== name ? org : '', email, phone].filter(Boolean).join(' · '), uid: get('UID').trim() })
    }
    card = null
  }
  for (const line of logical) {
    const upper = line.trim().toUpperCase()
    if (upper === 'BEGIN:VCARD') {
      finish()
      card = []
    } else if (upper === 'END:VCARD') finish()
    else if (card) {
      const colon = line.indexOf(':')
      if (colon < 1) continue
      const [prop, ...params] = line.slice(0, colon).split(';')
      // "item1.EMAIL" (Apple's groups) is EMAIL.
      card.push({ prop: prop.replace(/^[\w-]+\./, '').toUpperCase(), params: params.join(';'), value: line.slice(colon + 1) })
    }
  }
  finish()
  return out
}
