# Deployment

Two reference Compose stacks. Pick the one that matches where you're running wterm.

| Variant | Use it when | Reverse proxy |
|---|---|---|
| [`cloudflared/`](cloudflared/) | Personal laptop / workstation, no public IP | Cloudflare Tunnel |
| [`traefik/`](traefik/) | Server with a public IP and an existing Traefik install | Traefik |

Both stacks build the same image from `app/Dockerfile` — only the runtime wiring differs.

## Quick start

```bash
cd deploy/<variant>
cp .env.example .env
# fill in WTERM_PASSWORD, TOKEN_SECRET, hostnames, ...
docker compose up -d --build
```

## Required environment variables

Every variant needs these:

| Variable | Purpose |
|---|---|
| `WTERM_PASSWORD` | Login password for the terminal UI. |
| `TOKEN_SECRET` | Secret that signs session cookies. Generate with `openssl rand -hex 32`. |

The Cloudflare variant additionally needs `SHELL_USER`, `HOST_HOME`, `APPCTL_HOST_PATH`, `CLOUDFLARED_CONFIG`, and `CLOUDFLARED_CREDENTIALS`. The Traefik variant needs `WTERM_HOST` and an external `traefik` Docker network.

See each variant's `.env.example` for the full list.

## Container shell user

The Dockerfile takes four build args that decide who the in-container shell runs as:

| Build arg | Default | Notes |
|---|---|---|
| `SHELL_USER` | `wterm` | Username inside the container. On laptop deploys this should match your host user so bind-mounted files keep their ownership. |
| `SHELL_UID` | `1000` | |
| `SHELL_GID` | `1000` | |
| `SHELL_HOME` | `/home/wterm` | Home directory. Laptop variant points this at the bind-mounted host home. |

Both compose files pass these through automatically — set them in `.env`, not on the command line.

## Laptop deep dive

The laptop variant assumes a macOS host running an `appctl` daemon plus several `socat` bridges so the container can reach Chrome, ADB, and an SSH agent on the host. See [`../app/DEPLOYMENT.md`](../app/DEPLOYMENT.md) for the full step-by-step.
