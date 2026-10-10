/**
 * The STATIC conformance check (D36 §7): does a kit, at its pinned commit, have what the Launch kit
 * contract requires? Pure over a {@link KitFileReader} — the API runs it over the GitHub contents
 * API, tests over a map — and it never throws: every finding is one sentence in `problems`.
 *
 * 1. The manifest resolves (`launch.kit.json`, or the Rocketflare fallback) and parses.
 * 2. The must-have files exist: the init script (when `scaffold.init` is `node <path> …`),
 *    `.github/workflows/ci.yml`, `.github/workflows/<release.workflow>`, both tomls, and
 *    `CLAUDE.md` or `AGENTS.md`.
 * 3. `ci.yml` runs on `pull_request` and has a job whose check name — its `name:`, else its id —
 *    is `ci.requiredCheck`.
 * 4. The release workflow is deployer protocol v1's shape: `push` `tags`, `release` `published`,
 *    `workflow_dispatch` with the `environmentInput` input (a `choice` offering `staging` and
 *    `production`), and `id-token: write`.
 * 5. Both tomls parse; every KV id is a `<PLACEHOLDER>`; every top-level key is one the deploy
 *    gateway lets through (`deploy/binding-check.ts` `unprovisionableKeys`); every account-scoped
 *    name follows `{slug}-…` (+ `stagingSuffix` in staging). In the kit itself the slug is the
 *    kit's OWN pre-rename slug, so the check is that the names share one prefix — the production
 *    Worker's name — not that they carry a particular slug. And the two tomls have the same shape
 *    (the same bindings of each kind).
 *
 * **No YAML parser.** None is a dependency of `apps/web`, and the workflow checks need only
 * a mapping's keys and nesting, so {@link yamlOutline} reads block YAML by indentation: comments
 * stripped (outside quotes), `key:` lines nested by indent, `- item` lines kept as items. Flow
 * mappings spread over lines, anchors and multi-document files are not understood — a kit that
 * writes its triggers that way reads as missing them, and the problem says which.
 *
 * **The meta-kit's checker** (`rocketflare-dev/launch-kit` `scripts/kit-check.mjs`) runs the same
 * checks in plain JS and a few more Launch does not yet: the deployer's start → upload → activate →
 * finish steps and their environments, every command's entry point, the version file, the
 * gate-verified variable, `preview_id`s and `script_name`s. `tests/config/kit-conformance.test.ts`
 * runs this module over the meta-kit 0.1.0 (`tests/fixtures/launch-kit-0.1/`) to keep them aligned.
 *
 * **Not here (a known gap, K3):** the DYNAMIC check — the scaffold job run against a throwaway repo
 * (init → postInit → the gate's lint and typecheck). Until it exists `verified` means "passed the
 * static check" (`docs/CONCEPTS.md` known gaps).
 */
import type { KitManifest } from '@launch/shared/kit-manifest'
import type { KitManifestSource } from '@launch/shared/kits'
import { parse as parseToml } from 'smol-toml'
import { unprovisionableKeys } from '../deploy/binding-check'
import { resources, type TomlResources } from '../rocketflare/toml'
import { type KitFileReader, KitManifestError, readKitManifest } from './manifest'

export interface KitConformance {
  ok: boolean
  /** One sentence per problem; empty when `ok`. */
  problems: string[]
  manifest: KitManifest | null
  manifestSource: KitManifestSource | null
}

const WORKFLOWS_DIR = '.github/workflows'

// ---- a block-YAML outline -------------------------------------------------------------------------

export interface YamlNode {
  key: string | null
  /** What follows `key:` on its line (unquoted), or the item's text for a `- item`. */
  value: string
  indent: number
  children: YamlNode[]
}

/** A line without its comment: `#` at the start or after whitespace, outside quotes. */
function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return line.slice(0, i)
    }
  }
  return line
}

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2')

/**
 * Block YAML as a tree of keys by indentation (see the header for what it does not read). A
 * `- key: value` item becomes an item node whose first child is that key.
 */
