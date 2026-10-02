/**
 * The pure halves of the Launch P4 approval and release surfaces: the wording the inbox, the
 * request page and the CLI-parallel UI share (`approvalModel.ts`), the release lifecycle and chain
 * wording (`releaseModel.ts`), who may do what about a session's budget (`budgetAccess.ts`), and the
 * two polling decisions — a pending approval waits on a PERSON and is never polled.
 */
import {
  type ApprovalRequest,
  approvalRequestSchema,
  DEFAULT_APPROVAL_POLICIES,
} from '@launch/shared/launch-approvals'
import { describe, expect, it } from 'vitest'
import {
  APPROVAL_APPLY_POLL_MS,
  approvalOwesAnswer,
  approvalPollInterval,
  isApprovalConflict,
} from '@/ui/hooks/useApprovals'
import { RELEASES_POLL_MS, releaseOfApproval, releasesPollInterval } from '@/ui/hooks/useReleases'
import { ApiError } from '@/ui/lib/api-client'
import {
  approvalSummary,
  approversSentence,
  extraApprovers,
  orList,
  policyExpiryLabel,
  policySentence,
  progressLabel,
  requestApproversSentence,
  requesterName,
  waitingOn,
  whyNotSentence,
} from '@/ui/pages/approvals/approvalModel'
import { canPromote, chainEntry, nextVersion } from '@/ui/pages/apps/components/releaseModel'
import { budgetAccess } from '@/ui/pages/sessions/components/budgetAccess'
import { approvalRow, deployContext } from '../ui/helpers/approvals'

const USER = '11111111-1111-4111-8111-111111111111'

function request(overrides: Record<string, unknown> = {}): ApprovalRequest {
  return approvalRequestSchema.parse(approvalRow(overrides))
}

describe('approvalSummary — what is being approved, in plain words', () => {
  it('names the version and app of a production deploy, falling back to the commit', () => {
    expect(approvalSummary(request())).toBe('Deploy Expenses 1.3.0 to production')
    expect(
      approvalSummary(
        request({ context: deployContext({ version: null, tag: null, sha: 'f'.repeat(40) }) })
      )
    ).toBe('Deploy Expenses fffffff to production')
  })

  it('says who wants access to which app, what app is to be created, and the extra budget', () => {
    expect(
      approvalSummary(
        request({
          kind: 'app.access',
          context: { kind: 'app.access', userId: USER, message: null },
        })
      )
    ).toBe('Let Bob Builder sign in to Expenses')
    expect(
      approvalSummary(
        request({
          kind: 'app.create',
          app: null,
          context: {
            kind: 'app.create',
            slug: 'payroll',
            displayName: 'Payroll',
            ownerGroupId: null,
          },
        })
      )
    ).toBe('Create the app “Payroll”')
    expect(
      approvalSummary(
        request({
          kind: 'session.budget',
          context: {
            kind: 'session.budget',
            sessionId: USER,
            sessionTitle: 'Dark mode',
            extraUsd: 25,
            spentUsd: 10,
            capUsd: 10,
          },
        })
      )
    ).toBe('Add $25 to the session “Dark mode” on Expenses')
  })
})

describe('requesterName', () => {
  it('is You, the person, a GitHub actor for a CI-opened request, or Launch', () => {
    expect(requesterName(request({ requestedByUserId: USER }), USER)).toBe('You')
    expect(requesterName(request(), USER)).toBe('Bob Builder')
    expect(
      requesterName(
        request({ requester: null, requestedByUserId: null, requestedByLabel: 'github:octocat' }),
        USER
      )
    ).toBe('GitHub: octocat')
    expect(requesterName(request({ requester: null, requestedByUserId: null }), USER)).toBe(
      'Launch'
    )
  })
})

