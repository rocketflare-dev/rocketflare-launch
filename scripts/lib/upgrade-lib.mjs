/**
 * The pure half of `pnpm plugin upgrade` (`scripts/plugin.mjs`): the diff splitter and translator,
 * the release-note parser, version comparison and the vendored-plugin predicate. No I/O and nothing
 * runs at import time, so `apps/web/tests/config/upgrade-lib.test.ts` can drive it under vitest;
 * `upgrade-lib.d.mts` beside this file is the hand-written type surface (no `allowJs`).
 *
 * A plugin is authored in the Rocketflare kit's vocabulary (`@rocketflare/shared`, …). An upgrade
 * therefore fetches the plugin's own diff between two releases and translates each file block
 * through the SAME token map an install uses (`rename-lib.mjs`), so the patch arrives already
 * speaking Launch's names. Two invariants make that safe and are asserted by the test:
 *
 *   - every replacement is single-line, so `@@ -a,b +c,d @@` line counts are untouched (columns
 *     move, lines do not). `deriveNames` refusing a newline in the display name is what holds it.
 *   - `index <sha>..<sha>` lines are STRIPPED. They name upstream blobs that describe nothing once
 *     the content is translated, and their absence makes `git apply --3way` fail loudly rather
 *     than silently merge against the wrong preimage.
 */
import { applyReplacements } from './rename-lib.mjs'

// ---------------------------------------------------------------- manifest

/** `app === null` means this checkout IS the kit, not a copy of it. */
export function isKitManifest(manifest) {
  return manifest != null && manifest.app == null
}

// ---------------------------------------------------------------- diffs

const INDEX_LINE = /^index [0-9a-f]+\.\.[0-9a-f]+( \d{6})?$/
const BINARY_MARK = /^GIT binary patch$/

/**
 * Split a `git diff` into one block per file. The block keeps its own raw text; paths come from
 * the caller (a `-z --name-status` pass), never from a regex over the `diff --git` line, because a
 * path containing a space makes that line ambiguous.
 */
export function splitDiff(patchText) {
  if (patchText.trim() === '') return []
  const lines = patchText.split('\n')
  const blocks = []
  let current = null
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) blocks.push(current)
      current = { header: line, lines: [line] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) blocks.push(current)
  return blocks.map(b => ({ header: b.header, raw: `${b.lines.join('\n').replace(/\n+$/, '')}\n` }))
}

/** Thrown when a diff carries bytes a text substitution must not touch. */
export class BinaryPatchError extends Error {
  constructor(header) {
    super(`refusing to translate a binary patch block: ${header}`)
    this.name = 'BinaryPatchError'
  }
}

/**
 * Translate one file block into the adopter's names.
 *
 * Path lines (`diff --git`, `---`, `+++`, `rename from/to`, `copy from/to`) are always translated;
 * the body only when `translate` is true. Mode lines are left verbatim — that is what preserves
 * the `120000` symlink the kit ships. `index` lines are dropped.
 */
export function translateBlock(block, names, { translate = true } = {}) {
  const lines = block.raw.split('\n')
  const out = []
  const sub = s => applyReplacements(s, names).text
  let inBody = false
  for (const line of lines) {
    if (BINARY_MARK.test(line)) throw new BinaryPatchError(block.header)
    if (INDEX_LINE.test(line)) continue
    if (line.startsWith('@@')) {
      inBody = true
      // Only the trailing section hint may carry a token; the counts are column-invariant.
      const m = line.match(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)(.*)$/)
      out.push(m ? m[1] + (translate ? sub(m[2]) : m[2]) : line)
      continue
    }
    if (!inBody) {
      if (
        line.startsWith('diff --git ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('rename from ') ||
        line.startsWith('rename to ') ||
        line.startsWith('copy from ') ||
        line.startsWith('copy to ')
      ) {
        out.push(sub(line))
        continue
      }
      out.push(line) // mode lines, similarity index, "new file mode", …
      continue
    }
    out.push(translate ? sub(line) : line)
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

/** Line count of a patch block, the invariant the hunk headers depend on. */
export function countLines(text) {
  return text.split('\n').length
}

/**
 * The block with its `index` lines removed — the correct left-hand side of the line-count
 * invariant, since `translateBlock` drops them. Translation must not change the count of
 * ANYTHING else, or a `@@` header no longer describes its hunk.
 */
export function stripIndexLines(text) {
  return text
    .split('\n')
    .filter(l => !INDEX_LINE.test(l))
    .join('\n')
}

// ---------------------------------------------------------------- release notes

const unquote = s => s.replace(/^["']|["']$/g, '')

/**
 * Split the inside of an inline `[a, b]` list. Quote-aware, because a `migrations` entry is a
 * human sentence and sentences contain commas — splitting on every comma silently turns one
 * description into two fragments, which is a corrupted release note rather than a failed one.
 */
function splitInlineList(inner) {
  if (inner.trim() === '') return []
  const items = []
  let current = ''
  let quote = null
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === ',') {
      items.push(current.trim())
      current = ''
    } else current += ch
  }
  items.push(current.trim())
  return items.filter(s => s !== '')
}

/**
 * Parse the YAML frontmatter of a `docs/upgrades/X.Y.Z.md`. Deliberately a tiny scalar/list
 * reader rather than a YAML dependency: the shape is fixed and asserted by a test, and the kit
 * ships no YAML parser.
 *
 * A list may be inline (`areas: [api, ui]`) or a block sequence — three long `migrations`
 * descriptions read far better one per line, and that is how a person writes them:
 *
 *     migrations:
 *       - "messages gains nullable provider and model columns"
 */
export function parseNote(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) return null
  const data = {}
  const lines = m[1].split('\n')
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([a-z_]+):\s*(.*)$/)
    if (!kv) continue
    const [, key, rawValue] = kv
    const value = rawValue.trim()
    if (value.startsWith('[')) data[key] = splitInlineList(value.slice(1, -1))
    else if (value === '') {
      // `key:` with nothing after it: either a block sequence, or an empty scalar.
      const items = []
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^\s+-\s+(.*)$/)
        if (!item) break
        items.push(unquote(item[1].trim()))
        i = j
      }
      data[key] = items.length > 0 ? items : null
    } else if (value === 'null' || value === '~') data[key] = null
    else if (value === 'true' || value === 'false') data[key] = value === 'true'
    else data[key] = unquote(value)
  }
  return { data, body: m[2] }
}

// ---------------------------------------------------------------- versions

/** `-1 | 0 | 1`, comparing `X.Y.Z` numerically. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  }
  return 0
}

export const VERSION_RE = /^\d+\.\d+\.\d+$/

/**
 * A vendored plugin is the kit's own: the same repository, with no subdirectory (§16).
 *
 * One implementation, which normalises the URL (a trailing `/` or a missing `.git` still names the
 * same repository); `plugin-lib.mjs` re-exports it. Launch records no kit repository, so in Launch
 * no plugin is ever vendored. Takes anything shaped `{ repo, subdir }` — a surface's `source`.
 */
export function isVendored(source, kitRepo) {
  // Trailing slashes FIRST, then `.git` — the other order leaves `…/rocketflare.git/` as
  // `…/rocketflare.git` while the bare form normalises to `…/rocketflare`, so the same repository
  // reads as two. (The implementation this replaced had exactly that bug, unnoticed because
  // nothing ever passed it a trailing slash.)
  const norm = r =>
    (r ?? '')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
  const repo = norm(source?.repo)
  return repo !== '' && repo === norm(kitRepo) && (source?.subdir ?? '') === ''
}
