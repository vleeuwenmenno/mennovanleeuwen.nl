// Multiplayer names: what a name may look like, when two names count as the same, and random
// ones for players who don't want to pick. Shared by the game and the server (no imports), so
// the join screen can say what's wrong before asking.

export const NAME_MIN = 3
export const NAME_MAX = 20

/** Tidies what was typed: trims, and turns runs of spaces into one. */
export const tidyName = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim()

/** What's wrong with a (tidied) name, or null when it will do. */
export function nameProblem(name: string): string | null {
  if (name.length < NAME_MIN) return `At least ${NAME_MIN} characters`
  if (name.length > NAME_MAX) return `At most ${NAME_MAX} characters`
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '._-]*$/u.test(name)) return 'Letters, digits, spaces and - _ . \' only, starting with a letter or digit'
  return null
}

/** Two names are the same player name when they only differ in case, spaces or punctuation:
 * "Rex Vane", "rex-vane" and "RexVane" can't be online at once. */
export const nameKey = (name: string) => tidyName(name).toLowerCase().replace(/[\s'._-]/g, '')

const RANKS = ['Admiral', 'Commodore', 'Captain', 'Commander', 'Marshal', 'Warden', 'Ensign', 'Major']
const NAMES = [
  'Vex', 'Korr', 'Talon', 'Nyx', 'Brand', 'Sable', 'Oryn', 'Kade', 'Ryse', 'Tamsin', 'Quill', 'Dax', 'Ilsa', 'Varro', 'Juno', 'Rook',
  'Cass', 'Lyra', 'Marek', 'Tovan', 'Sela', 'Bastion', 'Corvin', 'Pell', 'Wren', 'Halden', 'Zara', 'Ostrik', 'Fen', 'Mira', 'Thane', 'Kestrel',
]

/** A random name such as "Commodore Vex", with a number added when `taken` says so. */
export function randomName(taken: (name: string) => boolean = () => false, random = Math.random): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(random() * xs.length)]
  for (let i = 0; i < 30; i++) {
    const name = `${pick(RANKS)} ${pick(NAMES)}`
    if (!taken(name)) return name
  }
  for (;;) {
    const name = `${pick(NAMES)} ${Math.floor(10 + random() * 990)}`
    if (!taken(name)) return name
  }
}
