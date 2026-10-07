/**
 * `launch files put|get|rm` — stored files (D23), over `/api/files`.
 *
 * - `put <path> [--scope uploads|avatars] [--type <mime>]` uploads one local file as multipart
 *   (the size and, for an avatar, the image type are checked before anything is sent — the
 *   server's 413/415 are the backstop). `--scope avatars` also makes it YOUR avatar. Prints the
 *   file's id and its `/api/files/:id` URL.
 * - `get <id> --out <file> [--force]` streams the object into a `0600` file (`wx` unless
 *   `--force`; a download cut off mid-body removes the file), as `audit export` does.
 * - `rm <id> [--yes]` deletes it (your own, or anyone's as an admin) after asking: whatever links to
 *   it — an avatar, an image in a message — stops showing it. A knowledge document's original is
 *   409 `owned_by_document` (delete the document instead), exit 1.
 * */

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  AVATAR_MIME_TYPES,
  FILE_SCOPES,
  isAvatarMimeType,
  MAX_UPLOAD_BYTES,
  uploadQuerySchema,
  uploadResponseSchema,
} from '@launch/shared/files'
import chalk from 'chalk'
import type { Command } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import {
  type ConfirmOptions,
  confirmConsequence,
  downloadToFile,
  oneOf,
  parseBody,
} from '../utils/input'
import { UUID_RE } from './org-common'

const filePath = (id: string) => `/api/files/${encodeURIComponent(id)}`

function checkId(id: string): string {
  if (!UUID_RE.test(id.trim())) throw new CliError(`not a file id: ${id}`)
  return id.trim()
}

/** Common types by extension; anything else is `application/octet-stream` unless `--type`. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip': 'application/zip',
}

export function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export interface FilesPutOptions {
  scope?: string
  type?: string
}

export async function runFilesPut(
  ctx: CommandContext,
  path: string,
  options: FilesPutOptions = {}
): Promise<void> {
  const query = parseBody(uploadQuerySchema, { scope: options.scope })
  if (query.scope === 'documents')
    throw new CliError('Knowledge documents are uploaded through the documents page, not here')
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new CliError(`cannot read ${path}: ${(error as { code?: string }).code ?? error}`)
  }
  if (bytes.byteLength === 0) throw new CliError(`${path} is empty`)
  if (bytes.byteLength > MAX_UPLOAD_BYTES)
    throw new CliError(`${path} is ${bytes.byteLength} bytes; the limit is ${MAX_UPLOAD_BYTES}`)
  const type = options.type ?? mimeFor(path)
  if (query.scope === 'avatars' && !isAvatarMimeType(type))
    throw new CliError(`An avatar must be ${AVATAR_MIME_TYPES.join(', ')} — not ${type}`)
  const form = new FormData()
  form.append('file', new File([new Uint8Array(bytes)], basename(path), { type }))
  const { data, raw } = await requireClient(ctx).request('POST', '/api/files', {
    schema: uploadResponseSchema,
    query: { scope: query.scope },
    body: form,
  })
  ctx.out.data(
    raw,
    () =>
      `${chalk.green('✓')} Uploaded ${data.filename} (${data.sizeBytes} bytes, ${data.contentType})${query.scope === 'avatars' ? ' — it is your avatar now' : ''}\n  id ${data.id} · ${data.url}`
  )
}

export async function runFilesGet(
  ctx: CommandContext,
  id: string,
  options: { out: string; force?: boolean }
): Promise<void> {
  if (!options.out) throw new CliError('--out <file> is required')
  const { body, contentType } = await requireClient(ctx).download(filePath(checkId(id)))
  const bytes = await downloadToFile({ body }, options.out, options.force)
  ctx.out.data(
    { path: options.out, bytes, contentType },
    () =>
      `${chalk.green('✓')} Saved ${bytes} bytes${contentType ? ` (${contentType})` : ''} to ${options.out}`
  )
}

export async function runFilesRemove(
  ctx: CommandContext,
  id: string,
  options: ConfirmOptions = {}
): Promise<void> {
  const fileId = checkId(id)
  if (
    !(await confirmConsequence(
      ctx,
      options,
      `Delete file ${fileId}?`,
      'Whatever links to it — an avatar, an image in a message — stops showing it. This cannot be undone.'
    ))
  )
    return
  await requireClient(ctx).request('DELETE', filePath(fileId))
  ctx.out.data({ deleted: fileId }, () => `${chalk.green('✓')} Deleted.`)
}

export function registerFilesCommands(program: Command, action: ActionWrapper): void {
  const files = program.command('files').description('stored files: upload, download, delete')
  files
    .command('put <path>')
    .description('upload a local file (max 5 MB); prints its id and URL')
    .option(
      '--scope <scope>',
      'uploads (default) | avatars (sets your avatar)',
      oneOf(
        '--scope',
        FILE_SCOPES.filter(s => s !== 'documents')
      )
    )
    .option('--type <mime>', 'the content type (default: from the extension)')
    .action(action((ctx, cmd) => runFilesPut(ctx, cmd.args[0] ?? '', cmd.opts())))
  files
    .command('get <id>')
    .description('download a file into a 0600 file')
    .requiredOption('--out <file>', 'where to write it')
    .option('--force', 'replace --out if it exists')
    .action(action((ctx, cmd) => runFilesGet(ctx, cmd.args[0] ?? '', cmd.opts())))
  files
    .command('rm <id>')
    .description('delete a file (yours, or any as an admin)')
    .option('-y, --yes', 'do not ask first')
    .action(action((ctx, cmd) => runFilesRemove(ctx, cmd.args[0] ?? '', cmd.opts())))
}
