/**
 * `launch logout [--all]` — drop the selected server's API key, tenant and user (every server's
 * with `--all`); the server URLs stay (D26).
 */
import { logoutFlow } from '../auth'
import type { CommandContext } from '../context'

export async function runLogout(
  ctx: CommandContext,
  options: { all?: boolean } = {}
): Promise<void> {
  const profiles = options.all
    ? Object.keys((await ctx.store.load()).profiles)
    : ctx.config.profile
      ? [ctx.config.profile]
      : []
  if (!options.all && !ctx.config.profile) {
    ctx.log.info(`No stored server at ${ctx.config.serverUrl} — nothing to do`)
    return
  }
  const cleared = await logoutFlow({ store: ctx.store, log: ctx.log, profiles })
  if (ctx.json) ctx.out.data({ loggedOut: cleared }, () => '')
}
