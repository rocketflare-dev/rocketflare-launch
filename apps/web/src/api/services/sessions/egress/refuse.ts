/**
 * The OpenAI hosts and their error shape (§18.22-B): a refusal in OpenAI's own shape, so a Codex
 * CLI reports it the way it reports the API's. Launch's own sandboxes handle the hosts in
 * `egress/registry.ts` (`CODEX_OUTBOUND_HANDLERS`), the sandbox host's `HostedSessionSandbox` in
 * `src/sandbox-host/egress.ts` — both over `forward-openai.ts`.
 *
 * A LEAF: no database, no config, so the sandbox host Worker can bundle it.
 */

/** The hosts Codex reaches. */
export const OPENAI_EGRESS_HOSTS = ['api.openai.com', 'chatgpt.com', 'auth.openai.com'] as const

/** An error in OpenAI's shape, so the CLI reports it the way it reports the API's. */
export function openAiError(status: number, type: string, message: string): Response {
  return Response.json({ error: { message, type, param: null, code: null } }, { status })
}
