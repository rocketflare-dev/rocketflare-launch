/**
 * Metering a turn from the CLI's own output — the `host` egress mode (`egress/host.ts`), where
 * the sandbox host's handlers key the requests but cannot reach Launch's database to meter them.
 * Same ledger as the proxies: the same pricing (`@launch/shared/ai/pricing`, under the runtime's
 * provider) and the same write (`recordSessionUsage`: one `ai_usage` row and the session's running
 * totals in ONE transaction, feature `session`).
 *
 * - **While the turn runs**: every Claude Code `assistant` line carries its response's usage
 *   (repeated on each content block of the same response — kept per response id, last value
 *   wins). Their priced sum is the turn's RUNNING cost, which `turn.ts` compares with the budget
 *   headroom it read at the start (`budgetHeadroom`) and kills the process when it is reached.
 *   Codex reports nothing per response, so its running cost stays 0 until the turn ends.
 * - **When it ends**: the turn's usage per model (`turnUsage`: Claude Code's `result` line's
 *   `modelUsage`, which includes its background calls, else its plain `usage` under the policy's
 *   model; Codex's `turn.completed`, measured against the thread's last total) is recorded — and,
 *   for a turn that never reported one (killed, crashed), what the running sum saw, so a stopped
 *   turn is still paid for.
 * - **A personal account** (`billing: 'subscription'`): the same rows with a null cost and the
 *   session's money total unmoved, as the proxies record it — and no budget to watch.
 */
import type { TokenUsage } from '@launch/shared/ai/chat'
import type { AiProvider } from '@launch/shared/ai/config'
import { estimateCostMicrocents } from '@launch/shared/ai/pricing'
import type { AiUsageBilling } from '@launch/shared/ai/usage'
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
  /** What to record: the turn's own usage, else the responses seen. Empty usage is dropped. */
  entries(): TurnUsageEntry[]
  /** Whose API the turn spent (`ai_usage.provider`). */
  readonly provider: AiProvider
  /** `metered` (Launch paid) or `subscription` (a person's own account). */
  readonly billing: AiUsageBilling
}

export interface TurnMeterOptions {
  /** The runtime's provider. Default: `anthropic` (Claude Code). */
  provider?: AiProvider
  /** Default: `metered`. */
  billing?: AiUsageBilling
}

const isEmpty = (u: TokenUsage) =>
  !u.inputTokens && !u.outputTokens && !u.cacheReadTokens && !u.cacheWriteTokens

export function createTurnMeter(policyModel: string, opts: TurnMeterOptions = {}): TurnMeter {
  const provider = opts.provider ?? 'anthropic'
  const billing = opts.billing ?? 'metered'
  const price = (model: string, usage: TokenUsage) =>
    billing === 'subscription' ? 0 : (estimateCostMicrocents(provider, model, usage) ?? 0)
  const responses = new Map<string, TurnUsageEntry>()
  let final: ClaudeModelUsage[] | null = null
  return {
    provider,
    billing,
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
    await recordSessionUsage(db, session, entry.model, entry.usage, {
      provider: meter.provider,
      billing: meter.billing,
    })
  }
}
