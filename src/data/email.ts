// The email address is never written out in the source, the bundle or the page markup, to keep
// it away from address harvesters. It is stored reversed and XOR-ed, decoded only when someone
// actually asks for it (a click, a terminal command), and shown masked until then.
//
// To change it: python3 -c "a='new@address'; print([ord(c) ^ 0x5a for c in reversed(a)])"

const CODES = [63, 55, 116, 52, 63, 45, 47, 63, 63, 54, 44, 26, 53, 52, 52, 63, 55]

/** The real address. Call it at the moment it is needed rather than storing it in markup. */
export const revealEmail = () =>
  CODES.map((c) => String.fromCharCode(c ^ 0x5a))
    .reverse()
    .join('')

/** "men•••@vle•••.me": enough to recognise, useless to a harvester. */
export function maskedEmail() {
  const [user, domain] = revealEmail().split('@')
  const [name, ...tld] = domain.split('.')
  return `${user.slice(0, 3)}•••@${name.slice(0, 3)}•••.${tld.join('.')}`
}

/** Opens the visitor's mail app, building the mailto link only at click time. */
export function composeEmail(subject?: string) {
  window.location.href = `mailto:${revealEmail()}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`
}
