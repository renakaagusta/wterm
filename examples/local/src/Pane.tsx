import { forwardRef, useCallback, useImperativeHandle, useRef, useState, useEffect } from "react";
import { Terminal, useTerminal } from "@wterm/react";
import type { WTerm } from "@wterm/dom";
import { Code2, Pencil, Check } from "lucide-react";
import "@wterm/react/css";

export interface PaneHandle {
  send: (data: string) => void;
}

interface PaneTerminalProps {
  paneId: string;
  sessionId: string;
  focused: boolean;
  onFocus: () => void;
  name: string;
  onRename: (name: string) => void;
  vscodeUrl: string;
  vscodePathFrom: string;
  vscodePathTo: string;
}

// ─── Topbar ──────────────────────────────────────────────────────────────────

interface TopbarProps {
  sessionId: string;
  name: string;
  onRename: (name: string) => void;
  vscodeUrl: string;
  vscodePathFrom: string;
  vscodePathTo: string;
  onFocus: () => void;
}

function PaneTopbar({ sessionId, name, onRename, vscodeUrl, vscodePathFrom, vscodePathTo, onFocus }: TopbarProps) {
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
    if (!vscodeUrl) return;
    try {
      const r = await fetch(`/api/cwd?sessionId=${sessionId}`);
      if (!r.ok) return;
      const { cwd } = await r.json();
      let path: string = cwd;
      if (vscodePathFrom && path.startsWith(vscodePathFrom)) {
        path = vscodePathTo + path.slice(vscodePathFrom.length);
      }
      window.open(`${vscodeUrl}/?folder=${encodeURIComponent(path)}`, "_blank");
    } catch {}
  }

  return (
    <div
      className="flex h-7 shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-2 select-none"
      onClick={onFocus}
    >
      {/* Editable name */}
      <div className="flex min-w-0 flex-1 items-center gap-1">
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
            className="min-w-0 flex-1 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-200 outline-none focus:ring-1 focus:ring-blue-500"
          />
        ) : (
          <span className="truncate text-xs text-zinc-400">{name}</span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); setEditing((v) => !v); }}
          className="shrink-0 rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:text-zinc-300 group-hover/topbar:opacity-100"
          title="Rename pane"
        >
          {editing ? <Check size={11} /> : <Pencil size={11} />}
        </button>
      </div>

      {/* VS Code button */}
      {vscodeUrl && (
        <button
          onClick={openInVscode}
          title="Open current path in VS Code"
          className="shrink-0 rounded p-0.5 text-zinc-600 transition-colors hover:text-blue-400"
        >
          <Code2 size={13} />
        </button>
      )}
    </div>
  );
}

// ─── Pane ────────────────────────────────────────────────────────────────────

export const PaneTerminal = forwardRef<PaneHandle, PaneTerminalProps>(
  function PaneTerminal({ sessionId, focused, onFocus, name, onRename, vscodeUrl, vscodePathFrom, vscodePathTo }, ref) {
    const [connected, setConnected] = useState(false);
    const { ref: termRef, write } = useTerminal();
    const wsRef = useRef<WebSocket | null>(null);
    const wtRef = useRef<WTerm | null>(null);

    useImperativeHandle(ref, () => ({
      send: (data: string) => {
        wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(data);
      },
    }));

    const connect = useCallback(
      (wt: WTerm) => {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const isLocal = import.meta.env.DEV && window.location.hostname === "localhost";
        const host = isLocal ? "localhost:3001" : window.location.host;
        const ws = new WebSocket(`${proto}//${host}/api/terminal?sessionId=${sessionId}`);
        wsRef.current = ws;
        ws.onopen = () => { ws.send(`\x1b[RESIZE:${wt.cols};${wt.rows}]`); setConnected(true); };
        ws.onmessage = (e: MessageEvent) => write(e.data as string);
        ws.onclose = () => { if (wsRef.current === ws) { setConnected(false); wsRef.current = null; } };
      },
      [sessionId, write],
    );

    const handleReady = useCallback((wt: WTerm) => { wtRef.current = wt; connect(wt); }, [connect]);
    const handleReconnect = useCallback(() => { if (wtRef.current) connect(wtRef.current); }, [connect]);
    const handleData = useCallback((data: string) => {
      wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(data);
    }, []);
    const handleResize = useCallback((cols: number, rows: number) => {
      wsRef.current?.readyState === WebSocket.OPEN &&
        wsRef.current.send(`\x1b[RESIZE:${cols};${rows}]`);
    }, []);

    return (
      <div className="group/topbar relative flex h-full w-full flex-col" onClick={onFocus}>
        {focused && (
          <div className="pointer-events-none absolute inset-0 z-10 rounded-sm ring-1 ring-blue-500/60" />
        )}
        <PaneTopbar
          sessionId={sessionId}
          name={name}
          onRename={onRename}
          vscodeUrl={vscodeUrl}
          vscodePathFrom={vscodePathFrom}
          vscodePathTo={vscodePathTo}
          onFocus={onFocus}
        />
        {!connected && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70">
            <button
              onClick={handleReconnect}
              className="rounded bg-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-600"
            >
              Reconnect
            </button>
          </div>
        )}
        <Terminal
          ref={termRef}
          cols={80}
          rows={24}
          autoResize
          wasmUrl="/wterm.wasm"
          onReady={handleReady}
          onData={handleData}
          onResize={handleResize}
          className="flex-1"
          style={{ borderRadius: 0, boxShadow: "none", padding: 4 }}
        />
      </div>
    );
  },
);
