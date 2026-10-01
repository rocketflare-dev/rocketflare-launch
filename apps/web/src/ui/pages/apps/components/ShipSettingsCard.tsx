/**
 * The app page's "Shipping" card (issue #5, `docs/plans/i5-ship-to-staging.md` §1.10–§1.13): what
 * happens when somebody presses Ship in a coding session on this app, and whether the repository's
 * main branch is protected the way Launch's merge needs.
 *
 * - **When someone ships**: go live on staging (Launch waits for CI, merges, releases and follows
 *   the staging deploy — the default) or open a pull request for review on GitHub (and stop).
 * - **Review before merging**: nobody, the app's owners, or named teams (the existing groups hooks:
 *   every group for `manage Group`, the reader's own otherwise — what they can name). When an
 *   administrator's approval policy for `session.merge` exists (`shipReviewSetBy === 'policy'`) it
 *   wins, and this half is read-only with that explanation.
 * - Editing is for the app's owners and admins (`viewerCanDeploy`, the route's rule); everyone
 *   else reads the same settings as sentences. The form validates with the server's
 *   `putAppShipSettingsRequestSchema`, and a save refetches the app.
 * - **Branch protection**, for owners and admins: `GET …/branch-protection` → one plain sentence
 *   per state, and for an administrator an Apply button where Launch can fix it (`none`, `blocks`
 *   once the blocking rule is gone). Never polled — GitHub is asked on each read.
 */
import { ShieldCheckIcon, ShieldExclamationIcon } from '@heroicons/react/24/outline'
import type { GroupRef } from '@launch/shared/groups'
import {
  type AppBranchProtection,
  type AppDetail,
  type AppShipSettings,
  KIT_REQUIRED_CHECK,
  putAppShipSettingsRequestSchema,
  type SessionShipMode,
  type ShipReviewMode,
} from '@launch/shared/launch-apps'
import { type ReactNode, useMemo, useState } from 'react'
import { FieldError, SectionPanel } from '@/ui/components/shared'
import {
  useApplyBranchProtection,
  useBranchProtection,
  useUpdateShipSettings,
} from '@/ui/hooks/useApps'
import { useGroups, useMyGroups } from '@/ui/hooks/useGroups'
import { usePermissions } from '@/ui/hooks/usePermissions'

const SHIP_MODE_TEXT: Record<SessionShipMode, { label: string; help: string }> = {
  staging: {
    label: 'Go live on staging',
    help: 'Launch waits for CI to pass, merges the change and puts it live on staging. Production is still a separate step.',
  },
  pr: {
    label: 'Open a pull request for review on GitHub',
    help: 'Launch stops once the pull request is open; somebody merges it on GitHub.',
  },
}

const REVIEW_TEXT: Record<ShipReviewMode, string> = {
  none: 'Nobody — merge as soon as CI passes',
  app_owners: 'One of the app’s owners',
  groups: 'Someone from these teams',
}

/** The settings as one sentence each, for a reader who may not change them. Pure. */
export function shipSettingsSentences(
  settings: AppShipSettings,
  setBy: AppDetail['shipReviewSetBy'],
  groupNames: ReadonlyMap<string, string>
): { ship: string; review: string } {
  const ship =
    settings.sessionShip === 'staging'
      ? 'Shipping a session puts the change live on staging.'
      : 'Shipping a session opens a pull request for review on GitHub.'
  if (setBy === 'policy') {
    return {
      ship,
      review: 'An administrator’s approval policy decides who reviews a change before it merges.',
    }
  }
  if (settings.sessionShip === 'pr') return { ship, review: 'Reviews happen on GitHub.' }
  switch (settings.review.mode) {
    case 'none':
      return { ship, review: 'Nobody has to approve a change before it merges.' }
    case 'app_owners':
      return { ship, review: 'One of the app’s owners approves each change before it merges.' }
    case 'groups': {
      const names = settings.review.groupIds.map(id => groupNames.get(id) ?? 'a team you can’t see')
      return {
        ship,
        review: `Someone from ${names.length ? names.join(', ') : 'the chosen teams'} approves each change before it merges.`,
      }
    }
  }
}

