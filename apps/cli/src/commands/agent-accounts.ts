/**
 * `launch agent-accounts ls|login|cancel|rm` (issue #6) — the caller's OWN Claude / Codex accounts
 * that coding sessions may bill (§18.22), over `/api/me/agent-credentials` and `/api/me/agent-logins`
 * with `@launch/shared/launch-agents`. The same flow as the web's "Connect your account" dialog:
 *
 * - `ls` — each runtime this deployment offers, whether a personal account may be connected, and
 *   the connected one's state ("Connected · in use", "Needs reconnecting", "Expires …").
 * - `login <runtime>` — start the relayed sign-in (or resume the one in flight), wait for the
 *   provider's page, print it (and Codex's one-time code to type there), then for Claude read the
 *   code Anthropic shows from a HIDDEN prompt or, when stdin is not a terminal, its first line —
 *   never argv — send it, and poll to the end. Exit 0 connected; 1 failed, expired or cancelled.
 *   A Ctrl-C at the prompt cancels the sign-in.
 * - `cancel <runtime>` — cancel the sign-in in flight. `rm <runtime> [--yes]` — disconnect (asks).
 *
 * No token is ever in a response: the API speaks of a credential's state only, and the code a
 * person pastes is sent once and never echoed. Polling is injectable (`sleep`, `pollMs`); with
 * `--json` `login` prints ONE `{ login }` document at the end.
 */
import {
  AGENT_RUNTIMES,
  type AgentCredential,
  type AgentLogin,
  type AgentRuntimeId,
  agentAccountsResponseSchema,
  agentLoginResponseSchema,
  agentRuntimeHasAccounts,
  isActiveAgentLoginStatus,
  submitAgentLoginCodeRequestSchema,
} from '@launch/shared/launch-agents'
import chalk from 'chalk'
import type { Command } from 'commander'
import type { ApiClient } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import {
  type ConfirmOptions,
  confirmAction,
  promptHiddenOnTerminal,
  readAllStdin,
} from '../utils/input'
import { formatDate, renderTable } from '../utils/output'

const loginPath = (id: string) => `/api/me/agent-logins/${encodeURIComponent(id)}`
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const DAY_MS = 24 * 60 * 60 * 1000

const PROVIDERS: Record<AgentRuntimeId, string> = {
  claude_code: 'Anthropic',
  codex: 'OpenAI',
  pi: 'Workers AI',
}

/** The runtimes a person can connect an account for (Pi has none: it runs on Workers AI). */
const ACCOUNT_RUNTIMES = AGENT_RUNTIMES.filter(agentRuntimeHasAccounts)
/** Codex's device page, when the row has not got one yet. */
const CODEX_DEVICE_PAGE = 'https://auth.openai.com/codex/device'

function runtimeArg(value: string): AgentRuntimeId {
  if (!(AGENT_RUNTIMES as readonly string[]).includes(value))
    throw new CliError(`Unknown runtime "${value}"`, {
      hint: `One of: ${ACCOUNT_RUNTIMES.join(', ')}.`,
    })
  if (!agentRuntimeHasAccounts(value as AgentRuntimeId))
    throw new CliError(`${value} has no personal account`, {
      hint: `Its sessions run on Launch's own account. Accounts: ${ACCOUNT_RUNTIMES.join(', ')}.`,
    })
  return value as AgentRuntimeId
}

/** What a connected credential is doing, as the Profile panel says it. Pure. */
export function credentialStatusText(
  credential: AgentCredential | undefined,
  now: Date = new Date()
): string {
  if (!credential) return 'Not connected'
  if (credential.status === 'needs_login') return 'Needs reconnecting'
  if (credential.expiresAt) {
    const left = credential.expiresAt.getTime() - now.getTime()
    if (left <= 0) return 'Expired — reconnect it'
    if (left < 30 * DAY_MS) return `Expires ${formatDate(credential.expiresAt)}`
  }
  return credential.inUse ? 'Connected · in use' : 'Connected'
}

/** A login's state in a sentence — the dialog's words. Pure. */
export function loginStatusText(login: AgentLogin): string {
  const provider = PROVIDERS[login.runtime]
  switch (login.status) {
    case 'starting':
      return `Starting ${provider}’s sign-in…`
    case 'awaiting_user':
      return login.needsCode
        ? `Sign in on ${provider}’s page, then paste the code it shows you.`
        : `Sign in on ${provider}’s page and enter the code shown here.`
    case 'submitting':
      return 'Sending your code…'
    case 'finishing':
      return 'Finishing…'
    case 'succeeded':
      return 'Connected.'
    case 'cancelled':
      return 'Cancelled.'
    case 'expired':
    case 'failed':
      return login.error ?? 'The sign-in did not finish. Start it again.'
  }
}

