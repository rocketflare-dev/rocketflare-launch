#!/usr/bin/env node
/**
 * CLI entry point (D26). Wires commander to the thin command modules; the ONE place that maps
 * errors to exit codes (0 ok · 1 error · 2 not logged in · 3 forbidden) and prints them. Global
 * `--server <name|url>`, `--profile <name>` and `--json` apply to every command. The bin name comes
 * from `package.json`.
 */
import { Command, InvalidArgumentError } from 'commander'
import { registerAccessCommands } from './commands/access'
import { registerActivityCommands } from './commands/activity'
import { registerAdminCommands } from './commands/admin'
import { registerAgentAccountsCommands } from './commands/agent-accounts'
import { registerAgentsCommands } from './commands/agents'
import { registerAiCommands } from './commands/ai'
import { registerApiCommands } from './commands/api'
import { registerApprovalsCommands } from './commands/approvals'
import { registerAppsCommands } from './commands/apps'
import { registerAuditCommands } from './commands/audit'
import { registerChatCommands } from './commands/chat'
import { aliasListVerbs } from './commands/commands'
import { runConfigGet, runConfigPath, runConfigSet } from './commands/config'
import { registerDeploysCommands } from './commands/deploys'
import { registerDocsCommands } from './commands/docs'
import { runEvalsPromote } from './commands/evals'
import { runFeaturesList } from './commands/features'
import { registerFeedbackVoteCommands, runFeedbackList } from './commands/feedback'
import { registerFilesCommands } from './commands/files'
import { registerGrantsCommands } from './commands/grants'
import { runGroupMembers, runGroupsList } from './commands/groups'
import { registerGroupsWriteCommands } from './commands/groups-write'
import { registerKeysCommands } from './commands/keys'
import { runLogin } from './commands/login'
import { runLogout } from './commands/logout'
import { registerMembersCommands } from './commands/members'
import { registerNotificationsCommands } from './commands/notifications'
import { registerPlatformCommands } from './commands/platform'
import { registerPoliciesCommands } from './commands/policies'
import { registerReleasesCommands } from './commands/releases'
import { registerServersCommands } from './commands/servers'
import {
  runSessionsEnd,
  runSessionsList,
  runSessionsPreviewUrl,
  runSessionsSay,
  runSessionsShip,
  runSessionsStart,
} from './commands/sessions'
import { runSessionsAttach } from './commands/sessions-attach'
import {
  runSessionsAttachment,
  runSessionsAttachments,
  runSessionsBudget,
  runSessionsCancel,
  runSessionsLandingRetry,
  runSessionsLogs,
  runSessionsResume,
  runSessionsShow,
  runSessionsWithdraw,
} from './commands/sessions-debug'
import { registerSharedCommands } from './commands/shared'
import { runStatus } from './commands/status'
import { registerTenantCommands } from './commands/tenant'
import { runTracesList, runTracesShow } from './commands/traces'
import { runWhoami } from './commands/whoami'
import { bannerEnv, CONFIG_KEYS, createConfigStore, DEFAULT_SERVER_URL, ENV } from './config'
import { type CommandContext, createContext } from './context'
import { CliError, exitCodeFor } from './errors'
import { BIN_NAME, VERSION } from './package-info'
import { cliPlugins } from './plugins'
import {
  animateBanner,
  type BannerInfo,
  bannerMode,
  commandHeader,
  helpHeader,
  isBareInvocation,
  isRootHelp,
  staticBanner,
  TAGLINE,
} from './utils/banner'
import { positiveInt } from './utils/input'
import { createLogger } from './utils/logger'
import { formatJson } from './utils/output'

interface GlobalOptions {
  server?: string
  profile?: string
  json?: boolean
}

// The Rocketflare header (utils/banner.ts): humans on a terminal only — never `--json`, a pipe, CI
// (still) or NO_COLOR. `headerInfo` gains the selected server before parsing.
const banner = bannerMode(bannerEnv(), {
  stdoutIsTTY: Boolean(process.stdout.isTTY),
  stderrIsTTY: Boolean(process.stderr.isTTY),
  json: process.argv.includes('--json'),
})
let headerInfo: BannerInfo = { version: VERSION }
let rootBannerShown = false

