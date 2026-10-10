/**
 * The scaffold job's ROCKETFLARE-LEGACY steps (D36 K3, `docs/plans/multi-kit.md` §8): what Launch
 * still does to a Rocketflare copy that the kit contract has no field for, because the kit does
 * not do it itself yet. Each one is a workaround for an upstream issue
 * (`docs/plans/upstream-kit-issues.md`), runs only for a PRE-CONTRACT Rocketflare kit — `kit.id`
 * `rocketflare` AND no `launch.kit.json` in the kit at the pin (every release up to 0.17.x) — and,
 * within that, only for the versions it applies to. A kit that ships `launch.kit.json` gets the
 * generic job alone ({@link ./job.ts}); its own tests must pass on a fresh copy, which is what the
 * dynamic conformance check proves.
 *
 * | Step | Applies to (Rocketflare, pre-contract) | Upstream |
 * |------|-----------------------------------------|----------|
 * | `patchPreserved` — `KIT.preserved` gains the `rocketflare-dev/` org refs before the rename | `< 0.15.2` (and only while the kit has no `KIT.preservedPattern`) | rocketflare#37, fixed in 0.15.2 |
 * | the leftover `<slug>-dev/` warning after the rename | `< 0.15.2` | rocketflare#37 |
 * | `legacyDefaultPlugins` — the kit's own `default-plugins.mjs --tsv` loop, `db:generate` per plugin, the plugin declarations into BOTH tomls (`PLUGIN_DECLARATIONS_TS`), `plugin-api-doc`, a matching lockfile | every pre-contract release (the kit lists its plugins in `.rocketflare.json`, not `plugins.defaults`) | issue 1 (`appendToArray` counts a value quoted in a comment) |
 * | removing `apps/web/tests/config/plugin-ci.test.ts` | `< 0.15.8` (moved to `tests/kit-only/` then) | issue 5 |
 * | `kitTestPatches` 1-2: `update-check-lib.test.ts` | `< 0.15.2` | issue 3 / rocketflare#37 |
 * | `kitTestPatches` 3: the analytics allow-list entry | while the installed analytics plugin still deletes unscoped (3.4.1) | rocketflare-plugins#8 |
 * | `kitTestPatches` 4-6: `patch-toml.test.ts` | every pre-contract release (still present in 0.17.8) | issue 2 |
 * | `legacyGate` — `pnpm gate lint typecheck` (0.16.0+, else `pnpm lint` + `pnpm typecheck`) then `pnpm web test:config` | every pre-contract release (no `launch.kit.json`, so no `ci.gateList` the kit vouches for before 0.16.0) | — |
 *
 * A patch whose anchor is gone is skipped with a warning (fixed upstream, or a different tree),
 * so a range that is too wide costs a log line, never a broken copy.
 *
 * The fragment below is plain Node ESM spliced into `.launch/scaffold.mjs` after the generic
 * helpers it uses (`run`, `git`, `log`, `warn`, `fail`, `fs`, `path`); like the rest of the
 * script it holds no backticks and no `${`.
 */

/**
 * rocketflare#37: the literals `scripts/lib/rename-lib.mjs`'s `KIT.preserved` gains, inserted after
 * `'github.com/rocketflare-dev/rocketflare'`, most specific first — `rocketflare-dev/` alone would
 * keep the org but still rename the repo after it (`rocketflare-plugins` → `<slug>-plugins`).
 */
export const PRESERVED_ORG_REFS = [
  'rocketflare-dev/rocketflare-plugins',
  'rocketflare-dev/rocketflare-plugin-',
  'rocketflare-dev/rocketflare/',
  'rocketflare-dev/',
] as const

/** The version gates of the table above, by step (exclusive upper bounds). */
export const ROCKETFLARE_LEGACY_BEFORE = {
  patchPreserved: '0.15.2',
  updateCheckLibPatches: '0.15.2',
  pluginCiTest: '0.15.8',
} as const

