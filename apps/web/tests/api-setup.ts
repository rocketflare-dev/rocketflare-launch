/**
 * Per-FILE teardown for the api projects (`tests/setup.ts` is the per-RUN one): end every
 * pooled script handle so a fork's connection count does not climb file after file
 * (`53300 too many clients` is what that looks like). Handles are rebuilt on demand.
 *
 * It also gives Node workerd's `HTMLRewriter`, which the preview gateway's bridge injection uses
 * (`tests/mocks/html-rewriter.ts`).
 */
import { afterAll } from 'vitest'
import { closeAllDatabases } from '@/db/client'
import { installFakeHTMLRewriter } from './mocks/html-rewriter'

installFakeHTMLRewriter()

afterAll(async () => {
  await closeAllDatabases()
})
