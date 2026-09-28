/**
 * The setup wizard's status vocabulary, one glyph per state so it reads without colour too:
 * ● ok (success) · ◐ warning · ● failed (error) · ○ not set / not checked (muted).
 */
import type { CredentialCheck, SetupStepStatus } from '@launch/shared/launch-setup'

const STYLES: Record<SetupStepStatus, { glyph: string; className: string; label: string }> = {
  ok: { glyph: '●', className: 'text-success', label: 'OK' },
  warning: { glyph: '◐', className: 'text-warning', label: 'Needs a look' },
  failed: { glyph: '●', className: 'text-error', label: 'Failed' },
  unchecked: { glyph: '○', className: 'text-muted', label: 'Not checked' },
  todo: { glyph: '○', className: 'text-muted', label: 'Not set' },
}

export function statusLabel(status: SetupStepStatus): string {
  return STYLES[status].label
}

export function StatusDot({
  status,
  withLabel = false,
}: {
  status: SetupStepStatus
  withLabel?: boolean
}) {
  const style = STYLES[status]
  return (
    <span className="inline-flex items-center gap-1.5 text-sm" data-status={status}>
      <span aria-hidden="true" className={style.className}>
        {style.glyph}
      </span>
      {withLabel ? (
        <span className="text-secondary">{style.label}</span>
      ) : (
        <span className="sr-only">{style.label}</span>
      )}
    </span>
  )
}

/** Every probe of a check run, in the order it ran (dependent probes follow what they need). */
export function CheckList({ checks }: { checks: readonly CredentialCheck[] }) {
  if (checks.length === 0) return null
  return (
    <ul className="space-y-1.5" aria-label="Check results">
      {checks.map(check => (
        <li key={check.id} className="flex items-start gap-2 text-sm">
          <span className="mt-0.5">
            <StatusDot status={check.status} />
          </span>
          <span className="min-w-0">
            <span className="font-medium">{check.label}</span>
            {check.detail && (
              <span className="block text-xs text-muted break-words">{check.detail}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}
