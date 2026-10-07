/**
 * `launch platform setup` (issue #6) — the Setup page's state from a terminal, over
 * `GET /api/platform/setup` (`setupOverviewSchema`; platform administrators, an admin key —
 * `launch login --admin` — or the browser). Read-only: `GET /` never probes upstream, so this
 * shows the LAST check of each credential; re-running one is the page's Check button.
 *
 * Prints each step with its status, each credential as SET / not set with its last check, and
 * then the warnings — only things someone has to act on (a step not yet done, a failed or
 * warning probe with its detail, an enabled coding agent with no key to bill). **No value ever
 * appears**: the server sends presence booleans and probe sentences, never a credential, and this
 * prints no `metadata` either. `--json` prints the body as sent.
 *
 * The writes (settings, credentials, public URL, kit pin, coding agents, sandbox) live in
 * `platform-setup.ts`; OIDC signing keys and the access-request queue in `platform-identity.ts`.
 */
import {
  type CredentialLastCheck,
  type SetupOverview,
  type SetupStepStatus,
  setupOverviewSchema,
} from '@launch/shared/launch-setup'
import chalk from 'chalk'
import type { Command } from 'commander'
import { type CommandContext, requireClient } from '../context'
import type { ActionWrapper } from '../plugins/types'
import { formatDate, renderTable } from '../utils/output'
import { withAdminKey } from './admin-key'
import { registerPlatformIdentityCommands } from './platform-identity'
import { kitLine, registerPlatformSetupCommands } from './platform-setup'

const STEP_LABELS: Record<SetupOverview['steps'][number]['id'], string> = {
  domain: 'Apps domain',
  cloudflare: 'Cloudflare',
  neon: 'Neon',
  resend: 'Resend (email)',
  github: 'GitHub',
  identity: 'Sign-in (OIDC)',
  public_url: 'Public URL',
}

const STATUS_WORDS: Record<SetupStepStatus, string> = {
  todo: 'not started',
  unchecked: 'entered, not checked',
  ok: 'ok',
  warning: 'warning',
  failed: 'failed',
}

function colourStatus(status: SetupStepStatus): string {
  const word = STATUS_WORDS[status]
  if (status === 'ok') return chalk.green(word)
  if (status === 'failed') return chalk.red(word)
  if (status === 'warning') return chalk.yellow(word)
  return chalk.dim(word)
}

/** The probes of a check that need someone: failed and warning ones, with their sentence. */
function problems(where: string, checks: CredentialLastCheck | null | undefined): string[] {
  return (checks ?? [])
    .filter(c => c.status !== 'ok')
    .map(c => `${where}: ${c.label} — ${c.status}${c.detail ? `: ${c.detail}` : ''}`)
}

/** Everything in the overview someone has to act on, one sentence each. Pure, so tests read it. */
export function setupWarnings(data: SetupOverview): string[] {
  const out: string[] = []
  for (const step of data.steps) {
    const label = STEP_LABELS[step.id]
    if (step.status === 'todo') out.push(`${label}: not set up yet`)
    else if (step.status === 'unchecked') out.push(`${label}: entered but never checked`)
  }
  for (const cred of data.credentials) {
    out.push(...problems(cred.kind, cred.lastCheck))
  }
  out.push(...problems('Sign-in (OIDC)', data.identity.checks))
  out.push(...problems('Public URL', data.publicUrl.checks))
  for (const agent of data.sessionAgents.runtimes) {
    if (agent.enabled && agent.credentialMode === 'platform' && agent.platformKey.source === null) {
      out.push(
        agent.platformKey.kind === 'workers_ai'
          ? `${agent.label}: enabled, but this Worker has no Workers AI binding ([ai]), so it is not offered`
          : `${agent.label}: enabled on Launch's account, but no ${agent.platformKey.kind} is set`
      )
    }
  }
  return out
}

export async function runPlatformSetup(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('GET', '/api/platform/setup', { schema: setupOverviewSchema })
  )
  ctx.out.data(raw, () => {
    const warnings = setupWarnings(data)
    const lines = [
      renderTable(data.steps, [
        { header: 'Step', value: s => STEP_LABELS[s.id] },
        { header: 'Status', value: s => colourStatus(s.status) },
      ]),
      '',
      renderTable(data.credentials, [
        { header: 'Credential', value: c => c.kind },
        { header: 'Set', value: c => (c.set ? 'yes' : 'no') },
        { header: 'Last check', value: c => c.lastCheckStatus },
        { header: 'Checked', value: c => formatDate(c.lastCheckedAt) },
      ]),
      '',
      `Public URL  ${data.publicUrl.url}  ${data.publicUrl.status ?? 'not checked'}`,
      `Kit         ${kitLine(data.templatePin)}`,
      `Sessions    containers run ${data.sessionSandbox.host}`,
      '',
      warnings.length === 0
        ? chalk.green('Nothing to act on.')
        : [chalk.yellow(`To act on (${warnings.length}):`), ...warnings.map(w => `  ! ${w}`)].join(
            '\n'
          ),
    ]
    return lines.join('\n')
  })
}

export function registerPlatformCommands(program: Command, action: ActionWrapper): void {
  const platform = program
    .command('platform')
    .description('the Launch deployment itself (platform administrators; `login --admin`)')
  platform
    .command('setup')
    .description('each setup step and credential with its last check, and what to act on')
    .action(action(ctx => runPlatformSetup(ctx)))
  registerPlatformSetupCommands(platform, action)
  registerPlatformIdentityCommands(platform, action)
}