const program = new Command()
program
  .name(BIN_NAME)
  .description(`Rocketflare Launch — ${TAGLINE}. The \`${BIN_NAME}\` command-line interface.`)
  .version(VERSION)
  .option(
    '--server <name|url>',
    `a stored server's name, or a URL (default: $${ENV.url}, $${ENV.profile}, the default server, else ${DEFAULT_SERVER_URL})`
  )
  .option('--profile <name>', 'use this stored server (see `servers ls`)')
  .option('--json', 'print raw JSON instead of tables', false)
  .showHelpAfterError()
  .addHelpText('beforeAll', ({ command }) => {
    if (banner === 'off') return ''
    if (command !== program) return helpHeader(headerInfo)
    return rootBannerShown ? '' : staticBanner(headerInfo)
  })
  .addHelpText(
    'after',
    `
Exit codes: 0 ok · 1 error · 2 not logged in · 3 forbidden
Env:        ${ENV.apiKey} · ${ENV.url} · ${ENV.profile} · ${ENV.configDir} · ${ENV.debug} · ${ENV.banner}=off|static

For agents:
  ${BIN_NAME} commands --json              every command, its arguments and options
  ${BIN_NAME} api ls <word>                find an API route by path or summary
  ${BIN_NAME} api show <METHOD> <path>     what a route does and the JSON it takes
  ${BIN_NAME} api call <METHOD> <path>     call a route no command covers yet (--data, --query)
  --json on any command prints the raw body · --server <name> picks the server`
  )

/** Run a command with a context built from the global options; print + exit-code any error. */
function action(handler: (ctx: CommandContext, command: Command) => Promise<void>) {
  return async (...args: unknown[]) => {
    const command = args.at(-1) as Command
    const globals = command.optsWithGlobals<GlobalOptions>()
    let ctx: CommandContext | undefined
    try {
      ctx = await createContext({
        server: globals.server,
        profile: globals.profile,
        json: globals.json,
      })
      if (banner !== 'off' && !ctx.json)
        process.stderr.write(
          `${commandHeader({ ...headerInfo, serverUrl: ctx.config.serverUrl, profile: ctx.config.profile })}\n`
        )
      await handler(ctx, command)
    } catch (error) {
      report(error, ctx)
      process.exitCode = exitCodeFor(error)
    }
  }
}

function report(error: unknown, ctx: CommandContext | undefined): void {
  const log = ctx?.log ?? createLogger()
  if (error instanceof CliError) {
    log.error(error.message)
    if (error.hint) log.hint(error.hint)
    if (ctx?.json) {
      const body = 'body' in error ? (error as { body?: unknown }).body : undefined
      process.stderr.write(
        `${formatJson({ error: error.message, exitCode: error.exitCode, ...(body ? { body } : {}) })}\n`
      )
    }
    return
  }
  log.error(error instanceof Error ? error.message : String(error))
  if (process.env[ENV.debug] && error instanceof Error && error.stack) log.hint(error.stack)
}

// ---- auth ----------------------------------------------------------------------------------

program
  .command('login')
  .description('sign in through the browser and store an API key')
  .option('--server <name|url>', 'server to sign in to: a stored name or a URL')
  .option('--name <server>', 'store the login under this server name')
  .option(
    '--admin',
    'ask for an admin-scoped key (platform admins): reaches `admin` and `platform` commands; stored as <server>-admin'
  )
  .action(action((ctx, cmd) => runLogin(ctx, cmd.opts())))

program
  .command('logout')
  .description('remove the selected server’s stored API key')
  .option('--all', 'sign out of every stored server')
  .action(action((ctx, cmd) => runLogout(ctx, cmd.opts())))

program
  .command('whoami')
  .description('show the signed-in user and tenant')
  .action(action(runWhoami))

