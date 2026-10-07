/**
 * `launch docs …` — the knowledge base (`/api/ai/documents`, D18) from a terminal (issue #6), and
 * the way to debug retrieval: `docs search "<q>"` prints each hit's fused rank and score, which
 * signal found it (dense / lexical rank), the passage and where it sits in its document.
 *
 * - `ls [--status] [--page] [--page-size]`, `show <id>` (the row + its card's excerpt),
 *   `content <id> [--offset] [--max-chars]` (a character window; 409 while not converted),
 *   `passages <id> [--page] [--page-size]` (the stored chunks; never the vectors).
 * - `add --title <t> (--file <path|-> | --text <t>) [--source] [--groups <ids>]` — `POST /ingest`
 *   with the same schema the page posts. There is no URL fetcher on the server: `--source` is a
 *   free-text label (a URL is fine), the text is what you give it.
 * - `visibility <id> (--tenant | --groups <id,…>)` — `PUT /:id/visibility`; `--groups ''` is the
 *   page's "only you and admins", and it warns as the page does.
 * - `rm <id>` — `DELETE /:id`, confirmed with the page's words.
 *
 * - `upload <file> [--title] [--source] [--groups]` — `POST /upload`, multipart, the same three
 *   parts the page sends. The type and size are checked first with the page's own
 *   `validateDocumentFile` (the server's 415/413 rules); converted types are indexed by a job.
 * A document the caller may not see is the same 404 as one that does not exist.
 *
 * `cli.ts` calls `registerDocsCommands(program, action)` once.
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  documentCardSchema,
  documentContentSchema,
  documentPassageSchema,
  documentSchema,
  documentStatusSchema,
  documentTypeLabel,
  ingestTextRequestSchema,
  resolveDocumentUploadType,
  searchRequestSchema,
  searchResponseSchema,
  uploadDocumentFieldsSchema,
  validateDocumentFile,
} from '@launch/shared/ai/embeddings'
import { MAX_UPLOAD_BYTES } from '@launch/shared/files'
import { isPrivateSelection, setVisibilityRequestSchema } from '@launch/shared/groups'
import { paginatedResponse } from '@launch/shared/pagination'
import chalk from 'chalk'
import { type Command, InvalidArgumentError } from 'commander'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'
import type { ActionWrapper } from '../plugins/types'
import {
  type ConfirmOptions,
  confirmAction,
  type InputSeams,
  parseBody,
  readTextArg,
} from '../utils/input'
import { formatDate, formatPagination, renderTable } from '../utils/output'

export const documentsResponseSchema = paginatedResponse(documentSchema)
export const passagesResponseSchema = paginatedResponse(documentPassageSchema)

const documentApiPath = (id: string) => `/api/ai/documents/${encodeURIComponent(id)}`

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function accessLabel(d: { visibility: string; groups: { name: string }[] }): string {
  if (d.visibility === 'tenant') return 'everyone'
  return d.groups.length ? d.groups.map(g => g.name).join(', ') : 'only owner and admins'
}

const CLIP = 400
function clip(text: string, max = CLIP): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}… (+${flat.length - max} chars)` : flat
}

// ---- ls / show / content / passages ----------------------------------------------------------

export interface DocsListOptions {
  status?: string
  page?: number
  pageSize?: number
}

export async function runDocsList(ctx: CommandContext, options: DocsListOptions = {}) {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/ai/documents', {
    schema: documentsResponseSchema,
    query: { status: options.status, page: options.page, pageSize: options.pageSize },
  })
  ctx.out.data(raw, () =>
    renderTable(data.items, [
      { header: 'Added', value: d => formatDate(d.createdAt) },
      { header: 'Id', value: d => d.id },
      { header: 'Title', value: d => d.title },
      { header: 'Type', value: d => documentTypeLabel(d.contentType) },
      { header: 'Status', value: d => d.status },
      { header: 'Passages', value: d => d.chunkCount },
      { header: 'Visible to', value: d => accessLabel(d) },
    ])
  )
  ctx.out.text(formatPagination(data.pagination))
}

export async function runDocsShow(ctx: CommandContext, id: string) {
  const client = requireClient(ctx)
  const [doc, card] = await Promise.all([
    client.request('GET', documentApiPath(id), { schema: documentSchema }),
    client.request('GET', `${documentApiPath(id)}/card`, { schema: documentCardSchema }),
  ])
  const d = doc.data
  ctx.out.data({ document: doc.raw, card: card.raw }, () => {
    const lines = [
      chalk.bold(d.title),
      chalk.dim(
        `${d.id} · ${documentTypeLabel(d.contentType)} · ${sizeLabel(d.sizeBytes)} · ` +
          `${d.status} · ${d.chunkCount} passage(s) · added ${formatDate(d.createdAt)}`
      ),
      `${chalk.bold('Source:')}     ${d.source ?? '—'}`,
      `${chalk.bold('Visible to:')} ${accessLabel(d)}`,
    ]
    if (d.error) lines.push(chalk.red(`Error: ${d.error}`))
    if (card.data.excerpt) lines.push('', card.data.excerpt)
    lines.push(
      '',
      chalk.dim(
        `Read it: \`${ctx.binName} docs content ${d.id}\` · its passages: \`${ctx.binName} docs passages ${d.id}\``
      )
    )
    return lines.join('\n')
  })
}

export interface DocsContentOptions {
  offset?: number
  maxChars?: number
}

export async function runDocsContent(
  ctx: CommandContext,
  id: string,
  options: DocsContentOptions = {}
) {
  const { data, raw } = await requireClient(ctx).request('GET', `${documentApiPath(id)}/content`, {
    schema: documentContentSchema,
    query: { offset: options.offset, maxChars: options.maxChars },
  })
  ctx.out.data(raw, () => data.text)
  const end = data.offset + data.returnedChars
  ctx.log.hint(
    `characters ${data.offset}–${end} of ${data.totalChars}` +
      (data.hasMore && data.nextOffset !== null
        ? ` · next: \`${ctx.binName} docs content ${id} --offset ${data.nextOffset}\``
        : '')
  )
}

export interface DocsPassagesOptions {
  page?: number
  pageSize?: number
  full?: boolean
}

export async function runDocsPassages(
  ctx: CommandContext,
  id: string,
  options: DocsPassagesOptions = {}
) {
  const { data, raw } = await requireClient(ctx).request('GET', `${documentApiPath(id)}/passages`, {
    schema: passagesResponseSchema,
    query: { page: options.page, pageSize: options.pageSize },
  })
  ctx.out.data(raw, () =>
    data.items
      .map(
        p =>
          `${chalk.bold(`#${p.seq + 1}`)} ${chalk.dim(
            `${p.tokenCount} tokens · offset ${p.charOffset ?? '?'} · ${p.id}`
          )}\n${options.full ? p.text : clip(p.text)}`
      )
      .join('\n\n')
  )
  ctx.out.text(formatPagination(data.pagination))
}

// ---- search ----------------------------------------------------------------------------------

export interface DocsSearchOptions {
  limit?: number
  doc?: string
  full?: boolean
}

export async function runDocsSearch(
  ctx: CommandContext,
  query: string,
  options: DocsSearchOptions = {}
) {
  const body = parseBody(
    searchRequestSchema,
    {
      query,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.doc ? { documentId: options.doc } : {}),
    },
    'search'
  )
  const { data, raw } = await requireClient(ctx).request('POST', '/api/ai/documents/search', {
    schema: searchResponseSchema,
    body,
  })
  ctx.out.data(raw, () => {
    if (!data.hits.length) return `No passages match "${data.query}".`
    const lines: string[] = []
    for (const h of data.hits) {
      const found = [
        h.denseRank ? `dense #${h.denseRank}` : null,
        h.lexicalRank ? `lexical #${h.lexicalRank}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
      lines.push(
        `${chalk.bold(`${h.rank}.`)} ${chalk.bold(h.title)}  ${chalk.dim(
          `score ${h.score.toFixed(4)} · ${found || 'no signal'} · passage ${h.seq + 1}/${h.documentPassages}` +
            ` · offset ${h.charOffset ?? '?'}`
        )}`,
        `   ${options.full ? h.text : clip(h.text)}`,
        chalk.dim(`   doc ${h.documentId} · chunk ${h.chunkId}`),
        ''
      )
    }
    lines.push(
      chalk.dim(
        'Score is reciprocal-rank fusion of the dense and lexical lists — higher is better; not a cosine similarity.'
      )
    )
    return lines.join('\n')
  })
}

// ---- add (ingest text) -----------------------------------------------------------------------

export interface DocsAddOptions extends InputSeams {
  title?: string
  file?: string
  text?: string
  source?: string
  /** Comma-separated group ids: restricts the document (empty = only you and admins). */
  groups?: string
}

