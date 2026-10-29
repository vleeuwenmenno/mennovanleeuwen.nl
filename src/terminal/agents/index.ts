import { generatedImage } from '../../data/agentImages'
import { agentSettings, answerApproval, claimClientCall, answerForm, createThread, getThread, listProjects, listThreads, sendClientResult, sendMessage, threadMatches, type Permission, type Thread, type Workdir } from '../../data/agents'
import { seafileAt, syncAgentPlaces } from '../../data/agentPlaces'
import { getAccount } from '../../os/account'
import { CmdError, type Ctx } from '../types'
import { prettyPath } from '../vfs'
import { Session } from './app'
import { runAgentCall } from './exec'
import { markdown } from './markdown'
import { toolTitle } from './render'
import { ago, lines as toMarkup, seg } from './text'

// agents: the Agents app in the terminal, as a coding agent's CLI. In a Seafile folder that folder
// is the work folder (file tools, the terminal tool, its AGENTS.md); elsewhere it answers like the
// app does. -p answers once and prints the result, for pipes and scripts.

type Command = { desc: string; usage?: string; man?: string; run: (ctx: Ctx) => string | void | Promise<string | void>; complete?: (args: string[], word: string) => { value: string; label: string; hint?: string }[] }

const AGENTS_MAN = `{c:bold}NAME{/}
       agents - talk to the agents in the terminal, with the current folder to work in

{c:bold}SYNOPSIS{/}
       agents [options] [prompt]
       agents -p [options] prompt        answer once, print the reply, exit
       agents -c                         continue the latest thread for this folder
       agents -r [id|words]              resume a thread
       agents ls                         list threads

{c:bold}DESCRIPTION{/}
       Starts a session like a coding agent's CLI. In a folder on Seafile, that folder becomes
       the thread's work folder: the agent can read, search and edit its files (each change
       waits for your yes, unless you allow edits), run msh commands in this terminal, and
       follows the folder's AGENTS.md. Threads are the Agents app's: /open shows one there.

       Type a message and press Enter. Shift+Enter (or Alt+Enter, or \\ at the end) starts a
       new line. #name[:weight] selects a LoRA, $name invokes a skill anywhere, and @name
       points at a tool; Tab completes all three. /name still invokes a skill at the start.
       @./path adds a file, ! runs a command (its output goes along with your next message),
       and # followed by a space remembers something. Esc stops the agent; Shift+Tab cycles between asking
       for each change, accepting edits, and plan mode (read only until you approve a plan).
       Ask for an image after configuring ComfyUI in Settings → Apps → Agents → Images.
       /images opens the model browser and session overrides; /images show prints effective
       settings, /images reset follows account defaults, /images set {"seed":42} updates them.
       Empty model/clip/vae values mean automatic recommendations: /images set {"vae":""}.
       /images set {"loras":[{"name":"style.safetensors","weight":0.8}]} saves LoRAs.
       /images show explains automatic/manual choices and missing or ambiguous assets.
       /images profile lists style profiles; select <id|none>, save {"name":"…","description":"…"},
       reset <id> or delete <id> manages them. /memory reset-images forgets image observations.
       Krea2 presets are krea2_raw and krea2_turbo; both need installed model, clip and vae.
       Generated images keep their private download URL, settings and metadata link, with an inline
       preview below in interactive sessions. /images art on|off controls it (on by default,
       remembered for this account in this browser). Previews use at most 48 columns and 24 rows;
       large downloads, narrow terminals, TERM=dumb and print mode skip them. /open shows the image in the app.
       /threads <words> searches past threads, including archives, across projects.
       /threads open <id> resumes a result (a unique prefix from the last results also works).
       /threads this [words] searches this thread; without words it repeats the last search.

       /branch [message id] continues in a new thread; the original stays unchanged.
       /tasks lists background tasks (agents that run on their own and report back); /tasks show,
       runs, run, dry, pause or resume <task>, and /tasks log, approve, deny or cancel <run>.
       /help lists the commands: /resume, /threads, /branch, /images, /model, /tools, /skills, /context, /export, ….

{c:bold}OPTIONS{/}
       -c, --continue          continue the latest thread in this folder
       -r, --resume [what]     resume a thread by id (its first characters) or title words (earlier titles too)
       -p, --print             non-interactive: print the answer and exit (changes that need
                               approval are declined); also when the output goes into a pipe
       --model <name>          the model to use
       --deep                  deep research mode
       --project <name>        put a new thread in this project
       --permission-mode <m>   auto (the default: web addresses it builds are checked),
                               default (ask first), acceptEdits, plan or bypass
       --no-dir                no work folder, even in a Seafile folder

{c:bold}EXAMPLES{/}
       cd ~/Projects/site && agents
       agents "what does this folder hold?"
       agents -p "summarise README.md" > /tmp/summary.md
       cat notes.md | agents -p "turn this into a todo list"`

