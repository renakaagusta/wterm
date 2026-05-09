import { useCallback, useEffect, useRef, useState } from "react";
import {
  Columns2, Rows2, X, Cpu, MemoryStick, HardDrive, Terminal as TermIcon,
  LogOut, Search, Plus, PanelLeft, LayoutTemplate, Code2, Copy, Folder, Monitor,
} from "lucide-react";
import { PaneTerminal, PaneHandle, GitInfo } from "./Pane";
import { FileBrowser } from "./FileBrowser";
import { FileViewer } from "./FileViewer";
import { LoginPage } from "./LoginPage";
import { GitHubPanel } from "./GitHubPanel";

// ─── Pane tree ──────────────────────────────────────────────────────────────

type TerminalPane = { kind: "terminal"; id: string; sessionId: string };
type SplitPane = { kind: "split"; direction: "h" | "v"; ratio: number; first: PaneNode; second: PaneNode };
type PaneNode = TerminalPane | SplitPane;

interface ForwardedTerminalInfo { id: string; name: string; workspace: string }

let _nextId = 1;
const newId = () => String(_nextId++);
const newTermPane = (): TerminalPane => { const id = newId(); return { kind: "terminal", id, sessionId: `s${id}` }; };

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

function insertPane(node: PaneNode, targetId: string, newPane: TerminalPane): PaneNode {
  if (node.kind === "terminal")
    return node.id === targetId
      ? { kind: "split", direction: "v", ratio: 0.5, first: node, second: newPane }
      : node;
  return { ...node, first: insertPane(node.first, targetId, newPane), second: insertPane(node.second, targetId, newPane) };
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

// ─── Workspace persistence ───────────────────────────────────────────────────

type ViewMode = "split" | "tabs";
interface Workspace { root: PaneNode; focusedId: string; names?: Record<string, string>; viewMode?: ViewMode; sessionCwds?: Record<string, string> }

async function fetchWorkspace(): Promise<Workspace | null> {
  try {
    const r = await fetch("/api/workspace");
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function saveWorkspace(root: PaneNode, focusedId: string, names: Record<string, string>, viewMode: ViewMode, sessionCwds: Record<string, string>) {
  fetch("/api/workspace", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, focusedId, names, viewMode, sessionCwds }),
  }).catch(() => {});
}

// ─── VS Code config ──────────────────────────────────────────────────────────

interface VscodeConfig { vscodeUrl: string; vscodePathFrom: string; vscodePathTo: string }

