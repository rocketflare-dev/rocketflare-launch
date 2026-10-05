import { FIRST_REPLY_QUIET_MS, type OpenTurn } from '../sessionChatModel'
import { useElapsed } from './useElapsed'

/**
 * A quiet line once the open turn has said nothing for `FIRST_REPLY_QUIET_MS`: the agent is
 * waiting on its first model reply (a long resumed conversation whose prompt cache expired can
 * take minutes), not stuck. Gone with the turn's first output.
 */
export function FirstReplyWait({
  agent,
  turn,
  className = '',
}: {
  agent: string
  turn: OpenTurn
  className?: string
}) {
  const elapsed = useElapsed(turn.at)
  if (turn.firstOutputAt || elapsed < FIRST_REPLY_QUIET_MS) return null
  return (
    <p className={`text-xs text-muted ${className}`.trim()} data-testid="first-reply-wait">
      Waiting for {agent}’s first reply
    </p>
  )
}