export const ROCKETFLARE_LEGACY_SCRIPT = String.raw`
// ---- Rocketflare-legacy steps (pre-contract Rocketflare only; see rocketflare-legacy.ts) ----

const LEGACY_BEFORE = __LEGACY_BEFORE__
const PRESERVE_ANCHOR = "'github.com/rocketflare-dev/rocketflare',"
const PRESERVE_EXTRA = __PRESERVE_EXTRA__
const LEGACY_TOMLS = { production: 'apps/web/wrangler.toml', staging: 'apps/web/wrangler.staging.toml' }

/**
 * Whether the pre-contract Rocketflare workarounds run for this kit checkout, and from which
 * version: kit.id rocketflare and no launch.kit.json (every release up to 0.17.x).
 */
function rocketflareLegacy(kitDir, kitVersion) {
  const on = KIT.id === 'rocketflare' && !fs.existsSync(path.join(kitDir, 'launch.kit.json'))
  return {
    on,
    version: kitVersion,
    before: max => on && versionBelow(kitVersion, max),
  }
}

/** rocketflare#37: keep every rocketflare-dev/ reference through the rename (kits before 0.15.2). */
function patchPreserved(appDir) {
  const rel = 'scripts/lib/rename-lib.mjs'
  const file = path.join(appDir, rel)
  if (!fs.existsSync(file)) fail(rel + ' is missing: this is not a Rocketflare kit', 1)
  let text = fs.readFileSync(file, 'utf8')
  // Kit 0.15.2+ fixes rocketflare#37 itself: KIT.preservedPattern keeps every rocketflare-dev/
  // reference, and KIT.preserved no longer lists the org (the anchor below is gone).
  if (/\bpreservedPattern\s*:/.test(text)) {
    log('KIT.preservedPattern keeps the rocketflare-dev/ references: nothing to patch (rocketflare#37 is fixed in this kit).')
    return
  }
  const missing = PRESERVE_EXTRA.filter(l => !text.includes("'" + l + "'"))
  if (missing.length) {
    const at = text.indexOf(PRESERVE_ANCHOR)
    if (at === -1) fail('KIT.preserved in ' + rel + ' has no ' + PRESERVE_ANCHOR + ' line to patch after (rocketflare#37)', 1)
    const lineStart = text.lastIndexOf('\n', at) + 1
    const lineEnd = text.indexOf('\n', at) + 1
    const indent = text.slice(lineStart, at)
    const added = missing.map(l => indent + "'" + l + "',\n").join('')
    text = text.slice(0, lineEnd) + added + text.slice(lineEnd)
    fs.writeFileSync(file, text)
  }
  const out = run(
    'node',
    ['--input-type=module', '-e', "import('./" + rel + "').then(m => process.stdout.write(JSON.stringify(m.KIT.preserved)))"],
    { cwd: appDir, capture: true, quiet: true }
  )
  const preserved = JSON.parse(out)
  for (const l of PRESERVE_EXTRA) {
    if (!preserved.includes(l)) fail('KIT.preserved does not include ' + l + ' after the patch', 1)
  }
  for (let i = 0; i < preserved.length; i++) {
    for (let j = i + 1; j < preserved.length; j++) {
      if (preserved[j].includes(preserved[i])) {
        fail('KIT.preserved must be longest first: ' + preserved[i] + ' comes before ' + preserved[j], 1)
      }
    }
  }
  log('KIT.preserved: ' + preserved.join(', '))
}

// Run with the kit's own tsx from the app root. The kit's patchToml writes the binding blocks,
// migrations and vars; the crons and run_worker_first prefixes are appended HERE, because the
// kit's appendToArray (0.15) counts a value quoted in a COMMENT as present, and the kit's tomls
// mention the analytics plugin's "/cubejs-api", "/mcp" and "15 * * * *" in comments (issue 1).
const PLUGIN_DECLARATIONS_TS = [
  "// Written by Launch's scaffold job and deleted with .launch/: every installed plugin's",
  '// declarations into BOTH tomls, as pnpm provision cloudflare <env> writes them (D31).',
  "import fs from 'node:fs'",
  "import path from 'node:path'",
  "import { readManifest } from '../scripts/lib/manifest.mjs'",
  "import { patchToml, readTomlString } from '../apps/web/scripts/provision/patch-toml'",
  'import {',
  '  pluginBindingBlocks,',
  '  pluginDeclarations,',
  '  pluginMigrationBlocks,',
  '  readPluginResources,',
  "} from '../apps/web/scripts/provision/plugin-resources'",
  '',
  '/** The body of a key = [ ... ] array (comment- and string-aware), or null. */',
  'function arrayRange(text: string, key: string): { start: number; end: number } | null {',
  "  const m = new RegExp('^' + key + '\\\\s*=\\\\s*\\\\[', 'm').exec(text)",
  '  if (!m) return null',
  '  let inString = false',
  '  let inComment = false',
  '  for (let i = m.index + m[0].length; i < text.length; i++) {',
  '    const ch = text[i]',
  "    if (inComment) { if (ch === '\\n') inComment = false; continue }",
  "    if (inString) { if (ch === '\\\\') i++; else if (ch === '\"') inString = false; continue }",
  "    if (ch === '#') inComment = true",
  "    else if (ch === '\"') inString = true",
  "    else if (ch === ']') return { start: m.index + m[0].length, end: i }",
  '  }',
  '  return null',
  '}',
  '',
  '/** The quoted values of an array body, ignoring anything in a comment. */',
  'function arrayValues(inner: string): string[] {',
  '  const out: string[] = []',
  "  for (const line of inner.split('\\n')) {",
  "    let code = ''",
  '    let inString = false',
  '    for (let i = 0; i < line.length; i++) {',
  '      const ch = line[i]',
  "      if (!inString && ch === '#') break",
  "      if (ch === '\"') inString = !inString",
  '      code += ch',
  '    }',
  '    for (const v of code.matchAll(/"([^"]*)"/g)) out.push(v[1])',
  '  }',
  '  return out',
  '}',
  '',
  'function ensureArrayValues(text: string, key: string, values: string[]): string {',
  '  const r = arrayRange(text, key)',
  "  if (!r) throw new Error('no ' + key + ' = [...] array')",
  '  const inner = text.slice(r.start, r.end)',
  '  const present = new Set(arrayValues(inner))',
  '  const missing = values.filter(v => !present.has(v))',
  '  if (missing.length === 0) return text',
  '  let body: string',
  "  if (inner.includes('\\n')) {",
  "    const indent = /\\n([ \\t]+)\\S/.exec(inner)?.[1] ?? '  '",
  "    const close = /\\n([ \\t]*)$/.exec(inner)?.[1] ?? ''",
  "    const head = inner.replace(/\\n[ \\t]*$/, '').replace(/[ \\t]+$/, '')",
  "    body = head + '\\n' + missing.map(v => indent + JSON.stringify(v) + ',').join('\\n') + '\\n' + close",
  '  } else {',
  "    body = [...arrayValues(inner), ...missing].map(v => JSON.stringify(v)).join(', ')",
  '  }',
  '  return text.slice(0, r.start) + body + text.slice(r.end)',
  '}',
  '',
  'const root = process.cwd()',
  'const { manifest } = readManifest(root)',
  'const plugins = readPluginResources(root, manifest?.surfaces ?? [])',
  "const tomls = { production: 'apps/web/wrangler.toml', staging: 'apps/web/wrangler.staging.toml' } as const",
  "const app = readTomlString(fs.readFileSync(path.join(root, tomls.production), 'utf8'), 'name')",
  "if (!app) throw new Error('apps/web/wrangler.toml has no name')",
  'const { crons, apiPrefixes, vars } = pluginDeclarations(plugins)',
  "const prefixes = apiPrefixes.flatMap(p => [p, p + '/*'])",
  'for (const env of Object.keys(tomls) as Array<keyof typeof tomls>) {',
  '  const file = path.join(root, tomls[env])',
  "  const before = fs.readFileSync(file, 'utf8')",
  '  let after = patchToml(before, {',
  '    bindings: pluginBindingBlocks(app, plugins, env),',
  '    migrations: pluginMigrationBlocks(plugins),',
  "    vars: vars.filter(v => !v.secret).map(v => ({ key: v.key, value: v.example ?? '' })),",
  '  })',
  "  if (crons.length) after = ensureArrayValues(after, 'crons', crons)",
  "  if (prefixes.length) after = ensureArrayValues(after, 'run_worker_first', prefixes)",
  "  const r1 = arrayRange(after, 'crons')",
  "  const r2 = arrayRange(after, 'run_worker_first')",
  '  const haveCrons = r1 ? arrayValues(after.slice(r1.start, r1.end)) : []',
  '  const havePrefixes = r2 ? arrayValues(after.slice(r2.start, r2.end)) : []',
  '  const lost = [...crons.filter(c => !haveCrons.includes(c)), ...prefixes.filter(p => !havePrefixes.includes(p))]',
  "  if (lost.length) throw new Error(tomls[env] + ': could not write ' + lost.join(', '))",
  '  if (after !== before) fs.writeFileSync(file, after)',
  "  console.log(tomls[env] + ': plugin declarations ' + (after !== before ? 'written' : 'unchanged') + ' (' + plugins.map(p => p.id).join(', ') + ')')",
  '}',
  '',
].join('\n')

// Kit tests a renamed, provisioned copy fails through no fault of its own (issues 2 and 3,
// rocketflare-plugins#8). Each is an exact edit; one whose anchor is gone (fixed upstream, or a
// different kit) is skipped with a warning, and the gate says whether that still matters.
function kitTestPatches(slug, legacy) {
  const file = 'apps/web/tests/config/update-check-lib.test.ts'
  const updateCheck = legacy.before(LEGACY_BEFORE.updateCheckLibPatches)
  return [
    {
      when: updateCheck,
      file,
      why: 'the rename rewrote the regex the manifest file name is matched with',
      find: 'toMatch(/no \\.' + slug + '/)',
      replace: 'toMatch(/no \\.rocketflare/)',
    },
    {
      when: updateCheck,
      file,
      why: 'a renamed copy is not the kit: its manifest has an app block',
      find: "  it('stays silent in the kit repository itself (its manifest has app: null)'",
      replace:
        '  // Skipped by Launch: a renamed copy is not the kit (its manifest has an app block).\n' +
        "  it.skip('stays silent in the kit repository itself (its manifest has app: null)'",
    },
    {
      // The analytics plugin (3.4.1) ships this test without declaring it in its own
      // unscopedAllowlist. The kit's CI never sees it (the plugin is not committed there); a
      // committed install is scanned, so the reason is recorded here, as Launch itself did.
      // Only while the delete is unscoped: 3.4.2 names the tenant (plugins#8, kit 0.16.0's
      // default), and the scan fails a stale entry.
      when: legacy.on,
      file: 'apps/web/tests/config/unscoped-allowlist.test.ts',
      requires: 'apps/web/src/plugins/analytics/tests/api/dashboard-visibility.test.ts',
      requiresText: 'db.delete(analyticsPageGroups).where(eq(analyticsPageGroups.pageId, orphaned))',
      why: 'the analytics plugin test the allow-list scan finds once the plugin is committed',
      find: "one flush may hold spans from more than one tenant — D32',\n}",
      replace:
        "one flush may hold spans from more than one tenant — D32',\n" +
        '  // Added by Launch: the analytics plugin ships this test without declaring it in its own\n' +
        '  // unscopedAllowlist, so the entry lives here until the plugin carries it (upstream).\n' +
        "  'src/plugins/analytics/tests/api/dashboard-visibility.test.ts':\n" +
        "    'a TEST, not runtime code: it deletes the group grants of a page it just created by page id (a uuid it owns) to set up the \"empty grant list is private\" case',\n" +
        '}',
    },
    {
      // Its unprovision() regex is unanchored, so under DATABASE_DRIVER=neon it matches the
      // COMMENTED HYPERDRIVE example and rewrites the real 32-hex KV id instead: every copy
      // fails once write_config puts real ids in (issue 2a).
      when: legacy.on,
      file: 'apps/web/tests/config/patch-toml.test.ts',
      why: 'unprovision() must only match a real HYPERDRIVE block, not the commented example',
      find: '/(binding = "HYPERDRIVE"\\n(?:[^\\n]*\\n)*?id = ")[0-9a-f]{32}(")/,',
      replace: '/(^binding = "HYPERDRIVE"\\n(?:[^\\n]*\\n)*?id = ")[0-9a-f]{32}(")/m,',
    },
    {
      // The shipped production toml has no workers_dev line (its tests insert a note there);
      // write_config adds workers_dev = false to both files, so production's is dropped again
      // (issue 2b).
      when: legacy.on,
      file: 'apps/web/tests/config/patch-toml.test.ts',
      why: 'the shipped production shape has no workers_dev line; Launch writes one',
      find: "    .replace(/^routes = \\[/m, '# routes = [')\n}",
      replace:
        "    .replace(/^routes = \\[/m, '# routes = [')\n" +
        "    .replace(/\\n(?:# Launch[^\\n]*\\n)?workers_dev = false\\n/, env === 'production' ? '\\n' : '$&')\n" +
        '}',
    },
    {
      when: legacy.on,
      file: 'apps/web/tests/config/patch-toml.test.ts',
      why: 'a note on the two edits above',
      find: "\nfunction unprovision(text: string, env: 'staging' | 'production'): string {",
      replace:
        '\n// Edited by Launch: the HYPERDRIVE match is anchored (it matched the commented example and\n' +
        '// rewrote the real KV id), and write_config’s workers_dev = false is dropped from production.\n' +
        "function unprovision(text: string, env: 'staging' | 'production'): string {",
    },
  ]
}

function patchKitTests(appDir, slug, legacy) {
  for (const p of kitTestPatches(slug, legacy)) {
    if (!p.when) continue
    const abs = path.join(appDir, p.file)
    if (!fs.existsSync(abs)) continue
    if (p.requires && !fs.existsSync(path.join(appDir, p.requires))) continue
    if (p.requiresText && !fs.readFileSync(path.join(appDir, p.requires), 'utf8').includes(p.requiresText)) {
      log(p.file + ': no patch for "' + p.why + '" (fixed upstream)')
      continue
    }
    const text = fs.readFileSync(abs, 'utf8')
    if (text.includes(p.replace)) continue
    if (!text.includes(p.find)) {
      warn(p.file + ': the patch for "' + p.why + '" no longer applies; skipped')
      continue
    }
    // A function, so a $ in the replacement is literal.
    fs.writeFileSync(abs, text.replace(p.find, () => p.replace))
    log(p.file + ': patched (' + p.why + ')')
  }
}

/** The kit's default-plugins loop (its CI's), then the declarations and a lockfile that matches. */
function legacyDefaultPlugins(appDir, slug) {
  const devVars = path.join(appDir, 'apps/web/.dev.vars')
  const createdDevVars = !fs.existsSync(devVars)
  // db:generate runs dotenv -e .dev.vars (as on a laptop); a throwaway URL, never used to connect.
  if (createdDevVars) {
    fs.writeFileSync(devVars, 'DATABASE_URL=postgresql://test:test@localhost:5433/' + slug.replace(/-/g, '_') + '_test\n')
  }
  try {
    const tsv = run('node', ['scripts/default-plugins.mjs', '--tsv'], { cwd: appDir, capture: true })
    const entries = tsv.split('\n').filter(Boolean).map(line => line.split('\t'))
    if (entries.length === 0) log('No default plugins.')
    for (const [id, repo, ref, subdir] of entries) {
      if (!id) continue
      const spec = ref ? repo + '@' + ref : repo
      const args = ['plugin', 'add', spec]
      if (subdir) args.push('--subdir', subdir)
      args.push('--apply', '--allow-dirty')
      run('pnpm', args, { cwd: appDir })
      const version = run(
        'node',
        [
          '--input-type=module',
          '-e',
          "import('./scripts/lib/manifest.mjs').then(({ readManifest }) => { const { manifest } = readManifest(); const s = ((manifest && manifest.surfaces) || []).find(x => x.id === " +
            JSON.stringify(id) +
            "); process.stdout.write((s && s.source && s.source.version) || 'unpinned') })",
        ],
        { cwd: appDir, capture: true, quiet: true }
      ).trim()
      run('pnpm', ['db:generate', '--name', 'plugin-' + id + '-' + version], { cwd: appDir })
    }
    if (entries.length > 0) {
      fs.mkdirSync(path.join(appDir, '.launch'), { recursive: true })
      fs.writeFileSync(path.join(appDir, '.launch/plugin-declarations.ts'), PLUGIN_DECLARATIONS_TS)
      run('pnpm', ['exec', 'tsx', '.launch/plugin-declarations.ts'], { cwd: appDir })
      // docs/plugin-api.md carries used-by annotations from the installed plugins, and the app's
      // gate diffs it: regenerate it now, as the kit's rule for a committed install says.
      if (fs.existsSync(path.join(appDir, 'scripts/plugin-api-doc.mjs'))) {
        run('node', ['scripts/plugin-api-doc.mjs'], { cwd: appDir })
      }
    }
    run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: appDir })
    if (run('pnpm', ['lint:fix'], { cwd: appDir, allowFail: true }).status !== 0) {
      warn('pnpm lint:fix reported problems it could not fix; the gate will show them')
    }
  } finally {
    if (createdDevVars) fs.rmSync(devVars, { force: true })
  }
}

/** Issue 5: before 0.15.8 the test that reads plugin-ci.yml sat in tests/config/, not kit-only/. */
function legacyRemoveFiles(appDir, legacy) {
  if (legacy.before(LEGACY_BEFORE.pluginCiTest)) {
    fs.rmSync(path.join(appDir, 'apps/web/tests/config/plugin-ci.test.ts'), { force: true })
  }
}

/** The copy's root package.json has a gate script: the kit's pnpm gate (0.16.0+). */
function hasGateScript(appDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
    return Boolean(pkg && pkg.scripts && pkg.scripts.gate)
  } catch {
    return false
  }
}

/** Pre-contract Rocketflare's gate: pnpm gate lint typecheck (0.16.0+) or the scripts by name. */
function legacyGate(appDir) {
  if (hasGateScript(appDir)) run('pnpm', ['gate', 'lint', 'typecheck'], { cwd: appDir })
  else {
    run('pnpm', ['lint'], { cwd: appDir })
    run('pnpm', ['typecheck'], { cwd: appDir })
  }
  run('pnpm', ['web', 'test:config'], { cwd: appDir })
}
`
  .replace('__LEGACY_BEFORE__', () => JSON.stringify(ROCKETFLARE_LEGACY_BEFORE))
  .replace('__PRESERVE_EXTRA__', () => JSON.stringify(PRESERVED_ORG_REFS))
