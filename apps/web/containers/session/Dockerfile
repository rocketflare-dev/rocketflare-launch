# Coding-session image (Launch P3, spec/07) — PLACEHOLDER from slice 3a.
#
# `[[containers]]` in both wrangler tomls names this file, and `wrangler deploy --dry-run`
# (`pnpm build:api`) refuses a missing Dockerfile without building it. Slice 3b owns the real image
# (docs/plans/p3-sessions.md §1.9): Node 24 first on PATH, corepack pnpm 10, a pinned
# @anthropic-ai/claude-code, a `pnpm fetch` store for KIT_TAG=0.15.0, `EXPOSE 5173 8787`.
#
# The base image MUST stay on the same stable line as the Worker's `@cloudflare/sandbox` (0.12.10).
FROM docker.io/cloudflare/sandbox:0.12.10

EXPOSE 5173 8787
