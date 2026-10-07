/**
 * Release = root version (CLAUDE.md): one tag ships apps/web and the CLI, and the CLI published to
 * npm as `@rocketflare-dev/launch` (`scripts/publish-cli.mjs`) prints `apps/cli/package.json`'s
 * version for `--version`. The two must move together, or a tag would publish a CLI that names
 * another release.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../..')
const versionOf = (file: string) =>
  (JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as { version: string }).version

describe('the CLI version', () => {
  it('equals the root version (bump them together)', () => {
    expect(versionOf('apps/cli/package.json')).toBe(versionOf('package.json'))
  })
})