program
  .command('status')
  .description('check the selected server’s health and login state')
  .option('--all', 'check every stored server')
  .option('--ready', 'exit 1 unless the server is ready (its database answers)')
  .action(action((ctx, cmd) => runStatus(ctx, cmd.opts())))

registerServersCommands(program, action)

// ---- tenant-scoped -------------------------------------------------------------------------

const groups = program.command('groups').description('groups of the active tenant (admin+)')
groups
  .command('list')
  .description('list groups with their member counts')
  .action(action(runGroupsList))
groups
  .command('members <groupId>')
  .description('list the people in one group')
  .action(action((ctx, cmd) => runGroupMembers(ctx, String(cmd.args[0] ?? ''))))

registerGroupsWriteCommands(groups, action)

const features = program
  .command('features')
  .description('feature flags in effect for the active tenant')
features
  .command('list', { isDefault: true })
  .description('list features and whether they are on')
  .action(action(runFeaturesList))

const traces = program
  .command('traces')
  .description('AI traces of the active tenant — agent runs, chat turns, AI jobs (admin+)')
traces
  .command('list')
  .description('list recent traces, newest first')
  .option('--agent <key>', 'only this agent or surface, e.g. chat, research-topic')
  .option('--status <status>', 'ok | error', (value: string) => {
    if (value !== 'ok' && value !== 'error')
      throw new InvalidArgumentError('--status must be ok or error')
    return value
  })
  .option('--run <id>', 'only the trace of this agent run')
  .option('--conversation <id>', 'only traces of this chat thread')
  .option('--since <iso>', 'only traces that started at or after this ISO timestamp')
  .option('--page <n>', 'page number', positiveInt('--page'))
  .option('--page-size <n>', 'items per page (max 200)', positiveInt('--page-size'))
  .action(
    action((ctx, cmd) => {
      const { run, ...rest } = cmd.opts()
      return runTracesList(ctx, { ...rest, runId: run })
    })
  )
traces
  .command('show <id>')
  .description('print one trace as a span tree — <id> is a trace id, agent run id or message id')
  .option('--full', 'print tool/model content unclipped')
  .action(action((ctx, cmd) => runTracesShow(ctx, cmd.args[0] ?? '', cmd.opts())))

const feedback = program
  .command('feedback')
  .description('thumbs up/down on AI answers — the eval promotion queue (admin+)')
feedback
  .command('list')
  .description('list feedback, newest first')
  .option('--rating <rating>', 'up | down', (value: string) => {
    if (value !== 'up' && value !== 'down')
      throw new InvalidArgumentError('--rating must be up or down')
    return value
  })
  .option('--target <target>', 'message | agent_run', (value: string) => {
    if (value !== 'message' && value !== 'agent_run')
      throw new InvalidArgumentError('--target must be message or agent_run')
    return value
  })
  .option('--page <n>', 'page number', positiveInt('--page'))
  .option('--page-size <n>', 'items per page (max 200)', positiveInt('--page-size'))
  .action(action((ctx, cmd) => runFeedbackList(ctx, cmd.opts())))

registerFeedbackVoteCommands(feedback, action)

const evals = program.command('evals').description('eval datasets (pnpm eval runs them)')
evals
  .command('promote <id>')
  .description(
    'append a real answer (message or agent run id) to apps/evals/datasets/<name>.jsonl as a draft case (admin+)'
  )
  .requiredOption('--dataset <name>', 'dataset file name, without .jsonl')
  .option('--dir <path>', 'datasets directory (default: apps/evals/datasets, found from the cwd)')
  .option('--run', 'the id is an agent run (skip the message lookup)')
  .option('--id <caseId>', 'case id to write (default message-<8> / run-<8>)')
  .option('-y, --yes', 'write without asking — the case contains tenant data')
  .action(action((ctx, cmd) => runEvalsPromote(ctx, cmd.args[0] ?? '', cmd.opts())))

const sessions = program
  .command('sessions')
  .description('coding sessions — chat with a coding agent on an app, then ship a pull request')
