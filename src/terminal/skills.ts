import { installSkills, listSkills, removeSkill, setSkillEnabled, skillInfo, type Skill, type Workdir } from '../data/agents'
import { seafileAt, syncAgentPlaces } from '../data/agentPlaces'
import { getAccount } from '../os/account'
import { lookup, writeFile } from './fs'
import { CmdError, type Ctx } from './types'
import { HOME, prettyPath, resolvePath } from './vfs'

// skills: the agents' skills from the terminal, the way a coding agent's CLI does it. They are
// folders with a SKILL.md, in ~/.agents/skills (and .agents/skills in a project); this lists them,
// installs them from GitHub, makes a new one to fill in, and switches them on and off.

type Command = { desc: string; usage?: string; man?: string; run: (ctx: Ctx) => string | void | Promise<string | void>; complete?: (args: string[], word: string) => { value: string; label: string; hint?: string }[] }

const c = (color: string, s: string) => `{c:${color}}${s}{/}`
const esc = (s: string) => s.replace(/\{/g, '{​')

const SKILLS_MAN = `{c:bold}NAME{/}
       skills - the agents' skills: list, install, make, switch on and off

{c:bold}SYNOPSIS{/}
       skills [ls]                       list the skills (and whether they are on)
       skills add <source> [--skill name] [--project] [--force]
       skills new <name> [--project]     make a skill folder with a SKILL.md to fill in
       skills info <name>                what it says, and its files
       skills rm <name> [--project]      remove an installed skill
       skills enable|disable <name>      let the agents use it, or not
       skills path                       where skills are kept

{c:bold}DESCRIPTION{/}
       A skill is a folder with a SKILL.md: front matter with a name and a description, then
       instructions in Markdown, and any files they refer to. The agents see each skill's name
       and description, and read the whole skill when a task matches it. Typing /name in
       agents starts one yourself.

       Skills live in ~/.agents/skills (your Seafile, through the home mount) and, for a project,
       in .agents/skills (or .claude/skills) of the work folder. Copying a folder there, or
       unzip skill.zip -d ~/.agents/skills, installs one as well.

{c:bold}SOURCES{/}
       owner/repo                  every skill in a GitHub repository
       owner/repo/path/to/skill    one folder of it
       owner/repo@branch           another branch or tag
       https://github.com/owner/repo/tree/main/skills/name

{c:bold}OPTIONS{/}
       --project   use .agents/skills in the current folder instead of ~/.agents/skills
       --skill     install only the skill with this folder name
       --force     replace a skill that is installed already

{c:bold}EXAMPLES{/}
       skills add anthropics/skills/skills/pdf
       skills new release-notes && nano ~/.agents/skills/release-notes/SKILL.md
       skills disable msh`

function needAccount() {
  const a = getAccount()
  if (a.status !== 'user') throw new CmdError('skills: sign in first (the agents are for signed-in users)')
  if (!a.seafile) throw new CmdError('skills: skills live in Seafile: link it in Settings → Seafile first')
}

/** The current folder as a work folder, for its project skills (null when it is not on Seafile). */
function folderHere(cwd: string): Workdir | null {
  const at = seafileAt(cwd)
  return at ? { ...at, label: prettyPath(cwd) } : null
}

/** Where --project installs: .agents/skills under the current folder. */
function projectFolder(cwd: string): Workdir {
  const abs = `${cwd === '/' ? '' : cwd}/.agents/skills`
  const at = seafileAt(abs)
  if (!at) throw new CmdError(`skills: ${prettyPath(cwd)} is not on Seafile, so it cannot hold skills`)
  return { ...at, label: prettyPath(abs) }
}

function userFolder(): Workdir {
  syncAgentPlaces()
  const at = seafileAt(`${HOME}/.agents/skills`)
  if (!at) throw new CmdError('skills: your home folder is not on Seafile, so ~/.agents/skills has nowhere to be. Mount it in Settings → Seafile, or use --project in a Seafile folder.')
  return { ...at, label: '~/.agents/skills' }
}

const SOURCE: Record<Skill['source'], string> = { project: 'project', user: '~', builtin: 'built in' }

function table(skills: Skill[], cols: number): string {
  if (!skills.length) return c('muted', 'No skills yet. Try: skills add anthropics/skills, or skills new <name>.')
  const w = Math.min(28, Math.max(...skills.map((s) => s.name.length)))
  return skills
    .map((s) => {
      const mark = s.enabled ? c('green', '●') : c('muted', '○')
      const tag = c('muted', `[${SOURCE[s.source]}${s.userOnly ? ', /only' : ''}]`)
      const room = Math.max(20, cols - w - 18)
      const desc = s.description.length > room ? `${s.description.slice(0, room - 1)}…` : s.description
      return `${mark} ${c(s.enabled ? 'bold' : 'muted', s.name.padEnd(w))}  ${esc(desc)} ${tag}`
    })
    .join('\n')
}

const TEMPLATE = (name: string) => `---
name: ${name}
description: What this skill does and when to use it, in one or two sentences. The agents decide from this line whether to read the rest.
---

# ${name}

Instructions for the agent, in Markdown: the steps to follow, the rules to keep, and an example
of a good result. Refer to other files in this folder by relative path (templates/example.md);
the agent reads them with read_skill_file. msh scripts here can be run with the terminal tool.
`

async function skills(ctx: Ctx): Promise<string> {
  const args = [...ctx.args]
  const flag = (f: string) => {
    const i = args.indexOf(f)
    if (i < 0) return false
    args.splice(i, 1)
    return true
  }
  const option = (f: string) => {
    const i = args.indexOf(f)
    if (i < 0) return undefined
    const v = args[i + 1]
    if (v === undefined) throw new CmdError(`skills: ${f} needs a value`)
    args.splice(i, 2)
    return v
  }
  const project = flag('--project') || flag('-p')
  const force = flag('--force') || flag('-f')
  const only = option('--skill')
  const sub = args.shift() ?? 'ls'
  if (sub === '--help' || sub === '-h' || sub === 'help') return SKILLS_MAN
  needAccount()
  syncAgentPlaces()
  switch (sub) {
    case 'ls':
    case 'list': {
      const list = await listSkills({ folder: folderHere(ctx.cwd) })
      return table(list, ctx.size.cols)
    }
    case 'add':
    case 'install': {
      const source = args[0]
      if (!source) throw new CmdError('usage: skills add <owner/repo[/path][@ref]> [--skill name] [--project] [--force]')
      const folder = project ? projectFolder(ctx.cwd) : userFolder()
      if (ctx.tty) ctx.print(c('muted', `Fetching ${source} from GitHub…`))
      const r = await installSkills({ source, skill: only, force, folder }).catch((e: Error) => {
        throw new CmdError(`skills: ${e.message}`)
      })
      return [...r.installed.map((s) => `${c('green', '✓')} ${c('bold', s.name)} ${c('muted', `→ ${s.label} (${s.files} file${s.files === 1 ? '' : 's'})`)}`), c('muted', `From ${r.from}. The agents see them in new turns; /name starts one in agents.`)].join('\n')
    }
    case 'rm':
    case 'remove':
    case 'uninstall': {
      const name = args[0]
      if (!name) throw new CmdError('usage: skills rm <name> [--project]')
      await removeSkill(name, project ? projectFolder(ctx.cwd) : userFolder()).catch((e: Error) => {
        throw new CmdError(`skills: ${e.message}`)
      })
      return `Removed ${c('bold', name)} ${c('muted', "(it is in the library's trash)")}`
    }
    case 'info':
    case 'show': {
      const name = args[0]
      if (!name) throw new CmdError('usage: skills info <name>')
      const s = await skillInfo(name, { folder: folderHere(ctx.cwd) }).catch((e: Error) => {
        throw new CmdError(`skills: ${e.message}`)
      })
      return [
        `${c('bold', s.name)} ${s.enabled ? c('green', 'on') : c('yellow', 'off')}${s.userOnly ? c('muted', ' (only with /name)') : ''}`,
        esc(s.description),
        `${c('muted', 'Where:')} ${s.label}`,
        ...(s.files.length ? [`${c('muted', 'Files:')} ${s.files.join('  ')}`] : []),
        '',
        esc(s.body.trim()),
      ].join('\n')
    }
    case 'enable':
    case 'disable': {
      const name = args[0]
      if (!name) throw new CmdError(`usage: skills ${sub} <name>`)
      const list = await listSkills({ folder: folderHere(ctx.cwd) })
      if (!list.some((s) => s.name === name)) throw new CmdError(`skills: no skill called ${name}`)
      setSkillEnabled(name, sub === 'enable')
      return `${c('bold', name)} is ${sub === 'enable' ? c('green', 'on') : c('yellow', 'off')}`
    }
    case 'new':
    case 'create': {
      const name = args[0]
      if (!name || !/^[A-Za-z0-9][\w.-]{0,63}$/.test(name)) throw new CmdError('usage: skills new <name>   (letters, digits, - and _)')
      const base = project ? `${ctx.cwd === '/' ? '' : ctx.cwd}/.agents/skills` : `${HOME}/.agents/skills`
      if (!project) userFolder()
      const file = `${base}/${name}/SKILL.md`
      if (lookup(resolvePath(ctx.cwd, file))) throw new CmdError(`skills: ${prettyPath(file)} exists already`)
      await writeFile(ctx.cwd, file, TEMPLATE(name), false, false, 'skills')
      return `Made ${c('bold', prettyPath(file))}. Fill it in: ${c('cyan', `nano ${prettyPath(file)}`)}`
    }
    case 'path':
    case 'where': {
      const lines = [`${c('muted', 'yours:')}    ${seafileAt(`${HOME}/.agents/skills`) ? '~/.agents/skills' : c('yellow', 'none (home is not on Seafile)')}`]
      const here = folderHere(ctx.cwd)
      if (here) lines.push(`${c('muted', 'project:')}  ${prettyPath(ctx.cwd)}/.agents/skills, ${prettyPath(ctx.cwd)}/.claude/skills`)
      lines.push(`${c('muted', 'built in:')} msh, skill-creator`)
      return lines.join('\n')
    }
    default:
      throw new CmdError(`skills: unknown command '${sub}'. Try skills --help`)
  }
}

const SUBS = ['ls', 'add', 'new', 'info', 'rm', 'enable', 'disable', 'path']

export const skillsCommands: Record<string, Command> = {
  skills: {
    desc: "the agents' skills: list, install from GitHub, make, switch on and off",
    usage: 'skills [ls|add|new|info|rm|enable|disable|path] …',
    man: SKILLS_MAN,
    run: skills,
    complete: (args, word) => (args.length ? [] : SUBS.filter((s) => s.startsWith(word)).map((s) => ({ value: s, label: s }))),
  },
}
