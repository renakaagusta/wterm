#!/bin/bash
# Fix docker socket permissions so non-root shell user can run docker commands
chmod 666 /var/run/docker.sock 2>/dev/null || true

# Forward Chrome CDP ports (9222-9299) from container localhost → macOS host.
# This lets `agent-browser --cdp PORT` reach the Chrome instance running on the Mac.
for port in $(seq 9222 9299); do
  socat TCP-LISTEN:${port},reuseaddr,fork TCP:host.docker.internal:${port} 2>/dev/null &
done

# Forward ADB server port so Linux adb client can reach the macOS ADB server.
socat TCP-LISTEN:5037,reuseaddr,fork TCP:host.docker.internal:5037 2>/dev/null &

exec node server.mjs
