/**
 * Which kit a new app is cut from (D36 K5) — Create app's first field, and the first field of the
 * create-app interview's brief later (`docs/plans/create-app-interview.md`: the chosen kit's
 * manifest is the "kit defaults" layer the brief resolves against). Self-contained on purpose: a
 * value, the offered kits and a change handler, nothing about the form around it.
 *
 * One row per kit — name, pinned version, the default called out in words, the description under
 * it — as a radio group. The caller renders it only when there is a choice to make (two or more
 * kits); with one, the dialog is what it was before kits.
 */
import type { KitOption } from '@launch/shared/kits'

/** Show the picker? Only when there is a choice: two or more kits. Pure. */
export function hasKitChoice(kits: readonly KitOption[] | undefined): kits is KitOption[] {
  return (kits?.length ?? 0) > 1
}

/** "the Rocketflare kit", "the Acme kit" — a kit named in a sentence. Pure. */
export function kitPhrase(name: string): string {
  return /\bkit$/i.test(name.trim()) ? `the ${name}` : `the ${name} kit`
}

/** The kit a picker starts on: the default, else the first. Pure. */
export function initialKitId(kits: readonly KitOption[]): string {
  return (kits.find(k => k.isDefault) ?? kits[0])?.id ?? ''
}

export function KitPicker({
  kits,
  value,
  onChange,
  disabled = false,
}: {
  kits: readonly KitOption[]
  value: string
  onChange: (kitId: string) => void
  disabled?: boolean
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="label text-sm mb-1">Kit</legend>
      <div
        role="radiogroup"
        aria-label="Kit"
        className="rounded-lg border border-base-300 divide-y divide-base-300"
      >
        {kits.map(kit => {
          const id = `create-kit-${kit.slug}`
          return (
            <label
              key={kit.id}
              htmlFor={id}
              className="flex items-start gap-3 px-3 py-2.5 cursor-pointer"
            >
              <input
                id={id}
                type="radio"
                name="create-kit"
                className="radio radio-primary radio-sm mt-0.5"
                value={kit.id}
                checked={value === kit.id}
                onChange={() => onChange(kit.id)}
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium text-base-content">{kit.name}</span>
                  {kit.version && (
                    <span className="font-mono text-xs tabular-nums text-muted">{kit.version}</span>
                  )}
                  {kit.isDefault && <span className="text-xs text-muted">default</span>}
                </span>
                {kit.description && (
                  <span className="block text-xs text-muted mt-0.5">{kit.description}</span>
                )}
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
