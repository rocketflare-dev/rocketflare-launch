/**
 * `launch releases ls|create|promote [--wait]` — cut an app's release and promote it to production
 * (Launch P4, plan §4f), over `/api/apps/:id/releases` and `@launch/shared/launch-releases`.
 *
 * Slice 4f owns this file. `cli.ts` calls `registerReleasesCommands(program, action)` once, after the kit's own
 * commands, so the slice adds its `program.command(...)` entries here and never edits `cli.ts`
 * (the plugin `register` shape, `plugins/types.ts`). From 4a it registers nothing.
 */
import type { Command } from 'commander'
import type { ActionWrapper } from '../plugins/types'

export function registerReleasesCommands(_program: Command, _action: ActionWrapper): void {}
