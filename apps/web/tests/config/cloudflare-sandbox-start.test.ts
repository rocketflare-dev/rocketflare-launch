/**
 * `CloudflareSandbox.start` (Launch P3, fast resume): the container boots BEFORE the runtime
 * allow-list is applied, each attempt is bounded, and an attempt that never answers (seen under
 * `wrangler dev` on a start seconds after a destroy) is followed by a reset and one more attempt.
 * Plus the one ordering the warm suspend depends on: the SDK's own idle sleep outlasts the warm
 * window.
 */
import { describe, expect, it } from 'vitest'
import {
  CloudflareSandbox,
  SESSION_SANDBOX_SLEEP_AFTER,
  START_ATTEMPTS,
} from '@/api/services/sessions/sandbox/cloudflare-sandbox'
import { SESSION_WARM_KEEP_MINUTES, warmMinutesLeft } from '@/api/services/sessions/warm'
import type { AppConfig } from '@/config'
import { FakeSandboxNamespace } from '../mocks/bindings'

function sandboxOver(ns: FakeSandboxNamespace, startAttemptMs = 50): CloudflareSandbox {
  return new CloudflareSandbox(
    ns as unknown as ConstructorParameters<typeof CloudflareSandbox>[0],
    's-start',
    { cfg: {} as AppConfig, startAttemptMs }
  )
}

const methods = (ns: FakeSandboxNamespace) => ns.calls.map(c => c.method)

describe('CloudflareSandbox.start', () => {
  it('boots the container first, then applies the allow-list with the extra hosts', async () => {
    const ns = new FakeSandboxNamespace()
    ns.handlers.exec = () => ({ exitCode: 0, stdout: '', stderr: '' })
    await sandboxOver(ns).start({ extraAllowedHosts: ['ep-x.us-east-2.aws.neon.tech'] })
    expect(methods(ns)).toEqual(['exec', 'setAllowedHosts'])
    expect(ns.calls[1]?.args[0]).toContain('ep-x.us-east-2.aws.neon.tech')
    expect(ns.calls[1]?.args[0]).toContain('registry.npmjs.org')
  })

  it('resets and tries once more when an attempt never answers', async () => {
    const ns = new FakeSandboxNamespace()
    let execs = 0
    ns.handlers.exec = () => {
      execs++
      // The first boot hangs (a stale Durable Object after a destroy); the second answers.
      return execs === 1 ? new Promise(() => {}) : { exitCode: 0, stdout: '', stderr: '' }
    }
    await sandboxOver(ns).start()
    expect(methods(ns)).toEqual(['exec', 'destroy', 'exec', 'setAllowedHosts'])
  })

  it(`gives up after ${START_ATTEMPTS} attempts with a readable error`, async () => {
    const ns = new FakeSandboxNamespace()
    ns.handlers.exec = () => new Promise(() => {})
    await expect(sandboxOver(ns).start()).rejects.toThrow(
      /The session container did not start within/
    )
    expect(methods(ns).filter(m => m === 'exec')).toHaveLength(START_ATTEMPTS)
  })

  it('does not retry a start that failed for another reason', async () => {
    const ns = new FakeSandboxNamespace()
    ns.handlers.exec = () => ({ exitCode: 1, stdout: '', stderr: '' })
    await expect(sandboxOver(ns).start()).rejects.toThrow('The session container did not start')
    expect(methods(ns)).toEqual(['exec'])
  })
})

describe('the warm window', () => {
  it("is shorter than the SDK's own idle sleep, so the Workflow cools a kept container first", () => {
    const sleepMinutes = Number(/^(\d+)m$/.exec(SESSION_SANDBOX_SLEEP_AFTER)?.[1])
    expect(sleepMinutes).toBeGreaterThan(SESSION_WARM_KEEP_MINUTES + 15)
  })

  it('counts down from when the container was kept', () => {
    const now = new Date('2026-09-28T12:00:00Z')
    expect(warmMinutesLeft(null, now)).toBeNull()
    expect(warmMinutesLeft(now, now)).toBe(SESSION_WARM_KEEP_MINUTES)
    expect(warmMinutesLeft(new Date(now.getTime() - 10 * 60_000), now)).toBe(
      SESSION_WARM_KEEP_MINUTES - 10
    )
    expect(warmMinutesLeft(new Date(now.getTime() - 90 * 60_000), now)).toBe(0)
  })
})
