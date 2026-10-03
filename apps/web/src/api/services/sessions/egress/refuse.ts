/**
 * The OpenAI hosts and their refusal (§18.22-B): a 403 in OpenAI's own error shape, so a Codex CLI
 * reports it the way it reports the API's. Launch's own sandboxes handle the hosts for real
 * (`egress/registry.ts`, `CODEX_OUTBOUND_HANDLERS`); the sandbox host's `host` mode runs Claude Code
 * only, so its `HostedSessionSandbox` answers them with this refusal — the hosts are on the shared
 * allow-list (`SESSION_BASE_ALLOWED_HOSTS`), and a host on it with no handler would pass straight
 * through.
 *
 * A LEAF: no database, no config, so the sandbox host Worker can bundle it.
 */

/** The hosts Codex reaches. */
export const OPENAI_EGRESS_HOSTS = ['api.openai.com', 'chatgpt.com', 'auth.openai.com'] as const

/** An error in OpenAI's shape, so the CLI reports it the way it reports the API's. */
export function openAiError(status: number, type: string, message: string): Response {
  return Response.json({ error: { message, type, param: null, code: null } }, { status })
}

/** The handler for one refused host. */
export function refuseHost(host: string): (req: Request) => Promise<Response> {
  return async () =>
    openAiError(403, 'permission_error', `This Launch sandbox may not reach ${host}`)
}
