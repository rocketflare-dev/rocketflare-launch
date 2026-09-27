/**
 * The kit-to-Launch name translator: name derivation and the ordered replacement classes. A plugin
 * is authored in the Rocketflare kit's vocabulary, and `pnpm plugin add|upgrade` translates every
 * file it copies in through `applyReplacements` (the kit's `rename.mjs` used the same map to turn
 * the kit into Launch once). No I/O and nothing runs at import time, so
 * `apps/web/tests/config/rename-lib.test.ts` can drive it under vitest; `rename-lib.d.mts` beside
 * this file is the hand-written type surface (no `allowJs`).
 *
 * Every token the kit ships under its own name is one of nine classes, applied per file in the
 * order below — longest / most specific first — so a partial form can never win over a longer one:
 *
 *   scope    `@rocketflare/`             → `@<slug>/`        package scope + every import specifier
 *   env      `ROCKETFLARE` (any)         → `<UPPER>`         CLI env prefix, incl. the bare `ENV_PREFIX`
 *   domain   `rocketflare.dev|.local`    → `<domain>`        `noreply@`, `app.`, `staging.` prefixes kept
 *   cfgdir   `.rocketflare` (config dir) → `.<slug>`         `~/.rocketflare`, `CONFIG_DIR_NAME`
 *   dbuser   `postgresql://rocketflare:` → `<snake>`         the Postgres OWNER must stay a plain
 *            `POSTGRES_USER: rocketflare`, `-U rocketflare`  identifier (db-roles.ts refuses `my-app`)
 *   snake    `rocketflare_`              → `<snake>_`        db names, RLS role, password, key prefix
 *   kebab    `rocketflare-`              → `<slug>-`         worker, queue, workflow, bucket, themes
 *   display  `Rocketflare`               → display name      APP_NAME, titles, prose
 *   bare     `rocketflare` (word)        → `<slug>`          bin, `cfld.name`, root package, containers
 *
 * `domain` runs before `cfgdir` because `app.rocketflare.dev` contains `.rocketflare`; `dbuser`
 * runs before `bare` for the identifier reason above. Case-sensitive throughout.
 */

/** What the kit calls itself today — the left-hand side of every replacement. */
export const KIT = Object.freeze({
  slug: 'rocketflare',
  upper: 'ROCKETFLARE',
  display: 'Rocketflare',
  domains: ['rocketflare.dev', 'rocketflare.local'],
  /**
   * Literal strings restored after the pass, longest first: the kit's origin, and the three
   * filenames that keep the KIT's name in a renamed app.
   *
   * `rocketflare-plugin.json` is the ECOSYSTEM's filename, identical in every plugin repository,
   * and `.rocketflare.json` / its sidecar are how plugin documentation names a kit host's manifest.
   */
  preserved: [
    // Launch: the upstream GitHub org, its repositories and its images keep their real names when a
    // plugin's files are translated on the way in (`ghcr.io/rocketflare-dev/local-neon-proxy`,
    // `rocketflare-dev/rocketflare-plugins`). Longest first.
    'github.com/rocketflare-dev/rocketflare',
    'rocketflare-dev/rocketflare-plugins',
    'rocketflare-dev/rocketflare-plugin-',
    'rocketflare-dev/',
    '.rocketflare.local.json',
    'rocketflare-plugin.json',
    '.rocketflare.json',
  ],
})

export const SLUG_RE = /^[a-z][a-z0-9-]*$/
export const HEX_COLOUR_RE = /^#[0-9a-fA-F]{6}$/

/** `null` when the slug is acceptable, else the sentence to print. */
export function validateSlug(slug) {
  if (typeof slug !== 'string' || slug.length === 0) return 'a slug is required'
  if (!SLUG_RE.test(slug)) {
    return `slug '${slug}' must match ${SLUG_RE} (lowercase, digits, hyphens; starts with a letter)`
  }
  if (slug === KIT.slug) return `slug '${slug}' is the kit's own name — pick the app's`
  if (slug.endsWith('-')) return `slug '${slug}' must not end with a hyphen`
  return null
}

