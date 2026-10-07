/**
 * Which component draws each runtime's sign-in modal body (§18.22). One entry per runtime; the
 * streams replace the component FILES (`ClaudeLogin.tsx` — stream A, `CodexLogin.tsx` — stream B),
 * never this table.
 */
import type { AgentLogin, AgentRuntimeId } from '@launch/shared/launch-agents'
import type { ComponentType } from 'react'
import { ClaudeLogin } from './ClaudeLogin'
import { CodexLogin } from './CodexLogin'

export interface AgentLoginBodyProps {
  login: AgentLogin
  /** Paste the provider's code back (a runtime whose login `needsCode`). */
  onSubmitCode: (code: string) => void
  submitting: boolean
  /** Why the last paste was refused, in a sentence. */
  submitError: string | null
}

export const AGENT_LOGIN_BODIES: Record<AgentRuntimeId, ComponentType<AgentLoginBodyProps> | null> =
  {
    claude_code: ClaudeLogin,
    codex: CodexLogin,
    // Pi has no personal account, so no sign-in (rocketflare-launch#14).
    pi: null,
  }