/** One plain sentence per branch-protection state, and whether Apply can help. Pure. */
export function protectionSentence(protection: AppBranchProtection): {
  title: string
  text: string
  tone: 'ok' | 'warning' | 'muted'
  canApply: boolean
} {
  switch (protection.state) {
    case 'ok':
      return {
        title: 'Protected',
        text: `Changes reach the main branch only through a pull request with “${KIT_REQUIRED_CHECK}” passing, and Launch can still merge and release.`,
        tone: 'ok',
        canApply: false,
      }
    case 'none':
      return {
        title: 'Not protected',
        text: 'Anyone with access to the repository can push straight to the main branch, skipping CI. Launch can protect it.',
        tone: 'warning',
        canApply: true,
      }
    case 'blocks':
      return {
        title: 'Another rule is in the way',
        text: 'The main branch has a protection rule that would stop Launch from releasing merged changes. Remove that rule in the repository’s settings on GitHub, then apply Launch’s protection — the steps are in Launch’s deploy guide (DEPLOY.md, existing apps’ branch protection).',
        tone: 'warning',
        canApply: true,
      }
    case 'unavailable':
      return {
        title: 'Not available on this plan',
        text: 'GitHub doesn’t offer branch rules for this repository on its account’s plan, so Launch can’t protect it. Launch still waits for CI before it merges.',
        tone: 'muted',
        canApply: false,
      }
    case 'unknown':
      return {
        title: 'Couldn’t check',
        text: 'Launch couldn’t ask GitHub about this repository just now. Try again later.',
        tone: 'muted',
        canApply: false,
      }
  }
}

/** The groups this reader may name: every group for `manage Group`, their own otherwise. */
function useNameableGroups(enabled: boolean): GroupRef[] {
  const { can } = usePermissions()
  const all = can('manage', 'Group')
  const groups = useGroups(undefined, enabled && all)
  const mine = useMyGroups()
  return useMemo(() => {
    if (all)
      return (groups.data?.items ?? []).map(g => ({ id: g.id, name: g.name, typeName: g.typeName }))
    return mine.data?.items ?? []
  }, [all, groups.data, mine.data])
}

