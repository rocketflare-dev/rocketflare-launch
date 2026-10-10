/**
 * The kit catalogue (D36 K1, `docs/plans/multi-kit.md`): the kits a platform admin registered,
 * each a repo pinned to a release, a commit or Follow latest, with the manifest snapshot read at
 * that pin (`launch.kit.json`, or the built-in Rocketflare fallback) and the result of the static
 * conformance check. Exactly one kit is the DEFAULT — the one new apps are cut from until Create
 * app gains a picker (K5). `/api/platform/kits` (platform admins) and `launch kits …`.
 *
 * A kit's pin has the `templatePinSchema` shape (`@launch/shared/launch-setup`) with the repo kept
 * on the kit. The built-in Rocketflare row may carry NO stored pin: it then follows Launch's code
 * default (`DEFAULT_TEMPLATE_PIN`), exactly as an unset `template_pin` setting did — `pinIsCodeDefault`.
 */
import { z } from 'zod'
import { kitManifestSchema } from './kit-manifest'
import { kitLatestCheckSchema, kitRepoSchema, templatePinSchema } from './launch-setup'

/** `unchecked` (never checked at this pin) · `verified` (the checks passed) · `failed`. */
export const KIT_CHECK_STATUSES = ['unchecked', 'verified', 'failed'] as const
export const kitCheckStatusSchema = z.enum(KIT_CHECK_STATUSES)
export type KitCheckStatus = z.infer<typeof kitCheckStatusSchema>

/** Where a kit's manifest came from: its own `launch.kit.json`, or Launch's Rocketflare fallback. */
export const KIT_MANIFEST_SOURCES = ['repo', 'fallback'] as const
export const kitManifestSourceSchema = z.enum(KIT_MANIFEST_SOURCES)
export type KitManifestSource = z.infer<typeof kitManifestSourceSchema>

/** A kit's catalogue key: what `launch kits show <slug>` and the picker name it by. */
export const kitSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/, 'lowercase letters, digits and dashes (3-40)')

/** The pin stored on a kit row: a `TemplatePin` without its repo (the row holds the repo). */
export const kitStoredPinSchema = z
  .object({
    tag: z.string().trim().min(1).max(100).optional(),
    commit: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{40}$/, 'A full 40-character commit SHA'),
    follow: z.literal('latest').nullish(),
  })
  .refine(pin => !pin.follow || Boolean(pin.tag), {
    message: 'A pin that follows the latest release names its tag',
    path: ['tag'],
  })
export type KitStoredPin = z.infer<typeof kitStoredPinSchema>

const refSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'A tag, a commit SHA or a branch name')

/**
 * What an admin pins a kit to; the SERVER resolves it through GitHub, as the template pin does: a
 * release `tag` to its commit, a `commit` (a SHA or a branch) to its full SHA, `latest` to the
 * newest release (`latestKitTag`), stored with `follow: 'latest'`.
 */
export const kitPinRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tag'), tag: refSchema }),
  z.object({ kind: z.literal('commit'), ref: refSchema }),
  z.object({ kind: z.literal('latest') }),
])
export type KitPinRequest = z.infer<typeof kitPinRequestSchema>

/** `POST /api/platform/kits` — register a kit. `slug`/`name` default to the manifest's `kit` block. */
export const kitAddRequestSchema = z.object({
  repo: kitRepoSchema,
  pin: kitPinRequestSchema,
  slug: kitSlugSchema.optional(),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).optional(),
})
export type KitAddRequest = z.infer<typeof kitAddRequestSchema>

/** `:id` in `/api/platform/kits/:id` — the uuid, or the slug. */
export const kitIdParamSchema = z.object({ id: z.string().trim().min(1).max(100) })

/** One kit as the catalogue lists it. */
export const kitSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  repo: z.string(),
  /** The effective pin (the code default for a Rocketflare row with none stored). */
  pin: templatePinSchema,
  /** No pin stored: the row follows `DEFAULT_TEMPLATE_PIN`, moving with Launch. */
  pinIsCodeDefault: z.boolean(),
  isDefault: z.boolean(),
  status: kitCheckStatusSchema,
  /** One sentence per problem the last check found; empty when it passed or never ran. */
  problems: z.array(z.string()),
  /** The manifest's `schema`, as text (`"1"`), when one was read. */
  contractVersion: z.string().nullable(),
  manifestSource: kitManifestSourceSchema.nullable(),
  checkedAt: z.coerce.date().nullable(),
  /** The last newest-release lookup (Follow latest). */
  latestCheck: kitLatestCheckSchema.nullable(),
  /** Apps created from (or imported into) this kit. */
  appCount: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type Kit = z.infer<typeof kitSchema>

/** `GET /api/platform/kits/:id` — the kit and the manifest snapshot taken at its pin. */
export const kitDetailSchema = kitSchema.extend({ manifest: kitManifestSchema.nullable() })
export type KitDetail = z.infer<typeof kitDetailSchema>

export const kitListResponseSchema = z.object({ kits: z.array(kitSchema) })
export type KitListResponse = z.infer<typeof kitListResponseSchema>

export const kitRemoveResponseSchema = z.object({ removed: z.literal(true) })
