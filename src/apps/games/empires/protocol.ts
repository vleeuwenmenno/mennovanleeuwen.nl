// What the Empires At War multiplayer client and server say to each other over the WebSocket at
// MP_PATH, as JSON text. Shared by both sides (types only, nothing to run).

export const MP_PATH = '/api/empires/ws'

/** Client to server. */
export type ClientMsg =
  /** First message on every connection. `token` resumes an identity after a reload or a dropped
   * connection (it is kept for a short while). */
  | { t: 'hello'; token?: string }
  /** Take a name (also to change it later). */
  | { t: 'claim'; name: string }
  /** For the round trip time; answered with `pong` straight away. */
  | { t: 'ping'; n: number }

/** Server to client. */
export type ServerMsg =
  /** Answer to `hello` when there's no identity to resume: pick a name next. `login` is the
   * signed-in GitHub login, which only this player may use as a name. */
  | { t: 'ready'; suggestion: string; login: string | null }
  /** You're in, as `name`. Keep `token` (per tab) to come back as the same player. */
  | { t: 'welcome'; id: string; name: string; token: string; resumed: boolean }
  /** A claim that didn't go through, with a free name to offer instead. */
  | { t: 'refused'; why: string; suggestion: string }
  | { t: 'pong'; n: number; at: number }
  /** Something the client did wrong; the connection stays open unless it's closed as well. */
  | { t: 'error'; why: string }
