import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { Terminal, useTerminal } from "@wterm/react";
import type { WTerm } from "@wterm/dom";
import "@wterm/react/css";

export interface PaneHandle {
  send: (data: string) => void;
}

interface PaneTerminalProps {
  paneId: string;
  sessionId: string;
  focused: boolean;
  onFocus: () => void;
}

export const PaneTerminal = forwardRef<PaneHandle, PaneTerminalProps>(
  function PaneTerminal({ sessionId, focused, onFocus }, ref) {
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
        // Bypass Vite WS proxy only on localhost to avoid double-hop latency.
        // When accessed remotely (tunnel, server), route WS through the same host.
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
      <div className="relative flex h-full w-full flex-col" onClick={onFocus}>
        {focused && (
          <div className="pointer-events-none absolute inset-0 z-10 rounded-sm ring-1 ring-blue-500/60" />
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
