/**
 * More budget for one session (Launch P3 "Extend", P4 "Ask for more budget"), validated with the
 * same `extendBudgetSchema` the route applies. A few presets, because the question a person is
 * answering is "how much more", not "type a number".
 *
 * From P4 it goes through a `session.budget` approval (plan §4c), and the modal has two modes:
 *
 * - `extend` — the app's owners and admins. Their click opens (or joins) the request AND records
 *   their approval, so the cap usually moves at once (P3's one click). When they created the
 *   session themselves they are its requester, so it waits for another approver instead.
 * - `ask` — the session's creator without that right: the reason goes to the approvers and the
 *   page then links to the request.
 *
 * The answer decides the toast: the cap moved ("Budget extended"), or it is waiting (and the
 * request is one click away).
 */
import { approvalPath } from '@launch/shared/launch-approvals'
import { extendBudgetSchema, type Session } from '@launch/shared/launch-sessions'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatCost } from '@/ui/components/ai/StatRows'
import { FieldError, Modal, showToast } from '@/ui/components/shared'
import { useExtendBudget } from '@/ui/hooks/useSessions'

const PRESETS = [5, 10, 25] as const

export type BudgetMode = 'extend' | 'ask'

export function ExtendBudgetModal({
  session,
  mode = 'extend',
  open,
  onClose,
}: {
  session: Session
  mode?: BudgetMode
  open: boolean
  onClose: () => void
}) {
  const [amount, setAmount] = useState('10')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const extend = useExtendBudget(session.id)
  const navigate = useNavigate()
  const asking = mode === 'ask'

  const submit = () => {
    const parsed = extendBudgetSchema.safeParse({
      extraUsd: Number(amount),
      ...(reason.trim() ? { reason } : {}),
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter an amount')
      return
    }
    const capBefore = session.budget.capMicrocents
    extend.mutate(parsed.data, {
      onSuccess: ({ session: next, approvalId }) => {
        onClose()
        if (next.budget.capMicrocents > capBefore || !approvalId) {
          showToast('Budget extended', 'success')
          return
        }
        showToast(`Asked for $${parsed.data.extraUsd} more — waiting for approval`, 'success')
        // 202: it waits for someone else (the caller is the session's creator, and so its
        // requester). Take them to the request, which they can share.
        navigate(approvalPath(approvalId))
      },
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={asking ? 'Ask for more budget' : "Extend this session's budget"}
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={submit}
            disabled={extend.isPending}
          >
            {extend.isPending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : asking ? (
              'Ask for approval'
            ) : (
              'Extend'
            )}
          </button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={event => {
          event.preventDefault()
          submit()
        }}
      >
        <p className="text-sm text-secondary">
          It has spent {formatCost(session.budget.spentMicrocents)} of{' '}
          {formatCost(session.budget.capMicrocents)}. The extra is added to this session only
          {asking ? ', once an owner of the app or an administrator approves it.' : '.'}
        </p>
        <div className="flex gap-2">
          {PRESETS.map(preset => (
            <button
              key={preset}
              type="button"
              className={`btn btn-sm ${amount === String(preset) ? 'btn-primary' : ''}`}
              onClick={() => {
                setAmount(String(preset))
                setError(null)
              }}
            >
              +${preset}
            </button>
          ))}
        </div>
        <label className="form-control w-full max-w-40">
          <span className="label-text text-xs">Amount (USD)</span>
          <input
            type="number"
            min={1}
            max={1000}
            step={1}
            className="input input-sm input-bordered"
            value={amount}
            onChange={event => {
              setAmount(event.target.value)
              setError(null)
            }}
            aria-invalid={Boolean(error)}
            aria-describedby="extend-budget-error"
          />
        </label>
        <label className="block">
          <span className="label-text text-xs">
            {asking ? 'Why? (shown to the approvers)' : 'Note (optional)'}
          </span>
          <textarea
            className="textarea w-full text-sm mt-1"
            rows={2}
            maxLength={1000}
            value={reason}
            placeholder={asking ? 'What is left to do, and why it needs more.' : undefined}
            onChange={event => setReason(event.target.value)}
          />
        </label>
        <FieldError id="extend-budget-error" message={error} />
      </form>
    </Modal>
  )
}
