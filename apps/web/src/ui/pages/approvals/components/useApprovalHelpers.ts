/**
 * Two small hooks the approval surfaces share:
 *
 * - `useGroupNames()` — id → name for the groups this reader may see: every group for `manage
 *   Group` (admins), their own groups otherwise (`/api/groups/mine`, the only list a member may
 *   read). A group the reader cannot see is counted in words ("members of one team") rather than
 *   fetched — the approvers sentence never needs a request the reader would be refused.
 * - `useExpiry(expiresAt)` — re-read the clock at the rate `expiryState` chooses: a second under
 *   an hour, a minute under a day, and NO timer beyond (ui.md: a naive one-second countdown on a
 *   seven-day deadline is ~600 000 re-renders of a panel nobody is watching).
 */
import { useEffect, useMemo, useState } from 'react'
import { useGroups, useMyGroups } from '@/ui/hooks/useGroups'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { expiryState } from '@/ui/pages/agents/run/interrupts/expiry'

export function useGroupNames(): ReadonlyMap<string, string> {
  const { can } = usePermissions()
  const all = useGroups(undefined, can('manage', 'Group'))
  const mine = useMyGroups()
  return useMemo(() => {
    const names = new Map<string, string>()
    for (const group of mine.data?.items ?? []) names.set(group.id, group.name)
    for (const group of all.data?.items ?? []) names.set(group.id, group.name)
    return names
  }, [all.data, mine.data])
}

export function useExpiry(expiresAt: Date | null) {
  const [now, setNow] = useState(() => new Date())
  const state = useMemo(() => expiryState(expiresAt, now), [expiresAt, now])
  const tickMs = state?.tickMs ?? null
  useEffect(() => {
    if (tickMs === null) return
    const timer = setInterval(() => setNow(new Date()), tickMs)
    return () => clearInterval(timer)
  }, [tickMs])
  return state
}
