#!/usr/bin/env node
/**
 * `pnpm cli:publish [--dry-run] [--provenance]` — publish the `launch` CLI to npm as
 * `@rocketflare-dev/launch`. The workspace package stays `@launch/cli` (private, `workspace:*`
 * shared contracts); what ships is its esbuild bundle (`apps/cli/dist/cli.js`, `@launch/shared`
 * inlined) staged into `apps/cli/.npm/` with a public `package.json` whose runtime dependencies are
 * the bundle's externals.
 *
 * The version is the ROOT `package.json` version (release = root version: one tag ships web and
 * CLI) and must equal `apps/cli/package.json`'s, which the bundle prints for `--version`
 * (`cli-version.test.ts` keeps them in step). Run by hand after `npm login`, and by
 * `.github/workflows/publish.yml` on a release tag (`--provenance`, npm trusted publishing — no token). A version
 * already on npm is skipped, not an error, so re-running a tag's job is safe.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const NPM_NAME = '@rocketflare-dev/launch'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'apps/cli')
const STAGE = path.join(CLI, '.npm')
/** What esbuild leaves external (apps/cli `build` script): the published package depends on these. */
const RUNTIME_DEPS = ['chalk', 'commander', 'open', 'zod']

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const provenance = args.has('--provenance')

const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { cwd: ROOT, stdio: 'inherit', encoding: 'utf8', ...opts })

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

const root = readJson(path.join(ROOT, 'package.json'))
const cli = readJson(path.join(CLI, 'package.json'))
const version = root.version
if (cli.version !== version) {
  fail(`apps/cli/package.json is ${cli.version} but the root is ${version} — bump them together`)
}

const published = (() => {
  try {
    return execFileSync('npm', ['view', `${NPM_NAME}@${version}`, 'version'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
})()
if (published === version) {
  console.log(`${NPM_NAME}@${version} is already on npm — nothing to do.`)
  process.exit(0)
}

console.log(`Building ${NPM_NAME}@${version}…`)
run('pnpm', ['--filter', '@launch/cli', 'build'])

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(path.join(STAGE, 'dist'), { recursive: true })
cpSync(path.join(CLI, 'dist/cli.js'), path.join(STAGE, 'dist/cli.js'))
cpSync(path.join(CLI, 'README.md'), path.join(STAGE, 'README.md'))
cpSync(path.join(ROOT, 'LICENSE'), path.join(STAGE, 'LICENSE'))

const dependencies = Object.fromEntries(
  RUNTIME_DEPS.map(name => {
    const range = cli.dependencies?.[name]
    if (!range) fail(`apps/cli/package.json has no dependency on ${name}`)
    return [name, range]
  })
)
writeFileSync(
  path.join(STAGE, 'package.json'),
  `${JSON.stringify(
    {
      name: NPM_NAME,
      version,
      description: 'Rocketflare Launch — the control plane. The `launch` command-line interface.',
      license: cli.license,
      type: 'module',
      bin: { launch: 'dist/cli.js' },
      files: ['dist', 'README.md', 'LICENSE'],
      engines: { node: '>=22' },
      dependencies,
      repository: {
        type: 'git',
        url: 'git+https://github.com/rocketflare-dev/rocketflare-launch.git',
        directory: 'apps/cli',
      },
      homepage: 'https://github.com/rocketflare-dev/rocketflare-launch/tree/main/apps/cli#readme',
      publishConfig: { access: 'public' },
    },
    null,
    2
  )}\n`
)

// The bundle must run on its own and report the version it is published as.
const printed = execFileSync('node', [path.join(STAGE, 'dist/cli.js'), '--version'], {
  cwd: CLI,
  encoding: 'utf8',
}).trim()
if (printed !== version) fail(`the bundle prints ${printed}, expected ${version}`)

// From inside the staged folder: npm checks `bin` paths against its cwd, not the folder argument.
const publishArgs = ['publish', '--access', 'public']
if (provenance) publishArgs.push('--provenance')
if (dryRun) publishArgs.push('--dry-run')
console.log(`${dryRun ? 'Dry run: ' : ''}npm ${publishArgs.join(' ')}`)
run('npm', publishArgs, { cwd: STAGE })
console.log(
  dryRun
    ? `✓ ${NPM_NAME}@${version} packs cleanly (nothing published)`
    : `✓ Published ${NPM_NAME}@${version} — npm i -g ${NPM_NAME}`
)