function groupIds(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

export async function runDocsAdd(ctx: CommandContext, options: DocsAddOptions) {
  if ((options.file === undefined) === (options.text === undefined)) {
    throw new CliError('Give the text with exactly one of --file <path|-> or --text <text>')
  }
  const text =
    options.file !== undefined ? await readTextArg(options.file, options) : (options.text ?? '')
  const body = parseBody(
    ingestTextRequestSchema,
    {
      title: options.title,
      text,
      ...(options.source ? { source: options.source } : {}),
      ...(options.groups !== undefined
        ? { visibility: 'groups', groupIds: groupIds(options.groups) }
        : {}),
    },
    'document'
  )
  const { data, raw } = await requireClient(ctx).request('POST', '/api/ai/documents/ingest', {
    schema: documentSchema,
    body,
  })
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Added "${data.title}" (${data.id}) — ` +
        (data.status === 'indexed'
          ? `indexed, ${data.chunkCount} passage(s)`
          : `${data.status}; a job is indexing it`),
      chalk.dim(`Search it: \`${ctx.binName} docs search "…" --doc ${data.id}\``),
    ].join('\n')
  )
}

// ---- upload (a local file, multipart) ---------------------------------------------------------

export interface DocsUploadOptions {
  title?: string
  source?: string
  groups?: string
  /** Injected for tests: read the file's bytes. */
  readBytes?: (path: string) => Promise<Uint8Array>
}

