/**
 * `launch audit export --format csv|json --out <file>` and `launch audit verify` — the hash-chained
 * audit log (Launch P4, plan §4e), over `/api/audit/{export,verify}` and
 * `@launch/shared/launch-audit`.
 *
 * Slice 4e owns this file. `cli.ts` calls `registerAuditCommands(program, action)` once, after the kit's own
 * commands, so the slice adds its `program.command(...)` entries here and never edits `cli.ts`
 * (the plugin `register` shape, `plugins/types.ts`). From 4a it registers nothing.
 */
import type { Command } from 'commander'
import type { ActionWrapper } from '../plugins/types'

export function registerAuditCommands(_program: Command, _action: ActionWrapper): void {}
