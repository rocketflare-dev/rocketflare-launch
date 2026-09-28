/**
 * The approval emails (Launch P4, plan §1.13), in the kit's `emailShell` like every other
 * transactional email (`services/email.ts`): one to each eligible approver when a request opens,
 * one to the requester when it is decided. Both link to the request's page (`approvalPath`), where
 * the decision is made — approving by replying is out of scope (spec/08).
 *
 * Pure: `notify.ts` renders these and enqueues `email.send`.
 */
import { approvalPath } from '@launch/shared/launch-approvals'
import type { AppConfig } from '../../../config'
import type { EmailMessage } from '../email'
import { emailShell } from '../email'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function approvalUrl(cfg: AppConfig, id: string): string {
  return new URL(approvalPath(id), cfg.APP_URL).toString()
}

function button(url: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;background:#1f2937;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">${escapeHtml(label)}</a></p>
<p style="font-size:13px;color:#52525b;word-break:break-all;">Or paste this link into your browser:<br>${escapeHtml(url)}</p>`
}

export interface ApprovalEmailInput {
  approvalId: string
  /** The kind's one-line title (`KindHandler.describe`). */
  title: string
  /** Who asked — a name or `github:<actor>`. */
  requester: string
  reason: string | null
}

/** To an approver: someone asked, and the page where they decide. */
export function approvalRequestedEmail(
  cfg: AppConfig,
  to: string,
  input: ApprovalEmailInput
): EmailMessage {
  const url = approvalUrl(cfg, input.approvalId)
  const subject = `Approval needed: ${input.title}`
  const reason = input.reason
    ? `<p style="margin:0 0 16px;">Their reason: <em>${escapeHtml(input.reason)}</em></p>`
    : ''
  const body = `<h1 style="margin:0 0 16px;font-size:22px;">${escapeHtml(input.title)}</h1>
<p>${escapeHtml(input.requester)} is asking for your approval in ${escapeHtml(cfg.APP_NAME)}.</p>
${reason}${button(url, 'Review the request')}`
  return {
    to,
    subject,
    html: emailShell(cfg, subject, body),
    text: `${input.requester} is asking for your approval: ${input.title}${input.reason ? `\nReason: ${input.reason}` : ''}\n\nReview it: ${url}`,
    link: url,
  }
}

/** To the requester: approved or rejected, with the approver's comment when there is one. */
export function approvalDecidedEmail(
  cfg: AppConfig,
  to: string,
  input: {
    approvalId: string
    title: string
    status: 'approved' | 'rejected'
    comment: string | null
  }
): EmailMessage {
  const url = approvalUrl(cfg, input.approvalId)
  const verb = input.status === 'approved' ? 'approved' : 'rejected'
  const subject = `Request ${verb}: ${input.title}`
  const comment = input.comment
    ? `<p style="margin:0 0 16px;">Comment: <em>${escapeHtml(input.comment)}</em></p>`
    : ''
  const body = `<h1 style="margin:0 0 16px;font-size:22px;">${escapeHtml(input.title)}</h1>
<p>Your request was <strong>${verb}</strong>.</p>
${comment}${button(url, 'See the request')}`
  return {
    to,
    subject,
    html: emailShell(cfg, subject, body),
    text: `Your request was ${verb}: ${input.title}${input.comment ? `\nComment: ${input.comment}` : ''}\n\n${url}`,
    link: url,
  }
}
