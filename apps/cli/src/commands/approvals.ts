/**
 * `launch approvals ls|show|approve|reject` — the approvals inbox from a terminal (Launch P4, plan
 * §4f), over the `/api/approvals` routes and `@launch/shared/launch-approvals`.
 *
 * Slice 4f owns this file. `cli.ts` calls `registerApprovalsCommands(program, action)` once, after the kit's own
 * commands, so the slice adds its `program.command(...)` entries here and never edits `cli.ts`
 * (the plugin `register` shape, `plugins/types.ts`). From 4a it registers nothing.
 */
import type { Command } from 'commander'
import type { ActionWrapper } from '../plugins/types'

export function registerApprovalsCommands(_program: Command, _action: ActionWrapper): void {}
