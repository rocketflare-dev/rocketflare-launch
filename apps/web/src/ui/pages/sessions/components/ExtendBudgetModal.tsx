/**
 * "Extend budget" (Launch P3, plan §1.11): add dollars to one session's cap. For the app's owners
 * and administrators — the route's rule, audited `session.budget.extended` — and validated with
 * the same `extendBudgetSchema` the route applies. A few presets, because the question a person is
 * answering is "how much more", not "type a number".
 */
import { extendBudgetSchema, type Session } from '@launch/shared/launch-sessions'
import { useState } from 'react'
import { formatCost } from '@/ui/components/ai/StatRows'
import { FieldError, Modal } from '@/ui/components/shared'
import { useExtendBudget } from '@/ui/hooks/useSessions'

const PRESETS = [5, 10, 25] as const

export function ExtendBudgetModal({
  session,
  open,
  onClose,
}: {
  session: Session
  open: boolean
  onClose: () => void
}) {
  const [amount, setAmount] = useState('10')
  const [error, setError] = useState<string | null>(null)
  const extend = useExtendBudget(session.id)

  const submit = () => {
    const parsed = extendBudgetSchema.safeParse({ extraUsd: Number(amount) })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter an amount')
      return
    }
    extend.mutate(parsed.data, { onSuccess: onClose })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Extend this session's budget"
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
            {extend.isPending ? <span className="loading loading-spinner loading-xs" /> : 'Extend'}
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
          {formatCost(session.budget.capMicrocents)}. The extra is added to this session only.
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
        <FieldError id="extend-budget-error" message={error} />
      </form>
    </Modal>
  )
}