function BranchProtection({ app, canApply }: { app: AppDetail; canApply: boolean }) {
  const protection = useBranchProtection(app.id, app.viewerCanDeploy)
  const apply = useApplyBranchProtection(app.id)
  if (!app.viewerCanDeploy) return null

  let body: ReactNode
  if (protection.isLoading) {
    body = <p className="text-sm text-muted">Checking the main branch on GitHub…</p>
  } else if (!protection.data) {
    body = (
      <p className="text-sm text-muted" data-testid="protection-state" data-state="error">
        Launch couldn’t check the main branch’s protection.
      </p>
    )
  } else {
    const said = protectionSentence(protection.data)
    const Icon = said.tone === 'ok' ? ShieldCheckIcon : ShieldExclamationIcon
    const iconClass =
      said.tone === 'ok' ? 'text-success' : said.tone === 'warning' ? 'text-warning' : 'text-muted'
    body = (
      <div className="flex items-start gap-2" data-testid="protection-state">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${iconClass}`} aria-hidden="true" />
        <div className="min-w-0 space-y-1 text-sm">
          <p className="font-medium" data-state={protection.data.state}>
            {said.title}
          </p>
          <p className="text-secondary">{said.text}</p>
          {protection.data.detail && protection.data.state !== 'ok' && (
            <p className="text-xs text-muted">{protection.data.detail}</p>
          )}
          {said.canApply &&
            (canApply ? (
              <button
                type="button"
                className="btn btn-sm mt-1"
                disabled={apply.isPending}
                onClick={() => apply.mutate()}
              >
                {apply.isPending && <span className="loading loading-spinner loading-xs" />}
                Apply Launch’s protection
              </button>
            ) : (
              <p className="text-xs text-muted">An administrator can apply Launch’s protection.</p>
            ))}
        </div>
      </div>
    )
  }

  return (
    <div className="border-t border-[color:var(--border-subtle)] pt-3">
      <h3 className="mb-2 text-sm font-semibold">Main branch protection</h3>
      {body}
    </div>
  )
}

export function ShipSettingsCard({
  app,
  canApplyProtection,
}: {
  app: AppDetail
  /** Applying the ruleset is for administrators (`manage App`). */
  canApplyProtection: boolean
}) {
  const canEdit = app.viewerCanDeploy
  const policy = app.shipReviewSetBy === 'policy'
  const [draft, setDraft] = useState<AppShipSettings | null>(null)
  const current = draft ?? app.shipSettings
  const save = useUpdateShipSettings(app.id)
  const available = useNameableGroups(canEdit && !policy)
  const groupNames = useMemo(() => new Map(available.map(g => [g.id, g.name])), [available])

  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(app.shipSettings)
  const parsed = putAppShipSettingsRequestSchema.safeParse(current)
  const groupError = parsed.success
    ? undefined
    : parsed.error.issues.find(i => i.path.join('.') === 'review.groupIds')?.message

  const update = (next: Partial<AppShipSettings>) => setDraft({ ...current, ...next })
  const setReview = (mode: ShipReviewMode) =>
    update({ review: { mode, groupIds: mode === 'groups' ? current.review.groupIds : [] } })
  const toggleGroup = (id: string) => {
    const ids = new Set(current.review.groupIds)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    update({ review: { mode: 'groups', groupIds: [...ids] } })
  }

  // Nothing to ship yet (waiting on approval), or nothing to ship any more.
  if (app.status === 'requested' || app.status === 'archived') return null

  const sentences = shipSettingsSentences(app.shipSettings, app.shipReviewSetBy, groupNames)
  // A chosen team the reader cannot list still shows, as a chip they can only remove.
  const chips: GroupRef[] = [
    ...available,
    ...current.review.groupIds
      .filter(id => !groupNames.has(id))
      .map(id => ({ id, name: 'A team you can’t see', typeName: '' })),
  ]

  return (
    <SectionPanel
      title="Shipping"
      description="What happens when someone ships a coding session on this app."
    >
      <div className="space-y-4">
        {!canEdit ? (
          <div className="space-y-1 text-sm" data-testid="ship-settings-readonly">
            <p>{sentences.ship}</p>
            <p className="text-secondary">{sentences.review}</p>
            <p className="text-xs text-muted">
              The app’s owners and administrators can change this.
            </p>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={event => {
              event.preventDefault()
              if (!parsed.success || !dirty) return
              save.mutate(parsed.data, { onSuccess: () => setDraft(null) })
            }}
          >
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">When someone ships</legend>
              {(['staging', 'pr'] as const).map(mode => (
                <label key={mode} className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="ship-mode"
                    className="radio radio-sm mt-0.5"
                    checked={current.sessionShip === mode}
                    onChange={() => update({ sessionShip: mode })}
                  />
                  <span className="text-sm">
                    {SHIP_MODE_TEXT[mode].label}
                    <span className="block text-xs text-muted">{SHIP_MODE_TEXT[mode].help}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {policy ? (
              <div className="space-y-1 text-sm" data-testid="review-policy">
                <p className="font-medium">Review before merging</p>
                <p className="text-secondary">
                  An administrator requires a review for every merge in Settings → Approvals, so
                  that policy decides who approves — it can’t be changed here.
                </p>
              </div>
            ) : (
              <fieldset className="space-y-2" disabled={current.sessionShip === 'pr'}>
                <legend className="mb-1 text-sm font-medium">Review before merging</legend>
                {current.sessionShip === 'pr' && (
                  <p className="text-xs text-muted">
                    Only used when changes go live on staging — on GitHub, reviews happen there.
                  </p>
                )}
                {(['none', 'app_owners', 'groups'] as const).map(mode => (
                  <label key={mode} className="flex cursor-pointer items-start gap-2">
                    <input
                      type="radio"
                      name="ship-review"
                      className="radio radio-sm mt-0.5"
                      checked={current.review.mode === mode}
                      onChange={() => setReview(mode)}
                    />
                    <span className="text-sm">{REVIEW_TEXT[mode]}</span>
                  </label>
                ))}
                {current.review.mode === 'groups' && (
                  <div className="pl-6">
                    {chips.length === 0 ? (
                      <p className="text-xs text-muted">
                        You aren’t in any teams to name. An administrator can choose teams here.
                      </p>
                    ) : (
                      <div
                        className="flex flex-wrap gap-2"
                        role="group"
                        aria-label="Reviewing teams"
                      >
                        {chips.map(group => {
                          const on = current.review.groupIds.includes(group.id)
                          return (
                            <button
                              key={group.id}
                              type="button"
                              aria-pressed={on}
                              onClick={() => toggleGroup(group.id)}
                              className={`badge badge-lg ${on ? 'badge-primary' : 'badge-outline'}`}
                            >
                              {group.name}
                            </button>
                          )
                        })}
                      </div>
                    )}
                    <FieldError message={groupError} />
                  </div>
                )}
              </fieldset>
            )}

            <div className="flex items-center gap-2">
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={!dirty || !parsed.success || save.isPending}
              >
                {save.isPending && <span className="loading loading-spinner loading-xs" />}
                Save
              </button>
              {dirty && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setDraft(null)}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}

        <BranchProtection app={app} canApply={canApplyProtection} />
      </div>
    </SectionPanel>
  )
}
