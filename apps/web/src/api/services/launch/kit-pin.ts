/**
 * The kit pin (`launch_settings.template_pin`) as the Setup page's Kit version card edits it. The
 * pin has ONE source of truth — the setting, else `DEFAULT_TEMPLATE_PIN` — and this module is the
 * only writer besides a hand-edited row:
 *
 * - `templatePinStatus` — the pin new apps get and whether it is the code default.
 * - `resolveTemplatePinRequest` — the admin's choice (`templatePinRequestSchema`) → a full pin, looked up
 *   in the kit repo through GitHub: a release TAG is resolved to its commit (an annotated tag is
 *   dereferenced through `GET …/git/tags/{sha}`), and a COMMIT — a SHA, short or full, or a branch
 *   (`main` = "latest main") — to its full SHA through `GET …/commits/{ref}`, which also proves the
 *   commit exists in that repo. Nothing the admin typed is stored unresolved.
 * - `listKitTags` — the repo's tags for the card's picker.
 *
 * GitHub is reached as the connected GitHub App: an installation token narrowed to `contents:
 * read`, revoked when the lookup is done. The kit repo is public, so it need not be one the App is
 * installed on. No App connected → 409 `github_app_not_configured` (resetting to the default
 * needs no GitHub at all).
 */
import {
  DEFAULT_TEMPLATE_PIN,
  type KitTagsResponse,
  type TemplatePin,
  type TemplatePinRequest,
  type TemplatePinStatus,
  templatePinSchema,
} from '@launch/shared/launch-setup'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { ApiError, ConflictError } from '../../utils/core/errors'
import { getCredential, getSetting } from './credentials'
import {
  GitHubApiError,
  type GitHubOptions,
  githubJson,
  installationToken,
  listInstallations,
  revokeInstallationToken,
} from './github-app'

/** The pin new apps are cut from, and whether it is the code default (no valid setting row). */
export async function templatePinStatus(db: Database): Promise<TemplatePinStatus> {
  const parsed = templatePinSchema.safeParse(await getSetting(db, 'template_pin'))
  return {
    pin: parsed.success ? parsed.data : DEFAULT_TEMPLATE_PIN,
    isDefault: !parsed.success,
    default: DEFAULT_TEMPLATE_PIN,
  }
}

export type KitLookupOptions = Pick<GitHubOptions, 'fetch' | 'apiBase'>

function kitRefNotFound(message: string, details: Record<string, unknown>): ApiError {
  return new ApiError(422, message, 'kit_ref_not_found', details)
}

function githubFailed(err: unknown): ApiError {
  const reason = err instanceof Error ? err.message : String(err)
  return new ApiError(502, `GitHub could not answer: ${reason}`, 'github_lookup_failed')
}

/** A read-only installation token for the lookup, and its revocation. */
async function withKitToken<T>(
  db: Database,
  cfg: AppConfig,
  opts: KitLookupOptions,
  fn: (token: string) => Promise<T>
): Promise<T> {
  const stored = await getCredential(db, cfg, 'github_app')
  if (!stored) {
    throw new ConflictError(
      'Connect the GitHub App in Setup first: Launch looks the kit up through it',
      'github_app_not_configured'
    )
  }
  const raw = stored.metadata.installationId ?? stored.metadata.installation_id ?? null
  let token: string
  try {
    let installationId = typeof raw === 'number' || typeof raw === 'string' ? raw : null
    if (installationId === null) {
      const [first] = await listInstallations(stored.secret, opts)
      if (!first) throw new Error('The GitHub App is not installed anywhere')
      installationId = first.id
    }
    const minted = await installationToken(
      stored.secret,
      installationId,
      { permissions: { contents: 'read' } },
      opts
    )
    token = minted.token
  } catch (err) {
    throw githubFailed(err)
  }
  try {
    return await fn(token)
  } finally {
    await revokeInstallationToken(token, opts).catch(() => undefined)
  }
}

function repoPath(repo: string): string {
  const [owner = '', name = ''] = repo.split('/')
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

interface GitObject {
  sha: string
  type: string
}

/** A release tag → its commit, dereferencing annotated tag objects. */
async function tagCommit(
  token: string,
  repo: string,
  tag: string,
  opts: KitLookupOptions
): Promise<string> {
  let object: GitObject
  try {
    const ref = await githubJson<{ object: GitObject }>(
      `${repoPath(repo)}/git/ref/tags/${tag}`,
      { token },
      opts
    )
    object = ref.object
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      throw kitRefNotFound(`${repo} has no tag ${tag}`, { repo, tag })
    }
    throw githubFailed(err)
  }
  // An annotated tag points at a tag object; follow it (a tag of a tag, rarely) to the commit.
  for (let hops = 0; object.type === 'tag' && hops < 5; hops++) {
    try {
      const tagObject = await githubJson<{ object: GitObject }>(
        `${repoPath(repo)}/git/tags/${object.sha}`,
        { token },
        opts
      )
      object = tagObject.object
    } catch (err) {
      throw githubFailed(err)
    }
  }
  if (object.type !== 'commit') {
    throw kitRefNotFound(`The tag ${tag} in ${repo} does not point at a commit`, { repo, tag })
  }
  return object.sha
}

/** A SHA (short or full) or a branch → the full commit SHA; proof the commit is in the repo. */
async function commitSha(
  token: string,
  repo: string,
  ref: string,
  opts: KitLookupOptions
): Promise<string> {
  try {
    const commit = await githubJson<{ sha: string }>(
      `${repoPath(repo)}/commits/${encodeURIComponent(ref)}`,
      { token },
      opts
    )
    return commit.sha
  } catch (err) {
    // GitHub answers 422 "No commit found for SHA" as well as 404.
    if (err instanceof GitHubApiError && (err.status === 404 || err.status === 422)) {
      throw kitRefNotFound(`${repo} has no commit or branch ${ref}`, { repo, ref })
    }
    throw githubFailed(err)
  }
}

/** The admin's choice → a full pin, looked up in the kit repo. */
export async function resolveTemplatePinRequest(
  db: Database,
  cfg: AppConfig,
  request: TemplatePinRequest,
  opts: KitLookupOptions = {}
): Promise<TemplatePin> {
  const repo = request.repo ?? (await templatePinStatus(db)).pin.repo
  return withKitToken(db, cfg, opts, async token => {
    if (request.kind === 'tag') {
      const commit = await tagCommit(token, repo, request.tag, opts)
      return templatePinSchema.parse({ repo, tag: request.tag, commit })
    }
    const commit = await commitSha(token, repo, request.ref, opts)
    return templatePinSchema.parse({ repo, commit })
  })
}

/** The kit repo's tags as GitHub lists them (first 30), each with its commit. */
export async function listKitTags(
  db: Database,
  cfg: AppConfig,
  repoParam: string | undefined,
  opts: KitLookupOptions = {}
): Promise<KitTagsResponse> {
  const repo = repoParam ?? (await templatePinStatus(db)).pin.repo
  return withKitToken(db, cfg, opts, async token => {
    try {
      const tags = await githubJson<{ name: string; commit: { sha: string } }[]>(
        `${repoPath(repo)}/tags?per_page=30`,
        { token },
        opts
      )
      return { repo, tags: tags.map(t => ({ name: t.name, commit: t.commit.sha })) }
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) {
        throw kitRefNotFound(`No repository ${repo}`, { repo })
      }
      throw githubFailed(err)
    }
  })
}