export async function runDocsUpload(ctx: CommandContext, file: string, options: DocsUploadOptions) {
  const name = basename(file)
  const type = resolveDocumentUploadType(name, '')
  let bytes: Uint8Array
  try {
    bytes = await (options.readBytes ?? (p => readFile(p)))(file)
  } catch (error) {
    throw new CliError(`Cannot read ${file} (${(error as Error).message})`)
  }
  const problem = validateDocumentFile(
    { name, type: type?.contentType ?? '', size: bytes.byteLength },
    MAX_UPLOAD_BYTES
  )
  if (problem || !type) throw new CliError(problem ?? 'Unsupported file type')
  const fields = parseBody(
    uploadDocumentFieldsSchema,
    {
      ...(options.title ? { title: options.title } : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(options.groups !== undefined
        ? { visibility: 'groups', groupIds: groupIds(options.groups) }
        : {}),
    },
    'upload'
  )
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: type.contentType }), name)
  if (fields.title) form.append('title', fields.title)
  if (fields.source) form.append('source', fields.source)
  if (fields.visibility) form.append('visibility', fields.visibility)
  if (fields.groupIds) form.append('groupIds', JSON.stringify(fields.groupIds))
  const { data, raw } = await requireClient(ctx).request('POST', '/api/ai/documents/upload', {
    schema: documentSchema,
    body: form,
  })
  ctx.out.data(raw, () =>
    [
      `${chalk.green('✓')} Uploaded "${data.title}" (${data.id}, ${type.label}, ${sizeLabel(data.sizeBytes)}) — ` +
        (data.status === 'indexed'
          ? `indexed, ${data.chunkCount} passage(s)`
          : `${data.status}; a job is ${type.kind === 'convert' ? 'converting and indexing' : 'indexing'} it`),
      chalk.dim(`Watch it: \`${ctx.binName} docs show ${data.id}\``),
    ].join('\n')
  )
}

// ---- visibility ------------------------------------------------------------------------------

export interface DocsVisibilityOptions {
  tenant?: boolean
  groups?: string
}

export async function runDocsVisibility(
  ctx: CommandContext,
  id: string,
  options: DocsVisibilityOptions
) {
  if (Boolean(options.tenant) === (options.groups !== undefined)) {
    throw new CliError('Give exactly one of --tenant or --groups <id,…>')
  }
  const body = parseBody(
    setVisibilityRequestSchema,
    options.tenant
      ? { visibility: 'tenant', groupIds: [] }
      : { visibility: 'groups', groupIds: groupIds(options.groups ?? '') },
    'visibility'
  )
  if (isPrivateSelection(body.visibility, body.groupIds)) {
    ctx.log.warn('No groups: only the document’s owner and admins will see it.')
  }
  const { data, raw } = await requireClient(ctx).request(
    'PUT',
    `${documentApiPath(id)}/visibility`,
    { schema: documentSchema, body }
  )
  ctx.out.data(raw, () => `${chalk.green('✓')} "${data.title}" is visible to ${accessLabel(data)}.`)
}

// ---- rm --------------------------------------------------------------------------------------