/** `my-app` → `My App`. */
export function titleCase(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Every derived form of the new name. `display` defaults to Title Case of the slug; `domain`
 * to `<slug>.example.com` (a placeholder that is obviously not yours, like the kit's `.dev`).
 */
export function deriveNames(slug, display, options = {}) {
  const problem = validateSlug(slug)
  if (problem) throw new Error(problem)
  const snake = slug.replaceAll('-', '_')
  const domain = options.domain ?? `${slug}.example.com`
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new Error(`domain '${domain}' does not look like an apex host (example.com)`)
  }
  const colour = options.colour ?? null
  if (colour !== null && !HEX_COLOUR_RE.test(colour)) {
    throw new Error(`colour '${colour}' must be a 6-digit hex like #2563eb`)
  }
  const trimmed = typeof display === 'string' ? display.trim() : ''
  // A newline here would break `pnpm plugin upgrade`, which translates plugin diffs with these
  // same replacements: its hunk headers are only safe because every substitution changes columns
  // and never line counts.
  if (/[\r\n]/.test(trimmed)) {
    throw new Error('display name must be a single line')
  }
  return Object.freeze({
    slug,
    snake,
    upper: snake.toUpperCase(),
    display: trimmed.length > 0 ? trimmed : titleCase(slug),
    domain: domain.toLowerCase(),
    /** The API-key prefix as stored: `<snake>_`. */
    prefix: `${snake}_`,
    colour: colour === null ? null : colour.toLowerCase(),
  })
}

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The ordered classes for one set of names. Each `pattern` is a fresh global RegExp. */
export function buildReplacements(names) {
  const kit = KIT.slug
  return [
    {
      id: 'scope',
      label: `@${kit}/`,
      pattern: new RegExp(`@${kit}/`, 'g'),
      replacement: `@${names.slug}/`,
    },
    { id: 'env', label: KIT.upper, pattern: new RegExp(KIT.upper, 'g'), replacement: names.upper },
    {
      id: 'domain',
      label: KIT.domains.join(' | '),
      pattern: new RegExp(`${kit}\\.(?:dev|local)\\b`, 'g'),
      replacement: names.domain,
    },
    {
      id: 'cfgdir',
      label: `.${kit} (config dir)`,
      pattern: new RegExp(`\\.${kit}(?![\\w.-])`, 'g'),
      replacement: `.${names.slug}`,
    },
    {
      id: 'dbuser',
      label: `${kit} (Postgres owner)`,
      pattern: new RegExp(`(postgresql://|POSTGRES_USER: |-U )${kit}\\b`, 'g'),
      replacement: `$1${names.snake}`,
    },
    {
      id: 'snake',
      label: `${kit}_`,
      pattern: new RegExp(`${kit}_`, 'g'),
      replacement: `${names.snake}_`,
    },
    {
      id: 'kebab',
      label: `${kit}-`,
      pattern: new RegExp(`${kit}-`, 'g'),
      replacement: `${names.slug}-`,
    },
    {
      id: 'display',
      label: KIT.display,
      pattern: new RegExp(escapeRegExp(KIT.display), 'g'),
      replacement: names.display,
    },
    { id: 'bare', label: kit, pattern: new RegExp(`\\b${kit}\\b`, 'g'), replacement: names.slug },
  ]
}

/** The class ids in application order — the columns of the dry-run table. */
export const CLASS_IDS = Object.freeze(buildReplacements(deriveNames('x')).map(c => c.id))

const PRESERVE_MARK = i => `\u0000P${i}\u0000`

/**
 * One pass over `text`: every class in order, counting matches per class. Returns the new text
 * (identical object when nothing matched) and `counts` keyed by class id.
 */
export function applyReplacements(text, names) {
  const counts = Object.fromEntries(CLASS_IDS.map(id => [id, 0]))
  let out = text
  let preservedHits = 0
  KIT.preserved.forEach((literal, i) => {
    const parts = out.split(literal)
    preservedHits += parts.length - 1
    out = parts.join(PRESERVE_MARK(i))
  })
  for (const cls of buildReplacements(names)) {
    out = out.replace(cls.pattern, (...m) => {
      counts[cls.id] += 1
      // `$1` in the replacement is the captured context (dbuser); everything else is literal.
      return cls.replacement.includes('$1') ? cls.replacement.replace('$1', m[1]) : cls.replacement
    })
  }
  KIT.preserved.forEach((literal, i) => {
    out = out.split(PRESERVE_MARK(i)).join(literal)
  })
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return { text: total === 0 ? text : out, counts, total, preserved: preservedHits }
}

/** A NUL byte in the first 8 KiB is a binary; the translator skips it. */
export function isBinary(buffer) {
  const len = Math.min(buffer.length, 8192)
  for (let i = 0; i < len; i++) if (buffer[i] === 0) return true
  return false
}
