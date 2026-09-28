/**
 * `launch grants needs|ls|request|revoke <app>` — an app's shared config and grants (Launch P5,
 * plan §4 5f), over `/api/apps/:id/{config,grants}` and `@launch/shared/launch-grants`.
 *
 * Slice 5f owns this file. `cli.ts` calls `registerGrantsCommands(program, action)` once, after the
 * kit's own commands, so the slice adds its `program.command(...)` entries here and never edits
 * `cli.ts`. From 5a it registers nothing.
 */
import type { Command } from 'commander'
import type { ActionWrapper } from '../plugins/types'

export function registerGrantsCommands(_program: Command, _action: ActionWrapper): void {}
