/**
 * The Rocketflare adapter's `declaredConfig` (spec/02, Launch P5 plan §1.14, §4 5e): what an app
 * says it needs, read-only from files the kit already writes —
 *
 * `launch.plugins.json` `surfaces[]` → each `anchor` (`plugin.json`) → `vars[]`, parsed the way
 * `scripts/lib/plugin-lib.mjs` validates them (`{ key | name, example?, secret? }` or a bare
 * string), plus the kit's own optional secrets (`ANTHROPIC_API_KEY`, `LANGFUSE_*`, …) filed under
 * `KIT_CONFIG_PLUGIN_ID`. A missing or unreadable anchor is skipped, never thrown.
 *
 * `read(path)` answers a repo file's text at the scanned ref, or null when it is absent — the
 * caller (`grants/detect.ts`) binds it to GitHub, a test to a fixture map.
 *
 * **Slice 5e owns this file** (and the `declaredConfig` row in `adapter.ts`'s table). From 5a it
 * throws `NotWiredError`.
 */
import type { DeclaredConfigItem } from '@launch/shared/launch-grants'
import { NotWiredError } from '../../grants/types'

export type RepoFileReader = (path: string) => Promise<string | null>

export async function declaredConfig(_read: RepoFileReader): Promise<DeclaredConfigItem[]> {
  throw new NotWiredError('rocketflare/declared-config.declaredConfig', '5e')
}