const PERMS: Permission[] = ['default', 'auto', 'acceptEdits', 'plan', 'bypass']

function needAgents() {
  const a = getAccount()
  if (a.status !== 'user') throw new CmdError('agents: sign in with GitHub first (the agents are for signed-in users)')
  if (!a.integrations.ollama) throw new CmdError('agents: add an Ollama API key in Settings → Integrations first')
}

/** The current folder as a work folder, when it is on Seafile. */
function folderHere(cwd: string): Workdir | null {
  const at = seafileAt(cwd)
  return at ? { ...at, label: prettyPath(cwd) } : null
}

const sameFolder = (a: Workdir | null, b: Workdir | null) => !!a && !!b && a.repo === b.repo && a.path === b.path

async function agents(ctx: Ctx): Promise<string | void> {
  const args = [...ctx.args]
  const opts = { cont: false, resume: null as string | null, print: false, model: null as string | null, deep: false, project: null as string | null, permission: 'auto' as Permission, noDir: false }
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const value = () => {
      const v = args[++i]
      if (v === undefined) throw new CmdError(`agents: ${a} needs a value`)
      return v
    }
    if (a === '-h' || a === '--help') return AGENTS_MAN
    else if (a === '-c' || a === '--continue') opts.cont = true
    else if (a === '-r' || a === '--resume') opts.resume = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : ''
    else if (a === '-p' || a === '--print') opts.print = true
    else if (a === '--model' || a === '-m') opts.model = value()
    else if (a === '--deep') opts.deep = true
    else if (a === '--project') opts.project = value()
    else if (a === '--permission-mode') {
      const p = value() as Permission
      if (!PERMS.includes(p)) throw new CmdError(`agents: --permission-mode is one of ${PERMS.join(', ')}`)
      opts.permission = p
    } else if (a === '--no-dir') opts.noDir = true
    else if (a.startsWith('-') && a.length > 1 && !words.length) throw new CmdError(`agents: unknown option ${a}. Try agents --help`)
    else words.push(a)
  }
  needAgents()
  syncAgentPlaces()
  if (words[0] === 'ls' || words[0] === 'list') return listing(ctx)
  const settings = agentSettings()
  const workdir = opts.noDir ? null : folderHere(ctx.cwd)
  let projectId: number | null = null
  if (opts.project) {
    const p = (await listProjects()).find((x) => x.name.toLowerCase() === opts.project!.toLowerCase())
    if (!p) throw new CmdError(`agents: no project called ${opts.project}`)
    projectId = p.id
  }
  let prompt = words.join(' ').trim()
  if (ctx.stdin) prompt = prompt ? `${prompt}\n\n${ctx.stdin}` : ctx.stdin
  const base = { workdir, mode: opts.deep ? ('deep' as const) : settings.mode, model: opts.model, projectId, permission: opts.permission, tools: settings.tools }
  if (opts.print || !ctx.tty) {
    if (!prompt) throw new CmdError('agents: -p needs a prompt (an argument, or text piped in)')
    return printMode(ctx, prompt, base)
  }
  // Which thread: the latest here (-c), one asked for (-r), or a new one.
  let thread: Thread | null = null
  let first: string | null = prompt || null
  if (opts.cont || opts.resume !== null) {
    const threads = await listThreads(false)
    if (opts.cont) thread = threads.find((t) => sameFolder(t.workdir, workdir)) ?? (workdir ? null : threads[0] ?? null)
    else if (opts.resume) {
      const q = opts.resume.toLowerCase()
      // Earlier titles count: a thread is found by the name it had when you last saw it.
      const hits = threads.filter((t) => t.id.startsWith(q) || threadMatches(t, q))
      if (hits.length === 1) thread = hits[0]
      else first = `/resume ${opts.resume}`
    } else first = '/resume'
    if (opts.cont && !thread) ctx.print(toMarkup([[seg('No earlier thread for this folder: starting a new one.', 'muted')]]))
  }
  let messages: Awaited<ReturnType<typeof getThread>>['messages'] = []
  if (thread) {
    const got = await getThread(thread.id)
    thread = got.thread
    messages = got.messages
  }
  return new Session(ctx, { ...base, thread, messages, workdir: thread ? thread.workdir : workdir, permission: thread ? thread.permission : base.permission, first }).run()
}

