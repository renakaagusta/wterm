# Laptop Deployment Guide

Step-by-step setup for running wterm on a personal macOS workstation, exposed to the internet via Cloudflare Tunnel. Server deployments behind Traefik are simpler — see [`../deploy/traefik/`](../deploy/traefik/).

---

## Architecture Overview

```
Browser → terminal.example.com
             ↓
       cloudflared (Docker)
             ↓
       wterm (Docker, port 3001)
             ↓ bind mounts & socat bridges
       macOS host
         ├── appctl daemon  (Unix socket + TCP :9225 + socat bridge :7654)
         ├── Chrome (CDP ports 9223–9230)
         ├── ADB server (:5037)
         └── Android SDK (emulator, sdkmanager, adb, etc.)
```

The container forwards several ports back to the macOS host via `socat` so agents inside the terminal can use macOS-native tools (Chrome, Android emulator, appctl) transparently.

---

## Prerequisites

Install these on the macOS host before deploying:

- **Docker Desktop** — containers must be able to resolve `host.docker.internal`
- **Node.js 20+** — for the appctl daemon
- **socat** — bridges the appctl Unix socket over TCP (`brew install socat`)
- **Cloudflare account** — with a tunnel created via `cloudflared tunnel create`
- **Android Studio / SDK** — optional, only if Android tooling is needed
- **Google Chrome** — optional, only if browser automation is needed

---

## Step 1 — Clone the repos

```bash
git clone <wterm-repo-url> ~/Documents/project/wterm
git clone <appctl-repo-url> ~/Documents/project/appctl
```

The `appctl` directory is bind-mounted read-only into the container at `/opt/appctl`.

---

## Step 2 — Create the Cloudflare tunnel config

```bash
cd ~/Documents/project/wterm/deploy/cloudflared
cp cloudflared-config.example.yml cloudflared-config.yml
```

Edit `cloudflared-config.yml` and replace `REPLACE_WITH_TUNNEL_ID` and the example hostnames with your own. The credentials JSON path is set in `.env` (next step) — the file inside the container always lives at `/etc/cloudflared/credentials.json`.

---

## Step 3 — Create `.env`

```bash
cp .env.example .env
```

Fill in at minimum:

```env
SHELL_USER=youruser                                   # your macOS username
HOST_HOME=/Users/youruser                             # absolute path
APPCTL_HOST_PATH=/Users/youruser/Documents/project/appctl
WTERM_PASSWORD=<openssl rand -hex 16>
TOKEN_SECRET=<openssl rand -hex 32>
CLOUDFLARED_CONFIG=/Users/youruser/Documents/project/wterm/deploy/cloudflared/cloudflared-config.yml
CLOUDFLARED_CREDENTIALS=/Users/youruser/.cloudflared/<tunnel-id>.json
```

See `.env.example` for the optional variables (VS Code URL, GH token, host port, etc).

---

## Step 4 — Start the appctl daemon on the macOS host

The daemon must run on the host so the container can reach it.

```bash
node ~/Documents/project/appctl/daemon.mjs &
```

The daemon listens on two interfaces:
- Unix socket: `/tmp/appctl.sock` (for local macOS processes)
- TCP: `127.0.0.1:9225` (for Docker containers via `host.docker.internal`)

**Bridge the Unix socket over TCP** so the container's `entrypoint.sh` can reconstruct it:

```bash
socat TCP-LISTEN:7654,reuseaddr,fork UNIX-CONNECT:/tmp/appctl.sock &
```

To make both survive reboots, add them to `~/Library/LaunchAgents/`. Example plist for the daemon:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>dev.appctl.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/youruser/Documents/project/appctl/daemon.mjs</string>
  </array>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>/tmp/appctl-daemon.log</string>
  <key>StandardErrorPath</key> <string>/tmp/appctl-daemon.log</string>
