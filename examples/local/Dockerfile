FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy manifests for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY patches/ ./patches/
COPY packages/@internal/ts/package.json  ./packages/@internal/ts/
COPY packages/@wterm/core/package.json   ./packages/@wterm/core/
COPY packages/@wterm/dom/package.json    ./packages/@wterm/dom/
COPY packages/@wterm/react/package.json  ./packages/@wterm/react/
COPY examples/local/package.json         ./examples/local/

RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/@internal/ts/ ./packages/@internal/ts/
COPY packages/@wterm/core/  ./packages/@wterm/core/
COPY packages/@wterm/dom/   ./packages/@wterm/dom/
COPY packages/@wterm/react/ ./packages/@wterm/react/
COPY examples/local/        ./examples/local/

# Copy wasm and build Vite frontend
RUN mkdir -p examples/local/public && \
    cp examples/local/node_modules/@wterm/core/wasm/wterm.wasm examples/local/public/wterm.wasm
RUN cd examples/local && node_modules/.bin/vite build

# Bundle server.ts into a single server.mjs (all npm deps stay external)
RUN cd examples/local && node_modules/.bin/esbuild server.ts \
    --platform=node \
    --format=esm \
    --bundle \
    --packages=external \
    --outfile=server.mjs

# ─── Runtime ────────────────────────────────────────────────────────────────
# Server only needs node-pty + ws at runtime — install them fresh so
# native bindings are compiled for this platform/arch.

FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only the two runtime deps (compiles node-pty native bindings here)
RUN npm install node-pty@^1.0.0 ws@^8.18.2 --save-exact 2>&1 | tail -3

COPY --from=builder /app/examples/local/dist    ./dist
COPY --from=builder /app/examples/local/server.mjs ./

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    WORKSPACE_FILE=/data/workspace.json

EXPOSE 3001

CMD ["node", "server.mjs"]
