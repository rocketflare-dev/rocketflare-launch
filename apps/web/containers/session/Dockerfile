# The coding-session image (Launch P3, spec/07, docs/plans/p3-sessions.md §1.9).
#
# `[[containers]]` in both wrangler tomls builds it: `wrangler deploy` builds and pushes it with
# Launch (linux/amd64), `wrangler dev` builds it with the local Docker (docs/SESSIONS-LOCAL.md).
# What a Rocketflare checkout needs and nothing else — NO Postgres (each session gets its own Neon
# branch, or a TEMPLATE database locally, reached over HTTP(S) because a locked sandbox has no TCP
# out) and NO credential of any kind, wherever the container runs: the model key and the GitHub
# token are injected on the way out — by Launch's outbound handlers (`services/sessions/egress/*`)
# in Launch's own sandboxes, and by the sandbox host's (`src/sandbox-host/egress.ts`, from the
# grant Launch sends) for SESSION_SANDBOX_HOST=remote. The container only ever sees a placeholder.
#
# **The base MUST stay on the same stable line as the Worker's `@cloudflare/sandbox` (0.12.10).**
# Bumping either, or anything in this file, replaces running containers on deploy: DRAIN sessions
# first (docs/DEPLOY.md § Coding sessions), and bump SESSION_IMAGE_VERSION below together with
# `SESSION_IMAGE_VERSION` in `src/api/services/sessions/rocketflare-dev.ts` (a config test pins it).
FROM docker.io/cloudflare/sandbox:0.12.10

# Recorded on every session row (`sessions.image_version`) so a drain can tell who ran on what.
LABEL dev.rocketflare.launch.session-image="session-5"

# Node 24 FIRST on PATH (S7 finding 6): the base image ships Node 22 in /usr/local/bin, ahead of
# /usr/bin, and the kit refuses anything below 24. The base's own server is not Node, so replacing
# the /usr/local/bin links is safe.
# `lsof` and `ps` too: the kit's bootstrap checks for them (its dev supervisor owns its ports
# with them).
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs lsof procps \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/node /usr/local/bin/node \
 && ln -sf /usr/bin/npm /usr/local/bin/npm \
 && ln -sf /usr/bin/npx /usr/local/bin/npx \
 && node -v | grep -q '^v24\.'

# pnpm 10 through corepack (the kit's `packageManager` pin), and a PINNED Claude Code: its
# stream-json output is what `services/sessions/claude-stream.ts` parses. npm 11 blocks install
# scripts by default; Claude Code's postinstall fetches its native binary, so it is allowed by name.
ARG PNPM_VERSION=10.18.0
ARG CLAUDE_CODE_VERSION=2.1.283
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code \
      corepack@latest "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && corepack enable \
 && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
 && pnpm -v && claude --version

# A warm pnpm store for the pinned kit tag (~12 s saved per session, S7): a session's
# `pnpm install --frozen-lockfile --prefer-offline` resolves from here, not the registry. Only the
# STORE is kept, so no lifecycle script needs to run (`ignore-scripts`): the kit's fetch runs
# esbuild's postinstall, whose Go binary segfaults under amd64 emulation on an ARM Mac.
ARG KIT_TAG=0.16.0
RUN git clone --depth 1 --branch "${KIT_TAG}" https://github.com/rocketflare-dev/rocketflare /tmp/kit \
 && cd /tmp/kit && pnpm fetch --frozen-lockfile --config.ignore-scripts=true \
 && rm -rf /tmp/kit

# Non-secret defaults every session shares. No key: `ANTHROPIC_API_KEY` is a placeholder the model
# proxy swaps (set per command by the turn runner, never here).
ENV NODE_USE_SYSTEM_CA=1 \
    CI=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1 \
    JAVASCRIPT_POOL_MIN_SIZE=0 \
    TYPESCRIPT_POOL_MIN_SIZE=0 \
    PYTHON_POOL_MIN_SIZE=0
RUN git config --system init.defaultBranch main \
 && git config --system advice.detachedHead false \
 && mkdir -p /workspace

# :3000 is the Sandbox SDK's own control server (S7 finding 3): the app's Vite UI is :5173 and its
# `wrangler dev` API :8787 (`DEV_UI_PORT` / `DEV_API_PORT`, kit 0.15).
EXPOSE 5173 8787
