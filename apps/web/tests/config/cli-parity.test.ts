/**
 * CLI parity (issue #6): everything the app can do or show through `/api`, an agent can do or see
 * with `launch`. Every route the Hono app mounts under `/api` (the plugins' included) must either be
 * CALLED by a CLI command or be listed in `cli-parity-exclusions.ts` with a reason. A new route with
 * neither fails here, by name.
 *
 * "Called" is read from the CLI's source: every path literal in `apps/cli/src` — a quoted string or
 * a template whose `${…}` parts become `:param` — after inlining the one-line path helpers
 * (`const sessionPath = (id) => \`/api/sessions/${…}\``), compared with the route's pattern. So a
 * command must name its path where it calls it (directly, or through such a helper); a path built
 * at run time out of variables is invisible to this test, and should not be. The extraction lives
 * in `cli-parity-lib.ts`, shared with the API catalog (`api-catalog-lib.ts`).
 */
import { describe, expect, it } from 'vitest'
import { CLI_PARITY_EXCLUSIONS, CLI_PARITY_PREFIX_EXCLUSIONS } from './cli-parity-exclusions'
import { callShape, cliCalls, excluded, inScope, serverRoutes } from './cli-parity-lib'

describe('CLI parity with the API (issue #6)', () => {
  const routes = serverRoutes().filter(inScope)
  const called = cliCalls()

  it('reads a non-trivial route table', () => {
    expect(routes.length).toBeGreaterThan(100)
  })

  it('every /api route has a CLI command or a recorded exclusion', () => {
    const missing = routes.filter(r => !called.has(callShape(r)) && !excluded(r))
    expect(
      missing,
      `These routes have no \`launch\` command and no entry in tests/config/cli-parity-exclusions.ts.\nAdd a command in apps/cli/src/commands/ (name the path literally where you call it), or an exclusion with a one-line reason:\n  ${missing.join('\n  ')}`
    ).toEqual([])
  })

  it('every exclusion names a route that still exists and gives a reason', () => {
    const all = new Set(serverRoutes())
    const stale = Object.keys(CLI_PARITY_EXCLUSIONS).filter(r => !all.has(r))
    expect(stale, 'stale exclusions — the route is gone; delete the entry').toEqual([])
    for (const [route, reason] of Object.entries(CLI_PARITY_EXCLUSIONS)) {
      expect(reason.trim().length, `${route} needs a reason`).toBeGreaterThan(10)
    }
    for (const { prefix, reason } of CLI_PARITY_PREFIX_EXCLUSIONS) {
      expect(
        [...all].some(r => (r.split(' ')[1] as string).startsWith(prefix)),
        `prefix ${prefix} matches no route`
      ).toBe(true)
      expect(reason.trim().length).toBeGreaterThan(10)
    }
  })

  it('an exclusion is not also covered — drop it once the CLI calls the route', () => {
    const covered = Object.keys(CLI_PARITY_EXCLUSIONS).filter(r => called.has(callShape(r)))
    expect(
      covered,
      'these excluded routes are called by the CLI now; delete the exclusion'
    ).toEqual([])
  })
})
