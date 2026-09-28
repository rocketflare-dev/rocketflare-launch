/**
 * `launch shared ls|show|set <slug> --env|pushes <slug> [--wait]` — shared config from the
 * terminal (Launch P5, plan §4 5f), over `/api/shared-resources` and `@launch/shared/launch-grants`.
 * `set` reads values from a hidden TTY prompt or stdin — never argv, where they would land in the
 * shell history — and nothing ever prints one back.
 *
 * Slice 5f owns this file. `cli.ts` calls `registerSharedCommands(program, action)` once, after the
 * kit's own commands, so the slice adds its `program.command(...)` entries here and never edits
 * `cli.ts` (the plugin `register` shape, `plugins/types.ts`). From 5a it registers nothing.
 */
import type { Command } from 'commander'
import type { ActionWrapper } from '../plugins/types'

export function registerSharedCommands(_program: Command, _action: ActionWrapper): void {}
