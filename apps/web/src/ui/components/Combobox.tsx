/**
 * An editable combobox with a list popup (WAI-ARIA APG "combobox with listbox popup", list
 * autocomplete): one input that is both a free-text field and a filter over `options`.
 *
 * - **ARIA**: the input is `role="combobox"` with `aria-autocomplete="list"`, `aria-expanded`,
 *   `aria-controls` (the listbox) and `aria-activedescendant` (the highlighted option); the popup is
 *   `role="listbox"` of `role="option"`s, the highlighted one `aria-selected`. Focus never leaves the
 *   input, so a screen reader follows the active descendant.
 * - **Keyboard**: ArrowDown / ArrowUp open the list and move through it (wrapping), Alt+ArrowDown
 *   opens without moving, Home / End jump to the first / last option while the list is open, Enter
 *   picks the highlighted option (and only then is kept from submitting the form), Escape closes
 *   the list — or, closed, clears the input — and Tab closes it.
 * - **Mouse**: the chevron toggles the list; hovering highlights; clicking an option picks it.
 * - **Free typing**: what is typed is the value whether or not an option matches it — validating
 *   it is the caller's job (the Kit card sends it to the server, which looks it up).
 *
 * Filtering is a case-insensitive substring match on the text typed since the list was last
 * picked from, so reopening after a pick shows every option again. No dependency: Launch has no
 * headless-UI library, and this is the one combobox it needs.
 */
import { ChevronUpDownIcon } from '@heroicons/react/24/outline'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useState } from 'react'

export interface ComboboxOption {
  value: string
  /** Secondary text beside the value (a short SHA, a date). */
  description?: ReactNode
}

export interface ComboboxProps {
  /** The input's id — what a `<label htmlFor>` names. */
  id: string
  value: string
  /** Every change to the text: typing, clearing, or a pick. */
  onChange: (value: string) => void
  /** An option was picked (Enter or a click) — after `onChange` with the same value. */
  onSelect?: (value: string) => void
  options: readonly ComboboxOption[]
  /** The list opened or closed — e.g. to load the options only when someone looks. */
  onOpenChange?: (open: boolean) => void
  loading?: boolean
  /** Shown in the popup when nothing matches what was typed. */
  emptyMessage?: string
  placeholder?: string
  disabled?: boolean
  className?: string
  inputClassName?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}

export function Combobox({
  id,
  value,
  onChange,
  onSelect,
  options,
  onOpenChange,
  loading = false,
  emptyMessage = 'No matches',
  placeholder,
  disabled = false,
  className = '',
  inputClassName = '',
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: ComboboxProps) {
  const listboxId = `${id}-listbox`
  const optionPrefix = `${id}-option-${useId().replace(/:/g, '')}`
  const [open, setOpenState] = useState(false)
  const [active, setActive] = useState(-1)
  // The text typed since the last pick: the filter. A pick resets it, so the list is whole again.
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? options.filter(o => o.value.toLowerCase().includes(needle)) : [...options]
  }, [options, query])

  function setOpen(next: boolean) {
    setOpenState(next)
    if (!next) setActive(-1)
    if (next !== open) onOpenChange?.(next)
  }

  // A shorter list (more typed, options reloaded) never leaves the highlight past its end.
  useEffect(() => {
    if (active >= filtered.length) setActive(filtered.length - 1)
  }, [active, filtered.length])

  const activeId = open && active >= 0 ? `${optionPrefix}-${active}` : undefined
  useEffect(() => {
    if (!activeId) return
    // jsdom has no scrollIntoView; a browser keeps the highlighted option in view.
    document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId])

  function pick(option: ComboboxOption) {
    onChange(option.value)
    onSelect?.(option.value)
    setQuery('')
    setOpen(false)
  }

  function move(to: number) {
    if (filtered.length === 0) return
    setActive(((to % filtered.length) + filtered.length) % filtered.length)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (!open) {
          setOpen(true)
          if (!event.altKey) move(0)
        } else if (!event.altKey) {
          move(active + 1)
        }
        return
      case 'ArrowUp':
        event.preventDefault()
        if (!open) {
          setOpen(true)
          move(filtered.length - 1)
        } else {
          move(active - 1)
        }
        return
      case 'Home':
      case 'End':
        // Closed, they move the caret as in any text field.
        if (!open || filtered.length === 0) return
        event.preventDefault()
        move(event.key === 'Home' ? 0 : filtered.length - 1)
        return
      case 'Enter': {
        const option = open && active >= 0 ? filtered[active] : undefined
        if (!option) return // the form submits what was typed
        event.preventDefault()
        pick(option)
        return
      }
      case 'Escape':
        if (open) {
          event.preventDefault()
          setOpen(false)
        } else if (value) {
          event.preventDefault()
          onChange('')
          setQuery('')
        }
        return
      case 'Tab':
        setOpen(false)
        return
    }
  }

  return (
    <div className={`relative ${className}`}>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeId}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        spellCheck={false}
        className={`input input-bordered input-sm w-full pr-8 ${inputClassName}`}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={e => {
          onChange(e.target.value)
          setQuery(e.target.value)
          setActive(-1)
          if (!open) setOpen(true)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? 'Hide options' : 'Show options'}
        className="absolute right-1 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs btn-square"
        disabled={disabled}
        // Keep focus in the input: the list belongs to it.
        onMouseDown={e => e.preventDefault()}
        onClick={() => {
          document.getElementById(id)?.focus()
          setOpen(!open)
        }}
      >
        <ChevronUpDownIcon className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-box border border-[color:var(--border-default)] bg-base-100 shadow-lg">
          <div
            id={listboxId}
            role="listbox"
            aria-label="Options"
            className="max-h-60 overflow-auto py-1 text-sm"
          >
            {filtered.map((option, index) => (
              <div
                key={option.value}
                id={`${optionPrefix}-${index}`}
                role="option"
                // Never tabbed to or focused: the input keeps focus (`aria-activedescendant`).
                tabIndex={-1}
                aria-selected={index === active}
                className={`flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 ${
                  index === active ? 'bg-base-200' : ''
                }`}
                onMouseDown={e => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(option)}
              >
                <span className="font-mono">{option.value}</span>
                {option.description !== undefined && (
                  <span className="text-xs text-muted">{option.description}</span>
                )}
              </div>
            ))}
          </div>
          {filtered.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted" role="status">
              {loading ? 'Loading…' : emptyMessage}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
