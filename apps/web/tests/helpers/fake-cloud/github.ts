/**
 * FakeGitHub — the GitHub App, its installation tokens and the repo surface Launch drives,
 * stateful. Repositories keep real git-shaped state (refs → commits → flat trees of file
 * contents), so a test can commit through the Git Data API and read the files back through
 * `getRepoFile` (raw contents) or `readFile()`. See `index.ts` for the API.
 *
 * Tokens are checked the way GitHub checks them: app endpoints want the app JWT (any compact JWS
 * here), everything else a live installation token — a revoked or unknown one is a 401, a token
 * narrowed to other repositories is a 403, and moving a ref over a change to `.github/workflows/*`
 * needs `workflows: write` (the reason the scaffold job gets its own token, plan §0.1).
 *
 * P3 adds pull requests and CI: `POST …/pulls` (`pull_requests: write`; the head branch must exist,
 * and a second OPEN one from the same head is GitHub's 422), `GET …/pulls?state&head=owner:branch`,
 * `GET …/pulls/{n}`, and the two CI reads on a commit — `GET …/commits/{ref}/check-runs`
 * (`checks: read`) and `GET …/commits/{ref}/status`, the combined status (`statuses: read`: no
 * statuses is `pending` with `total_count: 0`, as GitHub answers). A test sets CI with
 * `setCheckRuns(owner, repo, ref, runs)` / `setStatuses(owner, repo, ref, statuses)` (the ref is
 * resolved to its sha when set) and reads `pulls`.
 *
 * P4 adds the release dance (plan §1.8): `POST …/git/refs` (a tag; 422 when it exists),
 * `POST …/releases` and `GET …/releases/tags/{tag}` (`releases`; `onRelease` is awaited after an
 * API-published one — the test's stand-in for `release: published` starting the production job),
 * `GET …/compare/{base}...{head}` (the commits reachable from head and not from base, oldest
 * first) and `GET …/commits/{sha}/pulls` (the PR a merge commit merged, or whose head it is).
 * Pull requests carry `merged_at`, `merge_commit_sha` and `user.login`. Test hooks:
 * `openPull(owner, repo, {head, base?, title, author?})` (a PR nobody opened through the API — a
 * person's, which a release's compare must still find), `merge(owner, repo, number)` (a merge
 * commit on the base branch, the PR closed and merged), `closePull(owner, repo, number)`, and
 * `publish(owner, repo, tag)` (a Release published in GitHub by hand — the job-originated path).
 *
 * Issue #5 (`docs/plans/i5-ship-to-staging.md` §3 S1) adds what a landing and the branch-protection
 * diagnosis call: an open PR's `head.sha` follows its branch (as GitHub's does), so a push after
 * the gate is visible; `PUT …/pulls/{n}/merge` (`contents: write`; squash by default — one commit
 * on the base with the head's files, the PR closed and merged, recorded in `merges` /
 * `mergeCount`; 409 when `sha` is not the head, 405 when closed or a required check is not green
 * on the head; issue #11: `mergeCommitChecks`, when set, is every new merge commit's CI); check runs carry an `id` (= the Actions job's) and `app.slug` (default
 * `github-actions`); `GET …/actions/jobs/{id}/logs` (`actions: read`; `setJobLog(owner, repo, id,
 * log)`, 404 without one); `GET …/check-runs/{id}/annotations` (a run's `annotations`); rulesets —
 * `GET|POST …/rulesets`, `GET|PUT …/rulesets/{id}` (`administration`; `current_user_can_bypass`
 * from an `Integration` bypass actor naming the App's id; 403 after `disableRulesets(owner, repo)`,
 * a plan without them) — and `GET …/branches/{b}/protection` (classic; 404 "Branch not protected").
 * The hook `protect(owner, repo, { requiredChecks, bypassAppId?, classic?, name? })` protects the
 * default branch; a direct ref update of it (`updateRef`, so `commitFiles`) by a token the rules
 * do not let bypass is then a 422.
 *
 * A release tag's deploy run (`releases/tag-run.ts`): `pushTagRun(owner, repo, tag, { status,
 * conclusion, jobs })` records the run a tag push starts (`event: push`); `GET …/workflows/{f}/runs`
 * filters by `branch` (a branch or tag name) and `event`, and `GET …/actions/runs/{id}/jobs`
 * (`actions: read`) lists its jobs.
 *
 * Issue #9: `POST …/check-runs` (`checks: write`; 422 for a sha with no commit) adds a run to the
 * head's list (answered by `GET …/check-runs` with its `external_id`) and records it in
 * `createdCheckRuns`. A token mint asking for more than the installation lists (`checks: write`
 * on an installation with `checks: read`) is GitHub's 422.
 *
 * App page P2 (stage-aware Retry): `POST …/actions/runs/{id}/rerun-failed-jobs` (`actions: write`;
 * a completed, unsuccessful run's next attempt — `run_attempt + 1`, its failed and cancelled jobs
 * queued again — recorded in `reruns`; 403 for a run still going or one that succeeded) and
 * `POST …/actions/runs/{id}/cancel` (`actions: write`; the run and its unfinished jobs end
 * `cancelled`, recorded in `cancels`; 409 for a completed run). `pushRun(owner, repo, ref, …)`
 * records any run (a production run on a tag is `event: release`).
 */
import {
  belongsTo,
  type FakeRequest,
  type IdSource,
  json,
  noContent,
  type ResourceLabel,
  type VendorHandler,
} from './core'

export interface FakeInstallationToken {
  token: string
  installationId: number
  expires_at: string
  /** Repository NAMES it may touch; null = every repository of the installation. */
  repositories: string[] | null
  /** Narrowed permissions; null = the installation's own. */
  permissions: Record<string, string> | null
  revoked: boolean
}

export interface FakeCommit {
  sha: string
  tree: string
  parents: string[]
  message: string
}

export interface FakeWorkflowRun {
  id: number
  owner: string
  repo: string
  workflow: string
  ref: string
  inputs: Record<string, string>
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  head_sha: string
  run_attempt: number
  created_at: string
  /** What started it (default `workflow_dispatch`); a tag push's run is `push`. */
  event?: string
  /** `GET …/actions/runs/{id}/jobs` (default none); a test flips their status as the run goes. */
  jobs?: FakeWorkflowJob[]
}

export interface FakeWorkflowJob {
  id?: number
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion?: string | null
}

export interface FakeRepo {
  id: number
  owner: string
  name: string
  description: string | null
  private: boolean
  archived: boolean
  default_branch: string
  /** `heads/main` → commit sha; `tags/x` → commit sha. */
  refs: Map<string, string>
  environments: Map<string, Record<string, unknown>>
  variables: Map<string, string>
}

export interface FakeGitHubPull {
  number: number
  owner: string
  repo: string
  head: string
  base: string
  title: string
  body: string
  state: 'open' | 'closed'
  /** The head branch's sha when the PR was opened. */
  headSha: string
  /** P4: the author's login — the App's bot for a PR opened through the API. */
  author: string
  /** P4: set by `merge()`. */
  merged: boolean
  mergedAt: string | null
  mergeSha: string | null
}

/** P4: a GitHub Release (`POST …/releases`, or `publish()`). */
export interface FakeGitHubRelease {
  id: number
  owner: string
  repo: string
  tag: string
  name: string
  body: string
  draft: boolean
  prerelease: boolean
  /** The commit the tag points at. */
  sha: string
  publishedAt: string | null
  /** `api` when Launch published it; `hook` when a test (a person in GitHub) did. */
  via: 'api' | 'hook'
}

export interface FakeCheckRun {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion?: string | null
  html_url?: string
  /** Issue #5: the check run's id (= the Actions job's id); `setCheckRuns` assigns one when absent. */
  id?: number
  /** Issue #5: the reporting App's slug, answered as `app.slug` (default `github-actions`). */
  app?: string
  /** Issue #5: what `GET …/check-runs/{id}/annotations` answers (default none). */
  annotations?: FakeCheckAnnotation[]
  /** Issue #9: the reporter's own id (`launch/gate`'s `tree:<sha>`), answered as `external_id`. */
  external_id?: string
  /** Issue #9: what a `POST …/check-runs` sent as `output`. */
  output?: { title?: string; summary?: string; text?: string }
  /** Issue #9: the sha a `POST …/check-runs` named. */
  head_sha?: string
}

/** Issue #5: one check-run annotation. */
export interface FakeCheckAnnotation {
  path: string
  start_line: number
  annotation_level: 'notice' | 'warning' | 'failure'
  title?: string
  message: string
}

/** Issue #5: a repository ruleset (`POST …/rulesets`, or `protect()`). */
export interface FakeRuleset {
  id: number
  name: string
  target: 'branch'
  enforcement: 'active' | 'evaluate' | 'disabled'
  bypass_actors: { actor_id: number | null; actor_type: string; bypass_mode: string }[]
  conditions: { ref_name: { include: string[]; exclude: string[] } }
  rules: { type: string; parameters?: Record<string, unknown> }[]
}

