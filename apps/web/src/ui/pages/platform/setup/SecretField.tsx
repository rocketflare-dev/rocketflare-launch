/**
 * A WRITE-ONLY field. The server never returns a secret, so there is nothing to prefill: when a
 * value is already set the field shows "Set" and a "Replace" button, and only then an empty input
 * for the new value. Cancelling a replace throws the typed value away.
 */
import { FieldError } from '@/ui/components/shared'

interface SecretFieldProps {
  id: string
  label: string
  /** A value is stored server-side. */
  isSet: boolean
  replacing: boolean
  onReplace: (replacing: boolean) => void
  value: string
  onChange: (value: string) => void
  placeholder?: string
  multiline?: boolean
  hint?: string
  error?: string
}

export function SecretField({
  id,
  label,
  isSet,
  replacing,
  onReplace,
  value,
  onChange,
  placeholder,
  multiline = false,
  hint,
  error,
}: SecretFieldProps) {
  const editing = !isSet || replacing
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {editing ? (
        <div className="flex items-start gap-2">
          {multiline ? (
            <textarea
              id={id}
              className="textarea textarea-bordered w-full font-mono text-xs"
              rows={6}
              value={value}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              onChange={e => onChange(e.target.value)}
              aria-invalid={Boolean(error)}
            />
          ) : (
            <input
              id={id}
              type="password"
              className="input input-bordered w-full font-mono"
              value={value}
              placeholder={placeholder}
              autoComplete="new-password"
              spellCheck={false}
              onChange={e => onChange(e.target.value)}
              aria-invalid={Boolean(error)}
            />
          )}
          {isSet && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                onChange('')
                onReplace(false)
              }}
            >
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <span id={id} className="text-sm text-secondary">
            <span aria-hidden="true">•••••••• </span>Set — hidden
          </span>
          <button type="button" className="btn btn-sm" onClick={() => onReplace(true)}>
            Replace
          </button>
        </div>
      )}
      {hint && editing && <p className="text-xs text-muted">{hint}</p>}
      <FieldError message={error} />
    </div>
  )
}
