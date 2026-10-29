import { api } from '../os/account'
import { readAppData } from './appData'
import type { Ctx } from './types'

export const appDataCommands = {
  mvl: {
    desc: 'Read account notes, calendar events and background task status as JSON',
    usage: 'mvl notes | mvl calendar FROM TO | mvl tasks',
    man: 'Read-only authenticated account data. Calendar dates use YYYY-MM-DD or UTC ISO timestamps; TO is exclusive (maximum 366 days). Notes are saved server notes, excluding trash. Tasks are background agent tasks, not to-do items. No mutation subcommands. Network and authorization errors fail the command. Agent policy must explicitly authorize these private network reads; never classify mvl as pure.',
    run: (ctx: Ctx) => readAppData(ctx.args, ctx.signal, (path, signal) => api(path, { method: 'GET', signal })),
  },
}