async function listing(ctx: Ctx): Promise<string> {
  const threads = await listThreads(false)
  if (!threads.length) return toMarkup([[seg('No threads yet. Start one with agents.', 'muted')]])
  return toMarkup(
    threads.slice(0, 50).map((t) => [seg(t.id.slice(0, 8), 'muted'), seg('  '), seg(t.title.slice(0, Math.max(10, ctx.size.cols - 40)).padEnd(Math.min(40, Math.max(10, ctx.size.cols - 40))), t.pinned ? 'bold' : undefined), seg(`  ${ago(t.updatedAt).padStart(4)}`, 'muted'), ...(t.workdir ? [seg(`  ${t.workdir.label}`, 'cyan')] : []), ...(t.running ? [seg('  working', 'yellow')] : [])]),
  )
}

/** agents -p: one answer, printed; nobody is there to allow changes, so those are declined. */
async function printMode(ctx: Ctx, prompt: string, o: { workdir: Workdir | null; mode: 'quick' | 'deep'; model: string | null; projectId: number | null; permission: Permission; tools: ReturnType<typeof agentSettings>['tools'] }): Promise<string> {
  const thread = await createThread({ mode: o.mode, model: o.model ?? undefined, tools: o.tools, projectId: o.projectId, workdir: o.workdir, permission: o.permission })
  const imageLinks = new Map<string, string>()
  const imageSettingsLinks = new Map<string, string>()
  let answer = ''
  let failure: string | null = null
  await sendMessage(
    thread.id,
    prompt,
    [],
    (e) => {
      if (e.type === 'message' && e.message.role === 'tool' && e.message.toolName === 'generate_image') {
        const image = generatedImage(e.message.content)
        if (image) { imageLinks.set(new URL(image.url, location.origin).href, image.settings?.operation === 'remove' ? 'Image with objects removed' : image.settings?.operation === 'inpaint' ? 'Inpainted image' : image.settings?.operation === 'upscale' ? 'Upscaled image' : image.settings?.operation === 'refine' ? 'Refined image' : image.settings && 'hires' in image.settings && image.settings.hires ? 'Generated image with hires refinement' : 'Generated image'); if (image.settings) imageSettingsLinks.set(new URL(image.url + '/metadata', location.origin).href, image.settings.operation === 'remove' ? 'Removal settings' : image.settings.operation === 'inpaint' ? 'Inpaint settings' : image.settings.operation === 'upscale' ? 'Upscale settings' : image.settings.operation === 'refine' ? 'Refinement settings' : 'hires' in image.settings && image.settings.hires ? 'Generation and hires settings' : 'Generation settings') }
      }
      if (e.type === 'message' && e.message.role === 'assistant') {
        if (e.message.content.trim()) answer = e.message.content.trim()
        if (ctx.tty) for (const c of e.message.toolCalls ?? []) ctx.print(toMarkup([[seg('● ', 'muted'), seg(toolTitle(c).filter(Boolean).join(' '), 'muted')]]))
      } else if (e.type === 'approval') void answerApproval(thread.id, e.callId, false, { feedback: 'This runs non-interactively (agents -p), with nobody to allow changes: say what you would change instead.' })
      else if (e.type === 'question') void answerForm(thread.id, e.callId, null)
      else if (e.type === 'client') {
        void claimClientCall(thread.id, e.callId).then((mine) =>
          mine
            ? runAgentCall({ name: e.call.name, arguments: e.call.arguments ?? {}, workdir: o.workdir, fallbackDir: ctx.cwd, grant: e.grant, signal: ctx.signal }).then((r) => sendClientResult(thread.id, e.callId, r.output, r.status, { result: r.result, capabilities: r.capabilities }).catch(() => {}))
            : undefined,
        )
      } else if (e.type === 'error') failure = e.error
    },
    ctx.signal,
    { terminal: true },
  )
  if (failure) throw new CmdError(`agents: ${failure}`)
  for (const [link, label] of imageLinks) if (!answer.includes(link)) answer += `\n\n${label}: ${link}`
  for (const [link, label] of imageSettingsLinks) if (!answer.includes(link)) answer += `\n${label}: ${link}`
  if (!ctx.tty) return answer
  return toMarkup(markdown(answer, Math.max(30, ctx.size.cols - 1)))
}

export const agentsCommands: Record<string, Command> = {
  agents: {
    desc: 'the agents, as a coding CLI in this folder (agents -p to ask once)',
    usage: 'agents [-c] [-r [id]] [-p] [--model m] [--permission-mode m] [prompt]',
    man: AGENTS_MAN,
    run: agents,
    complete: (args, word) => (args.length ? [] : ['ls', '--continue', '--resume', '--print', '--model', '--deep', '--project', '--permission-mode', '--no-dir'].filter((s) => s.startsWith(word)).map((s) => ({ value: s, label: s }))),
  },
}