describe('who may decide, and why not', () => {
  const approvers = DEFAULT_APPROVAL_POLICIES['deploy.production'].approvers

  it('lists the approvers in words, naming the teams it can and counting the rest', () => {
    expect(approversSentence(approvers)).toBe('the app’s owners or the organisation’s admins')
    const groupId = '33333333-3333-4333-8333-333333333333'
    const other = '44444444-4444-4444-8444-444444444444'
    expect(
      approversSentence(
        { appOwners: false, admins: false, groupIds: [groupId, other], userIds: [USER] },
        new Map([[groupId, 'Platform']])
      )
    ).toBe('members of Platform, members of one team or one named person')
    expect(orList(['a', 'b', 'c'])).toBe('a, b or c')
  })

  it('gives one sentence per reason, and none once the request is settled', () => {
    const detail = {
      policy: DEFAULT_APPROVAL_POLICIES['deploy.production'],
      status: 'pending' as const,
    }
    expect(whyNotSentence('not_an_approver', detail)).toBe(
      'Waiting for the app’s owners or the organisation’s admins to decide.'
    )
    expect(whyNotSentence('self_approval', detail)).toMatch(/someone else has to/)
    expect(whyNotSentence('already_decided', detail)).toMatch(/already decided/)
    expect(whyNotSentence('not_pending', detail)).toBeNull()
    expect(whyNotSentence(null, detail)).toBeNull()
  })

  it('names who it waits on when the server lists them, and says when nobody can', () => {
    const person = (name: string | null, email: string) => ({
      id: crypto.randomUUID(),
      name,
      email,
    })
    const base = {
      policy: DEFAULT_APPROVAL_POLICIES['deploy.production'],
      status: 'pending' as const,
    }
    const two = { ...base, eligible: [person('Alice', 'a@x.test'), person(null, 'bob@x.test')] }
    expect(whyNotSentence('not_an_approver', two)).toBe(
      'Waiting for Alice or bob@x.test to decide.'
    )
    expect(whyNotSentence('self_approval', two)).toBe(
      'You can’t approve a request you asked for or are part of — someone else has to: Alice or bob@x.test.'
    )
    expect(whyNotSentence('already_decided', two)).toBe(
      'You have already decided this request. It is waiting for Alice or bob@x.test.'
    )
    const five = {
      ...base,
      eligible: ['A', 'B', 'C', 'D', 'E'].map(n => person(n, `${n}@x.test`)),
    }
    expect(waitingOn(five).who).toBe('A, B or 3 others')
    const nobody = { ...base, eligible: [] }
    expect(waitingOn(nobody)).toEqual({ who: '', nobody: true })
    expect(whyNotSentence('not_an_approver', nobody)).toMatch(/^Nobody can approve this request/)
    expect(whyNotSentence('self_approval', nobody)).toMatch(/Settings → Approvals/)
  })

  it('counts progress as N of M, never past M', () => {
    expect(progressLabel({ approvals: 1, requiredApprovals: 2 })).toBe('1 of 2 approvals')
    expect(progressLabel({ approvals: 3, requiredApprovals: 1 })).toBe('1 of 1 approval')
  })

  it('words an expiry in the unit it was set in', () => {
    expect(policyExpiryLabel(7 * 24 * 60)).toBe('after 7 days')
    expect(policyExpiryLabel(36 * 60)).toBe('after 36 hours')
    expect(policyExpiryLabel(45)).toBe('after 45 minutes')
    expect(policyExpiryLabel(null)).toBe('never')
  })
})

describe('polling: only while the SERVER owes an answer', () => {
  it('never polls a pending request (it waits on a person) or a settled one', () => {
    expect(approvalPollInterval({ status: 'pending', appliedAt: null, applyError: null })).toBe(
      false
    )
    expect(
      approvalPollInterval({ status: 'approved', appliedAt: new Date(), applyError: null })
    ).toBe(false)
    expect(approvalPollInterval({ status: 'rejected', appliedAt: null, applyError: null })).toBe(
      false
    )
  })

  it('polls an approval whose effect is still being carried out, and stops at an apply error', () => {
    expect(approvalOwesAnswer({ status: 'approved', appliedAt: null, applyError: null })).toBe(true)
    expect(approvalPollInterval({ status: 'approved', appliedAt: null, applyError: null })).toBe(
      APPROVAL_APPLY_POLL_MS
    )
    expect(
      approvalPollInterval({ status: 'approved', appliedAt: null, applyError: 'GitHub said 502' })
    ).toBe(false)
  })

  it('polls releases only while one is deploying or about to', () => {
    expect(
      releasesPollInterval([{ status: 'staging_active' }, { status: 'awaiting_approval' }])
    ).toBe(false)
    expect(releasesPollInterval([{ status: 'tagged' }])).toBe(RELEASES_POLL_MS)
    expect(releasesPollInterval([{ status: 'promoting' }])).toBe(RELEASES_POLL_MS)
    expect(releasesPollInterval(undefined)).toBe(false)
  })
})

