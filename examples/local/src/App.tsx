import { useCallback, useEffect, useRef, useState } from "react";
import { Columns2, Rows2, X, Cpu, MemoryStick, HardDrive, Terminal as TermIcon, Zap, LogOut } from "lucide-react";
import { PaneTerminal, PaneHandle } from "./Pane";
import { LoginPage } from "./LoginPage";

// ─── Pane tree ──────────────────────────────────────────────────────────────

type TerminalPane = { kind: "terminal"; id: string; sessionId: string };
type SplitPane = { kind: "split"; direction: "h" | "v"; ratio: number; first: PaneNode; second: PaneNode };
type PaneNode = TerminalPane | SplitPane;

let _nextId = 1;
const newId = () => String(_nextId++);
const newTermPane = (): TerminalPane => ({ kind: "terminal", id: newId(), sessionId: crypto.randomUUID() });

function collectTerminals(node: PaneNode): TerminalPane[] {
  if (node.kind === "terminal") return [node];
  return [...collectTerminals(node.first), ...collectTerminals(node.second)];
}

function collectIds(node: PaneNode): string[] {
  return collectTerminals(node).map((p) => p.id);
}

function maxId(node: PaneNode): number {
  if (node.kind === "terminal") return parseInt(node.id) || 0;
  return Math.max(maxId(node.first), maxId(node.second));
}

function splitPane(node: PaneNode, targetId: string, direction: "h" | "v"): PaneNode {
  if (node.kind === "terminal")
    return node.id === targetId
      ? { kind: "split", direction, ratio: 0.5, first: node, second: newTermPane() }
      : node;
  return { ...node, first: splitPane(node.first, targetId, direction), second: splitPane(node.second, targetId, direction) };
}

