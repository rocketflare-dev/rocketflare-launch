/**
 * Claude's sign-in body (§18.22-A): Anthropic's own page in a new tab, then the code it shows
 * pasted back here. **Stream A owns this file** (its states, copy and the policy note); until then
 * it is the generic body with Claude's name on it.
 */
import { GenericLogin } from './GenericLogin'
import type { AgentLoginBodyProps } from './registry'

export function ClaudeLogin(props: AgentLoginBodyProps) {
  return <GenericLogin {...props} providerName="Anthropic" />
}
