import { createServer, IncomingMessage, ServerResponse } from "http";
import { parse } from "url";
import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { exec, execFile } from "child_process";
import { readFileSync, writeFileSync, existsSync, statSync, readlinkSync, readdirSync, createReadStream } from "fs";
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
  cwd?: string; // tracked via OSC 7 sequences from the shell
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

function resolveUid(username: string): { uid: number; gid: number; home: string } | null {
  try {
    // Read /etc/passwd to resolve uid/gid/home without spawning a process
    const passwd = readFileSync("/etc/passwd", "utf-8");
    for (const line of passwd.split("\n")) {
      const parts = line.split(":");
      if (parts[0] === username) {
        return { uid: parseInt(parts[2]), gid: parseInt(parts[3]), home: parts[5] };
      }
    }
  } catch {}
  return null;
}

function createSession(id: string): Session {
  const shellUser = process.env.SHELL_USER;
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  let uid: number | undefined;
  let gid: number | undefined;
  let home: string = process.env.HOME || "/";

  if (isRoot && shellUser) {
    const resolved = resolveUid(shellUser);
    if (resolved) { uid = resolved.uid; gid = resolved.gid; home = resolved.home; }
  }

  const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/bash");
  const osc7Cmd = `printf '\\033]7;file://%s%s\\007' "$(hostname)" "$(pwd)"`;
  const baseEnv = cleanEnv();
  const existingPrompt = baseEnv.PROMPT_COMMAND || "";
  const env = {
    ...baseEnv,
    HOME: home,
    USER: shellUser || baseEnv.USER || "",
    PROMPT_COMMAND: existingPrompt ? `${osc7Cmd}; ${existingPrompt}` : osc7Cmd,
    // Trust all directories — avoids "dubious ownership" errors on bind-mounted macOS paths
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };

  const ptyProcess = pty.spawn(shell, ["--login"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: home,
    env,
    ...(uid !== undefined ? { uid, gid } : {}),
  });

  const session: Session = { id, ptyProcess, clients: new Set(), scrollback: [], lastActivity: Date.now() };

  ptyProcess.onData((data) => {
    session.lastActivity = Date.now();
    // Parse OSC 7 CWD reports: \033]7;file://hostname/path\007 or ...\033\\
    const osc7 = data.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)(?:\x07|\x1b\\)/);
    if (osc7 && osc7[1]) {
      const path = decodeURIComponent(osc7[1]);
      if (path) session.cwd = path;
    }
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

// Scan /proc for direct children of a given PID.
function childPids(ppid: number): number[] {
  const out: number[] = [];
  try {
    for (const entry of readdirSync("/proc")) {
      const pid = parseInt(entry);
      if (isNaN(pid)) continue;
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf-8");
        const m = status.match(/^PPid:\s+(\d+)/m);
        if (m && parseInt(m[1]) === ppid) out.push(pid);
      } catch {}
    }
  } catch {}
  return out;
}

// Walk the process tree depth-first and return the deepest leaf PID.
// This finds the actual foreground shell (or subprocess) even when the
// pty process itself is `su` (which starts at cwd="/").
function deepestLeaf(pid: number, depth = 0): number {
  if (depth > 8) return pid; // guard against runaway
  const children = childPids(pid);
  if (children.length === 0) return pid;
  // Prefer the last child (most recently spawned, e.g. interactive shell).
  return deepestLeaf(children[children.length - 1], depth + 1);
}

function handleCwd(req: IncomingMessage, res: ServerResponse) {
  const { query } = parse(req.url || "/", true);
  const sessionId = typeof query.sessionId === "string" ? query.sessionId : "";
  const session = sessions.get(sessionId);
  if (!session) { res.writeHead(404); res.end("session not found"); return; }

  const cwd = session.cwd;
  if (!cwd) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ cwd: "/" })); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ cwd }));
}

// ─── Directory listing ───────────────────────────────────────────────────────

function handleLs(req: IncomingMessage, res: ServerResponse) {
  const { query } = parse(req.url || "/", true);
  const sessionId = typeof query.sessionId === "string" ? query.sessionId : "";
  const pathParam = typeof query.path === "string" ? query.path : "";
  const session = sessions.get(sessionId);
  const dir = pathParam || session?.cwd || "/";

  try {
    const raw = readdirSync(dir, { withFileTypes: true });
    const items = raw
      .filter((e) => e.isDirectory() || e.isFile())
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ dir, items }));
  } catch (err) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ dir, items: [], error: String(err) }));
  }
}

// ─── File content ────────────────────────────────────────────────────────────

function handleFileRead(req: IncomingMessage, res: ServerResponse) {
  const { query } = parse(req.url || "/", true);
  const filePath = typeof query.path === "string" ? query.path : "";

  if (!filePath) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "path required" }));
    return;
  }

  try {
    const stat = statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "File too large (>2 MB)", tooLarge: true }));
      return;
    }
    const content = readFileSync(filePath, "utf8");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ content, size: stat.size }));
  } catch (err) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

// ─── Raw file serving (for PDF preview etc.) ─────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".pdf":  "application/pdf",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
  ".webp": "image/webp",
};

function handleFileRaw(req: IncomingMessage, res: ServerResponse) {
  const { query } = parse(req.url || "/", true);
  const filePath = typeof query.path === "string" ? query.path : "";

  if (!filePath) { res.writeHead(400); res.end("path required"); return; }

  try {
    const stat = statSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": stat.size,
      "Content-Disposition": "inline",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}

// ─── Git info for a session's cwd ───────────────────────────────────────────

function handleGitInfo(req: IncomingMessage, res: ServerResponse) {
  const { query } = parse(req.url || "/", true);
  const sessionId = typeof query.sessionId === "string" ? query.sessionId : "";
  const session = sessions.get(sessionId);
  const empty = { branch: null as string | null, added: 0, removed: 0 };

  const cwd = session?.cwd;
  if (!cwd) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(empty));
    return;
  }

  execFile("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 3000 }, (err, branchOut) => {
    if (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(empty));
      return;
    }
    const branch = branchOut.trim();
    execFile("git", ["-C", cwd, "diff", "HEAD", "--shortstat"], { timeout: 3000 }, (_err2, stat) => {
      let added = 0, removed = 0;
      const addM = stat.match(/(\d+) insertion/);
      const delM = stat.match(/(\d+) deletion/);
      if (addM) added = parseInt(addM[1]);
      if (delM) removed = parseInt(delM[1]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ branch, added, removed }));
    });
  });
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
  if (pathname === "/api/ls") return handleLs(req, res);
  if (pathname === "/api/file") return handleFileRead(req, res);
  if (pathname === "/api/file-raw") return handleFileRaw(req, res);
  if (pathname === "/api/git-info") return handleGitInfo(req, res);
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
