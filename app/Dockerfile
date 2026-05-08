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

# Wrapper scripts for macOS-native Android tools — proxy through appctl host-exec
RUN printf '#!/bin/bash\nappctl host-exec "~/Library/Android/sdk/emulator/emulator $* 2>&1"\n' > /usr/local/bin/emulator && \
    printf '#!/bin/bash\nappctl host-exec "~/Library/Android/sdk/cmdline-tools/latest/bin/sdkmanager $*"\n' > /usr/local/bin/sdkmanager && \
    printf '#!/bin/bash\nappctl host-exec "~/Library/Android/sdk/cmdline-tools/latest/bin/avdmanager $*"\n' > /usr/local/bin/avdmanager && \
    printf '#!/bin/bash\nappctl host-exec "~/Library/Android/sdk/platform-tools/fastboot $*"\n' > /usr/local/bin/fastboot && \
    chmod +x /usr/local/bin/emulator /usr/local/bin/sdkmanager /usr/local/bin/avdmanager /usr/local/bin/fastboot

COPY --from=builder /build/app/dist    ./dist
COPY --from=builder /build/app/server.mjs ./
COPY app/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    WORKSPACE_FILE=/data/workspace.json \
    SHELL_USER=renakaagusta \
    PATH="/opt/appctl/node_modules/.bin:/opt/appctl:${PATH}" \
    AGENT_BROWSER_SCREENSHOT_DIR=/Users/renakaagusta/.cache/agent-browser

# Create non-root shell user with home dir pointing to the bind-mounted host home
RUN useradd -u 1000 -g 1000 -s /bin/bash -d /Users/renakaagusta -M renakaagusta 2>/dev/null || \
    useradd -s /bin/bash -d /Users/renakaagusta -M renakaagusta 2>/dev/null || true

# appctl symlink (actual dir is bind-mounted at runtime)
RUN ln -s /opt/appctl/cli.mjs /usr/local/bin/appctl || true

EXPOSE 3001

CMD ["/app/entrypoint.sh"]
