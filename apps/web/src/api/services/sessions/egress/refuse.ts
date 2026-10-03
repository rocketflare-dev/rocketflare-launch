/**
 * The OpenAI hosts' refusal (§18.22-B): a 403 in OpenAI's own error shape, so a Codex CLI reports
 * it the way it reports the API's. Staged in `egress/registry.ts` (`CODEX_OUTBOUND_HANDLERS`);
 * Stream B registers the hosts with their real handlers and keeps this for whatever it does not
 * wire (and for the sandbox host, whose `host` mode runs Claude Code only — a host on its
 * allow-list with no handler would pass straight through).
 *
 * A LEAF: no database, no config, so the sandbox host Worker can bundle it.
 */

/** The hosts Codex reaches, refused until Stream B wires them. */
export const OPENAI_EGRESS_HOSTS = ['api.openai.com', 'chatgpt.com', 'auth.openai.com'] as const

/** An error in OpenAI's shape, so the CLI reports it the way it reports the API's. */
export function openAiError(status: number, type: string, message: string): Response {
  return Response.json({ error: { message, type, param: null, code: null } }, { status })
}

/** The handler for one refused host. */
export function refuseHost(host: string): (req: Request) => Promise<Response> {
  return async () =>
    openAiError(403, 'permission_error', `Launch sessions may not reach ${host} yet`)
}
