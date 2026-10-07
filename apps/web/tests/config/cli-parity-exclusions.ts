/**
 * Routes the `launch` CLI deliberately does not call (issue #6), each with the reason. Read by
 * `cli-parity.test.ts`: a route listed here that the CLI starts calling, or that no longer exists,
 * fails that test too — so this list only ever holds real, current decisions.
 *
 * A reason is one of: browser-only (a redirect, a WebSocket/SSE stream the CLI reads as rows, a
 * paste/drop upload, an image), machine-to-machine (webhooks, the deployer's `/ci`), a duplicate of a
 * route the CLI already reads, or a decision that has no honest one-line terminal form.
 */
export const CLI_PARITY_EXCLUSIONS: Record<string, string> = {
  'GET /api/sessions/:id/agui/stream':
    'SSE for the browser; the CLI reads the same durable rows through GET /api/sessions/:id/events (sessions logs --follow)',
  'GET /api/agents/runs/:id/agui/stream':
    'SSE for the browser; the CLI polls the same projection through GET /api/agents/runs/:id/agui (agents logs --follow)',
  'POST /api/agui/run':
    'the AG-UI protocol endpoint for third-party AG-UI clients; the CLI talks to chat through /api/chat/conversations',
  'POST /api/github/webhook':
    'machine-to-machine: GitHub delivers here, signed with the webhook secret',
  'POST /api/admin/tenants/:id/support/enter':
    'support mode pins a BROWSER session to a tenant; an admin key has no session (400 support_needs_session)',
  'POST /api/admin/tenants/:id/support/leave':
    'support mode pins a BROWSER session to a tenant; an admin key has no session (400 support_needs_session)',
  'POST /api/app-access/:app/requests/:id/decide':
    'retired (410): access requests are decided as approvals — `launch approvals approve|reject`',
  'POST /api/access-requests':
    'for a signed-in person with NO organisation; a CLI key always belongs to one, so it cannot ask',
  'DELETE /api/tenant':
    'deleting the organisation is irreversible and owner-only; the web makes the owner retype its slug — kept off the terminal on purpose',
  'POST /api/tenants':
    'creating another organisation is a multi-tenant signup step (off in single mode); a CLI key is minted inside one',
  'GET /api/invite/:token':
    'browser-only: the invitation link a person opens from their email, before they have any key',
  'POST /api/invite/:token/accept':
    'browser-only: accepting an invitation signs a new person in; a CLI key cannot exist before it',
}

/** Whole subtrees, by path prefix. */
export const CLI_PARITY_PREFIX_EXCLUSIONS: ReadonlyArray<{ prefix: string; reason: string }> = []
