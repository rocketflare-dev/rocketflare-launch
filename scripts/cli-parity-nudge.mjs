#!/usr/bin/env node
/**
 * A Claude Code `PostToolUse` hook (Edit · Write · MultiEdit, `.claude/settings.json`): when a change
 * adds an API route under `apps/web/src/api/routes/` (or a plugin's) or a UI call site under
 * `src/ui/hooks/`, remind Claude ONCE per session to give the CLI the matching command or record an
 * exclusion (issue #6). The gate's `cli-parity.test.ts` is the hard check; this is the early word.
 *
 * Advisory: writes `additionalContext` and exits 0; never fails the edit on its own error.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { hookJson, parityChange, parityReminder } from './lib/cli-parity-nudge.mjs'

function main() {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return
  }
  const change = parityChange(payload)
  if (!change) return
  const session = String(payload.session_id ?? 'none').replace(/[^\w-]/g, '')
  const marker = path.join(tmpdir(), `launch-cli-parity-nudge-${session}`)
  if (existsSync(marker)) return
  writeFileSync(marker, change.file)
  process.stdout.write(
    hookJson(parityReminder(change), 'CLI parity: this change needs a matching `launch` command.')
  )
}

try {
  main()
} catch {
  // Advisory only.
}
