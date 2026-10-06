/**
 * Issue #16: Launch cannot read a toml's `[[containers]] max_instances` at run time, so the caps a
 * prebuild request checks (`services/sessions/container-capacity.ts`) are pinned to the tomls here.
 */
import fs from 'node:fs'
import path from 'node:path'
import TOML from '@iarna/toml'
import { describe, expect, it } from 'vitest'
import {
  containerCapFor,
  SANDBOX_HOST_MAX_CONTAINERS,
} from '@/api/services/sessions/container-capacity'
import { loadConfig } from '@/config'
import { createTestEnv } from '../mocks/bindings'

const maxInstances = (file: string) => {
  const doc = TOML.parse(fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8')) as {
    containers?: { max_instances?: number }[]
  }
  return doc.containers?.[0]?.max_instances
}

describe('the container caps a prebuild respects', () => {
  it('SESSION_MAX_CONTAINERS defaults to both deployed tomls’ max_instances', () => {
    const cfg = loadConfig(createTestEnv())
    expect(cfg.SESSION_MAX_CONTAINERS).toBe(maxInstances('wrangler.toml'))
    expect(cfg.SESSION_MAX_CONTAINERS).toBe(maxInstances('wrangler.staging.toml'))
    expect(containerCapFor(cfg, 'local')).toBe(cfg.SESSION_MAX_CONTAINERS)
  })

  it('the remote sandbox host’s cap is its own toml’s', () => {
    expect(SANDBOX_HOST_MAX_CONTAINERS).toBe(maxInstances('wrangler.sandbox-host.toml'))
    expect(containerCapFor(loadConfig(createTestEnv()), 'remote')).toBe(SANDBOX_HOST_MAX_CONTAINERS)
  })

  it('an instance that raises its cap sets the var with it', () => {
    const cfg = loadConfig(createTestEnv({ SESSION_MAX_CONTAINERS: '25' }))
    expect(cfg.SESSION_MAX_CONTAINERS).toBe(25)
  })
})
