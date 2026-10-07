/**
 * The decision behind `scripts/cli-parity-nudge.mjs` (issue #6): does this Edit / Write / MultiEdit
 * ADD an API route or a UI call site, so the agent should be reminded that the CLI needs a matching
 * command (or an exclusion in `apps/web/tests/config/cli-parity-exclusions.ts`)? Pure — the hook
 * script owns stdin, the once-per-session marker and the output.
 */

/** A route registration: `.get('/x'`, `.post("/x"`, `.on('PUT', '/x'`. */
const ROUTE_RE = /\.(?:get|post|put|patch|delete|on)\(\s*(?:\[[^\]]*\]\s*,\s*)?['"`][^'"`]*['"`]/g
/** A UI call site of the API: a mutation, or the api client hitting a path. */
const UI_CALL_RE = /useMutation\(|\bapi\.(?:get|post|put|patch|delete)\(|apiFetch\(/g

/** `apps/web/src/api/routes/x.ts` or a plugin's `apps/web/src/plugins/<id>/api/routes/x.ts`. */
export function isRouteFile(filePath) {
  return /apps\/web\/src\/(?:api\/routes|plugins\/[^/]+\/api\/routes)\/[^/]+\.ts$/.test(filePath)
}

/** `apps/web/src/ui/hooks/x.ts(x)` or a plugin's `apps/web/src/plugins/<id>/ui/hooks/x.ts(x)`. */
export function isUiHookFile(filePath) {
  return /apps\/web\/src\/(?:ui\/hooks|plugins\/[^/]+\/ui\/hooks)\/[^/]+\.tsx?$/.test(filePath)
}

const count = (text, re) => (text ? (text.match(re) ?? []).length : 0)

/** `[before, after]` text pairs the tool call wrote. Write has no "before": a new file is all added. */
function changes(toolName, input) {
  if (!input) return []
  if (toolName === 'Write') return [['', input.content ?? '']]
  if (toolName === 'Edit') return [[input.old_string ?? '', input.new_string ?? '']]
  if (toolName === 'MultiEdit')
    return (input.edits ?? []).map(e => [e.old_string ?? '', e.new_string ?? ''])
  return []
}

/** The registrations an edit adds, as written (`.post('/:id/retry'`), for the reminder. */
function addedRoutes(pairs) {
  const added = []
  for (const [before, after] of pairs) {
    const was = new Set(before.match(ROUTE_RE) ?? [])
    for (const m of after.match(ROUTE_RE) ?? []) if (!was.has(m)) added.push(m.slice(1))
  }
  return added
}

/**
 * `{ kind: 'route' | 'ui', file, routes }` when the call adds something the CLI should be able to
 * do, else null. A Write of an existing route file counts every registration in it — the hook
 * cannot see the old content, and a reminder on a rewrite is cheap.
 */
export function parityChange(payload) {
  const toolName = payload?.tool_name
  const input = payload?.tool_input
  const file = input?.file_path ?? ''
  const pairs = changes(toolName, input)
  if (pairs.length === 0) return null
  if (isRouteFile(file)) {
    const routes = addedRoutes(pairs)
    return routes.length > 0 ? { kind: 'route', file, routes } : null
  }
  if (isUiHookFile(file)) {
    const grew = pairs.some(
      ([before, after]) => count(after, UI_CALL_RE) > count(before, UI_CALL_RE)
    )
    return grew ? { kind: 'ui', file, routes: [] } : null
  }
  return null
}

/** What Claude reads. */
export function parityReminder(change) {
  const what =
    change.kind === 'route'
      ? `You added API route(s) in ${change.file}: ${change.routes.join(', ')}.`
      : `You added a UI call site (a mutation or an api call) in ${change.file}.`
  return [
    `${what} Launch keeps the CLI level with the UI (issue #6): anything a user can do or see in the app, an agent must be able to do or see with \`launch\`.`,
    '- Add or extend the matching command in `apps/cli/src/commands/` (parse with the same `@launch/shared` schema, `--json` on reads, tests in `apps/cli/tests/`), and document it in `.claude/rules/cli.md`, `docs/CONCEPTS.md` §11 and the `launch-cli` skill;',
    '- or, when a terminal genuinely cannot use it (browser-only: WebSocket, OAuth redirect, paste/drop upload, the preview bridge; or machine-to-machine: webhooks, `/ci`), add the route to `apps/web/tests/config/cli-parity-exclusions.ts` with a one-line reason.',
    "- For a route: put a one-line `/** … */` summary directly above the registration and validate its body/query with an exported `@launch/shared` schema, then run `pnpm api:catalog` and commit `apps/cli/src/generated/api-catalog.json` + `api-schemas.ts` (what `launch api ls|show|schema` reads and `launch api call` validates with). A body read without `validate('json', …)` fails unless it is multipart or listed in `api-catalog-manual-bodies.ts`.",
    '`apps/web/tests/config/cli-parity.test.ts` fails the gate on a route that has neither, and `api-catalog.test.ts` on a stale catalog, a route with no summary, a schema that is not an `@launch/shared` export, or an unvalidated body. (Reminded once per session.)',
  ].join('\n')
}

export function hookJson(message, notice) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    systemMessage: notice ?? message.split('\n')[0],
  })
}
