# Session image (spec/07): the stable sandbox image + what a Rocketflare checkout needs.
# No Postgres: each session gets its own Neon branch.
FROM docker.io/cloudflare/sandbox:0.12.10

RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y nodejs \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g corepack@latest @anthropic-ai/claude-code \
 && corepack enable && corepack prepare pnpm@10.18.0 --activate

# Warm pnpm store for the pinned kit tag: installs in a session resolve from here, not the network.
ARG KIT_TAG=0.13.0
RUN git clone --depth 1 --branch ${KIT_TAG} https://github.com/rocketflare-dev/rocketflare /tmp/kit \
 && cd /tmp/kit && pnpm fetch --frozen-lockfile \
 && rm -rf /tmp/kit

EXPOSE 3000 3001
