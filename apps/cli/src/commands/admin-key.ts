/**
 * `/api/admin/*` and `/api/platform/*` take the browser cookie or an ADMIN-scoped API key
 * (`launch login --admin`); an ordinary CLI key is 403 `admin_key_required` there. Every command on
 * those routes runs through `withAdminKey`, which keeps the exit code (401 → 2, 403 → 3) and adds
 * the hint to log in with `--admin`.
 */
import { CliApiError } from '../api'
import type { CommandContext } from '../context'

/** The 403 code the server sends a tenant-scoped key on `/api/admin/*` and `/api/platform/*`. */
const ADMIN_KEY_REQUIRED = 'admin_key_required'

/** Run `work`; a 401/403 keeps its exit code and gains the "log in with --admin" hint. */
export async function withAdminKey<T>(ctx: CommandContext, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (!(error instanceof CliApiError) || (error.status !== 401 && error.status !== 403)) {
      throw error
    }
    const hint =
      error.status === 401
        ? `Your key is missing or expired — admin keys last 30 days: ${ctx.binName} login --admin`
        : error.code === ADMIN_KEY_REQUIRED
          ? `this needs an admin key: ${ctx.binName} login --admin`
          : `this needs an admin key: ${ctx.binName} login --admin (and an account that is still a platform administrator)`
    throw new CliApiError({
      status: error.status,
      message: error.message,
      code: error.code,
      body: error.body,
      hint,
      cause: error,
    })
  }
}
