import { createServer, IncomingMessage, ServerResponse } from "http";
import { parse } from "url";
import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { exec } from "child_process";
import { readFileSync, writeFileSync, existsSync, statSync, readlinkSync, readdirSync } from "fs";
import { join, extname, dirname } from "path";
import { fileURLToPath } from "url";
import os from "os";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "127.0.0.1";
const IS_PROD = process.env.NODE_ENV === "production";

// ─── Auth ────────────────────────────────────────────────────────────────────

const WTERM_PASSWORD = process.env.WTERM_PASSWORD || "";
// TOKEN_SECRET should be set in env so tokens survive server restarts.
// Falls back to a random value (tokens invalidated on restart) if not set.
const TOKEN_SECRET = process.env.TOKEN_SECRET || randomUUID();

function makeToken(): string {
  return createHmac("sha256", TOKEN_SECRET).update("wterm:auth:v1").digest("hex");
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k.trim()] = decodeURIComponent(rest.join("=").trim());
  }
  return out;
}

function isAuthenticated(req: IncomingMessage): boolean {
  if (!WTERM_PASSWORD) return true;
  const token = parseCookies(req)["wterm_auth"];
  if (!token) return false;
  const expected = makeToken();
  try {
    return (
      token.length === expected.length &&
      timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"))
    );
  } catch { return false; }
}

