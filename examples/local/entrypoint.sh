#!/bin/bash
# Fix docker socket permissions so non-root shell user can run docker commands
chmod 666 /var/run/docker.sock 2>/dev/null || true

# Bridge host appctl daemon socket (exposed via TCP on host) into container as a Unix socket.
# The host must be running: socat TCP-LISTEN:7654,reuseaddr,fork UNIX-CONNECT:/tmp/appctl.sock
rm -f /tmp/appctl.sock
socat UNIX-LISTEN:/tmp/appctl.sock,reuseaddr,fork \
  TCP:host.docker.internal:7654 &
# Wait for socket to appear then make it world-accessible
until [ -S /tmp/appctl.sock ]; do sleep 0.1; done
chmod 777 /tmp/appctl.sock

# Forward Chrome CDP ports (9223-9230) from container localhost → macOS host.
# This lets `agent-browser --cdp PORT` reach the Chrome instance running on the Mac.
for port in 9223 9224 9226 9227 9228 9229 9230; do
  socat TCP-LISTEN:${port},reuseaddr,fork TCP:host.docker.internal:${port} 2>/dev/null &
done

# Forward ADB server port so Linux adb client can reach the macOS ADB server.
socat TCP-LISTEN:5037,reuseaddr,fork TCP:host.docker.internal:5037 2>/dev/null &

exec node server.mjs
