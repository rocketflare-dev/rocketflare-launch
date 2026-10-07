/**
 * Lookups the organisation-administration commands share (issue #6): a row by id, id prefix or
 * name/email, and a list in words. Input, validation and confirmation live in `utils/input.ts`.
 */
import { CliError } from '../errors'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Find one row by a full id, an id prefix, or a name/email (case-insensitive). `noun` words the
 * errors; `listHint` is the command that lists the candidates.
 */
export function pickOne<T extends { id: string }>(
  rows: readonly T[],
  ref: string,
  options: { noun: string; listHint: string; names?: (row: T) => Array<string | null | undefined> }
): T {
  const wanted = ref.trim().toLowerCase()
  if (!wanted) throw new CliError(`Give a ${options.noun}`)
  const exact = rows.find(r => r.id.toLowerCase() === wanted)
  if (exact) return exact
  const named = rows.filter(r =>
    (options.names?.(r) ?? []).some(n => n && n.toLowerCase() === wanted)
  )
  const matches = named.length > 0 ? named : rows.filter(r => r.id.toLowerCase().startsWith(wanted))
  if (matches.length === 1) return matches[0] as T
  if (matches.length > 1) {
    throw new CliError(`"${ref}" matches more than one ${options.noun} — give more of the id`)
  }
  throw new CliError(`No ${options.noun} matches "${ref}"`, {
    hint: `List them: ${options.listHint}`,
  })
}

/** `a, b and c` */
export function listWords(words: readonly string[], max = 5): string {
  const shown = words.slice(0, max)
  const rest = words.length - shown.length
  const items = rest > 0 ? [...shown, `${rest} more`] : shown
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
