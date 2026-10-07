/**
 * `launch feedback list` — thumbs on AI answers (`GET /api/feedback`, admin+) (D33).
 *
 * The promotion queue: `--rating down` is where eval cases come from. Each row names the rated
 * target (`message` / `agent_run`) and its id, which is exactly what `launch evals promote`
 * and `launch traces show` take.
 *
 * Issue #6 adds the thumbs themselves: `give <id> up|down [--run] [--comment]` (`POST`, any member;
 * voting again replaces the vote), `rm <id> [--run]` (withdraw) and `mine <ids…> [--run]`.
 */
import {
  createFeedbackRequestSchema,
  feedbackListResponseSchema,
  feedbackMineQuerySchema,
  feedbackMineResponseSchema,
  feedbackSchema,
} from '@launch/shared/ai/evals'
import chalk from 'chalk'
import type { Command } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import { parseBody } from '../utils/input'
import { formatDate, formatPagination, renderTable } from '../utils/output'

export interface FeedbackListOptions {
  rating?: 'up' | 'down'
  target?: 'message' | 'agent_run'
  page?: number
  pageSize?: number
}

export async function runFeedbackList(
  ctx: CommandContext,
  options: FeedbackListOptions = {}
): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/feedback', {
    schema: feedbackListResponseSchema,
    query: {
      rating: options.rating,
      target: options.target,
      page: options.page,
      pageSize: options.pageSize,
    },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'When', value: f => formatDate(f.updatedAt) },
      { header: 'Rating', value: f => (f.rating === 1 ? chalk.green('up') : chalk.red('down')) },
      { header: 'Target', value: f => f.target },
      { header: 'Id', value: f => f.targetId },
      { header: 'Comment', value: f => (f.comment ? f.comment.slice(0, 60) : '') },
      { header: 'User', value: f => f.userId?.slice(0, 8) ?? '' },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
  if (!ctx.json && data.items.length > 0) {
    ctx.log.hint(`Promote one: ${ctx.binName} evals promote <id> --dataset <name>`)
  }
}

// ---- give / rm / mine (issue #6): the thumbs under an answer --------------------------------

const feedbackTarget = (run?: boolean) => (run ? 'agent_run' : 'message')

export interface FeedbackGiveOptions {
  /** The id is an agent run, not an assistant message. */
  run?: boolean
  comment?: string
}

/** `feedback give <id> up|down [--run] [--comment]` — voting again replaces your vote. */
export async function runFeedbackGive(
  ctx: CommandContext,
  targetId: string,
  vote: string,
  options: FeedbackGiveOptions = {}
): Promise<void> {
  if (vote !== 'up' && vote !== 'down') throw new CliError('The vote is up or down')
  const body = parseBody(createFeedbackRequestSchema, {
    target: feedbackTarget(options.run),
    targetId,
    rating: vote === 'up' ? 1 : -1,
    ...(options.comment ? { comment: options.comment } : {}),
  })
  const { data, raw } = await requireClient(ctx).request('POST', '/api/feedback', {
    schema: feedbackSchema,
    body,
  })
  ctx.out.data(
    raw,
    () =>
      `${chalk.green('✓')} Thumbs ${data.rating === 1 ? 'up' : 'down'} on ${data.target === 'message' ? 'the answer' : 'the run'} ${data.targetId.slice(0, 8)}.`
  )
}

/** `feedback rm <id> [--run]` — withdraw your own vote (idempotent). */
export async function runFeedbackRemove(
  ctx: CommandContext,
  targetId: string,
  options: { run?: boolean } = {}
): Promise<void> {
  const target = feedbackTarget(options.run)
  await requireClient(ctx).request(
    'DELETE',
    `/api/feedback/${target}/${encodeURIComponent(targetId)}`
  )
  ctx.out.data(
    { target, targetId, removed: true },
    () => `${chalk.green('✓')} Your vote is withdrawn.`
  )
}

/** `feedback mine <ids…> [--run]` — your own votes on those answers or runs. */
export async function runFeedbackMine(
  ctx: CommandContext,
  targetIds: string[],
  options: { run?: boolean } = {}
): Promise<void> {
  const query = parseBody(feedbackMineQuerySchema, {
    target: feedbackTarget(options.run),
    targetIds: targetIds.join(','),
  })
  const { data, raw } = await requireClient(ctx).request('GET', '/api/feedback/mine', {
    schema: feedbackMineResponseSchema,
    query: { target: query.target, targetIds: query.targetIds.join(',') },
  })
  ctx.out.data(raw, () =>
    data.items.length === 0
      ? 'You have not rated any of them.'
      : renderTable(data.items, [
          { header: 'Id', value: f => f.targetId },
          {
            header: 'Rating',
            value: f => (f.rating === 1 ? chalk.green('up') : chalk.red('down')),
          },
          { header: 'Comment', value: f => f.comment ?? '' },
          { header: 'When', value: f => formatDate(f.updatedAt) },
        ])
  )
}

/** Adds `give|rm|mine` to the `feedback` command `cli.ts` creates. */
export function registerFeedbackVoteCommands(feedback: Command, action: ActionWrapper): void {
  feedback
    .command('give <id> <vote>')
    .description('thumbs up or down on an assistant message (or, with --run, an agent run)')
    .option('--run', 'the id is an agent run')
    .option('--comment <text>', 'what was good or wrong about it')
    .action(
      action((ctx, cmd) => runFeedbackGive(ctx, cmd.args[0] ?? '', cmd.args[1] ?? '', cmd.opts()))
    )
  feedback
    .command('rm <id>')
    .description('withdraw your vote')
    .option('--run', 'the id is an agent run')
    .action(action((ctx, cmd) => runFeedbackRemove(ctx, cmd.args[0] ?? '', cmd.opts())))
  feedback
    .command('mine <ids...>')
    .description('your own votes on these messages (or runs)')
    .option('--run', 'the ids are agent runs')
    .action(action((ctx, cmd) => runFeedbackMine(ctx, cmd.args as string[], cmd.opts())))
}