describe('conflicts are information', () => {
  it('treats a 409 not_pending / already_decided / deploy_run_gone as a conflict, not a 403', () => {
    const conflict = (code: string) => new ApiError({ error: 'x', statusCode: 409, code })
    expect(isApprovalConflict(conflict('not_pending'))).toBe(true)
    expect(isApprovalConflict(conflict('already_decided'))).toBe(true)
    expect(isApprovalConflict(conflict('deploy_run_gone'))).toBe(true)
    expect(
      isApprovalConflict(new ApiError({ error: 'x', statusCode: 403, code: 'self_approval' }))
    ).toBe(false)
  })
})

describe('releases', () => {
  it('previews the next version, and only offers Promote once staging runs it', () => {
    expect(nextVersion('1.2.3', 'patch')).toBe('1.2.4')
    expect(nextVersion('1.2.3', 'minor')).toBe('1.3.0')
    expect(nextVersion('1.2.3', 'major')).toBe('2.0.0')
    expect(nextVersion(null, 'patch')).toBeNull()
    expect(canPromote({ status: 'staging_active' })).toBe(true)
    expect(canPromote({ status: 'staging' })).toBe(false)
    expect(canPromote({ status: 'awaiting_approval' })).toBe(false)
    // As the route: a rejected release may be asked for again.
    expect(canPromote({ status: 'rejected' })).toBe(true)
  })

  it('finds the release a deploy approval is about, and nothing else', () => {
    expect(releaseOfApproval(request())).toEqual({
      appId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      releaseId: 'e1e1e1e1-0000-4000-8000-000000000001',
    })
    expect(releaseOfApproval(request({ subjectType: 'deploy_ticket' }))).toBeNull()
  })

  it('words each chain row, with the environment of a deploy and unknown actions verbatim', () => {
    expect(chainEntry({ action: 'pr.merged', summary: { after: { number: 41 } } })).toMatchObject({
      label: 'Pull request merged',
      detail: '#41',
      tone: 'success',
    })
    expect(
      chainEntry({ action: 'deploy.activated', summary: { after: { environment: 'staging' } } })
    ).toMatchObject({ label: 'Deploy activated', environment: 'staging' })
    // The server's own keys: session.shipped says prNumber, deploy.started names the release tag.
    expect(
      chainEntry({ action: 'session.shipped', summary: { after: { prNumber: 7, prUrl: 'x' } } })
    ).toMatchObject({ detail: '#7' })
    expect(
      chainEntry({
        action: 'deploy.started',
        summary: { after: { environment: 'production', release: '0.1.1', ref: 'refs/tags/0.1.1' } },
      })
    ).toMatchObject({ environment: 'production', detail: '0.1.1' })
    expect(chainEntry({ action: 'something.new', summary: {} })).toMatchObject({
      label: 'something.new',
      tone: 'neutral',
    })
  })
})

describe('budgetAccess', () => {
  it('extends for an owner, asks for the creator, and offers nothing to a reader', () => {
    expect(budgetAccess({ viewerCanManage: true }, true, null)).toEqual({
      mode: 'extend',
      pendingApprovalId: null,
    })
    expect(budgetAccess({ viewerCanManage: true }, false, 'x')).toEqual({
      mode: 'ask',
      pendingApprovalId: 'x',
    })
    expect(budgetAccess({ viewerCanManage: false }, false, 'x')).toEqual({
      mode: null,
      pendingApprovalId: null,
    })
  })
})

describe('grant.request approvers (P5): the owner team, which no policy list names', () => {
  const policy = DEFAULT_APPROVAL_POLICIES['grant.request']

  it('names the team when known, describes it otherwise, and adds nothing for other kinds', () => {
    expect(extraApprovers('grant.request', 'IT Identity')).toBe('the IT Identity team')
    expect(extraApprovers('grant.request')).toBe('the team that owns the secret')
    expect(extraApprovers('deploy.production', 'IT Identity')).toBeNull()
  })

  it('never says "nobody" about a grant request under the default policy', () => {
    expect(approversSentence(policy.approvers)).toBe('nobody (the policy names no approvers)')
    expect(requestApproversSentence({ kind: 'grant.request', policy }, undefined, 'IT')).toBe(
      'the IT team'
    )
    expect(
      requestApproversSentence(
        {
          kind: 'grant.request',
          policy: { ...policy, approvers: { ...policy.approvers, admins: true } },
        },
        undefined,
        'IT'
      )
    ).toBe('the IT team or the organisation’s admins')
    expect(policySentence(policy, undefined, extraApprovers('grant.request'))).toBe(
      '1 approval from the team that owns the secret'
    )
    // Without the server's `eligible`, the waiting sentence falls back to the same words.
    expect(waitingOn({ kind: 'grant.request', policy }).who).toBe('the team that owns the secret')
  })
})
