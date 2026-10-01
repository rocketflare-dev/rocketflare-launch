/**
 * The status check Launch's `launch` ruleset requires and a landing waits on
 * (`docs/plans/i5-ship-to-staging.md` §0.5, §1.13): `KIT_REQUIRED_CHECK` must be the NAME GitHub
 * reports for the kit's CI job — a check run is named after the job's `name:`, not its key — or
 * every merge waits for a check that never reports and the ruleset blocks every PR.
 *
 * `tests/fixtures/kit-ci/0.16.0-ci.yml` is the kit's `.github/workflows/ci.yml` at
 * `SHIP_GATE_KIT_VERSION`, verbatim. A kit release that renames the job changes the fixture, this
 * constant and every existing app's ruleset together (Apply on the app page rewrites it).
 */
import { readFileSync } from 'node:fs'
import { KIT_REQUIRED_CHECK } from '@launch/shared/launch-apps'
import { describe, expect, it } from 'vitest'
import { SHIP_GATE_KIT_VERSION } from '@/api/services/sessions/gate'

const ciYml = readFileSync(
  new URL(`../fixtures/kit-ci/${SHIP_GATE_KIT_VERSION}-ci.yml`, import.meta.url),
  'utf8'
)

/**
 * `jobs.<key>.name` for every job — a line-level read of the one shape the kit writes (two-space
 * job keys under `jobs:`, a four-space `name:`), so the fixture needs no YAML dependency. A job
 * with no `name:` is reported under its key, as GitHub does.
 */
function jobNames(yml: string): Record<string, string> {
  const out: Record<string, string> = {}
  let inJobs = false
  let current: string | null = null
  for (const raw of yml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '')
    if (/^\S/.test(line)) {
      inJobs = line.startsWith('jobs:')
      current = null
      continue
    }
    if (!inJobs) continue
    const job = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (job?.[1]) {
      current = job[1]
      out[current] = current
      continue
    }
    const name = line.match(/^ {4}name:\s*['"]?([^'"]+?)['"]?\s*$/)
    if (current && name?.[1]) out[current] = name[1]
  }
  return out
}

describe('KIT_REQUIRED_CHECK', () => {
  it('is Gate', () => {
    expect(KIT_REQUIRED_CHECK).toBe('Gate')
  })

  it("is the name of the kit's CI job `gate` (the check run GitHub reports)", () => {
    const names = jobNames(ciYml)
    expect(names.gate).toBe(KIT_REQUIRED_CHECK)
    // ONE job: the ruleset requires one check, and nothing else in the workflow could stand in.
    expect(Object.keys(names)).toEqual(['gate'])
  })

  it('runs on pull requests, so a PR into the default branch reports it', () => {
    expect(ciYml).toMatch(/^on:\n(?: {2}.*\n)*? {2}pull_request:/m)
  })

  it('reads a job name the way GitHub does (the parser is not vacuous)', () => {
    const yml = 'name: CI\njobs:\n  lint:\n    runs-on: x\n  test:\n    name: "Unit tests"\n'
    expect(jobNames(yml)).toEqual({ lint: 'lint', test: 'Unit tests' })
  })
})