/** Issue #5: what `protect()` sets up on a repo's default branch. */
export interface FakeProtectInput {
  /** The status checks a merge (and a direct push) needs green. */
  requiredChecks: string[]
  /** An App id the ruleset lets bypass (`Integration`, `always`) — Launch's is `opts.appId`. */
  bypassAppId?: number
  /** Classic branch protection instead of a ruleset: nothing can bypass it. */
  classic?: boolean
  /** The ruleset's name (default `branch-protection`). */
  name?: string
}

/** Issue #5: one merge through the API (`PUT …/pulls/{n}/merge`). */
export interface FakeMerge {
  owner: string
  repo: string
  number: number
  /** The merge commit. */
  sha: string
  /** The PR head it merged. */
  headSha: string
  method: 'squash' | 'merge' | 'rebase'
  title: string | null
  message: string | null
}

export interface FakeCommitStatus {
  context: string
  state: 'pending' | 'success' | 'failure' | 'error'
  target_url?: string
}

export interface FakeGitHubOptions {
  org: string
  appId: number
  installationId: number
  /** The installation's permissions (default: everything Launch needs). */
  permissions?: Record<string, string>
}

const ghError = (status: number, message: string) =>
  json({ message, documentation_url: 'https://docs.github.com/rest' }, status)

const DEFAULT_PERMISSIONS = {
  administration: 'write',
  contents: 'write',
  workflows: 'write',
  actions: 'write',
  environments: 'write',
  actions_variables: 'write',
  metadata: 'read',
  // P3: sessions open PRs and read their CI (issue #9: and post the `launch/gate` check run).
  pull_requests: 'write',
  checks: 'write',
  statuses: 'read',
}

export class FakeGitHub implements VendorHandler {
  /** Keyed `owner/name` (lower-case). A deleted repo is removed. */
  readonly repos = new Map<string, FakeRepo>()
  readonly tokens = new Map<string, FakeInstallationToken>()
  readonly commits = new Map<string, FakeCommit>()
  readonly trees = new Map<string, Map<string, string>>()
  readonly runs: FakeWorkflowRun[] = []
  /** App page P2: every accepted "re-run failed jobs" (`{ runId, attempt }` — the new attempt). */
  readonly reruns: { runId: number; attempt: number }[] = []
  /** App page P2: every accepted run cancel, by run id. */
  readonly cancels: number[] = []
  /** Called after each accepted `workflow_dispatch` (awaited) — the test's stand-in for the job. */
  onDispatch: ((run: FakeWorkflowRun) => unknown | Promise<unknown>) | null = null
  /** P3: every pull request opened, in order. */
  readonly pulls: FakeGitHubPull[] = []
  /** P3: `owner/name@sha` (lower-case repo) → the commit's check runs / statuses. */
  readonly checkRuns = new Map<string, FakeCheckRun[]>()
  /** Issue #9: every check run Launch POSTed (`launch/gate`), in order. */
  readonly createdCheckRuns: (FakeCheckRun & { owner: string; repo: string })[] = []
  readonly statuses = new Map<string, FakeCommitStatus[]>()
  /** P4: every release published, in order. */
  readonly releases: FakeGitHubRelease[] = []
  /** P4: called after each release published through the API (awaited) — `release: published`. */
  onRelease: ((release: FakeGitHubRelease) => unknown | Promise<unknown>) | null = null
  /** Issue #5: every merge through the API, in order (`mergeCount` counts them). */
  readonly merges: FakeMerge[] = []
  /**
   * Issue #11: the check runs every NEW merge commit (an API squash, or `merge()`) reports at once —
   * the default branch's CI on the push, as a landing's `land.main-ci` reads it. Null (the
   * default): a merge commit reports nothing until a test sets its runs.
   */
  mergeCommitChecks: FakeCheckRun[] | null = null
  /** Issue #5: `owner/name` (lower-case) → the repo's rulesets. */
  readonly rulesets = new Map<string, FakeRuleset[]>()
  /** Issue #5: `owner/name` (lower-case) → classic protection on one branch. */
  readonly classicProtection = new Map<string, { branch: string; requiredChecks: string[] }>()
  /** Issue #5: repos whose plan has no rulesets or protection (a private repo, free plan). */
  readonly rulesetsUnavailable = new Set<string>()
  /** Issue #5: `owner/name#jobId` (lower-case repo) → the Actions job's log. */
  readonly jobLogs = new Map<string, string>()

  constructor(
    private readonly ids: IdSource,
    readonly opts: FakeGitHubOptions
  ) {}

  get permissions(): Record<string, string> {
    return this.opts.permissions ?? DEFAULT_PERMISSIONS
  }

  resourcesFor(slug: string): ResourceLabel[] {
    return [...this.repos.values()]
      .filter(r => !r.archived && belongsTo(slug, r.name))
      .map(r => `github:repo:${r.owner}/${r.name}`)
  }

  repo(owner: string, name: string): FakeRepo | undefined {
    return this.repos.get(`${owner}/${name}`.toLowerCase())
  }

  /** Mint an installation token directly (as `POST …/access_tokens` would). */
  issueToken(
    scope: { repositories?: string[]; permissions?: Record<string, string> } = {}
  ): FakeInstallationToken {
    const token: FakeInstallationToken = {
      token: this.ids.secret('ghs_'),
      installationId: this.opts.installationId,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      repositories: scope.repositories ?? null,
      permissions: scope.permissions ?? null,
      revoked: false,
    }
    this.tokens.set(token.token, token)
    return token
  }

  /** The files of `ref` (a branch, `heads/x`, a tag or a commit sha), or null. */
  filesAt(owner: string, name: string, ref?: string): Map<string, string> | null {
    const repo = this.repo(owner, name)
    if (!repo) return null
    const sha = this.resolveRef(repo, ref ?? repo.default_branch)
    if (!sha) return null
    const commit = this.commits.get(sha)
    return commit ? (this.trees.get(commit.tree) ?? null) : null
  }

  /** One file's contents at `ref` (default branch when omitted), or null. */
  readFile(owner: string, name: string, path: string, ref?: string): string | null {
    return this.filesAt(owner, name, ref)?.get(path) ?? null
  }

  /**
   * Commit `files` onto a branch directly (no token) — what a scaffold job's `git push` leaves
   * behind. `null` deletes a path. Returns the new commit sha.
   */
  pushCommit(
    owner: string,
    name: string,
    files: Record<string, string | null>,
    message = 'test commit',
    branch?: string
  ): string {
    const repo = this.repo(owner, name)
    if (!repo) throw new Error(`FakeGitHub: no repo ${owner}/${name}`)
    const ref = `heads/${branch ?? repo.default_branch}`
    const parent = repo.refs.get(ref) ?? null
    const base = parent ? this.trees.get(this.commits.get(parent)?.tree ?? '') : undefined
    const tree = this.writeTree(base ?? new Map(), Object.entries(files))
    const sha = this.writeCommit(tree, parent ? [parent] : [], message)
    repo.refs.set(ref, sha)
    return sha
  }

  private ciKey(owner: string, name: string, ref: string): string {
    const repo = this.repo(owner, name)
    const sha = repo ? (this.resolveRef(repo, ref) ?? ref) : ref
    return `${owner}/${name}`.toLowerCase() + `@${sha}`
  }

  /**
   * P3: the check runs `ref` (resolved to its sha now) reports. Issue #5: each gets an `id` (the
   * Actions job's) when it has none; the stored runs are returned so a test can read them.
   */
  setCheckRuns(owner: string, name: string, ref: string, runs: FakeCheckRun[]): FakeCheckRun[] {
    const stored = runs.map(run => ({ ...run, id: run.id ?? this.ids.number() }))
    this.checkRuns.set(this.ciKey(owner, name, ref), stored)
    return stored
  }

  /**
   * The run a tag push starts (`deploy.yml`, `event: push`, `head_branch` the tag) — what the
   * pipeline strip and a landing follow (`releases/tag-run.ts`). Returned so a test can move it:
   * `run.status = 'completed'; run.conclusion = 'failure'; run.jobs[1].status = …`.
   */
  pushTagRun(
    owner: string,
    name: string,
    tag: string,
    input: {
      workflow?: string
      status?: FakeWorkflowRun['status']
      conclusion?: string | null
      jobs?: FakeWorkflowJob[]
    } = {}
  ): FakeWorkflowRun {
    const repo = this.repo(owner, name)
    if (!repo) throw new Error(`pushTagRun: no repo ${owner}/${name}`)
    const run: FakeWorkflowRun = {
      id: this.ids.number(),
      owner: repo.owner,
      repo: repo.name,
      workflow: input.workflow ?? 'deploy.yml',
      ref: `refs/tags/${tag}`,
      inputs: {},
      status: input.status ?? 'queued',
      conclusion: input.conclusion ?? null,
      head_sha:
        this.resolveRef(repo, `tags/${tag}`) ?? this.resolveRef(repo, repo.default_branch) ?? '',
      run_attempt: 1,
      created_at: new Date().toISOString(),
      event: 'push',
      jobs: (input.jobs ?? []).map(j => ({ ...j, id: j.id ?? this.ids.number() })),
    }
    this.runs.push(run)
    return run
  }