function removePane(node: PaneNode, targetId: string): PaneNode | null {
  if (node.kind === "terminal") return node.id === targetId ? null : node;
  const first = removePane(node.first, targetId);
  const second = removePane(node.second, targetId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function updateRatio(node: PaneNode, path: number[], ratio: number): PaneNode {
  if (node.kind === "terminal") return node;
  if (path.length === 0) return { ...node, ratio };
  const [head, ...rest] = path;
  return head === 0
    ? { ...node, first: updateRatio(node.first, rest, ratio) }
    : { ...node, second: updateRatio(node.second, rest, ratio) };
}

// ─── Flat layout computation ─────────────────────────────────────────────────

interface PaneGeometry { id: string; sessionId: string; l: number; t: number; w: number; h: number }
interface DividerInfo {
  key: string; isV: boolean; path: number[];
  l: number; t: number; w: number; h: number;
  pl: number; pt: number; pw: number; ph: number;
}

function computeLayouts(
  node: PaneNode, l=0, t=0, w=100, h=100, path: number[] = [],
): { panes: PaneGeometry[]; dividers: DividerInfo[] } {
  if (node.kind === "terminal")
    return { panes: [{ id: node.id, sessionId: node.sessionId, l, t, w, h }], dividers: [] };

  const isV = node.direction === "v";
  const fw = isV ? w * node.ratio : w;
  const fh = isV ? h : h * node.ratio;

  const divider: DividerInfo = {
    key: path.join("/") || "root", isV, path,
    l: isV ? l + fw : l, t: isV ? t : t + fh,
    w: isV ? 0 : w, h: isV ? h : 0,
    pl: l, pt: t, pw: w, ph: h,
  };

  const r1 = computeLayouts(node.first,  l,          t,          fw,       fh,       [...path, 0]);
  const r2 = computeLayouts(node.second, isV?l+fw:l, isV?t:t+fh, isV?w-fw:w, isV?h:h-fh, [...path, 1]);

  return { panes: [...r1.panes, ...r2.panes], dividers: [divider, ...r1.dividers, ...r2.dividers] };
}

// ─── Workspace persistence (server-side) ─────────────────────────────────────

interface Workspace { root: PaneNode; focusedId: string }

async function fetchWorkspace(): Promise<Workspace | null> {
  try {
    const r = await fetch("/api/workspace");
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function saveWorkspace(root: PaneNode, focusedId: string) {
  fetch("/api/workspace", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, focusedId }),
  }).catch(() => {});
}

// ─── Stats ───────────────────────────────────────────────────────────────────

interface Stats { cpu: number; ram: { used: number; total: number }; disk: { used: number; total: number } }

function fmt(bytes: number) {
  return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + "G" : (bytes / 1e6).toFixed(0) + "M";
}

function Bar({ pct }: { pct: number }) {
  const color = pct > 80 ? "bg-red-500" : pct > 60 ? "bg-yellow-400" : "bg-green-400";
  return (
    <div className="h-1.5 w-14 overflow-hidden rounded-full bg-zinc-700">
      <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

export default function App() {
  const [auth, setAuth] = useState<"loading" | "ok" | "login">("loading");
  const [root, setRoot] = useState<PaneNode | null>(null);
  const [focusedId, setFocusedId] = useState<string>("");
  const [stats, setStats] = useState<Stats | null>(null);
  const paneRefs = useRef(new Map<string, PaneHandle>());
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auth check on mount
  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => setAuth(r.ok ? "ok" : "login"))
      .catch(() => setAuth("login"));
  }, []);

  // Load workspace from server once authenticated
  useEffect(() => {
    if (auth !== "ok") return;
    fetchWorkspace().then((ws) => {
      if (ws?.root) {
        _nextId = maxId(ws.root) + 1;
        setRoot(ws.root);
        setFocusedId(ws.focusedId ?? collectIds(ws.root)[0]);
      } else {
        const pane = newTermPane();
        setRoot(pane);
        setFocusedId(pane.id);
      }
    });
  }, [auth]);

  // Save workspace to server (debounced 400ms)
  useEffect(() => {
    if (!root || !focusedId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveWorkspace(root, focusedId), 400);
  }, [root, focusedId]);

  useEffect(() => {
    if (auth !== "ok") return;
    const poll = async () => {
      try { const r = await fetch("/api/stats"); if (r.ok) setStats(await r.json()); } catch {}
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [auth]);

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    setRoot(null);
    setStats(null);
    setAuth("login");
  }

  const splitV = useCallback(() => setRoot((r) => r ? splitPane(r, focusedId, "v") : r), [focusedId]);
  const splitH = useCallback(() => setRoot((r) => r ? splitPane(r, focusedId, "h") : r), [focusedId]);

  const closePane = useCallback(() => {
    setRoot((r) => {
      if (!r || collectIds(r).length <= 1) return r;
      const next = removePane(r, focusedId);
      if (!next) return r;
      setFocusedId(collectIds(next)[0]);
      return next;
    });
  }, [focusedId]);

  const sendAppctl = useCallback(() => {
    paneRefs.current.get(focusedId)?.send("appctl\r");
  }, [focusedId]);

  const handleDividerDrag = useCallback((
    e: React.MouseEvent, path: number[], isV: boolean,
    pl: number, pt: number, pw: number, ph: number,
  ) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const onMove = (ev: MouseEvent) => {
      const xPct = ((ev.clientX - rect.left) / rect.width) * 100;
      const yPct = ((ev.clientY - rect.top) / rect.height) * 100;
      const ratio = isV ? (xPct - pl) / pw : (yPct - pt) / ph;
      setRoot((r) => r ? updateRatio(r, path, Math.max(0.05, Math.min(0.95, ratio))) : r);
    };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "d" && !e.shiftKey) { e.preventDefault(); splitV(); }
      if (e.shiftKey && e.key === "D") { e.preventDefault(); splitH(); }
      if (e.key === "w") { e.preventDefault(); closePane(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [splitV, splitH, closePane]);

  if (auth === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-600 text-sm">
        connecting…
      </div>
    );
  }

  if (auth === "login") {
    return <LoginPage onLogin={() => { setRoot(null); setAuth("ok"); }} />;
  }

  if (!root) {
    return (
      <div className="flex h-screen items-center justify-center bg-black text-zinc-600 text-sm">
        connecting…
      </div>
    );
  }

  const { panes, dividers } = computeLayouts(root);
  const paneCount = panes.length;

  return (
    <div className="flex h-screen flex-col bg-black">
      {/* Title bar */}
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 select-none">
        <TermIcon size={14} className="text-zinc-500" />
        <span className="text-xs text-zinc-400">{paneCount} {paneCount === 1 ? "pane" : "panes"}</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={splitV} title="Split vertical (⌘D)" className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200">
            <Columns2 size={13} /> <span>Vertical</span>
          </button>
          <button onClick={splitH} title="Split horizontal (⌘⇧D)" className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200">
            <Rows2 size={13} /> <span>Horizontal</span>
          </button>
          <button onClick={closePane} disabled={paneCount <= 1} title="Close pane (⌘W)" className="rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-red-400 disabled:opacity-30">
            <X size={13} />
          </button>
          <div className="ml-1 h-4 w-px bg-zinc-700" />
          <button onClick={handleLogout} title="Sign out" className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300">
            <LogOut size={13} />
          </button>
        </div>
      </div>

      {/* Pane area — flat absolute layout */}
      <div ref={containerRef} className="relative min-h-0 flex-1">
        {panes.map(({ id, sessionId, l, t, w, h }) => (
          <div
            key={id}
            style={{ position: "absolute", left: `${l}%`, top: `${t}%`, width: `${w}%`, height: `${h}%` }}
          >
            <PaneTerminal
              ref={(handle) => { if (handle) paneRefs.current.set(id, handle); else paneRefs.current.delete(id); }}
              paneId={id}
              sessionId={sessionId}
              focused={id === focusedId}
              onFocus={() => setFocusedId(id)}
            />
          </div>
        ))}
        {dividers.map(({ key, isV, path, l, t, w, h, pl, pt, pw, ph }) => (
          <div
            key={key}
            onMouseDown={(e) => handleDividerDrag(e, path, isV, pl, pt, pw, ph)}
            style={{
              position: "absolute",
              left: `${l}%`, top: `${t}%`,
              width: isV ? "4px" : `${w}%`,
              height: isV ? `${h}%` : "4px",
              transform: isV ? "translateX(-2px)" : "translateY(-2px)",
              cursor: isV ? "col-resize" : "row-resize",
              zIndex: 20,
            }}
            className="bg-zinc-800 hover:bg-blue-500 transition-colors"
          />
        ))}
      </div>

      {/* Bottom status bar */}
      <div className="flex items-center gap-4 border-t border-zinc-800 bg-zinc-950 px-3 py-1 text-xs text-zinc-500 select-none">
        {stats ? (
          <>
            <div className="flex items-center gap-1.5">
              <Cpu size={11} /><span className="w-8">{stats.cpu}%</span><Bar pct={stats.cpu} />
            </div>
            <div className="flex items-center gap-1.5">
              <MemoryStick size={11} /><span>{fmt(stats.ram.used)}/{fmt(stats.ram.total)}</span>
              <Bar pct={Math.round((stats.ram.used / stats.ram.total) * 100)} />
            </div>
            <div className="flex items-center gap-1.5">
              <HardDrive size={11} /><span>{fmt(stats.disk.used)}/{fmt(stats.disk.total)}</span>
              <Bar pct={Math.round((stats.disk.used / stats.disk.total) * 100)} />
            </div>
          </>
        ) : (
          <span className="text-zinc-700">loading stats…</span>
        )}
        <div className="ml-auto">
          <button onClick={sendAppctl} className="flex items-center gap-1.5 rounded bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-blue-600 hover:text-white transition-colors">
            <Zap size={11} /> appctl
          </button>
        </div>
      </div>
    </div>
  );
}
