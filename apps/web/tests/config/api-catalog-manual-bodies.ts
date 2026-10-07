/**
 * The routes that read their request body WITHOUT `validate('json', …)` and must (issue #6,
 * `api-catalog.test.ts`). Every other route either validates its JSON body with an `@launch/shared`
 * schema, reads multipart form data, or reads no body at all. An entry no route needs any more
 * fails the test, so this list only shrinks.
 *
 * `schema` / `byParam.schemas` name the identifier the route parses with BY HAND (resolved through
 * the route file's imports to its `@launch/shared` export), so the catalog and `launch api call`
 * still know the exact shape; with neither, the body is raw (`{ raw: true, reason }`).
 */
export interface ManualBody {
  reason: string
  /** The schema the handler `safeParse`s the body with. */
  schema?: string
  /** The body's schema is `schemas[<param>]` — a record of schemas keyed by a path param. */
  byParam?: { param: string; schemas: string }
  /** The body may be omitted entirely. */
  optional?: true
}

export const MANUAL_BODIES: Record<string, ManualBody> = {
  'POST /api/github/webhook': {
    reason:
      'GitHub signs the raw bytes (X-Hub-Signature-256): the body is verified before it is parsed, and its shape is GitHub’s',
  },
  'POST /api/sessions/:id/preview-grant': {
    reason:
      'the body is optional: validate(json) refuses the EMPTY application/json body the UI sends for none',
    schema: 'previewGrantRequestSchema',
    optional: true,
  },
  'PUT /api/platform/setup/credentials/:kind': {
    reason: 'the body’s schema depends on :kind (credentialPayloadSchemas[kind])',
    byParam: { param: 'kind', schemas: 'credentialPayloadSchemas' },
  },
}