  /**
   * App page P2: any run of `deploy.yml` on `ref` (`refs/tags/X` or `refs/heads/b`) — a production
   * run a published Release started is `event: release`. Returned so a test can move it, and its
   * `id` is what the deploy job's OIDC `run_id` claim must carry.
   */
  pushRun(
    owner: string,
    name: string,
    ref: string,
    input: {
      event?: string
      workflow?: string
      status?: FakeWorkflowRun['status']
      conclusion?: string | null
      jobs?: FakeWorkflowJob[]
    } = {}
  ): FakeWorkflowRun {
    const tag = ref.replace(/^refs\/(heads|tags)\//, '')
    const run = this.pushTagRun(owner, name, tag, input)
    run.ref = ref
    run.event = input.event ?? 'push'
    return run
  }

  /** Issue #5: the log `GET …/actions/jobs/{jobId}/logs` answers (null: none — GitHub's 404). */
  setJobLog(owner: string, name: string, jobId: number, log: string | null): void {
    const key = `${`${owner}/${name}`.toLowerCase()}#${jobId}`
    if (log === null) this.jobLogs.delete(key)
    else this.jobLogs.set(key, log)
  }

  /**
   * Issue #5: protect `owner/name`'s default branch — a ruleset (`pull_request` with 0 reviews,
   * `required_status_checks`, `non_fast_forward`, `deletion`) that `bypassAppId` may bypass, or
   * with `classic` classic branch protection nothing bypasses. Then a direct ref update of that
   * branch by a token that may not bypass is a 422, and a merge whose head lacks a green required
   * check is a 405. Returns the ruleset (null for classic).
   */
  protect(owner: string, name: string, input: FakeProtectInput): FakeRuleset | null {
    const repo = this.repo(owner, name)
    if (!repo) throw new Error(`FakeGitHub: no repo ${owner}/${name}`)
    const key = this.repoKey(repo)
    if (input.classic) {
      this.classicProtection.set(key, {
        branch: repo.default_branch,
        requiredChecks: [...input.requiredChecks],
      })
      return null
    }
    const ruleset: FakeRuleset = {
      id: this.ids.number(),
      name: input.name ?? 'branch-protection',
      target: 'branch',
      enforcement: 'active',
      bypass_actors:
        input.bypassAppId === undefined
          ? []
          : [{ actor_id: input.bypassAppId, actor_type: 'Integration', bypass_mode: 'always' }],
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: input.requiredChecks.map(context => ({ context })),
          },
        },
        { type: 'non_fast_forward' },
        { type: 'deletion' },
      ],
    }
    this.rulesets.set(key, [...(this.rulesets.get(key) ?? []), ruleset])
    return ruleset
  }

  /** Issue #5: the repo's plan has no rulesets (GitHub's 403 on every rulesets/protection call). */
  disableRulesets(owner: string, name: string): void {
    this.rulesetsUnavailable.add(`${owner}/${name}`.toLowerCase())
  }

  /** Issue #5: how many API merges `owner/name` (or one PR of it) has had. */
  mergeCount(owner: string, name: string, number?: number): number {
    return this.merges.filter(
      m =>
        m.owner.toLowerCase() === owner.toLowerCase() &&
        m.repo.toLowerCase() === name.toLowerCase() &&
        (number === undefined || m.number === number)
    ).length
  }

  /** P3: the commit statuses `ref` (resolved to its sha now) reports. */
  setStatuses(owner: string, name: string, ref: string, statuses: FakeCommitStatus[]): void {
    this.statuses.set(this.ciKey(owner, name, ref), statuses)
  }

  /** P4: open a pull request directly (a person's PR, not the App's). The head branch must exist. */
  openPull(
    owner: string,
    name: string,
    input: { head: string; base?: string; title: string; body?: string; author?: string }
  ): FakeGitHubPull {
    const repo = this.repo(owner, name)
    if (!repo) throw new Error(`FakeGitHub: no repo ${owner}/${name}`)
    const headSha = repo.refs.get(`heads/${input.head}`)
    if (!headSha) throw new Error(`FakeGitHub: no branch ${input.head}`)
    const pull = this.newPull(repo, {
      head: input.head,
      base: input.base ?? repo.default_branch,
      title: input.title,
      body: input.body ?? '',
      headSha,
      author: input.author ?? 'octocat',
    })
    return pull
  }

  /**
   * P4: merge an open pull request — a merge commit on the base branch (the base's files with the
   * head's on top, parents `[base, head]`), the PR closed with `merged_at` and `merge_commit_sha`.
   * Returns the merge commit's sha.
   */
  merge(owner: string, name: string, number: number, at: Date = new Date()): string {
    const repo = this.repo(owner, name)
    const pull = this.findPull(owner, name, number)
    if (!repo || !pull) throw new Error(`FakeGitHub: no pull request ${owner}/${name}#${number}`)
    if (pull.state !== 'open') throw new Error(`FakeGitHub: #${number} is not open`)
    const baseSha = repo.refs.get(`heads/${pull.base}`)
    const headSha = repo.refs.get(`heads/${pull.head}`) ?? pull.headSha
    if (!baseSha) throw new Error(`FakeGitHub: no base branch ${pull.base}`)
    const baseFiles = this.trees.get(this.commits.get(baseSha)?.tree ?? '') ?? new Map()
    const headFiles = this.trees.get(this.commits.get(headSha)?.tree ?? '') ?? new Map()
    const tree = this.writeTree(baseFiles, [...headFiles.entries()])
    const sha = this.writeCommit(
      tree,
      [baseSha, headSha],
      `Merge pull request #${number} from ${owner}/${pull.head}`
    )
    repo.refs.set(`heads/${pull.base}`, sha)
    this.mergeCommitCi(owner, name, sha)
    pull.state = 'closed'
    pull.merged = true
    pull.mergedAt = at.toISOString()
    pull.mergeSha = sha
    return sha
  }

  /** Issue #11: a new merge commit's CI, from `mergeCommitChecks` (nothing when that is null). */
  private mergeCommitCi(owner: string, name: string, sha: string): void {
    if (this.mergeCommitChecks) this.setCheckRuns(owner, name, sha, this.mergeCommitChecks)
  }

  /** P4: close a pull request without merging it. */
  closePull(owner: string, name: string, number: number): void {
    const pull = this.findPull(owner, name, number)
    if (!pull) throw new Error(`FakeGitHub: no pull request ${owner}/${name}#${number}`)
    pull.state = 'closed'
  }

  /**
   * P4: publish a Release on an existing tag by hand, as a person in GitHub would — the
   * job-originated production path. `onRelease` is NOT called: the test drives the job itself.
   */
  publish(owner: string, name: string, tag: string): FakeGitHubRelease {
    const repo = this.repo(owner, name)
    if (!repo) throw new Error(`FakeGitHub: no repo ${owner}/${name}`)
    const sha = repo.refs.get(`tags/${tag}`)
    if (!sha) throw new Error(`FakeGitHub: no tag ${tag}`)
    return this.newRelease(repo, { tag, sha, via: 'hook' })
  }

  /**
   * A repository anywhere (another org's public kit repo, say), with a first commit of `files`
   * on its default branch. No token is involved: a test fixture, not an API create.
   */
  seedRepo(
    owner: string,
    name: string,
    files: Record<string, string> = { 'README.md': `# ${name}\n` }
  ): FakeRepo {
    const repo: FakeRepo = {
      id: this.ids.number(),
      owner,
      name,
      description: null,
      private: false,
      archived: false,
      default_branch: 'main',
      refs: new Map(),
      environments: new Map(),
      variables: new Map(),
    }
    this.repos.set(`${owner}/${name}`.toLowerCase(), repo)
    const tree = this.writeTree(new Map(), Object.entries(files))
    repo.refs.set('heads/main', this.writeCommit(tree, [], 'Initial commit'))
    return repo
  }

  /**
   * Tag `ref` (a branch or a sha; default the default branch). `annotated` makes it a tag OBJECT,
   * as `git tag -a` does: `GET …/git/ref/tags/{tag}` then answers `type: 'tag'` with the object's
   * sha, and `GET …/git/tags/{sha}` dereferences it to the commit. Returns the COMMIT sha.
   */
  tag(owner: string, name: string, tag: string, opts: { ref?: string; annotated?: boolean } = {}) {
    const repo = this.repo(owner, name)
    if (!repo) throw new Error(`FakeGitHub: no repo ${owner}/${name}`)
    const sha = this.resolveRef(repo, opts.ref ?? repo.default_branch)
    if (!sha) throw new Error(`FakeGitHub: no ref ${opts.ref}`)
    repo.refs.set(`tags/${tag}`, sha)
    if (opts.annotated) this.tagObjects.set(`${repo.owner}/${repo.name}@${tag}`, this.ids.sha())
    return sha
  }

  /** `owner/name@tag` → the annotated tag object's sha (a tag made with `tag({ annotated })`). */
  readonly tagObjects = new Map<string, string>()

  /** P4: the release on `tag`, if one was published. */
  releaseFor(owner: string, name: string, tag: string): FakeGitHubRelease | undefined {
    return this.releases.find(
      r =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.repo.toLowerCase() === name.toLowerCase() &&
        r.tag === tag
    )
  }

  handle(req: FakeRequest): Promise<Response> | Response | null {
    if (req.url.hostname !== 'api.github.com') return null
    return this.route(req)
  }

  // ---- internals -------------------------------------------------------------------------------

  private repoKey(repo: FakeRepo): string {
    return `${repo.owner}/${repo.name}`.toLowerCase()
  }

  /** Issue #5: whether an ACTIVE ruleset governs `branch`. */
  private rulesetApplies(ruleset: FakeRuleset, repo: FakeRepo, branch: string): boolean {
    if (ruleset.enforcement !== 'active' || ruleset.target !== 'branch') return false
    const matches = (pattern: string) =>
      pattern === '~ALL' ||
      (pattern === '~DEFAULT_BRANCH' && branch === repo.default_branch) ||
      pattern === `refs/heads/${branch}`
    const { include, exclude } = ruleset.conditions.ref_name
    return include.some(matches) && !exclude.some(matches)
  }

  /** Issue #5: whether THE App (every installation token here is its) may bypass `ruleset`. */
  private bypassOf(ruleset: FakeRuleset): 'always' | 'pull_requests_only' | 'never' {
    const actor = ruleset.bypass_actors.find(
      a => a.actor_type === 'Integration' && a.actor_id === this.opts.appId
    )
    if (!actor) return 'never'
    return actor.bypass_mode === 'always' ? 'always' : 'pull_requests_only'
  }

  /** Issue #5: the status checks `branch` requires — every applying ruleset's, plus classic. */
  private requiredChecksFor(repo: FakeRepo, branch: string): string[] {
    const checks = new Set<string>()
    for (const ruleset of this.rulesets.get(this.repoKey(repo)) ?? []) {
      if (!this.rulesetApplies(ruleset, repo, branch)) continue
      for (const rule of ruleset.rules) {
        if (rule.type !== 'required_status_checks') continue
        const list = (rule.parameters?.required_status_checks ?? []) as { context: string }[]
        for (const c of list) checks.add(c.context)
      }
    }
    const classic = this.classicProtection.get(this.repoKey(repo))
    if (classic?.branch === branch) for (const c of classic.requiredChecks) checks.add(c)
    return [...checks]
  }

  /**
   * Issue #5: why a direct update of `heads/<branch>` is refused, or null. A ruleset with a
   * `pull_request` or `required_status_checks` rule refuses every push the App may not bypass;
   * classic protection with required checks refuses every push (an App never bypasses it).
   */
  private refUpdateRefusal(repo: FakeRepo, ref: string): string | null {
    const branch = ref.startsWith('heads/') ? ref.slice('heads/'.length) : null
    if (branch === null) return null
    for (const ruleset of this.rulesets.get(this.repoKey(repo)) ?? []) {
      if (!this.rulesetApplies(ruleset, repo, branch)) continue
      const blocking = ruleset.rules.some(
        r => r.type === 'pull_request' || r.type === 'required_status_checks'
      )
      if (blocking && this.bypassOf(ruleset) !== 'always') {
        return 'Repository rule violations found\n\nChanges must be made through a pull request.'
      }
    }
    const classic = this.classicProtection.get(this.repoKey(repo))
    if (classic?.branch === branch && classic.requiredChecks.length > 0) {
      return `Protected branch update failed for refs/heads/${branch}. Required status check "${classic.requiredChecks[0]}" is expected.`
    }
    return null
  }

  /** Issue #5: whether `context` is green on `sha` — a check run by that name, or a status. */
  private checkGreen(repo: FakeRepo, sha: string, context: string): boolean {
    const key = this.ciKey(repo.owner, repo.name, sha)
    const run = (this.checkRuns.get(key) ?? []).find(r => r.name === context)
    if (run) {
      return (
        run.status === 'completed' &&
        ['success', 'neutral', 'skipped'].includes(run.conclusion ?? 'success')
      )
    }
    const status = (this.statuses.get(key) ?? []).find(s => s.context === context)
    return status?.state === 'success'
  }

  /** Issue #5: a PR's head as GitHub reports it — the branch's commit while the PR is open. */
  private liveHeadSha(p: FakeGitHubPull): string {
    if (p.state !== 'open') return p.headSha
    return this.repo(p.owner, p.repo)?.refs.get(`heads/${p.head}`) ?? p.headSha
  }

  private rulesetJson(repo: FakeRepo, ruleset: FakeRuleset, full: boolean) {
    return {
      id: ruleset.id,
      name: ruleset.name,
      target: ruleset.target,
      source_type: 'Repository',
      source: `${repo.owner}/${repo.name}`,
      enforcement: ruleset.enforcement,
      bypass_actors: ruleset.bypass_actors,
      conditions: ruleset.conditions,
      current_user_can_bypass: this.bypassOf(ruleset),
      ...(full ? { rules: ruleset.rules } : {}),
    }
  }

  private findPull(owner: string, name: string, number: number): FakeGitHubPull | undefined {
    return this.pulls.find(
      p =>
        p.owner.toLowerCase() === owner.toLowerCase() &&
        p.repo.toLowerCase() === name.toLowerCase() &&
        p.number === number
    )
  }

  private newPull(
    repo: FakeRepo,
    input: Pick<FakeGitHubPull, 'head' | 'base' | 'title' | 'body' | 'headSha' | 'author'>
  ): FakeGitHubPull {
    const pull: FakeGitHubPull = {
      number: this.pulls.filter(p => p.owner === repo.owner && p.repo === repo.name).length + 1,
      owner: repo.owner,
      repo: repo.name,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      ...input,
    }
    this.pulls.push(pull)
    return pull
  }

  private newRelease(
    repo: FakeRepo,
    input: { tag: string; sha: string; name?: string; body?: string; via: 'api' | 'hook' }
  ): FakeGitHubRelease {
    const release: FakeGitHubRelease = {
      id: this.ids.number(),
      owner: repo.owner,
      repo: repo.name,
      tag: input.tag,
      name: input.name ?? input.tag,
      body: input.body ?? '',
      draft: false,
      prerelease: false,
      sha: input.sha,
      publishedAt: new Date().toISOString(),
      via: input.via,
    }
    this.releases.push(release)
    return release
  }

  private releaseJson(r: FakeGitHubRelease) {
    return {
      id: r.id,
      tag_name: r.tag,
      name: r.name,
      body: r.body,
      draft: r.draft,
      prerelease: r.prerelease,
      target_commitish: r.sha,
      html_url: `https://github.com/${r.owner}/${r.repo}/releases/tag/${r.tag}`,
      published_at: r.publishedAt,
    }
  }

  /** Every commit reachable from `sha` (itself included), following all parents. */
  private ancestors(sha: string): Set<string> {
    const seen = new Set<string>()
    const stack = [sha]
    while (stack.length > 0) {
      const next = stack.pop() as string
      if (seen.has(next)) continue
      seen.add(next)
      for (const parent of this.commits.get(next)?.parents ?? []) stack.push(parent)
    }
    return seen
  }

  /** The commits reachable from `head` and not from `base`, oldest first (parents before children). */
  private commitsBetween(base: string, head: string): FakeCommit[] {
    const excluded = this.ancestors(base)
    const order: FakeCommit[] = []
    const visited = new Set<string>()
    const visit = (sha: string) => {
      if (visited.has(sha) || excluded.has(sha)) return
      visited.add(sha)
      const commit = this.commits.get(sha)
      if (!commit) return
      for (const parent of commit.parents) visit(parent)
      order.push(commit)
    }
    visit(head)
    return order
  }

  private resolveRef(repo: FakeRepo, ref: string): string | null {
    const bare = ref.replace(/^refs\//, '')
    return (
      repo.refs.get(bare) ??
      repo.refs.get(`heads/${bare}`) ??
      repo.refs.get(`tags/${bare}`) ??
      (this.commits.has(bare) ? bare : null)
    )
  }

  private writeTree(base: Map<string, string>, entries: [string, string | null][]): string {
    const next = new Map(base)
    for (const [path, content] of entries) {
      if (content === null) next.delete(path)
      else next.set(path, content)
    }
    const sha = this.ids.sha()
    this.trees.set(sha, next)
    return sha
  }

  private writeCommit(tree: string, parents: string[], message: string): string {
    const sha = this.ids.sha()
    this.commits.set(sha, { sha, tree, parents, message })
    return sha
  }

  private isAppJwt(bearer: string | null): boolean {
    return !!bearer && bearer.split('.').length === 3
  }

  /** The live installation token behind `req`, or an error response. */
  private token(req: FakeRequest): FakeInstallationToken | Response {
    const token = req.bearer ? this.tokens.get(req.bearer) : undefined
    if (!token || token.revoked || Date.parse(token.expires_at) < Date.now()) {
      return ghError(401, 'Bad credentials')
    }
    return token
  }

  private can(token: FakeInstallationToken, permission: string, level: 'read' | 'write'): boolean {
    const granted = (token.permissions ?? this.permissions)[permission]
    if (!granted) return false
    return level === 'read' || granted === 'write' || granted === 'admin'
  }

  private repoAccess(token: FakeInstallationToken, repo: FakeRepo): Response | null {
    if (token.repositories && !token.repositories.includes(repo.name)) {
      return ghError(403, 'Resource not accessible by integration')
    }
    return null
  }

  private repoJson(repo: FakeRepo) {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.private,
      archived: repo.archived,
      default_branch: repo.default_branch,
      description: repo.description,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
    }
  }

  private async route(req: FakeRequest): Promise<Response> {
    const path = req.url.pathname
    const m = req.method
    const body = (req.json ?? {}) as Record<string, unknown>
    let match: RegExpMatchArray | null

    // ---- the app (app JWT)
    if (path === '/app' && m === 'GET') {
      if (!this.isAppJwt(req.bearer)) return ghError(401, 'A JSON web token could not be decoded')
      return json({
        id: this.opts.appId,
        slug: 'company-launch',
        name: 'Company Launch',
        owner: { login: this.opts.org },
        permissions: this.permissions,
      })
    }
    if (path === '/app/installations' && m === 'GET') {
      if (!this.isAppJwt(req.bearer)) return ghError(401, 'A JSON web token could not be decoded')
      return json([
        {
          id: this.opts.installationId,
          account: { login: this.opts.org, type: 'Organization' },
          permissions: this.permissions,
          repository_selection: 'all',
          suspended_at: null,
        },
      ])
    }
    match = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/)
    if (match && m === 'POST') {
      if (!this.isAppJwt(req.bearer)) return ghError(401, 'A JSON web token could not be decoded')
      if (Number(match[1]) !== this.opts.installationId) return ghError(404, 'Not Found')
      const repositories = (body.repositories as string[] | undefined) ?? undefined
      if (repositories?.some(name => !this.repo(this.opts.org, name))) {
        return ghError(
          422,
          'There is at least one repository that does not exist or is not accessible'
        )
      }
      const permissions = (body.permissions as Record<string, string> | undefined) ?? undefined
      // Issue #9: as GitHub does, a token may not ask for MORE than the installation holds (an
      // installation that has not accepted `checks: write` yet). A permission the fake's
      // installation does not list at all stays lenient.
      const rank: Record<string, number> = { read: 1, write: 2, admin: 3 }
      const over = Object.entries(permissions ?? {}).filter(([p, level]) => {
        const held = this.permissions[p]
        return held !== undefined && (rank[level] ?? 0) > (rank[held] ?? 0)
      })
      if (over.length > 0) {
        return ghError(422, 'The permissions requested are not granted to this installation.')
      }
      const token = this.issueToken({ repositories, permissions })
      return json(
        {
          token: token.token,
          expires_at: token.expires_at,
          permissions: token.permissions ?? this.permissions,
          repository_selection: token.repositories ? 'selected' : 'all',
        },
        201
      )
    }

    // ---- everything else: an installation token
    const token = this.token(req)
    if (token instanceof Response) return token

    if (path === '/installation/token' && m === 'DELETE') {
      token.revoked = true
      return noContent()
    }

    match = path.match(/^\/orgs\/([^/]+)\/repos$/)
    if (match && m === 'POST') {
      if (match[1].toLowerCase() !== this.opts.org.toLowerCase()) return ghError(404, 'Not Found')
      if (!this.can(token, 'administration', 'write')) {
        return ghError(403, 'Resource not accessible by integration')
      }
      const name = String(body.name ?? '')
      if (this.repo(this.opts.org, name)) {
        return json(
          {
            message: 'Repository creation failed.',
            errors: [{ message: 'name already exists on this account' }],
          },
          422
        )
      }
      const repo: FakeRepo = {
        id: this.ids.number(),
        owner: this.opts.org,
        name,
        description: body.description ? String(body.description) : null,
        private: body.private !== false,
        archived: false,
        default_branch: 'main',
        refs: new Map(),
        environments: new Map(),
        variables: new Map(),
      }
      this.repos.set(`${repo.owner}/${repo.name}`.toLowerCase(), repo)
      if (body.auto_init) {
        const tree = this.writeTree(new Map(), [['README.md', `# ${name}\n`]])
        repo.refs.set('heads/main', this.writeCommit(tree, [], 'Initial commit'))
      }
      return json(this.repoJson(repo), 201)
    }

    match = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/)
    if (!match) {
      return ghError(404, 'Not Found')
    }
    const repo = this.repo(decodeURIComponent(match[1]), decodeURIComponent(match[2]))
    if (!repo) return ghError(404, 'Not Found')
    const denied = this.repoAccess(token, repo)
    if (denied) return denied
    const rest = match[3] ?? ''
    const writable = (permission: string) =>
      this.can(token, permission, 'write')
        ? null
        : ghError(403, 'Resource not accessible by integration')
    if (repo.archived && m !== 'GET' && rest !== '') {
      return ghError(403, 'Repository was archived so is read-only.')
    }

    if (rest === '') {
      if (m === 'GET') return json(this.repoJson(repo))
      if (m === 'PATCH') {
        const refused = writable('administration')
        if (refused) return refused
        if (body.archived !== undefined) repo.archived = Boolean(body.archived)
        if (body.description !== undefined) repo.description = String(body.description)
        return json(this.repoJson(repo))
      }
      if (m === 'DELETE') {
        const refused = writable('administration')
        if (refused) return refused
        this.repos.delete(`${repo.owner}/${repo.name}`.toLowerCase())
        return noContent()
      }
    }

    // ---- contents (raw)
    match = rest.match(/^\/contents\/(.+)$/)
    if (match && m === 'GET') {
      const filePath = match[1].split('/').map(decodeURIComponent).join('/')
      const content = this.readFile(
        repo.owner,
        repo.name,
        filePath,
        req.url.searchParams.get('ref') ?? undefined
      )
      if (content === null) return ghError(404, 'Not Found')
      return new Response(content, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.github.raw' },
      })
    }

    // ---- Git Data
    match = rest.match(/^\/git\/ref\/(.+)$/)
    if (match && m === 'GET') {
      const sha = repo.refs.get(match[1])
      if (!sha) return ghError(404, 'Not Found')
      const tagName = match[1].startsWith('tags/') ? match[1].slice('tags/'.length) : null
      const tagObject = tagName
        ? this.tagObjects.get(`${repo.owner}/${repo.name}@${tagName}`)
        : null
      if (tagObject) {
        return json({ ref: `refs/${match[1]}`, object: { sha: tagObject, type: 'tag' } })
      }
      return json({ ref: `refs/${match[1]}`, object: { sha, type: 'commit' } })
    }
    // An annotated tag object → the commit it tags.
    match = rest.match(/^\/git\/tags\/([0-9a-f]+)$/)
    if (match && m === 'GET') {
      const prefix = `${repo.owner}/${repo.name}@`
      const entry = [...this.tagObjects.entries()].find(
        ([key, sha]) => sha === match?.[1] && key.startsWith(prefix)
      )
      const tagName = entry?.[0].slice(prefix.length)
      const commit = tagName ? repo.refs.get(`tags/${tagName}`) : undefined
      if (!entry || !commit) return ghError(404, 'Not Found')
      return json({ sha: entry[1], tag: tagName, object: { sha: commit, type: 'commit' } })
    }
    // `GET …/tags` — every tag with its commit, newest first (last created first here).
    if (rest === '/tags' && m === 'GET') {
      const tags = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('tags/'))
        .map(([ref, sha]) => ({ name: ref.slice('tags/'.length), commit: { sha } }))
        .reverse()
      return json(tags)
    }
    // `GET …/commits/{ref}` — a branch, tag, full or SHORT sha → the commit; 422 when none.
    match = rest.match(/^\/commits\/([^/]+)$/)
    if (match && m === 'GET') {
      const ref = decodeURIComponent(match[1])
      // Only a commit reachable from one of THIS repo's refs (the commit store is shared).
      const reachable = new Set<string>()
      for (const head of repo.refs.values()) for (const s of this.ancestors(head)) reachable.add(s)
      let sha = this.resolveRef(repo, ref)
      if (!sha && /^[0-9a-f]{7,39}$/.test(ref)) {
        const hits = [...reachable].filter(s => s.startsWith(ref))
        sha = hits.length === 1 ? (hits[0] ?? null) : null
      }
      if (sha && !reachable.has(sha)) sha = null
      if (!sha) return ghError(422, `No commit found for SHA: ${ref}`)
      const commit = this.commits.get(sha)
      return json({ sha, commit: { message: commit?.message ?? '' } })
    }
    match = rest.match(/^\/git\/commits\/([0-9a-f]+)$/)
    if (match && m === 'GET') {
      const commit = this.commits.get(match[1])
      if (!commit) return ghError(404, 'Not Found')
      return json({
        sha: commit.sha,
        tree: { sha: commit.tree },
        parents: commit.parents.map(sha => ({ sha })),
        message: commit.message,
      })
    }
    if (rest === '/git/trees' && m === 'POST') {
      const refused = writable('contents')
      if (refused) return refused
      const baseSha = body.base_tree ? String(body.base_tree) : null
      const base = baseSha ? this.trees.get(baseSha) : new Map<string, string>()
      if (!base) return ghError(422, 'base_tree is not a valid tree')
      const entries = ((body.tree as Record<string, unknown>[]) ?? []).map(
        e =>
          [String(e.path), e.sha === null ? null : String(e.content ?? '')] as [
            string,
            string | null,
          ]
      )
      return json({ sha: this.writeTree(base, entries) }, 201)
    }
    if (rest === '/git/commits' && m === 'POST') {
      const refused = writable('contents')
      if (refused) return refused
      const tree = String(body.tree ?? '')
      if (!this.trees.has(tree)) return ghError(422, 'tree is not a valid tree')
      const parents = ((body.parents as string[]) ?? []).map(String)
      const sha = this.writeCommit(tree, parents, String(body.message ?? ''))
      return json(
        {
          sha,
          tree: { sha: tree },
          parents: parents.map(p => ({ sha: p })),
          message: body.message,
        },
        201
      )
    }
    match = rest.match(/^\/git\/refs\/(.+)$/)
    if (match && m === 'PATCH') {
      const refused = writable('contents')
      if (refused) return refused
      const ref = match[1]
      const current = repo.refs.get(ref)
      if (!current) return ghError(422, 'Reference does not exist')
      const sha = String(body.sha ?? '')
      const commit = this.commits.get(sha)
      if (!commit) return ghError(422, 'Object does not exist')
      if (!body.force && !commit.parents.includes(current)) {
        return ghError(422, 'Update is not a fast forward')
      }
      // Issue #5: a protected branch refuses a direct update the App may not bypass.
      const refusal = this.refUpdateRefusal(repo, ref)
      if (refusal) return ghError(422, refusal)
      if (this.touchesWorkflows(current, sha) && !this.can(token, 'workflows', 'write')) {
        return ghError(
          403,
          'refusing to allow a GitHub App to create or update workflow without `workflows` permission'
        )
      }
      repo.refs.set(ref, sha)
      return json({ ref: `refs/${ref}`, object: { sha, type: 'commit' } })
    }

    // ---- Actions
    match = rest.match(/^\/actions\/workflows\/([^/]+)\/dispatches$/)
    if (match && m === 'POST') {
      const refused = writable('actions')
      if (refused) return refused
      const workflow = decodeURIComponent(match[1])
      const ref = String(body.ref ?? repo.default_branch)
      const headSha = this.resolveRef(repo, ref)
      const files = headSha ? this.trees.get(this.commits.get(headSha)?.tree ?? '') : undefined
      if (!headSha || !files?.has(`.github/workflows/${workflow}`)) {
        return ghError(404, 'Not Found')
      }
      const run: FakeWorkflowRun = {
        id: this.ids.number(),
        owner: repo.owner,
        repo: repo.name,
        workflow,
        ref,
        inputs: (body.inputs as Record<string, string>) ?? {},
        status: 'queued',
        conclusion: null,
        head_sha: headSha,
        run_attempt: 1,
        created_at: new Date().toISOString(),
      }
      this.runs.push(run)
      await this.onDispatch?.(run)
      return noContent()
    }
    match = rest.match(/^\/actions\/workflows\/([^/]+)\/runs$/)
    if (match && m === 'GET') {
      const workflow = decodeURIComponent(match[1])
      const branch = req.url.searchParams.get('branch')
      const event = req.url.searchParams.get('event')
      const runs = this.runs
        .filter(r => r.owner === repo.owner && r.repo === repo.name && r.workflow === workflow)
        .filter(r => !branch || r.ref.replace(/^refs\/(heads|tags)\//, '') === branch)
        .filter(r => !event || (r.event ?? 'workflow_dispatch') === event)
        .reverse()
        .map(r => ({
          id: r.id,
          run_attempt: r.run_attempt,
          status: r.status,
          conclusion: r.conclusion,
          head_sha: r.head_sha,
          head_branch: r.ref.replace(/^refs\/(heads|tags)\//, ''),
          event: r.event ?? 'workflow_dispatch',
          created_at: r.created_at,
          html_url: `https://github.com/${repo.owner}/${repo.name}/actions/runs/${r.id}`,
        }))
      return json({ total_count: runs.length, workflow_runs: runs })
    }
    // One run by id (the deploy progress read's poll): 404 for a run this repo never had.
    match = rest.match(/^\/actions\/runs\/(\d+)$/)
    if (match && m === 'GET') {
      const id = Number(match[1])
      const r = this.runs.find(x => x.owner === repo.owner && x.repo === repo.name && x.id === id)
      if (!r) return ghError(404, 'Not Found')
      return json({
        id: r.id,
        run_attempt: r.run_attempt,
        status: r.status,
        conclusion: r.conclusion,
        head_sha: r.head_sha,
        head_branch: r.ref.replace(/^refs\/(heads|tags)\//, ''),
        event: r.event ?? 'workflow_dispatch',
        created_at: r.created_at,
        html_url: `https://github.com/${repo.owner}/${repo.name}/actions/runs/${r.id}`,
      })
    }
    // A run's jobs (a tag run's: which one it is on, which one failed). `actions: read`.
    match = rest.match(/^\/actions\/runs\/(\d+)\/jobs$/)
    if (match && m === 'GET') {
      if (!this.can(token, 'actions', 'read'))
        return ghError(403, 'Resource not accessible by integration')
      const id = Number(match[1])
      const r = this.runs.find(x => x.owner === repo.owner && x.repo === repo.name && x.id === id)
      if (!r) return ghError(404, 'Not Found')
      const jobs = (r.jobs ?? []).map(j => ({
        id: j.id ?? 0,
        run_id: r.id,
        name: j.name,
        status: j.status,
        conclusion: j.status === 'completed' ? (j.conclusion ?? 'success') : null,
        html_url: `https://github.com/${repo.owner}/${repo.name}/actions/runs/${r.id}/job/${j.id ?? 0}`,
      }))
      return json({ total_count: jobs.length, jobs })
    }

    // App page P2: "Re-run failed jobs" (`actions: write`) — a COMPLETED run that did not succeed
    // starts its next attempt: the failed and cancelled jobs queue again. GitHub's 403 otherwise.
    match = rest.match(/^\/actions\/runs\/(\d+)\/rerun-failed-jobs$/)
    if (match && m === 'POST') {
      const refused = writable('actions')
      if (refused) return refused
      const id = Number(match[1])
      const r = this.runs.find(x => x.owner === repo.owner && x.repo === repo.name && x.id === id)
      if (!r) return ghError(404, 'Not Found')
      if (r.status !== 'completed') return ghError(403, 'This workflow is already running')
      if (r.conclusion === 'success') return ghError(403, 'This workflow run has no failed jobs')
      r.run_attempt += 1
      r.status = 'queued'
      r.conclusion = null
      for (const job of r.jobs ?? []) {
        if (job.status === 'completed' && job.conclusion !== 'success') {
          job.status = 'queued'
          job.conclusion = null
        }
      }
      this.reruns.push({ runId: r.id, attempt: r.run_attempt })
      return json({}, 201)
    }
    // App page P2: cancel a run in progress (`actions: write`); a completed one is GitHub's 409.
    match = rest.match(/^\/actions\/runs\/(\d+)\/cancel$/)
    if (match && m === 'POST') {
      const refused = writable('actions')
      if (refused) return refused
      const id = Number(match[1])
      const r = this.runs.find(x => x.owner === repo.owner && x.repo === repo.name && x.id === id)
      if (!r) return ghError(404, 'Not Found')
      if (r.status === 'completed') {
        return ghError(409, 'Cannot cancel a workflow run that is completed.')
      }
      r.status = 'completed'
      r.conclusion = 'cancelled'
      for (const job of r.jobs ?? []) {
        if (job.status !== 'completed') {
          job.status = 'completed'
          job.conclusion = 'cancelled'
        }
      }
      this.cancels.push(r.id)
      return json({}, 202)
    }

    // ---- P3: pull requests
    const readable = (permission: string) =>
      this.can(token, permission, 'read')
        ? null
        : ghError(403, 'Resource not accessible by integration')
    if (rest === '/pulls' && m === 'POST') {
      const refused = writable('pull_requests')
      if (refused) return refused
      // GitHub reads both refs to open a PR: a token without `contents: read` is refused this way
      // (seen live on the first real ship, 2026-09-29).
      if (!this.can(token, 'contents', 'read')) {
        return json(
          { message: 'Validation Failed', errors: [{ message: 'not all refs are readable' }] },
          422
        )
      }
      const head = String(body.head ?? '')
      const base = String(body.base ?? repo.default_branch)
      const headSha = repo.refs.get(`heads/${head}`)
      if (!headSha || !repo.refs.has(`heads/${base}`)) {
        return ghError(422, 'Validation Failed')
      }
      if (
        this.pulls.some(
          p =>
            p.owner === repo.owner && p.repo === repo.name && p.head === head && p.state === 'open'
        )
      ) {
        return ghError(422, `A pull request already exists for ${repo.owner}:${head}.`)
      }
      const pull = this.newPull(repo, {
        head,
        base,
        title: String(body.title ?? ''),
        body: String(body.body ?? ''),
        headSha,
        author: 'company-launch[bot]',
      })
      return json(this.pullJson(pull), 201)
    }
    if (rest === '/pulls' && m === 'GET') {
      const refused = readable('pull_requests')
      if (refused) return refused
      const state = req.url.searchParams.get('state') ?? 'open'
      const head = req.url.searchParams.get('head')
      const list = this.pulls.filter(
        p =>
          p.owner === repo.owner &&
          p.repo === repo.name &&
          (state === 'all' || p.state === state) &&
          (!head || `${p.owner}:${p.head}`.toLowerCase() === head.toLowerCase())
      )
      return json(list.map(p => this.pullJson(p)))
    }
    match = rest.match(/^\/pulls\/(\d+)$/)
    if (match && m === 'GET') {
      const refused = readable('pull_requests')
      if (refused) return refused
      const pull = this.pulls.find(
        p => p.owner === repo.owner && p.repo === repo.name && p.number === Number(match?.[1])
      )
      return pull ? json(this.pullJson(pull)) : ghError(404, 'Not Found')
    }

    // ---- Issue #5: squash merge, job logs, annotations, rulesets, classic protection
    match = rest.match(/^\/pulls\/(\d+)\/merge$/)
    if (match && m === 'PUT') {
      const refused = writable('contents')
      if (refused) return refused
      const pull = this.findPull(repo.owner, repo.name, Number(match[1]))
      if (!pull) return ghError(404, 'Not Found')
      if (pull.state !== 'open') return ghError(405, 'Pull Request is not mergeable')
      const headSha = this.liveHeadSha(pull)
      if (body.sha !== undefined && body.sha !== headSha) {
        return ghError(409, 'Head branch was modified. Review and try the merge again.')
      }
      const missing = this.requiredChecksFor(repo, pull.base).find(
        context => !this.checkGreen(repo, headSha, context)
      )
      if (missing) return ghError(405, `Required status check "${missing}" is expected.`)
      const baseSha = repo.refs.get(`heads/${pull.base}`)
      if (!baseSha) return ghError(422, 'Base branch was deleted')
      const method = (
        ['merge', 'rebase'].includes(String(body.merge_method)) ? body.merge_method : 'squash'
      ) as FakeMerge['method']
      const title = typeof body.commit_title === 'string' ? body.commit_title : null
      const message = typeof body.commit_message === 'string' ? body.commit_message : null
      const baseFiles = this.trees.get(this.commits.get(baseSha)?.tree ?? '') ?? new Map()
      const headFiles = this.trees.get(this.commits.get(headSha)?.tree ?? '') ?? new Map()
      const tree = this.writeTree(baseFiles, [...headFiles.entries()])
      const subject = title ?? `${pull.title} (#${pull.number})`
      const sha = this.writeCommit(
        tree,
        method === 'merge' ? [baseSha, headSha] : [baseSha],
        message ? `${subject}\n\n${message}` : subject
      )
      repo.refs.set(`heads/${pull.base}`, sha)
      this.mergeCommitCi(repo.owner, repo.name, sha)
      pull.headSha = headSha
      pull.state = 'closed'
      pull.merged = true
      pull.mergedAt = new Date().toISOString()
      pull.mergeSha = sha
      this.merges.push({
        owner: repo.owner,
        repo: repo.name,
        number: pull.number,
        sha,
        headSha,
        method,
        title,
        message,
      })
      return json({ sha, merged: true, message: 'Pull Request successfully merged' })
    }
    match = rest.match(/^\/actions\/jobs\/(\d+)\/logs$/)
    if (match && m === 'GET') {
      const refused = readable('actions')
      if (refused) return refused
      const log = this.jobLogs.get(`${this.repoKey(repo)}#${match[1]}`)
      if (log === undefined) return ghError(404, 'Not Found')
      return new Response(log, { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }
    match = rest.match(/^\/check-runs\/(\d+)\/annotations$/)
    if (match && m === 'GET') {
      const refused = readable('checks')
      if (refused) return refused
      const id = Number(match[1])
      const prefix = `${this.repoKey(repo)}@`
      const run = [...this.checkRuns.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .flatMap(([, runs]) => runs)
        .find(r => r.id === id)
      if (!run) return ghError(404, 'Not Found')
      return json(
        (run.annotations ?? []).map(a => ({
          path: a.path,
          start_line: a.start_line,
          end_line: a.start_line,
          annotation_level: a.annotation_level,
          title: a.title ?? null,
          message: a.message,
          raw_details: null,
        }))
      )
    }
    const noRulesets = () =>
      this.rulesetsUnavailable.has(this.repoKey(repo))
        ? ghError(
            403,
            'Upgrade to GitHub Pro or make this repository public to enable this feature.'
          )
        : null
    if (rest === '/rulesets' && m === 'GET') {
      const refused = readable('administration') ?? noRulesets()
      if (refused) return refused
      const list = this.rulesets.get(this.repoKey(repo)) ?? []
      return json(list.map(r => this.rulesetJson(repo, r, false)))
    }
    if (rest === '/rulesets' && m === 'POST') {
      const refused = writable('administration') ?? noRulesets()
      if (refused) return refused
      const list = this.rulesets.get(this.repoKey(repo)) ?? []
      const name = String(body.name ?? '')
      if (!name || list.some(r => r.name === name)) {
        return json({ message: 'Validation Failed', errors: ['Name must be unique'] }, 422)
      }
      const ruleset = { ...(body as unknown as Omit<FakeRuleset, 'id'>), id: this.ids.number() }
      this.rulesets.set(this.repoKey(repo), [...list, ruleset])
      return json(this.rulesetJson(repo, ruleset, true), 201)
    }
    match = rest.match(/^\/rulesets\/(\d+)$/)
    if (match && (m === 'GET' || m === 'PUT')) {
      const refused =
        (m === 'GET' ? readable('administration') : writable('administration')) ?? noRulesets()
      if (refused) return refused
      const list = this.rulesets.get(this.repoKey(repo)) ?? []
      const at = list.findIndex(r => r.id === Number(match?.[1]))
      const current = list[at]
      if (!current) return ghError(404, 'Not Found')
      if (m === 'GET') return json(this.rulesetJson(repo, current, true))
      const next = { ...current, ...(body as Partial<FakeRuleset>), id: current.id }
      list[at] = next
      return json(this.rulesetJson(repo, next, true))
    }
    match = rest.match(/^\/branches\/(.+)\/protection$/)
    if (match && m === 'GET') {
      const refused = readable('administration') ?? noRulesets()
      if (refused) return refused
      const branch = decodeURIComponent(match[1])
      const classic = this.classicProtection.get(this.repoKey(repo))
      if (!classic || classic.branch !== branch) return ghError(404, 'Branch not protected')
      return json({
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/branches/${branch}/protection`,
        required_status_checks: {
          strict: false,
          contexts: classic.requiredChecks,
          checks: classic.requiredChecks.map(context => ({ context, app_id: null })),
        },
        enforce_admins: { enabled: false },
        required_pull_request_reviews: null,
      })
    }

    // ---- P3: CI on a commit
    match = rest.match(/^\/commits\/([^/]+)\/check-runs$/)
    if (match && m === 'GET') {
      const refused = readable('checks')
      if (refused) return refused
      const runs =
        this.checkRuns.get(this.ciKey(repo.owner, repo.name, decodeURIComponent(match[1]))) ?? []
      return json({
        total_count: runs.length,
        check_runs: runs.map((r, i) => ({
          id: r.id ?? i + 1,
          name: r.name,
          status: r.status,
          conclusion: r.status === 'completed' ? (r.conclusion ?? 'success') : null,
          html_url:
            r.html_url ?? `https://github.com/${repo.owner}/${repo.name}/runs/${r.id ?? i + 1}`,
          app: { slug: r.app ?? 'github-actions' },
          external_id: r.external_id ?? null,
        })),
      })
    }
    // Issue #9: a Checks App's own run (`checks: write`) — completed, on a commit that exists.
    if (rest === '/check-runs' && m === 'POST') {
      const refused = writable('checks')
      if (refused) return refused
      const headSha = String(body.head_sha ?? '')
      if (!this.commits.has(headSha)) {
        return json({ message: 'Validation Failed', errors: ['No commit found for SHA'] }, 422)
      }
      const run: FakeCheckRun = {
        id: this.ids.number(),
        name: String(body.name ?? ''),
        status: (body.status as FakeCheckRun['status']) ?? 'queued',
        conclusion: (body.conclusion as string | undefined) ?? null,
        app: 'company-launch',
        head_sha: headSha,
        ...(typeof body.external_id === 'string' ? { external_id: body.external_id } : {}),
        ...(body.output ? { output: body.output as FakeCheckRun['output'] } : {}),
      }
      const key = this.ciKey(repo.owner, repo.name, headSha)
      this.checkRuns.set(key, [...(this.checkRuns.get(key) ?? []), run])
      this.createdCheckRuns.push({ owner: repo.owner, repo: repo.name, ...run })
      return json(
        {
          id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          external_id: run.external_id ?? null,
          head_sha: headSha,
          app: { slug: run.app },
        },
        201
      )
    }
    match = rest.match(/^\/commits\/([^/]+)\/status$/)
    if (match && m === 'GET') {
      const refused = readable('statuses')
      if (refused) return refused
      const ref = decodeURIComponent(match[1])
      const statuses = this.statuses.get(this.ciKey(repo.owner, repo.name, ref)) ?? []
      const state =
        statuses.length === 0
          ? 'pending'
          : statuses.some(s => s.state === 'failure' || s.state === 'error')
            ? 'failure'
            : statuses.some(s => s.state === 'pending')
              ? 'pending'
              : 'success'
      return json({
        state,
        sha: this.resolveRef(repo, ref) ?? ref,
        total_count: statuses.length,
        statuses: statuses.map(s => ({ ...s, target_url: s.target_url ?? null })),
      })
    }

    // ---- P4: tags, releases, compare, commit → pulls
    if (rest === '/git/refs' && m === 'POST') {
      const refused = writable('contents')
      if (refused) return refused
      const ref = String(body.ref ?? '').replace(/^refs\//, '')
      const sha = String(body.sha ?? '')
      if (!/^(heads|tags)\/.+/.test(ref)) return ghError(422, 'Reference name is invalid')
      if (!this.commits.has(sha)) return ghError(422, 'Object does not exist')
      if (repo.refs.has(ref)) return ghError(422, 'Reference already exists')
      repo.refs.set(ref, sha)
      return json({ ref: `refs/${ref}`, object: { sha, type: 'commit' } }, 201)
    }
    if (rest === '/releases' && m === 'POST') {
      const refused = writable('contents')
      if (refused) return refused
      const tag = String(body.tag_name ?? '')
      if (!tag) return ghError(422, 'Validation Failed')
      if (this.releaseFor(repo.owner, repo.name, tag)) {
        return json(
          {
            message: 'Validation Failed',
            errors: [{ resource: 'Release', code: 'already_exists' }],
          },
          422
        )
      }
      let sha = repo.refs.get(`tags/${tag}`)
      if (!sha && body.target_commitish) {
        const target = this.resolveRef(repo, String(body.target_commitish))
        if (target) {
          repo.refs.set(`tags/${tag}`, target)
          sha = target
        }
      }
      if (!sha) return ghError(422, 'Validation Failed')
      const release = this.newRelease(repo, {
        tag,
        sha,
        name: body.name ? String(body.name) : undefined,
        body: body.body ? String(body.body) : undefined,
        via: 'api',
      })
      await this.onRelease?.(release)
      return json(this.releaseJson(release), 201)
    }
    match = rest.match(/^\/releases\/tags\/(.+)$/)
    if (match && m === 'GET') {
      const release = this.releaseFor(repo.owner, repo.name, decodeURIComponent(match[1]))
      return release ? json(this.releaseJson(release)) : ghError(404, 'Not Found')
    }
    match = rest.match(/^\/compare\/(.+)\.\.\.(.+)$/)
    if (match && m === 'GET') {
      const base = this.resolveRef(repo, decodeURIComponent(match[1]))
      const head = this.resolveRef(repo, decodeURIComponent(match[2]))
      if (!base || !head) return ghError(404, 'Not Found')
      const ahead = this.commitsBetween(base, head)
      const behind = this.commitsBetween(head, base)
      return json({
        status:
          ahead.length === 0 && behind.length === 0
            ? 'identical'
            : behind.length === 0
              ? 'ahead'
              : ahead.length === 0
                ? 'behind'
                : 'diverged',
        ahead_by: ahead.length,
        behind_by: behind.length,
        total_commits: ahead.length,
        html_url: `https://github.com/${repo.owner}/${repo.name}/compare/${match[1]}...${match[2]}`,
        commits: ahead.map(c => ({
          sha: c.sha,
          parents: c.parents.map(p => ({ sha: p })),
          commit: { message: c.message, author: { name: 'octocat', date: null } },
        })),
      })
    }
    match = rest.match(/^\/commits\/([0-9a-f]+)\/pulls$/)
    if (match && m === 'GET') {
      const refused = readable('pull_requests')
      if (refused) return refused
      const sha = match[1]
      const list = this.pulls.filter(
        p =>
          p.owner === repo.owner &&
          p.repo === repo.name &&
          (p.mergeSha === sha || p.headSha === sha)
      )
      return json(list.map(p => this.pullJson(p)))
    }

    // ---- settings
    match = rest.match(/^\/environments\/([^/]+)$/)
    if (match && m === 'PUT') {
      // GitHub lists creating an environment under the "Administration" permission, not
      // "Environments" (which covers an environment's own secrets and variables).
      const refused = writable('administration')
      if (refused) return refused
      const name = decodeURIComponent(match[1])
      repo.environments.set(name, body)
      return json({ id: this.ids.number(), name })
    }
    match = rest.match(/^\/actions\/variables\/([^/]+)$/)
    if (match && m === 'GET') {
      if (!this.can(token, 'actions_variables', 'read')) {
        return ghError(403, 'Resource not accessible by integration')
      }
      const name = decodeURIComponent(match[1])
      const value = repo.variables.get(name)
      if (value === undefined) return ghError(404, 'Not Found')
      return json({ name, value, created_at: null, updated_at: null })
    }
    if (match && m === 'PATCH') {
      const refused = writable('actions_variables')
      if (refused) return refused
      const name = decodeURIComponent(match[1])
      if (!repo.variables.has(name)) return ghError(404, 'Not Found')
      repo.variables.set(name, String(body.value ?? ''))
      return noContent()
    }
    if (rest === '/actions/variables' && m === 'POST') {
      const refused = writable('actions_variables')
      if (refused) return refused
      const name = String(body.name ?? '')
      if (repo.variables.has(name)) return ghError(409, 'Already exists')
      repo.variables.set(name, String(body.value ?? ''))
      return json({}, 201)
    }

    return ghError(404, `Not Found (${m} ${path})`)
  }

  private pullJson(p: FakeGitHubPull) {
    return {
      number: p.number,
      html_url: `https://github.com/${p.owner}/${p.repo}/pull/${p.number}`,
      state: p.state,
      title: p.title,
      body: p.body,
      draft: false,
      merged: p.merged,
      merged_at: p.mergedAt,
      merge_commit_sha: p.mergeSha,
      user: { login: p.author },
      head: { ref: p.head, sha: this.liveHeadSha(p) },
      base: { ref: p.base },
    }
  }

  /** Whether moving a ref from `fromSha` to `toSha` changes anything under `.github/workflows/`. */
  private touchesWorkflows(fromSha: string, toSha: string): boolean {
    const before = this.trees.get(this.commits.get(fromSha)?.tree ?? '') ?? new Map()
    const after = this.trees.get(this.commits.get(toSha)?.tree ?? '') ?? new Map()
    const paths = new Set(
      [...before.keys(), ...after.keys()].filter(p => p.startsWith('.github/workflows/'))
    )
    for (const p of paths) if (before.get(p) !== after.get(p)) return true
    return false
  }
}
