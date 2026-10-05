/**
 * `appRlsRoleFor` — the RLS role a Launch-made app's migrations and `db-roles` name, which a
 * session's `dev` must give `session_owner` WITH ADMIN. It is the kit's `APP_ROLE`
 * (`rocketflare_app`) after the kit's rename to the app's slug, so it is checked against the rename
 * itself (`scripts/lib/rename-lib.mjs`, the same translator the kit's `scripts/rename.mjs` runs) —
 * not against a hand-written expectation alone. No database: the `config` project.
 */
import { describe, expect, it } from 'vitest'
import { appRlsRoleFor } from '@/api/services/sessions/db/neon-session-db'
import { applyReplacements, deriveNames } from '../../../../scripts/lib/rename-lib.mjs'

/** The kit's `APP_ROLE` line, as `apps/web/src/db/schema/rls.ts` ships it. */
const KIT_APP_ROLE_LINE = "export const APP_ROLE = 'rocketflare_app'"

describe('appRlsRoleFor', () => {
  it('is `<snake>_app`: hyphens become underscores', () => {
    expect(appRlsRoleFor('hello-world')).toBe('hello_world_app')
    expect(appRlsRoleFor('crm')).toBe('crm_app')
    expect(appRlsRoleFor('a1-b2-c3')).toBe('a1_b2_c3_app')
  })

  it('never answers the kit’s pre-rename role', () => {
    expect(appRlsRoleFor('hello-world')).not.toBe('rocketflare_app')
  })

  it.each(['hello-world', 'crm', 'expense-tracker-v2', 'a', 'x'.repeat(40)])(
    'matches what the kit’s rename makes of APP_ROLE for %s',
    slug => {
      const { text } = applyReplacements(KIT_APP_ROLE_LINE, deriveNames(slug))
      expect(text).toBe(`export const APP_ROLE = '${appRlsRoleFor(slug)}'`)
    }
  )

  it('refuses what is no slug, rather than quoting it into SQL', () => {
    expect(() => appRlsRoleFor('Bad"; DROP ROLE x; --')).toThrow(/unexpected identifier/)
  })
})