</dict>
</plist>
```

Load it:
```bash
launchctl load ~/Library/LaunchAgents/dev.appctl.daemon.plist
```

---

## Step 5 — Build and start the containers

```bash
cd ~/Documents/project/wterm/deploy/cloudflared
docker compose up -d --build
```

Check logs:
```bash
docker compose logs -f wterm
docker compose logs -f cloudflared
```

---

## Step 6 — Verify services inside the container

```bash
# appctl socket bridge
docker exec wterm ls -la /tmp/appctl.sock

# adb reaches macOS ADB server
docker exec -u "$SHELL_USER" wterm adb devices

# agent-browser is available
docker exec wterm agent-browser --version

# Android emulator list (proxied via appctl host-exec)
docker exec -u "$SHELL_USER" wterm emulator -list-avds
```

---

## Port reference

| Port | Where | Purpose |
|------|-------|---------|
| 3001 | Docker container | wterm HTTP/WebSocket server |
| 3021 | macOS loopback | Default host port the UI binds to (override via `WTERM_HOST_PORT`) |
| 5037 | macOS → container (socat) | ADB server (Linux adb client) |
| 7654 | macOS TCP | appctl Unix socket TCP bridge |
| 9223–9230 | macOS → container (socat) | Chrome CDP ports (agent-browser) |
| 9225 | macOS TCP | appctl daemon direct TCP (Docker clients) |

---

## Environment variables reference

See [`../deploy/cloudflared/.env.example`](../deploy/cloudflared/.env.example) for the authoritative list with descriptions.

| Variable | Required | Description |
|----------|----------|-------------|
| `SHELL_USER` | Yes | Username for the in-container shell (should match host user). |
| `HOST_HOME` | Yes | Absolute path of the host home directory to bind-mount. |
| `APPCTL_HOST_PATH` | Yes | Absolute path to your local appctl checkout. |
| `WTERM_PASSWORD` | Yes | Login password for the terminal UI. |
| `TOKEN_SECRET` | Yes | Secret for signing auth tokens. |
| `CLOUDFLARED_CONFIG` | Yes | Path to the tunnel ingress YAML. |
| `CLOUDFLARED_CREDENTIALS` | Yes | Path to the tunnel credentials JSON. |
| `WTERM_HOST_PORT` | No | Loopback port the UI binds to. Default `3021`. |
| `BRIDGE_SECRET` | No | Shared secret for the appctl HTTP bridge. |
| `GH_TOKEN` | No | GitHub token for the in-terminal `gh` CLI. |
| `VSCODE_URL` | No | Public URL of an openvscode-server, shown in the UI. |
| `VSCODE_PATH_MAP` | No | `host_path:container_path` rewrite for VS Code "open" links. |

---

## Rebuilding after code changes

```bash
cd ~/Documents/project/wterm/deploy/cloudflared
docker compose up -d --build wterm
```

The `cloudflared` container does not need rebuilding unless the tunnel config changes.

---

## Troubleshooting

**Login fails / 401 errors**
- Check `WTERM_PASSWORD` and `TOKEN_SECRET` are set in `.env`.

**appctl commands fail inside terminal**
- Verify `/tmp/appctl.sock` exists in container: `docker exec wterm ls /tmp/appctl.sock`
- Verify port 7654 is open on macOS: `nc -z 127.0.0.1 7654`
- Restart the socat bridge: `socat TCP-LISTEN:7654,reuseaddr,fork UNIX-CONNECT:/tmp/appctl.sock &`

**agent-browser can't reach Chrome**
- Ensure Chrome was launched with remote debugging: `appctl chrome launch`
- Verify CDP ports are forwarded: `docker exec wterm bash -c 'nc -z localhost 9223 && echo ok'`

**adb devices shows nothing**
- Make sure ADB server is running on macOS: `adb start-server`
- Verify port 5037 socat forward is active in the container.

**Cloudflare tunnel not connecting**
- Check the credentials path in `.env` matches the actual file location.
- Run `cloudflared tunnel info <tunnel-id>` to verify the tunnel exists.