/** What Anthropic's code page shows: `<code>#<state>`, no spaces. Pure. */
export function claudeCodeProblem(code: string): string | null {
  const parsed = submitAgentLoginCodeRequestSchema.safeParse({ code })
  if (!parsed.success) return 'Paste the code Anthropic showed you.'
  if (!/^[^\s#]+#[^\s#]+$/.test(parsed.data.code))
    return 'That looks incomplete. Copy the whole code from Anthropic’s page — it has a # in the middle.'
  return null
}

// ---- ls ------------------------------------------------------------------------------------

export async function runAgentAccountsList(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await client.request('GET', '/api/me/agent-credentials', {
    schema: agentAccountsResponseSchema,
  })
  ctx.out.data(raw, () => {
    const rows = data.runtimes.map(option => ({
      option,
      credential: data.credentials.find(c => c.runtime === option.runtime),
      login: data.logins.find(
        l => l.runtime === option.runtime && isActiveAgentLoginStatus(l.status)
      ),
    }))
    const lines = [
      renderTable(rows, [
        { header: 'Runtime', value: r => r.option.runtime },
        { header: 'Agent', value: r => r.option.label },
        { header: 'Account', value: r => r.option.accountLabel ?? '—' },
        {
          header: 'Personal account',
          value: r =>
            !r.option.enabled
              ? 'off here'
              : r.option.userCredentials
                ? r.option.credentialMode === 'user'
                  ? 'required'
                  : 'allowed'
                : 'Launch’s account only',
        },
        { header: 'Status', value: r => credentialStatusText(r.credential) },
        { header: 'Sign-in', value: r => (r.login ? r.login.status : null) },
      ]),
    ]
    const connectable = rows.filter(r => r.option.enabled && r.option.userCredentials)
    for (const r of connectable)
      if (!r.credential || r.credential.status === 'needs_login')
        lines.push(
          chalk.dim(`  Connect it: ${ctx.binName} agent-accounts login ${r.option.runtime}`)
        )
    return lines.join('\n')
  })
}

// ---- login ---------------------------------------------------------------------------------

export interface AgentLoginOptions {
  /** Open the provider's page in the browser too. */
  open?: boolean
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Whether stdin is a terminal (default `process.stdin.isTTY`). */
  isTTY?: boolean
  readStdin?: () => Promise<string>
  promptHidden?: (question: string) => Promise<string>
}

async function readLogin(client: ApiClient, id: string): Promise<AgentLogin> {
  return (await client.get(loginPath(id), { schema: agentLoginResponseSchema })).login
}

async function cancelLogin(client: ApiClient, id: string): Promise<AgentLogin | null> {
  try {
    const { data } = await client.request('POST', `${loginPath(id)}/cancel`, {
      schema: agentLoginResponseSchema,
    })
    return data.login
  } catch {
    return null
  }
}

/** The code, from a hidden prompt or stdin's first line. Never echoed. */
async function readCode(options: AgentLoginOptions): Promise<string> {
  const tty = options.isTTY ?? Boolean(process.stdin.isTTY)
  if (!tty) {
    const text = await (options.readStdin ?? readAllStdin)()
    return (text.split(/\r?\n/).find(l => l.trim()) ?? '').trim()
  }
  const ask =
    options.promptHidden ??
    ((q: string) => promptHiddenOnTerminal(q, 'Cancelled — the sign-in was stopped'))
  return (await ask('Code from Anthropic (hidden): ')).trim()
}

export async function runAgentAccountsLogin(
  ctx: CommandContext,
  runtimeValue: string,
  options: AgentLoginOptions = {}
): Promise<void> {
  const runtime = runtimeArg(runtimeValue)
  const client = requireClient(ctx)
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? 1500

  // Resume the sign-in already under way, as the dialog does; otherwise start one.
  const accounts = await client.get('/api/me/agent-credentials', {
    schema: agentAccountsResponseSchema,
  })
  let login =
    accounts.logins.find(l => l.runtime === runtime && isActiveAgentLoginStatus(l.status)) ??
    (
      await client.request('POST', '/api/me/agent-logins', {
        schema: agentLoginResponseSchema,
        body: { runtime },
      })
    ).data.login
  const provider = PROVIDERS[runtime]
  let said = ''
  const say = (line: string) => {
    if (line !== said) ctx.log.info(line)
    said = line
  }
  let shown = false
  let sent = false

  while (isActiveAgentLoginStatus(login.status)) {
    say(loginStatusText(login))
    if (now() > login.expiresAt.getTime() + 60_000) break
    if (login.status === 'awaiting_user' && !shown) {
      shown = true
      const url = login.verificationUrl ?? (runtime === 'codex' ? CODEX_DEVICE_PAGE : null)
      if (url) {
        ctx.log.info(`Open ${provider}’s sign-in: ${chalk.bold(url)}`)
        if (options.open) await ctx.open(url).catch(() => {})
      }
      if (login.userCode) {
        ctx.log.info(`Enter this one-time code there: ${chalk.bold(login.userCode)}`)
        ctx.log.hint(
          'It expires in 15 minutes. If OpenAI says device-code sign-in is not allowed, turn it on in your ChatGPT security settings, or ask your workspace admin.'
        )
      }
    }
    if (login.status === 'awaiting_user' && login.needsCode && !sent) {
      let code: string
      try {
        code = await readCode(options)
      } catch (error) {
        await cancelLogin(client, login.id)
        throw error
      }
      const problem = claudeCodeProblem(code)
      if (problem) {
        await cancelLogin(client, login.id)
        throw new CliError(problem, {
          hint: `The sign-in was cancelled; start again: ${ctx.binName} agent-accounts login ${runtime}`,
        })
      }
      sent = true
      login = (
        await client.request('POST', `${loginPath(login.id)}/code`, {
          schema: agentLoginResponseSchema,
          body: { code },
        })
      ).data.login
      continue
    }
    await sleep(login.status === 'awaiting_user' ? pollMs * 2 : pollMs)
    login = await readLogin(client, login.id)
  }

  if (isActiveAgentLoginStatus(login.status)) {
    throw new CliError('The sign-in did not finish in time', {
      hint: `Start it again: ${ctx.binName} agent-accounts login ${runtime}`,
    })
  }
  if (login.status !== 'succeeded') {
    throw new CliError(loginStatusText(login), {
      hint: `Start it again: ${ctx.binName} agent-accounts login ${runtime}`,
    })
  }
  ctx.out.data({ login }, () => `${chalk.green('✓')} Account connected.`)
}

// ---- cancel / rm ---------------------------------------------------------------------------

export async function runAgentAccountsCancel(
  ctx: CommandContext,
  runtimeValue: string
): Promise<void> {
  const runtime = runtimeArg(runtimeValue)
  const client = requireClient(ctx)
  const accounts = await client.get('/api/me/agent-credentials', {
    schema: agentAccountsResponseSchema,
  })
  const login = accounts.logins.find(
    l => l.runtime === runtime && isActiveAgentLoginStatus(l.status)
  )
  if (!login) throw new CliError(`No ${runtime} sign-in is under way`)
  const { raw } = await client.request('POST', `${loginPath(login.id)}/cancel`, {
    schema: agentLoginResponseSchema,
  })
  ctx.out.data(raw, () => `${chalk.green('✓')} Cancelled the sign-in.`)
}

export async function runAgentAccountsRemove(
  ctx: CommandContext,
  runtimeValue: string,
  options: ConfirmOptions = {}
): Promise<void> {
  const runtime = runtimeArg(runtimeValue)
  const client = requireClient(ctx)
  ctx.log.warn(
    'Sessions you start on it afterwards need another account; Launch deletes its stored copy of the token.'
  )
  const go = await confirmAction(
    `Disconnect your ${runtime} account?`,
    options,
    `Refusing to disconnect your ${runtime} account without confirmation`
  )
  if (!go) {
    ctx.log.info('Nothing was disconnected.')
    return
  }
  await client.request('DELETE', `/api/me/agent-credentials/${encodeURIComponent(runtime)}`)
  ctx.out.data({ runtime, removed: true }, () => `${chalk.green('✓')} Disconnected.`)
}

// ---- registration --------------------------------------------------------------------------

export function registerAgentAccountsCommands(program: Command, action: ActionWrapper): void {
  const accounts = program
    .command('agent-accounts')
    .description('your own Claude / Codex accounts that coding sessions may run on')
  accounts
    .command('ls')
    .description('the runtimes offered here and the accounts you have connected')
    .action(action(ctx => runAgentAccountsList(ctx)))
  accounts
    .command('login <runtime>')
    .description(
      `connect your account (${ACCOUNT_RUNTIMES.join(' | ')}): sign in on the provider’s page; Claude’s code is read hidden or from stdin`
    )
    .option('--open', 'open the provider’s page in your browser')
    .action(action((ctx, cmd) => runAgentAccountsLogin(ctx, cmd.args[0] ?? '', cmd.opts())))
  accounts
    .command('cancel <runtime>')
    .description('cancel the sign-in under way')
    .action(action((ctx, cmd) => runAgentAccountsCancel(ctx, cmd.args[0] ?? '')))
  accounts
    .command('rm <runtime>')
    .description('disconnect your account (asks first)')
    .option('-y, --yes', 'do not ask')
    .action(action((ctx, cmd) => runAgentAccountsRemove(ctx, cmd.args[0] ?? '', cmd.opts())))
}