export function yamlOutline(text: string): YamlNode[] {
  const root: YamlNode = { key: null, value: '', indent: -1, children: [] }
  const stack: YamlNode[] = [root]
  let block: number | null = null // inside a `|`/`>` scalar: lines indented deeper than this
  for (const raw of text.split(/\r?\n/)) {
    if (block !== null) {
      if (raw.trim() === '' || raw.search(/\S/) > block) continue
      block = null
    }
    const line = stripComment(raw).replace(/\s+$/, '')
    if (line.trim() === '' || line.trim() === '---') continue
    const indent = line.search(/\S/)
    let body = line.trim()
    while ((stack.at(-1) as YamlNode).indent >= indent) stack.pop()
    const parent = stack.at(-1) as YamlNode
    let itemIndent = indent
    if (body.startsWith('- ') || body === '-') {
      const item: YamlNode = { key: null, value: '', indent, children: [] }
      parent.children.push(item)
      stack.push(item)
      body = body.slice(1).trim()
      if (body === '') continue
      itemIndent = indent + 2
      const kv = /^([^:]+?):(?:\s+(.*))?$/.exec(body)
      if (!kv || /^["'[{]/.test(body)) {
        item.value = unquote(body)
        continue
      }
      const child: YamlNode = {
        key: unquote(kv[1] as string),
        value: unquote(kv[2] ?? ''),
        indent: itemIndent,
        children: [],
      }
      item.children.push(child)
      stack.push(child)
      if (/^[|>][-+]?$/.test(kv[2]?.trim() ?? '')) block = itemIndent
      continue
    }
    const kv = /^((?:"[^"]*"|'[^']*'|[^:])+?):(?:\s+(.*))?$/.exec(body)
    if (!kv) {
      // A continuation of a plain scalar, or something this outline does not read.
      continue
    }
    const node: YamlNode = {
      key: unquote(kv[1] as string),
      value: unquote(kv[2] ?? ''),
      indent: itemIndent,
      children: [],
    }
    parent.children.push(node)
    stack.push(node)
    if (/^[|>][-+]?$/.test(kv[2]?.trim() ?? '')) block = indent
  }
  return root.children
}

const child = (nodes: readonly YamlNode[] | undefined, key: string) =>
  nodes?.find(n => n.key === key)

/** A node's list: a flow sequence on its line (`[a, b]`), else its `- item` children. */
function listOf(node: YamlNode | undefined): string[] {
  if (!node) return []
  const flow = /^\[(.*)\]$/.exec(node.value.trim())
  if (flow) {
    return (flow[1] as string).split(',').map(unquote).filter(Boolean)
  }
  if (node.value.trim() !== '') return [unquote(node.value)]
  return node.children.filter(c => c.key === null).map(c => c.value)
}

// ---- the workflow checks ---------------------------------------------------------------------------

/** `ci.yml`'s check names: each job's `name:` (an expression-free one), else its id. */
export function workflowCheckNames(text: string): string[] {
  const jobs = child(yamlOutline(text), 'jobs')
  return (jobs?.children ?? [])
    .filter(j => j.key !== null)
    .map(j => {
      const name = child(j.children, 'name')?.value
      return name && name.trim() !== '' ? name : (j.key as string)
    })
}

/** A workflow's trigger names: the keys of its `on:` block, or its flow list (`on: [push]`). */
export function workflowTriggers(text: string): string[] {
  const doc = yamlOutline(text)
  const on = child(doc, 'on') ?? child(doc, 'true')
  if (!on) return []
  const keys = on.children.filter(c => c.key !== null).map(c => c.key as string)
  return keys.length > 0 ? keys : listOf(on)
}

/** The deployer protocol v1 trigger shape (§5), one sentence per missing piece. */
export function releaseWorkflowProblems(text: string, file: string, input: string): string[] {
  const doc = yamlOutline(text)
  // YAML 1.1 reads a bare `on` as true; GitHub writes and reads it as the key `on`.
  const on = child(doc, 'on') ?? child(doc, 'true')
  const problems: string[] = []
  if (!on) return [`${file} has no \`on:\` block (triggers)`]
  const flow = listOf(on)
  const push = child(on.children, 'push')
  if (!push || !child(push.children, 'tags')) {
    problems.push(`${file} is not triggered by pushing a version tag (\`on.push.tags\`)`)
  }
  const release = child(on.children, 'release')
  if (!release || !listOf(child(release.children, 'types')).includes('published')) {
    problems.push(
      `${file} is not triggered by a published release (\`on.release.types: [published]\`)`
    )
  }
  const dispatch = child(on.children, 'workflow_dispatch')
  if (!dispatch && !flow.includes('workflow_dispatch')) {
    problems.push(`${file} has no \`workflow_dispatch\` trigger`)
  } else {
    const declared = child(child(dispatch?.children, 'inputs')?.children, input)
    if (!declared) {
      problems.push(`${file}'s \`workflow_dispatch\` has no \`${input}\` input`)
    } else if (child(declared.children, 'type')?.value === 'choice') {
      // A choice must offer both environments Launch dispatches (a free-text input takes either).
      const options = listOf(child(declared.children, 'options'))
      const missing = ['staging', 'production'].filter(env => !options.includes(env))
      if (missing.length > 0) {
        problems.push(`${file}'s \`${input}\` input does not offer ${missing.join(' or ')}`)
      }
    }
  }
  const idToken = text
    .split(/\r?\n/)
    .some(line => /^\s*id-token:\s*["']?write["']?\s*$/.test(stripComment(line)))
  if (!idToken) {
    problems.push(`${file} never requests \`id-token: write\` (the deployer authenticates with it)`)
  }
  return problems
}

// ---- the toml checks -------------------------------------------------------------------------------

type Env = 'production' | 'staging'

/** The account-scoped names one toml declares (what `names.ts` computes for an app). */
function scopedNames(declared: TomlResources): string[] {
  return [
    ...declared.queues.map(q => q.queue),
    ...declared.queueConsumers.flatMap(q => [
      q.queue,
      ...(q.deadLetterQueue ? [q.deadLetterQueue] : []),
    ]),
    ...declared.r2.map(r => r.bucketName),
    ...declared.workflows.map(w => w.name),
  ]
}

/** The bindings of each kind, for the same-shape comparison. */
function shape(declared: TomlResources): Record<string, string[]> {
  const sorted = (xs: string[]) => [...new Set(xs)].sort()
  return {
    kv_namespaces: sorted(declared.kv.map(k => k.binding)),
    queues: sorted(declared.queues.map(q => q.binding)),
    r2_buckets: sorted(declared.r2.map(r => r.binding)),
    durable_objects: sorted(declared.durableObjects.map(d => `${d.binding}=${d.className}`)),
    workflows: sorted(declared.workflows.map(w => `${w.binding}=${w.className}`)),
  }
}

function tomlProblems(
  manifest: KitManifest,
  texts: Record<Env, string>
): { problems: string[]; declared: Partial<Record<Env, TomlResources>> } {
  const problems: string[] = []
  const declared: Partial<Record<Env, TomlResources>> = {}
  for (const env of ['production', 'staging'] as const) {
    const file = manifest.worker.tomls[env]
    try {
      declared[env] = resources(texts[env])
      const doc = parseToml(texts[env]) as Record<string, unknown>
      const refused = unprovisionableKeys(doc)
      if (refused.length > 0) {
        problems.push(`${file} declares what Launch cannot provision: ${refused.join(', ')}`)
      }
    } catch (err) {
      problems.push(`${file} does not parse: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const d = declared[env] as TomlResources
    for (const kv of d.kv) {
      if (!kv.placeholder) {
        problems.push(
          `${file}: the ${kv.binding} KV namespace id is ${kv.id ? 'a real id' : 'missing'}, not a <PLACEHOLDER> Launch fills`
        )
      }
    }
  }

  const prod = declared.production
  const staging = declared.staging
  const suffix = manifest.worker.naming.stagingSuffix
  const slug = prod?.workerName ?? null
  if (prod && !slug) problems.push(`${manifest.worker.tomls.production} has no Worker \`name\``)
  if (slug) {
    const follow = (env: Env, d: TomlResources) => {
      const file = manifest.worker.tomls[env]
      const tail = env === 'staging' ? suffix : ''
      if (env === 'staging' && d.workerName !== `${slug}${suffix}`) {
        problems.push(`${file}: the Worker is ${d.workerName ?? '(unnamed)'}, not ${slug}${suffix}`)
      }
      for (const name of new Set(scopedNames(d))) {
        // Staging names end with the suffix; production names never do (they would collide).
        const suffixOk = tail ? name.endsWith(tail) : !name.endsWith(suffix)
        if (!name.startsWith(`${slug}-`) || !suffixOk) {
          problems.push(`${file}: ${name} does not follow the naming rule ${slug}-<suffix>${tail}`)
        }
      }
    }
    follow('production', prod as TomlResources)
    if (staging) follow('staging', staging)
  }
  if (prod && staging) {
    const a = shape(prod)
    const b = shape(staging)
    for (const kind of Object.keys(a)) {
      if (JSON.stringify(a[kind]) !== JSON.stringify(b[kind])) {
        problems.push(
          `The two tomls bind different ${kind}: ${(a[kind] ?? []).join(', ') || '(none)'} in production, ${(b[kind] ?? []).join(', ') || '(none)'} in staging`
        )
      }
    }
  }
  return { problems, declared }
}

// ---- the check -------------------------------------------------------------------------------------

/** The script a `node <path> …` init runs, or null when init is some other command. */
export function initScriptPath(init: string): string | null {
  const match = /^node\s+(?:--\S+\s+)*([^\s-][^\s]*)/.exec(init.trim())
  return match ? (match[1] as string) : null
}

/** Run every static check over `read` (see the header). Never throws. */
export async function checkKitConformance(read: KitFileReader): Promise<KitConformance> {
  let resolved: Awaited<ReturnType<typeof readKitManifest>>
  try {
    resolved = await readKitManifest(read)
  } catch (err) {
    const message =
      err instanceof KitManifestError
        ? err.message
        : `The manifest could not be read: ${String(err)}`
    return { ok: false, problems: [message], manifest: null, manifestSource: null }
  }
  const { manifest, source } = resolved
  const problems: string[] = []

  const ciPath = `${WORKFLOWS_DIR}/ci.yml`
  const releasePath = `${WORKFLOWS_DIR}/${manifest.release.workflow}`
  const init = initScriptPath(manifest.scaffold.init)
  const [ci, release, production, staging, claude, agents, initScript] = await Promise.all([
    read(ciPath),
    read(releasePath),
    read(manifest.worker.tomls.production),
    read(manifest.worker.tomls.staging),
    read('CLAUDE.md'),
    read('AGENTS.md'),
    init ? read(init) : Promise.resolve(''),
  ])

  if (init && initScript === null) problems.push(`The init script ${init} is missing`)
  if (claude === null && agents === null) {
    problems.push(
      'There is no CLAUDE.md or AGENTS.md telling session agents how to work in the kit'
    )
  }

  if (ci === null) {
    problems.push(`${ciPath} is missing`)
  } else {
    if (!workflowTriggers(ci).includes('pull_request')) {
      problems.push(`${ciPath} does not run on \`pull_request\` (where the required check reports)`)
    }
    const names = workflowCheckNames(ci)
    if (!names.includes(manifest.ci.requiredCheck)) {
      problems.push(
        `${ciPath} has no job named ${manifest.ci.requiredCheck} (the required check); its jobs are ${names.join(', ') || '(none)'}`
      )
    }
  }

  if (release === null) {
    problems.push(`${releasePath} is missing`)
  } else {
    problems.push(
      ...releaseWorkflowProblems(release, releasePath, manifest.release.environmentInput)
    )
  }

  if (production === null) problems.push(`${manifest.worker.tomls.production} is missing`)
  if (staging === null) problems.push(`${manifest.worker.tomls.staging} is missing`)
  if (production !== null && staging !== null) {
    problems.push(...tomlProblems(manifest, { production, staging }).problems)
  }

  return { ok: problems.length === 0, problems, manifest, manifestSource: source }
}