export async function runDocsRemove(ctx: CommandContext, id: string, options: ConfirmOptions = {}) {
  const client = requireClient(ctx)
  const doc = await client.get(documentApiPath(id), { schema: documentSchema })
  const question = `Delete "${doc.title}"? Its chunks leave the search index for good.`
  if (!(await confirmAction(question, options))) {
    ctx.log.info('Nothing deleted.')
    return
  }
  await client.request('DELETE', documentApiPath(doc.id))
  ctx.out.data({ deleted: doc.id }, () => `${chalk.green('✓')} Deleted "${doc.title}".`)
}

// ---- registration ----------------------------------------------------------------------------

function positiveInt(label: string, min = 1) {
  return (value: string) => {
    const n = Number(value)
    if (!Number.isInteger(n) || n < min) {
      throw new InvalidArgumentError(`${label} must be an integer ≥ ${min}`)
    }
    return n
  }
}

export function registerDocsCommands(program: Command, action: ActionWrapper): void {
  const docs = program
    .command('docs')
    .description('the knowledge base: documents, their passages, and retrieval (search)')
  docs
    .command('ls')
    .description('documents you can see, newest first')
    .option('--status <status>', documentStatusSchema.options.join(' | '), (value: string) => {
      if (!documentStatusSchema.safeParse(value).success) {
        throw new InvalidArgumentError(
          `--status must be one of ${documentStatusSchema.options.join(', ')}`
        )
      }
      return value
    })
    .option('--page <n>', 'page number', positiveInt('--page'))
    .option('--page-size <n>', 'items per page (max 200)', positiveInt('--page-size'))
    .action(action((ctx, cmd) => runDocsList(ctx, cmd.opts<DocsListOptions>())))
  docs
    .command('show <id>')
    .description('one document: type, size, status, who sees it, and its opening text')
    .action(action((ctx, cmd) => runDocsShow(ctx, cmd.args[0] ?? '')))
  docs
    .command('content <id>')
    .description("print a window of the document's text")
    .option('--offset <n>', 'start at this character', positiveInt('--offset', 0))
    .option('--max-chars <n>', 'window size (max 50000)', positiveInt('--max-chars'))
    .action(action((ctx, cmd) => runDocsContent(ctx, cmd.args[0] ?? '', cmd.opts())))
  docs
    .command('passages <id>')
    .description('the passages (chunks) the document was split into')
    .option('--page <n>', 'page number', positiveInt('--page'))
    .option('--page-size <n>', 'items per page (max 200)', positiveInt('--page-size'))
    .option('--full', 'print each passage unclipped')
    .action(action((ctx, cmd) => runDocsPassages(ctx, cmd.args[0] ?? '', cmd.opts())))
  docs
    .command('search <query>')
    .description('hybrid search: each hit with its rank, score and which signal found it')
    .option('--limit <n>', 'hits (max 20, default 10)', positiveInt('--limit'))
    .option('--doc <id>', 'only this document')
    .option('--full', 'print each passage unclipped')
    .action(action((ctx, cmd) => runDocsSearch(ctx, cmd.args[0] ?? '', cmd.opts())))
  docs
    .command('add')
    .description('add a text document (indexed now if small, by a job if large)')
    .requiredOption('--title <title>', 'the title')
    .option('--file <path|->', 'the text: a file, or - for stdin')
    .option('--text <text>', 'the text, inline')
    .option('--source <source>', 'where it came from (free text, e.g. a URL)')
    .option('--groups <ids>', 'restrict to these group ids (comma-separated; "" = only you)')
    .action(action((ctx, cmd) => runDocsAdd(ctx, cmd.opts<DocsAddOptions>())))
  docs
    .command('upload <file>')
    .description(
      'upload a PDF, Word, Excel, OpenDocument, HTML, XML, CSV, JSON, Markdown or text file'
    )
    .option('--title <title>', 'the title (default: the file name)')
    .option('--source <source>', 'where it came from (default: the file name)')
    .option('--groups <ids>', 'restrict to these group ids (comma-separated; "" = only you)')
    .action(action((ctx, cmd) => runDocsUpload(ctx, cmd.args[0] ?? '', cmd.opts())))
  docs
    .command('visibility <id>')
    .description('who may read a document: everyone, or only some groups')
    .option('--tenant', 'everyone in the organisation')
    .option('--groups <ids>', 'only these group ids (comma-separated; "" = only owner and admins)')
    .action(action((ctx, cmd) => runDocsVisibility(ctx, cmd.args[0] ?? '', cmd.opts())))
  docs
    .command('rm <id>')
    .description('delete a document and its passages (asks first)')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(action((ctx, cmd) => runDocsRemove(ctx, cmd.args[0] ?? '', cmd.opts())))
}