sessions
  .command('start <app>')
  .description('start a session on an app (by slug)')
  .option('--title <title>', 'a name for the session')
  .option('--base <ref>', 'branch, tag or commit to start from (default: the app’s default branch)')
  .option('--runtime <runtime>', 'coding agent: claude_code or codex (default: the deployment’s)')
  .action(action((ctx, cmd) => runSessionsStart(ctx, cmd.args[0] ?? '', cmd.opts())))
sessions
  .command('say <id> <message>')
  .description('send one message to a session')
  .option('--follow', 'print the turn as it runs, until it ends')
  .option('--attach <file...>', 'images to send with it (PNG, JPEG, GIF, WebP; ≤5, ≤5 MB each)')
  .option(
    '--attach-id <id,...>',
    'images already uploaded with `sessions attach`',
    (v: string, p: string[] = []) => [
      ...p,
      ...v
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    ]
  )
  .action(
    action((ctx, cmd) => runSessionsSay(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts()))
  )
sessions
  .command('ship <id>')
  .description('run the checks, open a pull request and (by default) follow it live to staging')
  .option('--wait', 'follow the ship to its end (the default; kept for older scripts)')
  .option('--no-wait', 'return as soon as the ship has started')
  .action(action((ctx, cmd) => runSessionsShip(ctx, cmd.args[0] ?? '', cmd.opts())))
sessions
  .command('end <id>')
  .description('end a session (its branch is kept; asks first)')
  .option('-y, --yes', 'do not ask for confirmation')
  .action(action((ctx, cmd) => runSessionsEnd(ctx, cmd.args[0] ?? '', cmd.opts())))
sessions
  .command('show <id>')
  .description('show a session: status, PR, ship, budget, last error, the failing gate step, boots')
  .action(action((ctx, cmd) => runSessionsShow(ctx, cmd.args[0] ?? '')))
sessions
  .command('ls <app>')
  .description('list an app’s sessions')
  .option('--all', 'include finished sessions')
  .action(action((ctx, cmd) => runSessionsList(ctx, cmd.args[0] ?? '', cmd.opts())))
sessions
  .command('preview-url <id>')
  .description('print a one-minute sign-in URL for the session’s live preview')
  .option('--open', 'open it in the browser')
  .action(action((ctx, cmd) => runSessionsPreviewUrl(ctx, cmd.args[0] ?? '', cmd.opts())))
sessions
  .command('logs <id>')
  .description('print the session’s event log, every row (the debugging view)')
  .option('--follow', 'keep printing new rows until the session is quiet')
  .option('--since <seq>', 'only rows after this seq')
  .option('--type <types>', 'comma-separated type prefixes, e.g. ship.,turn.failed')
  .option('--limit <n>', 'only the last n matching rows')
  .action(action((ctx, cmd) => runSessionsLogs(ctx, cmd.args[0] ?? '', cmd.opts())))
sessions
  .command('resume <id>')
  .description('resume a suspended session')
  .action(action((ctx, cmd) => runSessionsResume(ctx, cmd.args[0] ?? '')))
sessions
  .command('cancel <id>')
  .description('stop the turn that is running')
  .action(action((ctx, cmd) => runSessionsCancel(ctx, cmd.args[0] ?? '')))
sessions
  .command('withdraw <id>')
  .description('withdraw the message waiting to be sent')
  .action(action((ctx, cmd) => runSessionsWithdraw(ctx, cmd.args[0] ?? '')))
sessions
  .command('landing-retry <id>')
  .description('retry a ship that stalled before its release')
  .option('--release-anyway', 'on red main checks: release without them (the deploy re-gates)')
  .action(action((ctx, cmd) => runSessionsLandingRetry(ctx, cmd.args[0] ?? '', cmd.opts())))
sessions
  .command('budget <id> <usd>')
  .description('ask to raise the session’s budget by <usd> dollars')
  .option('--reason <text>', 'why — shown on the approval')
  .action(
    action((ctx, cmd) => runSessionsBudget(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts()))
  )
