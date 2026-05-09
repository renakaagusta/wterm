FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /build

# Copy manifests for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .npmrc ./
COPY packages/@internal/ts/package.json  ./packages/@internal/ts/
COPY packages/@wterm/core/package.json   ./packages/@wterm/core/
COPY packages/@wterm/dom/package.json    ./packages/@wterm/dom/
COPY packages/@wterm/react/package.json  ./packages/@wterm/react/
COPY app/package.json                    ./app/

RUN pnpm install

# Copy source
COPY packages/@internal/ts/ ./packages/@internal/ts/
COPY packages/@wterm/core/  ./packages/@wterm/core/
COPY packages/@wterm/dom/   ./packages/@wterm/dom/
COPY packages/@wterm/react/ ./packages/@wterm/react/
COPY app/                   ./app/

# Copy wasm into app/public so vite bundles it into dist
RUN mkdir -p app/public && \
    cp packages/@wterm/core/wasm/wterm.wasm app/public/wterm.wasm

# Build all workspace packages in dependency order (turbo handles sequencing),
# then build the app (vite). app/public/wterm.wasm must exist before vite runs.
RUN pnpm run build

# Bundle server.ts into a single server.mjs (all npm deps stay external)
RUN cd app && pnpm exec esbuild server.ts \
    --platform=node \
    --format=esm \
    --bundle \
    --packages=external \
    --outfile=server.mjs

# ─── Runtime ────────────────────────────────────────────────────────────────
# Server only needs node-pty + ws at runtime — install them fresh so
# native bindings are compiled for this platform/arch.

FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ git curl docker.io sshpass openssh-client socat tmux unzip && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only the two runtime deps (compiles node-pty native bindings here)
RUN npm install node-pty@^1.0.0 ws@^8.18.2 --save-exact 2>&1 | tail -3

# Install Claude Code CLI and agent-browser (Linux version)
RUN npm install -g @anthropic-ai/claude-code agent-browser 2>&1 | tail -3

# Install Linux adb for direct ADB server communication (port 5037 forwarded to macOS)
RUN apt-get update && apt-get install -y android-tools-adb && rm -rf /var/lib/apt/lists/*


COPY --from=builder /build/app/dist    ./dist
COPY --from=builder /build/app/server.mjs ./
COPY app/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Shell user identity is set at build time so the same Dockerfile works for
# laptop deploys (where SHELL_USER must match the host user) and server deploys
# (where any non-root user will do). Override via --build-arg.
ARG SHELL_USER=wterm
ARG SHELL_UID=1000
ARG SHELL_GID=1000
ARG SHELL_HOME=/home/wterm

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    WORKSPACE_FILE=/data/workspace.json \
    SHELL_USER=${SHELL_USER} \
    PATH="/opt/appctl/node_modules/.bin:/opt/appctl:${PATH}" \
    AGENT_BROWSER_SCREENSHOT_DIR=${SHELL_HOME}/.cache/agent-browser

# Create non-root shell user. -M means no home dir is created — at runtime the
# host home is bind-mounted at SHELL_HOME (laptop) or a docker volume can be
# mounted there (server). Falls back to picking any free UID/GID if the
# requested ones are taken.
RUN groupadd -g ${SHELL_GID} ${SHELL_USER} 2>/dev/null || groupadd ${SHELL_USER} 2>/dev/null || true && \
    useradd -u ${SHELL_UID} -g ${SHELL_GID} -s /bin/bash -d ${SHELL_HOME} -M ${SHELL_USER} 2>/dev/null || \
    useradd -s /bin/bash -d ${SHELL_HOME} -M ${SHELL_USER} 2>/dev/null || true


# appctl symlink (actual dir is bind-mounted at runtime)
RUN ln -s /opt/appctl/cli.mjs /usr/local/bin/appctl || true

EXPOSE 3001

CMD ["/app/entrypoint.sh"]
