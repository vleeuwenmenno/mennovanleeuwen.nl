// The counters a note's changes carry, for merging two copies of it (src/data/notes.ts): the
// browser and the server (the agents' note tools, server/agents.ts and server/noteLinks.ts)
// change notes by the same rules, so neither's change loses to an older one because its clock
// is behind. Each counter is a time in ms, but a new change always counts on past the note's
// own counters, whatever the clock says.
//
// What changed is kept apart: `edited` for the text, colour and tilt (the latest text wins),
// `deleted` and `restored` for the trash (the later of the two says whether it is in the trash),
// `eventsAt` for its links to calendar events. `updated` is when anything last changed (the
// Notebook sorts by it), and stands in for `edited` in notes saved before it existed: so every
// change that is not an edit first keeps the text's time in `edited`, before `updated` moves on.
// The server image copies this file (Dockerfile).

export type NoteClock = { updated?: number; edited?: number; deleted?: number; restored?: number; eventsAt?: number }

/** A counter for a change to `n` made now: past every counter it has. */
export const noteNow = (n: NoteClock) => Math.max(Date.now(), (n.updated ?? 0) + 1, (n.edited ?? 0) + 1, (n.deleted ?? 0) + 1, (n.restored ?? 0) + 1, (n.eventsAt ?? 0) + 1)

/** `n` with its text (or colour, tilt) changed. */
export function editedNote<N extends NoteClock>(n: N, patch: NoInfer<Partial<N>>): N {
  const t = noteNow(n)
  return { ...n, ...patch, edited: t, updated: t }
}

/** `n` moved to the trash. */
export function trashedNote<N extends NoteClock>(n: N): N {
  const t = noteNow(n)
  return { ...n, edited: n.edited ?? n.updated, deleted: t, updated: t }
}

/** `n` taken out of the trash. */
export function restoredNote<N extends NoteClock>(n: N): N {
  const t = noteNow(n)
  return { ...n, edited: n.edited ?? n.updated, deleted: undefined, restored: t, updated: t }
}

/** `n` with its links to events changed (not an edit: `updated` stays). */
export function relinkedNote<N extends NoteClock>(n: N, patch: NoInfer<Partial<N>>): N {
  return { ...n, ...patch, edited: n.edited ?? n.updated, eventsAt: noteNow(n) }
}
