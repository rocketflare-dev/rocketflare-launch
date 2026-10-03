/**
 * Codex's sign-in body (§18.22-B): OpenAI's device page in a new tab and the code to type there —
 * nothing comes back through Launch. **Stream B owns this file**; until then it is the generic body
 * with OpenAI's name on it.
 */
import { GenericLogin } from './GenericLogin'
import type { AgentLoginBodyProps } from './registry'

export function CodexLogin(props: AgentLoginBodyProps) {
  return <GenericLogin {...props} providerName="OpenAI" />
}
