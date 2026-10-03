/**
 * Metering a turn from Claude Code's own output — the `host` egress mode (`egress/host.ts`), where
 * the sandbox host's handler keys the requests but cannot reach Launch's database to meter them. Same ledger as the proxy: the same pricing
 * (`@launch/shared/ai/pricing`) and the same write (`recordSessionUsage`: one `ai_usage` row and the
 * session's running totals in ONE transaction, feature `session`).
 *
 * - **While the turn runs**: every `assistant` line carries its response's usage (repeated on each
 *   content block of the same response — kept per response id, last value wins). Their priced sum
 *   is the turn's RUNNING cost, which `turn.ts` compares with the budget headroom it read at the
 *   start (`budgetHeadroom`) and kills the process when it is reached.
 * - **When it ends**: the `result` line's usage per model (`modelUsage`, which includes Claude
 *   Code's background calls) is recorded — else its plain `usage` under the policy's model — and,
 *   for a turn that never printed a `result` (killed, crashed), what the running sum saw, so a
 *   stopped turn is still paid for.
 */
import type { TokenUsage } from '@launch/shared/ai/chat'
import { estimateCostMicrocents } from '@launch/shared/ai/pricing'
import type { Database } from '../../../db/client'
import type { SessionRow } from '../../../db/schema'
import type { ClaudeLineMapping, ClaudeModelUsage } from './claude-stream'
import { recordSessionUsage } from './egress/anthropic'

export interface TurnUsageEntry {
  model: string
  usage: TokenUsage
}

export interface TurnMeter {
  /** Feed every mapping the turn's parser produced (any runtime's: only the usage is read). */
  observe(mapping: Pick<ClaudeLineMapping, 'messageUsage' | 'turnUsage'>): void
  /** The priced sum of the responses seen so far (an unpriced model counts 0, as in the proxy). */
  runningCostMicrocents(): number
  /** What to record: the `result` line's usage, else the responses seen. Empty usage is dropped. */
  entries(): TurnUsageEntry[]
}

const price = (model: string, usage: TokenUsage) =>
  estimateCostMicrocents('anthropic', model, usage) ?? 0

const isEmpty = (u: TokenUsage) =>
  !u.inputTokens && !u.outputTokens && !u.cacheReadTokens && !u.cacheWriteTokens

export function createTurnMeter(policyModel: string): TurnMeter {
  const responses = new Map<string, TurnUsageEntry>()
  let final: ClaudeModelUsage[] | null = null
  return {
    observe(mapping) {
      if (mapping.messageUsage) {
        const { id, model, usage } = mapping.messageUsage
        responses.set(id, { model: model ?? policyModel, usage })
      }
      if (mapping.turnUsage) final = mapping.turnUsage
    },
    runningCostMicrocents() {
      let total = 0
      for (const { model, usage } of responses.values()) total += price(model, usage)
      return total
    },
    entries() {
      const chosen: TurnUsageEntry[] =
        final && final.length > 0
          ? final.map(e => ({ model: e.model ?? policyModel, usage: e.usage }))
          : [...responses.values()]
      return chosen.filter(e => !isEmpty(e.usage))
    },
  }
}

/** Record a finished (or stopped) turn's usage, one row per model, as the proxy records a call. */
export async function recordTurnUsage(
  db: Database,
  session: Pick<SessionRow, 'id' | 'tenantId' | 'createdByUserId'>,
  meter: TurnMeter
): Promise<void> {
  for (const entry of meter.entries()) {
    await recordSessionUsage(db, session, entry.model, entry.usage)
  }
}
