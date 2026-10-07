/**
 * `launch admin sessions|drain|undrain` (issue #6) — the operator's coding-session controls over
 * `/api/admin/sessions` (global admins only). `admin tenants|users` live in `admin-orgs.ts`,
 * `admin flags` in `admin-flags.ts`; all are registered here.
 *
 * `/api/admin/*` takes the browser cookie or an ADMIN-scoped API key — `launch login --admin`
 * mints one (`GET /auth/cli?scope=admin`) for a platform administrator, and the server re-checks
 * its creator on every request. An ordinary CLI key is 403 `admin_key_required` there, so every
 * command here turns a 403 (or a 401 from an expired admin key) into exit 3 / 2 with the hint to
 * log in with `--admin`. `withAdminKey` (`admin-key.ts`) is shared with `platform.ts`.
 *
 * - `sessions [--scope active|all]` — every live (or every) session across the deployment, with
 *   the drain flag.
 * - `drain` — refuse new sessions and suspend the live ones (`docs/DEPLOY.md`: required before a
 *   deploy that touches the session image). Asks first; `--yes` skips the prompt, and without a
 *   terminal it refuses rather than guess.
 * - `undrain` — let sessions start again. Same confirmation.
 */
import {
  adminSessionListResponseSchema,
  drainResponseSchema,
  sessionListQuerySchema,
} from '@launch/shared/launch-sessions'
import chalk from 'chalk'
import type { Command } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { confirmConsequence } from '../utils/input'
import { formatDate, renderTable } from '../utils/output'
import { registerAdminFlagCommands } from './admin-flags'
import { withAdminKey } from './admin-key'
import { registerAdminOrgCommands } from './admin-orgs'

export interface AdminSessionsOptions {
  scope?: string
}

export async function runAdminSessions(
  ctx: CommandContext,
  options: AdminSessionsOptions = {}
): Promise<void> {
  const parsed = sessionListQuerySchema.safeParse({ scope: options.scope })
  if (!parsed.success) throw new CliError('--scope must be active or all')
  const client = requireClient(ctx)
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('GET', '/api/admin/sessions', {
      schema: adminSessionListResponseSchema,
      query: { scope: parsed.data.scope },
    })
  )
  ctx.out.data(raw, () => {
    const lines = [
      data.paused
        ? chalk.yellow('Sessions are DRAINED: new sessions are refused (launch admin undrain).')
        : 'Sessions are accepted.',
      '',
      renderTable(data.items, [
        { header: 'Session', value: s => s.shortId },
        { header: 'App', value: s => s.appSlug },
        { header: 'Kind', value: s => s.kind },
        { header: 'Status', value: s => s.status },
        { header: 'Runtime', value: s => s.runtime },
        { header: 'Image', value: s => s.imageVersion },
        { header: 'Container', value: s => `${Math.round(s.containerSeconds / 60)} min` },
        { header: 'Last activity', value: s => formatDate(s.lastActivityAt) },
        { header: 'Tenant', value: s => s.tenantId.slice(0, 8) },
      ]),
    ]
    return lines.join('\n')
  })
}

export interface DrainOptions {
  /** Act without asking. Required when stdin is not a terminal. */
  yes?: boolean
  /** Injected for tests: answer the confirmation prompt. */
  confirm?: (question: string) => Promise<boolean>
}

export async function runAdminDrain(ctx: CommandContext, options: DrainOptions = {}) {
  const client = requireClient(ctx)
  if (
    !(await confirmConsequence(
      ctx,
      options,
      'Drain coding sessions? New sessions are refused and every live one is suspended.'
    ))
  ) {
    return
  }
  const { data, raw } = await withAdminKey(ctx, () =>
    client.request('POST', '/api/admin/sessions/drain', { schema: drainResponseSchema, body: {} })
  )
  ctx.out.data(
    raw,
    () =>
      `Drained: new sessions are refused; ${data.suspended} live session${data.suspended === 1 ? '' : 's'} asked to suspend.`
  )
  ctx.log.hint(`Undo with \`${ctx.binName} admin undrain\` once the deploy is done.`)
}

export async function runAdminUndrain(ctx: CommandContext, options: DrainOptions = {}) {
  const client = requireClient(ctx)
  if (
    !(await confirmConsequence(
      ctx,
      options,
      'Undrain coding sessions? New sessions may start again.'
    ))
  ) {
    return
  }
  const { raw } = await withAdminKey(ctx, () =>
    client.request('POST', '/api/admin/sessions/undrain', { schema: drainResponseSchema, body: {} })
  )
  ctx.out.data(raw, () => 'Undrained: sessions may start again; people resume their own.')
}

export function registerAdminCommands(program: Command, action: ActionWrapper): void {
  const admin = program
    .command('admin')
    .description('operator controls across the deployment (needs `login --admin`)')
  admin
    .command('sessions')
    .description('coding sessions across every organisation, and whether they are drained')
    .option('--scope <scope>', 'active (default) or all')
    .action(action((ctx, cmd) => runAdminSessions(ctx, cmd.opts<AdminSessionsOptions>())))
  admin
    .command('drain')
    .description('refuse new sessions and suspend the live ones (before a session-image deploy)')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(action((ctx, cmd) => runAdminDrain(ctx, cmd.opts<DrainOptions>())))
  admin
    .command('undrain')
    .description('let sessions start again')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(action((ctx, cmd) => runAdminUndrain(ctx, cmd.opts<DrainOptions>())))
  registerAdminOrgCommands(admin, action)
  registerAdminFlagCommands(admin, action)
}