sessions
  .command('attach <id> <file...>')
  .description('upload images for the next message (PNG, JPEG, GIF, WebP; ≤5, ≤5 MB each)')
  .action(action((ctx, cmd) => runSessionsAttach(ctx, cmd.args[0] ?? '', cmd.args.slice(1))))
sessions
  .command('attachments <id>')
  .description('list the images the session’s messages carried')
  .action(action((ctx, cmd) => runSessionsAttachments(ctx, cmd.args[0] ?? '')))
sessions
  .command('attachment <id> <attachmentId>')
  .description('download one of the session’s images into a 0600 file')
  .requiredOption('--out <file>', 'where to write it')
  .option('--force', 'replace --out if it exists')
  .action(
    action((ctx, cmd) =>
      runSessionsAttachment(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts())
    )
  )

// ---- Launch P4: approvals, releases, audit (each file registers its own commands) ------------

registerApprovalsCommands(program, action)
registerReleasesCommands(program, action)
registerAuditCommands(program, action)

// ---- Launch P5: shared config and grants (each file registers its own commands) ---------------

registerSharedCommands(program, action)
registerGrantsCommands(program, action)

// ---- Launch P6 6c: an app and its kit upgrade ------------------------------------------------

registerAppsCommands(program, action)
registerDeploysCommands(program, action)

// ---- issue #6: what agents, AI and the organisation are doing ---------------------------------

registerAgentsCommands(program, action)
registerAiCommands(program, action)
registerChatCommands(program, action)
registerDocsCommands(program, action)
registerActivityCommands(program, action)
registerNotificationsCommands(program, action)
registerAdminCommands(program, action)
registerPlatformCommands(program, action)
registerMembersCommands(program, action)
registerKeysCommands(program, action)
registerTenantCommands(program, action)
registerPoliciesCommands(program, action)
registerAccessCommands(program, action)
registerFilesCommands(program, action)
registerAgentAccountsCommands(program, action)

// ---- issue #6: agent discovery — the API catalog, any route, and every command -------------

registerApiCommands(program, action)

// ---- config --------------------------------------------------------------------------------

const config = program.command('config').description('read or edit the CLI config file')
config
  .command('get [key]')
  .description(`print the config (API key redacted); keys: ${CONFIG_KEYS.join(', ')}`)
  .action(action((ctx, cmd) => runConfigGet(ctx, cmd.args[0])))
config
  .command('set <key> <value>')
  .description('set a config value')
  .action(action((ctx, cmd) => runConfigSet(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '')))
config.command('path').description('print the config file path').action(action(runConfigPath))

// ---- plugins -------------------------------------------------------------------------------

// Installed plugins register LAST (D31), so `--help` lists the kit's commands first and a plugin's
// under its own id. They get the same `action()` wrapper, and so the same context, error printer
// and exit-code mapping as everything above.
for (const plugin of cliPlugins) plugin.register(program, action)

// `ls` and `list` are one verb everywhere: each group answers to both, whichever it registered.
aliasListVerbs(program)

async function main(): Promise<void> {
  if (banner !== 'off') {
    try {
      const resolved = await createConfigStore().resolve()
      headerInfo = { version: VERSION, serverUrl: resolved.serverUrl, profile: resolved.profile }
    } catch {
      // A broken config is the command's error to report, not the header's.
    }
    if (banner === 'animate' && isRootHelp(process.argv.slice(2))) {
      await animateBanner(headerInfo, process.stdout)
      rootBannerShown = true
    }
  }
  // Bare `launch` asks what is here: the help on stdout and exit 0. (Commander's default treats a
  // missing subcommand as a usage error — help on stderr, exit 1 — which `pnpm cli` reports as a
  // failure.) An unknown command still exits 1.
  if (isBareInvocation(process.argv.slice(2))) {
    program.outputHelp()
    return
  }
  await program.parseAsync(process.argv)
}

void main()
