// Files that steer the agents themselves. Writing one is a lasting injection, so the server always
// asks (server/workdir.ts) and the terminal tool's policy refuses it unless that call was approved
// by name (src/terminal/policy.ts). No imports: the server uses it too.

export const STEERING = /(^|\/)(AGENTS\.md|CLAUDE\.md|\.agents|\.claude)(\/|$)/i
