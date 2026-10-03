/**
 * Cloudflare Worker entry (D5): `export default { fetch, queue, scheduled }` plus the in-script
 * Durable Object classes (`NotificationsHub`, D8; Launch P3's `SessionSandbox`, the coding
 * session's container, with the Sandbox SDK's `ContainerProxy` its outbound handlers run through)
 * and the Workflow classes (`AgentRunWorkflow`, D7; Launch P2's `AppLaunchWorkflow` and
 * `AppTeardownWorkflow`; P3's `SessionWorkflow`; P5's `GrantPushWorkflow`; §18.22's
 * `AgentLoginWorkflow`, the relayed sign-in for a personal AI account).
 * The classes are exported HERE — never from api/index.ts, which must stay importable from Node
 * tests.
 *
 * `fetch` looks at the HOST first (Launch P3, plan §1.6): a session preview host
 * (`<port>-<shortId>-<token>.<preview domain>`, `SESSION_PREVIEW_URL`) goes to the preview gateway
 * and never reaches the Hono app, so none of its middleware — `X-Frame-Options: DENY` above all —
 * touches a page Launch frames. Everything else is `app.fetch`, as before.
 *
 * The third export line is the plugin seam (D31): Cloudflare resolves a binding's `class_name`
 * against the named exports of THIS module and nowhere else, so a plugin that ships a DO or a
 * Workflow needs a line here. That line is permanent and names no plugin —
 * `plugins/worker-exports.ts` is the sixth barrel, one `export *` per installed plugin, written by
 * `pnpm plugin add` and deleted by `pnpm plugin remove`. Nothing about installing a plugin edits
 * this file.
 */
import { app } from './api/index'
import { handlePreview, previewHostOf } from './api/preview/gateway'
import { queue } from './api/queue'
import { scheduled } from './api/scheduled'
import type { AppBindings } from './api/types'

export { NotificationsHub } from './api/durable-objects/notifications-hub'
export { ContainerProxy, SessionSandbox } from './api/durable-objects/session-sandbox'
export { AgentLoginWorkflow } from './api/workflows/agent-login'
export { AgentRunWorkflow } from './api/workflows/agent-run'
export { AppLaunchWorkflow } from './api/workflows/app-launch'
export { AppTeardownWorkflow } from './api/workflows/app-teardown'
export { GrantPushWorkflow } from './api/workflows/grant-push'
export { SessionWorkflow } from './api/workflows/session'
export * from './plugins/worker-exports'

export default {
  fetch(request, env, ctx) {
    const preview = previewHostOf(request, env)
    if (preview) return handlePreview(request, env, ctx, preview)
    return app.fetch(request, env, ctx)
  },
  queue,
  scheduled,
} satisfies ExportedHandler<AppBindings>
