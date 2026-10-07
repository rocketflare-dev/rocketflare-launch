/**
 * `scripts/lib/cli-parity-nudge.mjs` — the PostToolUse hook's decision (issue #6): an edit that ADDS
 * an API route or a UI call site gets the CLI-parity reminder; anything else stays silent.
 */
import { describe, expect, it } from 'vitest'
import {
  hookJson,
  parityChange,
  parityReminder,
} from '../../../../scripts/lib/cli-parity-nudge.mjs'

const ROUTE_FILE = '/repo/apps/web/src/api/routes/sessions.ts'
const HOOK_FILE = '/repo/apps/web/src/ui/hooks/useSessions.ts'

describe('parityChange', () => {
  it('flags an Edit that adds a route registration', () => {
    const change = parityChange({
      tool_name: 'Edit',
      tool_input: {
        file_path: ROUTE_FILE,
        old_string: "router.get('/:id', h)",
        new_string: "router.get('/:id', h)\nrouter.post('/:id/retry', h)",
      },
    })
    expect(change).toEqual({ kind: 'route', file: ROUTE_FILE, routes: ["post('/:id/retry'"] })
  })

  it('ignores an Edit that only changes a handler body', () => {
    expect(
      parityChange({
        tool_name: 'Edit',
        tool_input: {
          file_path: ROUTE_FILE,
          old_string: "router.get('/:id', async c => a)",
          new_string: "router.get('/:id', async c => b)",
        },
      })
    ).toBeNull()
  })

  it('flags a plugin route file and a MultiEdit', () => {
    const change = parityChange({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: '/repo/apps/web/src/plugins/analytics/api/routes/pages.ts',
        edits: [{ old_string: 'x', new_string: "app.delete('/pages/:id', h)" }],
      },
    })
    expect(change?.kind).toBe('route')
  })

  it('flags a UI hook that gains a mutation, not one that is only reworded', () => {
    expect(
      parityChange({
        tool_name: 'Edit',
        tool_input: {
          file_path: HOOK_FILE,
          old_string: 'const a = 1',
          new_string: "useMutation({ mutationFn: () => api.post('/api/x') })",
        },
      })?.kind
    ).toBe('ui')
    expect(
      parityChange({
        tool_name: 'Edit',
        tool_input: {
          file_path: HOOK_FILE,
          old_string: "api.get('/api/a')",
          new_string: "api.get('/api/b')",
        },
      })
    ).toBeNull()
  })

  it('stays silent outside the route and hook directories, and on other tools', () => {
    expect(
      parityChange({
        tool_name: 'Write',
        tool_input: { file_path: '/repo/apps/web/src/api/services/x.ts', content: "r.get('/x')" },
      })
    ).toBeNull()
    expect(parityChange({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeNull()
    expect(parityChange(undefined)).toBeNull()
  })
})

describe('the reminder', () => {
  it('names the routes, the exclusion file and the gate test, as PostToolUse context', () => {
    const message = parityReminder({ kind: 'route', file: ROUTE_FILE, routes: ["post('/x'"] })
    expect(message).toContain("post('/x'")
    expect(message).toContain('cli-parity-exclusions.ts')
    expect(message).toContain('cli-parity.test.ts')
    const json = JSON.parse(hookJson(message))
    expect(json.hookSpecificOutput.hookEventName).toBe('PostToolUse')
  })
})