async function fetchVscodeConfig(): Promise<VscodeConfig> {
  try {
    const r = await fetch("/api/config");
    if (r.ok) return await r.json();
  } catch {}
  return { vscodeUrl: "https://code.renakaagusta.dev", vscodePathFrom: "", vscodePathTo: "" };
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

// ─── Sidebar tab item ────────────────────────────────────────────────────────

interface SidebarItemProps {
  id: string;
  sessionId: string;
  name: string;
  cwd: string;
  gitInfo?: GitInfo;
  isActive: boolean;
  vscodeConfig: VscodeConfig;
  onSelect: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
  onBrowse: () => void;
  onGithub: () => void;
}

function SidebarItem({ id, sessionId, name, cwd, gitInfo, isActive, vscodeConfig, onSelect, onClose, onRename, onBrowse, onGithub }: SidebarItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setDraft(name); }, [name, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  function commitRename() {
    const trimmed = draft.trim();
    if (trimmed) onRename(trimmed);
    else setDraft(name);
    setEditing(false);
  }

  async function openInVscode(e: React.MouseEvent) {
    e.stopPropagation();
    if (!vscodeConfig.vscodeUrl) return;
    try {
      const r = await fetch(`/api/cwd?sessionId=${sessionId}`);
      if (!r.ok) return;
      const { cwd: rawCwd } = await r.json();
      let path = rawCwd as string;
      if (vscodeConfig.vscodePathFrom && path.startsWith(vscodeConfig.vscodePathFrom))
        path = vscodeConfig.vscodePathTo + path.slice(vscodeConfig.vscodePathFrom.length);
      window.open(`${vscodeConfig.vscodeUrl}/?folder=${encodeURIComponent(path)}`, "_blank");
    } catch {}
  }

  function copyPath(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(cwd || "~").catch(() => {});
  }

  const lastSegment = cwd ? (cwd.split("/").filter(Boolean).at(-1) ?? "~") : "~";

  return (
    <div
      className={`group/item relative cursor-pointer px-3 py-2 select-none transition-colors
        ${isActive ? "bg-[#2d1515] text-zinc-200" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}`}
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
    >
      {/* Row 1: icon + name + close button */}
      <div className="flex items-center gap-2">
        <div className={`shrink-0 ${isActive ? "text-zinc-400" : "text-zinc-600"}`}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M2 3.5l3.5 3-3.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M7.5 9.5h3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") { setDraft(name); setEditing(false); }
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            className="min-w-0 flex-1 rounded bg-zinc-700 px-1 py-0.5 text-xs text-zinc-200 outline-none focus:ring-1 focus:ring-blue-500"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{name}</span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          title="Close"
          className="ml-auto shrink-0 rounded p-0.5 text-zinc-600 opacity-0 transition-opacity group-hover/item:opacity-100 hover:text-red-400"
        >
          <X size={11} />
        </button>
      </div>

      {/* Row 2: browsable path + copy + vscode */}
      <div className="mt-1 flex items-center gap-1 pl-5">
        <button
          onClick={(e) => { e.stopPropagation(); onBrowse(); }}
          title="Browse directory"
          className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-200 transition-colors"
        >
          <Folder size={11} className="shrink-0 text-zinc-500" />
          <span className="truncate">{lastSegment}</span>
        </button>
        <button
          onClick={copyPath}
          title={cwd || "~"}
          className="shrink-0 rounded p-0.5 text-zinc-700 opacity-0 transition-opacity group-hover/item:opacity-100 hover:text-zinc-400"
        >
          <Copy size={10} />
        </button>
        {vscodeConfig.vscodeUrl && (
          <button
            onClick={openInVscode}
            title="Open in VS Code"
            className="shrink-0 rounded p-0.5 text-zinc-700 opacity-0 transition-opacity group-hover/item:opacity-100 hover:text-blue-400"
          >
            <Code2 size={10} />
          </button>
        )}
      </div>

      {/* Row 3: git branch + github button */}
      <div className="mt-0.5 flex items-center gap-1 pl-5">
        {gitInfo?.branch && (
          <div className="flex min-w-0 flex-1 items-center gap-1 text-[10px]">
            <span className="text-zinc-500">⎇ {gitInfo.branch}</span>
            {gitInfo.added > 0 && <span className="text-green-500">+{gitInfo.added}</span>}
            {gitInfo.removed > 0 && <span className="text-red-500">-{gitInfo.removed}</span>}
          </div>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onGithub(); }}
          title="GitHub"
          className="shrink-0 rounded p-0.5 text-zinc-700 opacity-0 transition-opacity group-hover/item:opacity-100 hover:text-zinc-300"
        >
          <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

let _termCounter = 0;
const nextTermName = () => `Terminal ${++_termCounter}`;

export default function App() {
  const [auth, setAuth] = useState<"loading" | "ok" | "login">("loading");
  const [root, setRoot] = useState<PaneNode | null>(null);
  const [focusedId, setFocusedId] = useState<string>("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [cwds, setCwds] = useState<Record<string, string>>({});
  const [gitInfos, setGitInfos] = useState<Record<string, GitInfo>>({});
  const [fileBrowserTabId, setFileBrowserTabId] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<Record<string, string>>({});
  const [githubSessionId, setGithubSessionId] = useState<string | null>(null);
  const [sessionCwds, setSessionCwds] = useState<Record<string, string>>({});
  const [forwardedTerminals, setForwardedTerminals] = useState<ForwardedTerminalInfo[]>([]);
  const [search, setSearch] = useState("");
  const [vscodeConfig, setVscodeConfig] = useState<VscodeConfig>({ vscodeUrl: "", vscodePathFrom: "", vscodePathTo: "" });
  const [stats, setStats] = useState<Stats | null>(null);
  const paneRefs = useRef(new Map<string, PaneHandle>());
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => setAuth(r.ok ? "ok" : "login"))
      .catch(() => setAuth("login"));
  }, []);

  useEffect(() => {
    if (auth !== "ok") return;
    fetchVscodeConfig().then(setVscodeConfig);
    fetchWorkspace().then((ws) => {
      if (ws?.root) {
        _nextId = maxId(ws.root) + 1;
        setRoot(ws.root);
        setFocusedId(ws.focusedId ?? collectIds(ws.root)[0]);
        if (ws.viewMode) setViewMode(ws.viewMode);
        if (ws.sessionCwds) setSessionCwds(ws.sessionCwds);
        const saved = ws.names ?? {};
        const allIds = collectIds(ws.root);
        const filled: Record<string, string> = {};
        allIds.forEach((id) => { filled[id] = saved[id] ?? nextTermName(); });
        setNames(filled);
      } else {
        const pane = newTermPane();
        setRoot(pane);
        setFocusedId(pane.id);
        setNames({ [pane.id]: nextTermName() });
      }
    });
  }, [auth]);

  useEffect(() => {
    if (!root || !focusedId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // Build sessionId → cwd map from pane-level cwds
    const terminalPanes = collectTerminals(root);
    const scwds: Record<string, string> = {};
    for (const { id, sessionId } of terminalPanes) {
      if (cwds[id]) scwds[sessionId] = cwds[id];
    }
    saveTimer.current = setTimeout(() => saveWorkspace(root, focusedId, names, viewMode, scwds), 400);
  }, [root, focusedId, names, viewMode, cwds]);

  // Poll CWDs + git info for sidebar / topbar display
  useEffect(() => {
    if (auth !== "ok" || !root) return;
    const poll = async () => {
      const terminals = collectTerminals(root);
      const cwdUpdates: Record<string, string> = {};
      const gitUpdates: Record<string, GitInfo> = {};
      await Promise.all(terminals.map(async ({ id, sessionId }) => {
        try {
          const [cwdRes, gitRes] = await Promise.all([
            fetch(`/api/cwd?sessionId=${sessionId}`),
            fetch(`/api/git-info?sessionId=${sessionId}`),
          ]);
          if (cwdRes.ok) {
            const { cwd } = await cwdRes.json();
            if (cwd && cwd !== "/") cwdUpdates[id] = cwd;
          }
          if (gitRes.ok) {
            gitUpdates[id] = await gitRes.json();
          }
        } catch {}
      }));
      if (Object.keys(cwdUpdates).length) setCwds((prev) => ({ ...prev, ...cwdUpdates }));
      if (Object.keys(gitUpdates).length) setGitInfos((prev) => ({ ...prev, ...gitUpdates }));
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [auth, root]);

  useEffect(() => {
    if (auth !== "ok") return;
    const poll = async () => {
      try { const r = await fetch("/api/stats"); if (r.ok) setStats(await r.json()); } catch {}
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [auth]);

  useEffect(() => {
    if (auth !== "ok") return;
    const poll = async () => {
      try {
        const r = await fetch("/api/forwarded-terminals");
        if (r.ok) setForwardedTerminals(await r.json());
      } catch {}
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [auth]);

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    setRoot(null); setStats(null); setAuth("login");
  }

  const addPane = useCallback(() => {
    setRoot((r) => {
      const pane = newTermPane();
      setNames((n) => ({ ...n, [pane.id]: nextTermName() }));
      setFocusedId(pane.id);
      if (!r) return pane;
      // In tabs mode, add as a split off focused; in split mode, split vertically
      return splitPane(r, focusedId, "v");
    });
  }, [focusedId]);

  const splitV = useCallback(() => {
    setRoot((r) => {
      if (!r) return r;
      const result = splitPane(r, focusedId, "v");
      const before = new Set(collectIds(r));
      const newPaneId = collectIds(result).find((id) => !before.has(id));
      if (newPaneId) { setNames((n) => ({ ...n, [newPaneId]: nextTermName() })); setFocusedId(newPaneId); }
      return result;
    });
  }, [focusedId]);

  const splitH = useCallback(() => {
    setRoot((r) => {
      if (!r) return r;
      const result = splitPane(r, focusedId, "h");
      const before = new Set(collectIds(r));
      const newPaneId = collectIds(result).find((id) => !before.has(id));
      if (newPaneId) { setNames((n) => ({ ...n, [newPaneId]: nextTermName() })); setFocusedId(newPaneId); }
      return result;
    });
  }, [focusedId]);

  const closePane = useCallback((targetId?: string) => {
    const id = targetId ?? focusedId;
    setRoot((r) => {
      if (!r || collectIds(r).length <= 1) return r;
      const next = removePane(r, id);
      if (!next) return r;
      if (id === focusedId) setFocusedId(collectIds(next)[0]);
      setNames((n) => { const m = { ...n }; delete m[id]; return m; });
      setCwds((c) => { const m = { ...c }; delete m[id]; return m; });
      return next;
    });
  }, [focusedId]);

  const renamePane = useCallback((id: string, name: string) => {
    setNames((n) => ({ ...n, [id]: name }));
  }, []);

  const importForwarded = useCallback((fwd: ForwardedTerminalInfo) => {
    const sessionId = `fwd-${fwd.id}`;
    if (root) {
      const existing = collectTerminals(root).find((t) => t.sessionId === sessionId);
      if (existing) { setFocusedId(existing.id); return; }
    }
    const id = newId();
    const pane: TerminalPane = { kind: "terminal", id, sessionId };
    const label = `${fwd.workspace?.split("/").filter(Boolean).at(-1) ?? "vscode"}: ${fwd.name}`;
    setNames((n) => ({ ...n, [id]: label }));
    setFocusedId(id);
    setRoot((r) => {
      if (!r) return pane;
      return insertPane(r, focusedId, pane);
    });
  }, [focusedId, root]);

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
      if (e.key === "t") { e.preventDefault(); addPane(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [splitV, splitH, closePane, addPane]);

  if (auth === "loading") {
    return <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-600 text-sm">connecting…</div>;
  }
  if (auth === "login") {
    return <LoginPage onLogin={() => { setRoot(null); setAuth("ok"); }} />;
  }
  if (!root) {
    return <div className="flex h-screen items-center justify-center bg-black text-zinc-600 text-sm">connecting…</div>;
  }

  const terminals = collectTerminals(root);
  const { panes, dividers } = computeLayouts(root);
  const paneCount = panes.length;

  const filteredTerminals = search
    ? terminals.filter((t) => (names[t.id] ?? "").toLowerCase().includes(search.toLowerCase()))
    : terminals;

  // ─── Shared pane renderer (renders all terminals, active one visible) ────────
  function renderPaneTerminal(id: string, sessionId: string) {
    const openFile = openFiles[id];
    return (
      <div key={id} className="relative h-full w-full">
        <PaneTerminal
          ref={(handle) => { if (handle) paneRefs.current.set(id, handle); else paneRefs.current.delete(id); }}
          paneId={id}
          sessionId={sessionId}
          focused={id === focusedId && !openFile}
          onFocus={() => setFocusedId(id)}
          name={names[id] ?? "Terminal"}
          onRename={(name) => renamePane(id, name)}
          vscodeUrl={vscodeConfig.vscodeUrl}
          vscodePathFrom={vscodeConfig.vscodePathFrom}
          vscodePathTo={vscodeConfig.vscodePathTo}
          showTopbar={viewMode === "split"}
          gitInfo={gitInfos[id]}
          onGithub={() => setGithubSessionId(sessionId)}
          initialCwd={sessionCwds[sessionId]}
        />
        {openFile && (
          <div className="absolute inset-0 z-10">
            <FileViewer
              path={openFile}
              onClose={() => setOpenFiles((prev) => { const next = { ...prev }; delete next[id]; return next; })}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-black">
      {/* Title bar */}
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 select-none">
        <TermIcon size={14} className="text-zinc-500" />
        <span className="text-xs text-zinc-400">{paneCount} {paneCount === 1 ? "pane" : "panes"}</span>
        <div className="ml-auto flex items-center gap-1">
          {/* Mode toggle */}
          <button
            onClick={() => setViewMode("tabs")}
            title="Tabs mode"
            className={`rounded p-1 text-xs transition-colors ${viewMode === "tabs" ? "bg-zinc-700 text-zinc-200" : "text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"}`}
          >
            <PanelLeft size={13} />
          </button>
          <button
            onClick={() => setViewMode("split")}
            title="Split mode"
            className={`rounded p-1 text-xs transition-colors ${viewMode === "split" ? "bg-zinc-700 text-zinc-200" : "text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"}`}
          >
            <LayoutTemplate size={13} />
          </button>
          <div className="h-4 w-px bg-zinc-700" />
          {viewMode === "split" && (
            <>
              <button onClick={splitV} title="Split vertical (⌘D)" className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200">
                <Columns2 size={13} /> <span>Vertical</span>
              </button>
              <button onClick={splitH} title="Split horizontal (⌘⇧D)" className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200">
                <Rows2 size={13} /> <span>Horizontal</span>
              </button>
              <button onClick={() => closePane()} disabled={paneCount <= 1} title="Close pane (⌘W)" className="rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-red-400 disabled:opacity-30">
                <X size={13} />
              </button>
              <div className="h-4 w-px bg-zinc-700" />
            </>
          )}
          <button onClick={handleLogout} title="Sign out" className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300">
            <LogOut size={13} />
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex min-h-0 flex-1">
        {/* ── Tabs mode ── */}
        {viewMode === "tabs" && (
          <>
            {/* Sidebar */}
            <div className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
              {/* Search + add */}
              <div className="flex items-center gap-1.5 border-b border-zinc-800 px-2.5 py-1.5">
                <Search size={11} className="shrink-0 text-zinc-600" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search tabs…"
                  className="min-w-0 flex-1 bg-transparent text-xs text-zinc-300 placeholder-zinc-600 outline-none"
                />
                <button
                  onClick={addPane}
                  title="New terminal (⌘T)"
                  className="shrink-0 rounded p-0.5 text-zinc-600 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
                >
                  <Plus size={14} />
                </button>
              </div>

              {/* Tab list */}
              <div className="flex-1 overflow-y-auto">
                {filteredTerminals.map((t) => (
                  <SidebarItem
                    key={t.id}
                    id={t.id}
                    sessionId={t.sessionId}
                    name={names[t.id] ?? "Terminal"}
                    cwd={cwds[t.id] ?? ""}
                    gitInfo={gitInfos[t.id]}
                    isActive={t.id === focusedId}
                    vscodeConfig={vscodeConfig}
                    onSelect={() => setFocusedId(t.id)}
                    onClose={() => closePane(t.id)}
                    onRename={(name) => renamePane(t.id, name)}
                    onBrowse={() => { setFocusedId(t.id); setFileBrowserTabId(t.id); }}
                    onGithub={() => setGithubSessionId(t.sessionId)}
                  />
                ))}

                {/* VS Code terminals */}
                {forwardedTerminals.length > 0 && (
                  <div className="border-t border-zinc-800/60">
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                      VS Code
                    </div>
                    {forwardedTerminals.map((fwd) => {
                      const sessionId = `fwd-${fwd.id}`;
                      const isOpen = root ? collectTerminals(root).some((t) => t.sessionId === sessionId) : false;
                      const workspaceLabel = fwd.workspace?.split("/").filter(Boolean).at(-1) ?? "vscode";
                      return (
                        <div
                          key={fwd.id}
                          onClick={() => importForwarded(fwd)}
                          className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors
                            ${isOpen ? "text-blue-400 hover:bg-zinc-800/60" : "text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"}`}
                        >
                          <Monitor size={11} className="shrink-0 text-zinc-600" />
                          <span className="min-w-0 flex-1 truncate">
                            <span className="text-zinc-600">{workspaceLabel} </span>
                            {fwd.name}
                          </span>
                          {isOpen && <span className="shrink-0 text-[9px] text-blue-500">open</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Bottom stats */}
              <div className="border-t border-zinc-800 px-3 py-2 space-y-1.5">
                {stats ? (
                  <>
                    <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                      <Cpu size={10} /><span className="w-8">{stats.cpu}%</span><Bar pct={stats.cpu} />
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                      <MemoryStick size={10} /><span>{fmt(stats.ram.used)}/{fmt(stats.ram.total)}</span>
                      <Bar pct={Math.round((stats.ram.used / stats.ram.total) * 100)} />
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                      <HardDrive size={10} /><span>{fmt(stats.disk.used)}/{fmt(stats.disk.total)}</span>
                      <Bar pct={Math.round((stats.disk.used / stats.disk.total) * 100)} />
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-zinc-700">loading…</div>
                )}
                <div className="flex items-center pt-1">
                  <button onClick={handleLogout} title="Sign out" className="ml-auto rounded p-1 text-zinc-600 hover:bg-zinc-700 hover:text-zinc-300">
                    <LogOut size={12} />
                  </button>
                </div>
              </div>
            </div>

            {/* Single terminal area — all mounted, active visible */}
            <div className="relative min-w-0 flex-1">
              {terminals.map(({ id, sessionId }) => (
                <div
                  key={id}
                  style={{
                    position: "absolute", inset: 0,
                    visibility: id === focusedId ? "visible" : "hidden",
                    zIndex: id === focusedId ? 1 : 0,
                    pointerEvents: id === focusedId ? "auto" : "none",
                  }}
                >
                  {renderPaneTerminal(id, sessionId)}
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── Split mode ── */}
        {viewMode === "split" && (
          <>
            <div ref={containerRef} className="relative min-h-0 flex-1">
              {panes.map(({ id, sessionId, l, t, w, h }) => (
                <div
                  key={id}
                  style={{ position: "absolute", left: `${l}%`, top: `${t}%`, width: `${w}%`, height: `${h}%` }}
                >
                  {renderPaneTerminal(id, sessionId)}
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

          </>
        )}
      </div>

      {/* GitHub panel */}
      {githubSessionId && (
        <GitHubPanel sessionId={githubSessionId} onClose={() => setGithubSessionId(null)} />
      )}

      {/* File browser panel */}
      {fileBrowserTabId && (() => {
        const t = terminals.find((x) => x.id === fileBrowserTabId);
        if (!t) return null;
        return (
          <FileBrowser
            sessionId={t.sessionId}
            initialPath={cwds[t.id] || "/"}
            vscodeConfig={vscodeConfig}
            onSend={(cmd) => paneRefs.current.get(t.id)?.send(cmd)}
            onClose={() => setFileBrowserTabId(null)}
            onOpenFile={(path) => {
              setOpenFiles((prev) => ({ ...prev, [t.id]: path }));
              setFileBrowserTabId(null);
            }}
          />
        );
      })()}

      {/* Bottom status bar — split mode only (tabs mode has its own in the sidebar) */}
      {viewMode === "split" && (
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
            <button onClick={handleLogout} title="Sign out" className="rounded p-1 text-zinc-600 hover:bg-zinc-700 hover:text-zinc-300">
              <LogOut size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
