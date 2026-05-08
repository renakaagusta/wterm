import { forwardRef, useCallback, useImperativeHandle, useRef, useState, useEffect } from "react";
import { Terminal, useTerminal } from "@wterm/react";
import type { WTerm } from "@wterm/dom";
import { Code2, Pencil, Check } from "lucide-react";
import "@wterm/react/css";

export interface PaneHandle {
  send: (data: string) => void;
}

export interface GitInfo { branch: string | null; added: number; removed: number }

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
  showTopbar?: boolean;
  gitInfo?: GitInfo;
  onGithub?: () => void;
  initialCwd?: string;
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
  gitInfo?: GitInfo;
  onGithub?: () => void;
}

function PaneTopbar({ sessionId, name, onRename, vscodeUrl, vscodePathFrom, vscodePathTo, onFocus, gitInfo, onGithub }: TopbarProps) {
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
        {gitInfo?.branch && (
          <div className="ml-1 flex shrink-0 items-center gap-1 text-[10px]">
            <span className="text-zinc-600">⎇ {gitInfo.branch}</span>
            {gitInfo.added > 0 && <span className="text-green-600">+{gitInfo.added}</span>}
            {gitInfo.removed > 0 && <span className="text-red-500">-{gitInfo.removed}</span>}
          </div>
        )}
      </div>

      {onGithub && (
        <button
          onClick={(e) => { e.stopPropagation(); onGithub(); }}
          title="GitHub"
          className="shrink-0 rounded p-0.5 text-zinc-600 transition-colors hover:text-zinc-300"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
        </button>
      )}
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
  function PaneTerminal({ sessionId, focused, onFocus, name, onRename, vscodeUrl, vscodePathFrom, vscodePathTo, showTopbar = true, gitInfo, onGithub, initialCwd }, ref) {
    const [connected, setConnected] = useState(false);
    const [dragOver, setDragOver] = useState(false);
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
        const cwdParam = initialCwd ? `&cwd=${encodeURIComponent(initialCwd)}` : "";
        const ws = new WebSocket(`${proto}//${host}/api/terminal?sessionId=${sessionId}${cwdParam}`);
        wsRef.current = ws;
        ws.onopen = () => { ws.send(`\x1b[RESIZE:${wt.cols};${wt.rows}]`); setConnected(true); };
        ws.onmessage = (e: MessageEvent) => write(e.data as string);
        ws.onclose = () => { if (wsRef.current === ws) { setConnected(false); wsRef.current = null; } };
      },
      [sessionId, initialCwd, write],
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

    const handleDragOver = useCallback((e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(true);
      }
    }, []);

    const handleDragLeave = useCallback(() => setDragOver(false), []);

    const handleDrop = useCallback(async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      onFocus();

      const files = Array.from(e.dataTransfer.files);
      if (!files.length) return;

      const paths: string[] = [];
      for (const file of files) {
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const r = await fetch("/api/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: file.name, data: base64 }),
          });
          if (r.ok) {
            const { path } = await r.json();
            paths.push(path as string);
          }
        } catch {}
      }

      if (paths.length && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(paths.join(" "));
      }
    }, [onFocus]);

    return (
      <div
        className="group/topbar relative flex h-full w-full flex-col"
        onClick={onFocus}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {focused && (
          <div className="pointer-events-none absolute inset-0 z-10 rounded-sm ring-1 ring-blue-500/60" />
        )}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-blue-400 bg-blue-500/10">
            <span className="rounded bg-zinc-900/90 px-3 py-1.5 text-sm text-blue-300">Drop to upload &amp; paste path</span>
          </div>
        )}
        {showTopbar && (
          <PaneTopbar
            sessionId={sessionId}
            name={name}
            onRename={onRename}
            vscodeUrl={vscodeUrl}
            vscodePathFrom={vscodePathFrom}
            vscodePathTo={vscodePathTo}
            onFocus={onFocus}
            gitInfo={gitInfo}
            onGithub={onGithub}
          />
        )}
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
