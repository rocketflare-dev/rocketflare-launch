/**
 * Issue #12 (build once): a release's two uploads side by side — each deploy ticket's Worker
 * version id and Launch's artifact digest (`deploy/artifact-digest.ts`) — so the release view
 * says whether Live received the bytes Staging ran (`releaseArtifactSchema`).
 */
import type { ReleaseArtifact } from '@launch/shared/launch-releases'
import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../../../db/client'
import { type AppReleaseRow, deployTickets } from '../../../../db/schema'

type TicketFacts = { cfVersionId: string | null; artifactDigest: string | null }

/** The artifact of one release from its two tickets' facts. Pure. */
export function artifactOf(
  staging: TicketFacts | null | undefined,
  production: TicketFacts | null | undefined
): ReleaseArtifact | null {
  if (!staging && !production) return null
  const stagingDigest = staging?.artifactDigest ?? null
  const productionDigest = production?.artifactDigest ?? null
  return {
    stagingVersionId: staging?.cfVersionId ?? null,
    stagingDigest,
    productionVersionId: production?.cfVersionId ?? null,
    productionDigest,
    matches: stagingDigest && productionDigest ? stagingDigest === productionDigest : null,
  }
}

/** Each release's artifact (by release id), the tickets read in one query. */
export async function releaseArtifacts(
  db: Database,
  tenantId: string,
  rows: readonly Pick<AppReleaseRow, 'id' | 'stagingTicketId' | 'productionTicketId'>[]
): Promise<Map<string, ReleaseArtifact | null>> {
  const ids = [
    ...new Set(
      rows
        .flatMap(r => [r.stagingTicketId, r.productionTicketId])
        .filter((id): id is string => !!id)
    ),
  ]
  const tickets = new Map<string, TicketFacts>()
  if (ids.length > 0) {
    const found = await db
      .select({
        id: deployTickets.id,
        cfVersionId: deployTickets.cfVersionId,
        artifactDigest: deployTickets.artifactDigest,
      })
      .from(deployTickets)
      .where(and(eq(deployTickets.tenantId, tenantId), inArray(deployTickets.id, ids)))
    for (const t of found) tickets.set(t.id, t)
  }
  const out = new Map<string, ReleaseArtifact | null>()
  for (const r of rows) {
    out.set(
      r.id,
      artifactOf(
        r.stagingTicketId ? tickets.get(r.stagingTicketId) : null,
        r.productionTicketId ? tickets.get(r.productionTicketId) : null
      )
    )
  }
  return out
}