function authCookie(value: string, maxAge: number): string {
  const secure = IS_PROD ? "; Secure" : "";
  return `wterm_auth=${value}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function handleLogin(req: IncomingMessage, res: ServerResponse) {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    try {
      const { password } = JSON.parse(body);
      if (!WTERM_PASSWORD || password === WTERM_PASSWORD) {
        res.writeHead(200, {
          "Set-Cookie": authCookie(makeToken(), 7 * 24 * 3600),
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid password" }));
      }
    } catch {
      res.writeHead(400);
      res.end();
    }
  });
}

function handleLogout(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "Set-Cookie": authCookie("", 0),
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ ok: true }));
}

function handleAuthCheck(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

function unauthorized(res: ServerResponse) {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

const SESSION_IDLE_MS = 60 * 60 * 1000;
const SCROLLBACK_CHUNKS = 500;

interface Session {
  id: string;
  ptyProcess: pty.IPty;
  clients: Set<WebSocket>;
  scrollback: string[];
  lastActivity: number;
}

const sessions = new Map<string, Session>();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.clients.size === 0 && now - session.lastActivity > SESSION_IDLE_MS) {
      session.ptyProcess.kill();
      sessions.delete(id);
      console.log(`[session ${id.slice(0, 8)}] cleaned up after idle`);
    }
  }
}, 60_000);

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function createSession(id: string): Session {
  const shellUser = process.env.SHELL_USER;
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const usesSu = isRoot && !!shellUser;

  const cmd = usesSu ? "su" : (process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/bash"));
  const args = usesSu ? ["-", shellUser!] : [];
  const cwd = usesSu ? "/" : (process.env.HOME || "/");

  const ptyProcess = pty.spawn(cmd, args, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: cleanEnv(),
  });

  const session: Session = { id, ptyProcess, clients: new Set(), scrollback: [], lastActivity: Date.now() };

  ptyProcess.onData((data) => {
    session.lastActivity = Date.now();
    session.scrollback.push(data);
    if (session.scrollback.length > SCROLLBACK_CHUNKS)
      session.scrollback = session.scrollback.slice(-SCROLLBACK_CHUNKS);
    for (const client of session.clients)
      if (client.readyState === WebSocket.OPEN) client.send(data);
  });

  ptyProcess.onExit(() => {
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send("\r\n\x1b[31m[process exited]\x1b[0m\r\n");
        client.close();
      }
    }
    sessions.delete(id);
    console.log(`[session ${id.slice(0, 8)}] process exited`);
  });

  sessions.set(id, session);
  console.log(`[session ${id.slice(0, 8)}] created`);
  return session;
}

const DEFAULT_SESSION_ID = "s1";

function attachToSession(session: Session, ws: WebSocket) {
  const isNewClient = !session.clients.has(ws);
  session.clients.add(ws);

  if (session.scrollback.length > 0) {
    ws.send(session.scrollback.join(""));
    if (!isNewClient) ws.send("\r\n\x1b[90m─── reconnected ───\x1b[0m\r\n");
  }

  ws.on("message", (msg: Buffer | string) => {
    const input = typeof msg === "string" ? msg : msg.toString("utf-8");
    const resizeMatch = input.match(/^\x1b\[RESIZE:(\d+);(\d+)\]$/);
    if (resizeMatch) {
      session.ptyProcess.resize(parseInt(resizeMatch[1], 10), parseInt(resizeMatch[2], 10));
      return;
    }
    session.ptyProcess.write(input);
  });

  ws.on("close", () => {
    session.clients.delete(ws);
    session.lastActivity = Date.now();
    console.log(`[session ${session.id.slice(0, 8)}] client disconnected (${session.clients.size} remaining)`);
  });
}

// ─── Stats (async cached, cross-platform) ────────────────────────────────────

let cachedStats = {
  cpu: 0,
  ram: { used: os.totalmem() - os.freemem(), total: os.totalmem() },
  disk: { used: 0, total: 0 },
};

function updateCpu() {
  const cmd = process.platform === "darwin"
    ? "top -l 1 -s 0 | grep 'CPU usage'"
    : "top -bn1 | grep '%Cpu'";
  exec(cmd, { timeout: 3000 }, (err, out) => {
    if (!err) {
      if (process.platform === "darwin") {
        const m = out.match(/([\d.]+)% user,\s*([\d.]+)% sys/);
        if (m) cachedStats.cpu = Math.round(parseFloat(m[1]) + parseFloat(m[2]));
      } else {
        const m = out.match(/([\d.]+)\s+us.*?([\d.]+)\s+sy/);
        if (m) cachedStats.cpu = Math.round(parseFloat(m[1]) + parseFloat(m[2]));
      }
    } else {
      const load = os.loadavg()[0];
      cachedStats.cpu = Math.min(100, Math.round((load / os.cpus().length) * 100));
    }
    setTimeout(updateCpu, 4000);
  });
}

function updateRam() {
  const total = os.totalmem();
  if (process.platform === "darwin") {
    exec("vm_stat", { timeout: 2000 }, (err, out) => {
      if (!err) {
        const pageSize = parseInt(out.match(/page size of (\d+)/)?.[1] ?? "16384");
        const get = (k: string) => parseInt(out.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] ?? "0");
        const free = (get("Pages free") + get("Pages inactive") + get("Pages speculative")) * pageSize;
        cachedStats.ram = { used: total - free, total };
      } else {
        cachedStats.ram = { used: total - os.freemem(), total };
      }
      setTimeout(updateRam, 4000);
    });
  } else {
    exec("free -b", { timeout: 2000 }, (err, out) => {
      if (!err) {
        const m = out.match(/Mem:\s+(\d+)\s+(\d+)/);
        if (m) cachedStats.ram = { total: parseInt(m[1]), used: parseInt(m[2]) };
        else cachedStats.ram = { used: total - os.freemem(), total };
      } else {
        cachedStats.ram = { used: total - os.freemem(), total };
      }
      setTimeout(updateRam, 4000);
    });
  }
}

function updateDisk() {
  exec("df -k /", { timeout: 2000 }, (err, out) => {
    if (!err) {
      const parts = out.trim().split("\n").at(-1)!.trim().split(/\s+/);
      cachedStats.disk = { total: parseInt(parts[1]) * 1024, used: parseInt(parts[2]) * 1024 };
    }
    setTimeout(updateDisk, 10_000);
  });
}

updateCpu();
updateRam();
updateDisk();

function handleStats(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(cachedStats));
}

// ─── Workspace persistence ───────────────────────────────────────────────────

const WORKSPACE_FILE = process.env.WORKSPACE_FILE || join(os.homedir(), ".wterm-workspace.json");

function handleGetWorkspace(_req: IncomingMessage, res: ServerResponse) {
  try {
    const data = readFileSync(WORKSPACE_FILE, "utf-8");
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("no workspace");
  }
}

function handlePutWorkspace(req: IncomingMessage, res: ServerResponse) {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    try {
      JSON.parse(body);
      writeFileSync(WORKSPACE_FILE, body);
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
    } catch {
      res.writeHead(400);
    }
    res.end();
  });
}

// ─── Config ─────────────────────────────────────────────────────────────────

const VSCODE_URL = process.env.VSCODE_URL || "https://code.renakaagusta.dev";
// Optional path prefix rewrite: "from:to" e.g. "/Users/renakaagusta/Documents/project:/home/project"
const VSCODE_PATH_MAP = process.env.VSCODE_PATH_MAP || "";

function handleConfig(_req: IncomingMessage, res: ServerResponse) {
  const [pathFrom, pathTo] = VSCODE_PATH_MAP.includes(":") ? VSCODE_PATH_MAP.split(":") : ["", ""];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ vscodeUrl: VSCODE_URL, vscodePathFrom: pathFrom, vscodePathTo: pathTo }));
}

// ─── CWD of a session's shell ────────────────────────────────────────────────

function handleCwd(req: IncomingMessage, res: ServerResponse) {
  const { query } = parse(req.url || "/", true);
  const sessionId = typeof query.sessionId === "string" ? query.sessionId : "";
  const session = sessions.get(sessionId);
  if (!session) { res.writeHead(404); res.end("session not found"); return; }

  try {
    const pid = session.ptyProcess.pid;
    // On Linux, find the foreground child process for a more accurate CWD.
    // Fall back to the shell's own CWD if no children are found.
    let targetPid = pid;
    try {
      const children = readdirSync(`/proc/${pid}/task/${pid}/children`)?.[0]
        ? readFileSync(`/proc/${pid}/task/${pid}/children`, "utf-8").trim().split(/\s+/).filter(Boolean)
        : [];
      if (children.length > 0) targetPid = parseInt(children[children.length - 1]);
    } catch {}
    const cwd = readlinkSync(`/proc/${targetPid}/cwd`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cwd }));
  } catch {
    res.writeHead(500);
    res.end("could not read cwd");
  }
}

// ─── Static file serving (production) ───────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, "dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".wasm": "application/wasm",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".json": "application/json",
};

function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  if (!IS_PROD) return false;
  const { pathname } = parse(req.url || "/");
  let filePath = join(STATIC_DIR, pathname || "/");
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(STATIC_DIR, "index.html");
  }
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

// ─── HTTP + WS server ────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const { pathname } = parse(req.url || "/");

  // Public endpoints
  if (pathname === "/api/login"  && req.method === "POST") return handleLogin(req, res);
  if (pathname === "/api/logout" && req.method === "POST") return handleLogout(req, res);

  // Always serve static assets so the login page loads unauthenticated (skip API paths)
  if (!pathname?.startsWith("/api/") && serveStatic(req, res)) return;

  // Everything below requires auth
  if (!isAuthenticated(req)) return unauthorized(res);

  if (pathname === "/api/auth/check") return handleAuthCheck(req, res);
  if (pathname === "/api/stats") return handleStats(req, res);
  if (pathname === "/api/workspace" && req.method === "GET") return handleGetWorkspace(req, res);
  if (pathname === "/api/workspace" && req.method === "PUT") return handlePutWorkspace(req, res);
  if (pathname === "/api/config") return handleConfig(req, res);
  if (pathname === "/api/cwd") return handleCwd(req, res);
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = parse(req.url || "/", true);
  if (pathname !== "/api/terminal") { socket.destroy(); return; }
  if (!isAuthenticated(req)) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const sessionId = typeof query.sessionId === "string" ? query.sessionId : DEFAULT_SESSION_ID;
    let session = sessions.get(sessionId);

    if (!session) {
      const id = sessionId;
      try {
        session = createSession(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(`\r\n\x1b[31mFailed to spawn shell: ${msg}\x1b[0m\r\n`);
          ws.close();
        }
        return;
      }
    } else {
      console.log(`[session ${session.id.slice(0, 8)}] client reconnected`);
    }

    attachToSession(session, ws);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`> wterm ready on http://${HOST}:${PORT}`);
});
