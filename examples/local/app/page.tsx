"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Columns2,
  Rows2,
  X,
  Cpu,
  MemoryStick,
  HardDrive,
  Terminal as TermIcon,
  Zap,
} from "lucide-react";
import { PaneTerminal, PaneHandle, clearSession } from "./pane";

// ─── Pane tree ──────────────────────────────────────────────────────────────

type TerminalPane = { kind: "terminal"; id: string };
type SplitPane = {
  kind: "split";
  direction: "h" | "v";
  ratio: number;
  first: PaneNode;
  second: PaneNode;
};
type PaneNode = TerminalPane | SplitPane;

let _nextId = 1;
const newId = () => String(_nextId++);
const newTermPane = (): TerminalPane => ({ kind: "terminal", id: newId() });

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
  if (node.kind === "terminal" || path.length === 0) return path.length === 0 ? { ...node as SplitPane, ratio } : node;
  const [head, ...rest] = path;
  if (node.kind === "split")
    return head === 0
      ? { ...node, first: updateRatio(node.first, rest, ratio) }
      : { ...node, second: updateRatio(node.second, rest, ratio) };
  return node;
}

function collectIds(node: PaneNode): string[] {
  if (node.kind === "terminal") return [node.id];
  return [...collectIds(node.first), ...collectIds(node.second)];
}

// ─── Stats ──────────────────────────────────────────────────────────────────

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

// ─── Recursive pane renderer ────────────────────────────────────────────────

interface PaneViewProps {
  node: PaneNode;
  focusedId: string;
  onFocus: (id: string) => void;
  onUpdateRatio: (path: number[], ratio: number) => void;
  paneRefs: React.MutableRefObject<Map<string, PaneHandle>>;
  path?: number[];
}

function PaneView({ node, focusedId, onFocus, onUpdateRatio, paneRefs, path = [] }: PaneViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  if (node.kind === "terminal") {
    return (
      <PaneTerminal
        ref={(h) => { if (h) paneRefs.current.set(node.id, h); else paneRefs.current.delete(node.id); }}
        paneId={node.id}
        focused={node.id === focusedId}
        onFocus={() => onFocus(node.id)}
      />
    );
  }

  const isV = node.direction === "v";

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const ratio = isV ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      onUpdateRatio(path, Math.max(0.1, Math.min(0.9, ratio)));
    };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div ref={containerRef} className={`flex h-full w-full ${isV ? "flex-row" : "flex-col"}`}>
      <div style={isV ? { width: `${node.ratio * 100}%` } : { height: `${node.ratio * 100}%` }} className="min-h-0 min-w-0 overflow-hidden">
        <PaneView node={node.first} focusedId={focusedId} onFocus={onFocus} onUpdateRatio={onUpdateRatio} paneRefs={paneRefs} path={[...path, 0]} />
      </div>
      <div onMouseDown={onMouseDown} className={`z-10 flex-shrink-0 ${isV ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"} bg-zinc-800 hover:bg-blue-500 transition-colors`} />
      <div style={isV ? { width: `${(1 - node.ratio) * 100}%` } : { height: `${(1 - node.ratio) * 100}%` }} className="min-h-0 min-w-0 overflow-hidden">
        <PaneView node={node.second} focusedId={focusedId} onFocus={onFocus} onUpdateRatio={onUpdateRatio} paneRefs={paneRefs} path={[...path, 1]} />
      </div>
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function App() {
  const initialPane = newTermPane();
  const [root, setRoot] = useState<PaneNode>(initialPane);
  const [focusedId, setFocusedId] = useState(initialPane.id);
  const [stats, setStats] = useState<Stats | null>(null);
  const paneRefs = useRef(new Map<string, PaneHandle>());

  useEffect(() => {
    const poll = async () => {
      try { const r = await fetch("/api/stats"); if (r.ok) setStats(await r.json()); } catch {}
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, []);

  const splitV = useCallback(() => setRoot((r) => splitPane(r, focusedId, "v")), [focusedId]);
  const splitH = useCallback(() => setRoot((r) => splitPane(r, focusedId, "h")), [focusedId]);

  const closePane = useCallback(() => {
    setRoot((r) => {
      if (collectIds(r).length <= 1) return r;
      const next = removePane(r, focusedId);
      if (!next) return r;
      clearSession(focusedId);
      setFocusedId(collectIds(next)[0]);
      return next;
    });
  }, [focusedId]);

  const sendAppctl = useCallback(() => {
    paneRefs.current.get(focusedId)?.send("appctl\r");
  }, [focusedId]);

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

  const handleUpdateRatio = useCallback((path: number[], ratio: number) => {
    setRoot((r) => updateRatio(r, path, ratio));
  }, []);

  const paneCount = collectIds(root).length;

  return (
    <div className="flex h-screen flex-col bg-black">
      {/* Title bar */}
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 select-none">
        <TermIcon size={14} className="text-zinc-500" />
        <span className="text-xs text-zinc-400">{paneCount} {paneCount === 1 ? "pane" : "panes"}</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={splitV} title="Split vertical (⌘D)" className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200">
            <Columns2 size={13} /> <span className="hidden sm:inline">Vertical</span>
          </button>
          <button onClick={splitH} title="Split horizontal (⌘⇧D)" className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200">
            <Rows2 size={13} /> <span className="hidden sm:inline">Horizontal</span>
          </button>
          <button onClick={closePane} disabled={paneCount <= 1} title="Close pane (⌘W)" className="rounded p-1 text-zinc-400 hover:bg-zinc-700 hover:text-red-400 disabled:opacity-30">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Pane area */}
      <div className="min-h-0 flex-1">
        <PaneView node={root} focusedId={focusedId} onFocus={setFocusedId} onUpdateRatio={handleUpdateRatio} paneRefs={paneRefs} />
      </div>

      {/* Bottom status bar */}
      <div className="flex items-center gap-4 border-t border-zinc-800 bg-zinc-950 px-3 py-1 text-xs text-zinc-500 select-none">
        {stats ? (
          <>
            <div className="flex items-center gap-1.5">
              <Cpu size={11} />
              <span className="w-8">{stats.cpu}%</span>
              <Bar pct={stats.cpu} />
            </div>
            <div className="flex items-center gap-1.5">
              <MemoryStick size={11} />
              <span>{fmt(stats.ram.used)}/{fmt(stats.ram.total)}</span>
              <Bar pct={Math.round((stats.ram.used / stats.ram.total) * 100)} />
            </div>
            <div className="flex items-center gap-1.5">
              <HardDrive size={11} />
              <span>{fmt(stats.disk.used)}/{fmt(stats.disk.total)}</span>
              <Bar pct={Math.round((stats.disk.used / stats.disk.total) * 100)} />
            </div>
          </>
        ) : (
          <span className="text-zinc-700">loading stats…</span>
        )}
        <div className="ml-auto">
          <button
            onClick={sendAppctl}
            title="Run appctl in focused pane"
            className="flex items-center gap-1.5 rounded bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-blue-600 hover:text-white transition-colors"
          >
            <Zap size={11} />
            appctl
          </button>
        </div>
      </div>
    </div>
  );
}
