# Deployment Guide

This guide covers deploying wterm on a new macOS machine. The setup runs two Docker containers (wterm + Cloudflare tunnel) and relies on several macOS-side services.

---

## Architecture Overview

```
Browser → terminal.renakaagusta.dev
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

The Docker container forwards several ports back to the macOS host via `socat` so agents inside the terminal can use macOS-native tools (Chrome, Android emulator, appctl) transparently.

---

## Prerequisites

Install these on the macOS host before deploying:

- **Docker Desktop** — containers must be able to resolve `host.docker.internal`
- **Node.js 20+** — for the appctl daemon (`node /path/to/appctl/daemon.mjs`)
- **socat** — bridges the appctl Unix socket over TCP (`brew install socat`)
- **Cloudflare account** — with a tunnel configured for `terminal.renakaagusta.dev`
- **Android Studio / SDK** — if Android tooling is needed (`~/Library/Android/sdk`)
- **Google Chrome** — if browser automation via `agent-browser` is needed

---

## Step 1 — Clone the repo

```bash
git clone <wterm-repo-url> ~/Documents/project/wterm
git clone <appctl-repo-url> ~/Documents/project/appctl
```

The `appctl` directory is bind-mounted read-only into the container at `/opt/appctl`.

---

## Step 2 — Create the `.env` file

Create `examples/local/.env` (never commit this):

```env
# Password required to log in to the terminal UI
WTERM_PASSWORD=your-strong-password-here

# Secret used to sign session tokens (any long random string)
TOKEN_SECRET=your-random-secret-here

# Absolute path to your Cloudflare tunnel credentials JSON
CLOUDFLARED_CREDENTIALS=/Users/YOUR_USER/.cloudflared/your-tunnel-id.json
```

Generate a strong secret:
```bash
openssl rand -hex 32
```

---

## Step 3 — Configure the Cloudflare tunnel

Edit `examples/local/cloudflared-docker.yml`:

```yaml
tunnel: <your-tunnel-id>
credentials-file: /etc/cloudflared/credentials.json

ingress:
  - hostname: terminal.renakaagusta.dev
    service: http://wterm:3001

  - service: http_status:404
```

The tunnel ID and credentials file come from `cloudflared tunnel create <name>`.  
Make sure `CLOUDFLARED_CREDENTIALS` in `.env` points to the downloaded credentials JSON.

---

## Step 4 — Adapt `docker-compose.yml` for the new machine

Open `examples/local/docker-compose.yml` and update the bind-mount paths to match the new user's home directory:

```yaml
volumes:
  - wterm-data:/data
  - /Users/YOUR_USER:/Users/YOUR_USER          # ← update username
  - /var/run/docker.sock:/var/run/docker.sock
  - /Users/YOUR_USER/Documents/project/appctl:/opt/appctl:ro  # ← update path
```

Also update these environment variables in the same file:

```yaml
environment:
  - SHELL_USER=YOUR_USER    # the non-root user the shell runs as
```

---

## Step 5 — Adapt the Dockerfile for the new user

In `examples/local/Dockerfile`, update the username in two places:

```dockerfile
# Shell user account (must match SHELL_USER env)
RUN useradd -u 1000 -g 1000 -s /bin/bash -d /Users/YOUR_USER -M YOUR_USER ...

# Screenshot directory (on bind-mounted home)
ENV AGENT_BROWSER_SCREENSHOT_DIR=/Users/YOUR_USER/.cache/agent-browser
```

Also update the `PATH` inside `ENV` if the appctl path changes:

```dockerfile
ENV PATH="/opt/appctl/node_modules/.bin:/opt/appctl:${PATH}"
```

---

## Step 6 — Start the appctl daemon on the macOS host

The daemon must run on the host so the container can reach it.

```bash
# Start the daemon (auto-restarts are not set up — use launchd or a keep-alive loop)
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
    <string>/Users/YOUR_USER/Documents/project/appctl/daemon.mjs</string>
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

## Step 7 — Build and start the containers

```bash
cd ~/Documents/project/wterm/examples/local
docker-compose build
docker-compose up -d
```

Check logs:
```bash
docker-compose logs -f wterm
docker-compose logs -f cloudflared
```

---

## Step 8 — Verify services inside the container

```bash
# appctl socket bridge
docker exec wterm ls -la /tmp/appctl.sock

# adb reaches macOS ADB server
docker exec -u renakaagusta wterm adb devices

# agent-browser is available
docker exec wterm agent-browser --version

# Android emulator list (proxied via appctl host-exec)
docker exec -u renakaagusta wterm emulator -list-avds
```

---

## Port reference

| Port | Where | Purpose |
|------|-------|---------|
| 3001 | Docker container | wterm HTTP/WebSocket server |
| 5037 | macOS → container (socat) | ADB server (Linux adb client) |
| 7654 | macOS TCP | appctl Unix socket TCP bridge |
| 9223–9230 | macOS → container (socat) | Chrome CDP ports (agent-browser) |
| 9225 | macOS TCP | appctl daemon direct TCP (Docker clients) |

---

## Environment variables reference

| Variable | Required | Description |
|----------|----------|-------------|
| `WTERM_PASSWORD` | Yes | Login password for the terminal UI |
| `TOKEN_SECRET` | Yes | Secret for signing auth tokens |
| `CLOUDFLARED_CREDENTIALS` | Yes | Path to Cloudflare tunnel credentials JSON |
| `SHELL_USER` | Yes | macOS username the shell session runs as |
| `AGENT_BROWSER_SCREENSHOT_DIR` | No | Where screenshots are saved (default: `/tmp`) |
| `DOCKER_HOST` | No | Docker socket path inside container |

---

## Rebuilding after code changes

```bash
cd ~/Documents/project/wterm/examples/local
docker-compose build wterm
docker-compose up -d wterm
```

The `cloudflared` container does not need rebuilding unless the tunnel config changes.

---

## Troubleshooting

**Login fails / 401 errors**
- Check `WTERM_PASSWORD` and `TOKEN_SECRET` are set in `.env`

**appctl commands fail inside terminal**
- Verify `/tmp/appctl.sock` exists in container: `docker exec wterm ls /tmp/appctl.sock`
- Verify port 7654 is open on macOS: `nc -z 127.0.0.1 7654`
- Restart the socat bridge: `socat TCP-LISTEN:7654,reuseaddr,fork UNIX-CONNECT:/tmp/appctl.sock &`

**agent-browser can't reach Chrome**
- Ensure Chrome was launched with remote debugging: `appctl chrome launch`
- Verify CDP ports are forwarded: `docker exec wterm bash -c 'nc -z localhost 9223 && echo ok'`

**adb devices shows nothing**
- Make sure ADB server is running on macOS: `adb start-server`
- Verify port 5037 socat forward is active in the container

**Cloudflare tunnel not connecting**
- Check credentials path in `.env` matches the actual file location
- Run `cloudflared tunnel info <tunnel-id>` to verify the tunnel exists
