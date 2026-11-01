import { appDataResponse } from './appDataResponse'
import type { SafeJqBudget } from './jq-safe'
import { api } from '../os/account'
import { appDataDenial, readAppData, type AppDataGrant } from './appData'
import { CmdError, type Ctx } from './types'

export const appDataCommands = {
  mvl: {
    desc: 'Read account notes, calendar events and background task status as JSON',
    usage: 'mvl notes | mvl calendar FROM TO | mvl tasks',
    man: 'Read-only authenticated account data. Calendar dates use YYYY-MM-DD or UTC ISO timestamps; TO is exclusive (maximum 366 days). Notes are saved server notes, excluding trash. Tasks are background agent tasks, not to-do items. No mutation subcommands. Network and authorization errors fail the command. Agent policy must explicitly authorize these private network reads; never classify mvl as pure.',
    run: (ctx: Ctx) => {
      // Defense in depth: enforce the server resource grant at the actual read too.
      const guarded = ctx as Ctx & { policy?: { grant: AppDataGrant }; budget?: SafeJqBudget }
      const policy = guarded.policy
      const denied = policy && appDataDenial(ctx.args, policy.grant)
      if (denied) throw new CmdError(denied)
      if (policy && !guarded.budget) throw new CmdError('mvl: agent budget required')
      return readAppData(ctx.args, ctx.signal, (path, signal) => api(path, { method: 'GET', signal, decode: response => appDataResponse(response, guarded) }), guarded.budget)
    },
  },
}
