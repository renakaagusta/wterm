import * as vscode from 'vscode';
import WebSocket from 'ws';

const MAX_BUFFER_SIZE = 100 * 1024; // 100 KB

interface TermEntry {
  id: string;
  name: string;
  workspace: string;
  buffer: string;
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isDeactivating = false;

const terminalMap = new Map<vscode.Terminal, TermEntry>();

function getConfig(): { serverUrl: string; secret: string } {
  const cfg = vscode.workspace.getConfiguration('wtermBridge');
  return {
    serverUrl: cfg.get<string>('serverUrl') ?? 'ws://localhost:3021/ws/bridge',
    secret: cfg.get<string>('secret') ?? '',
  };
}

function terminalId(terminal: vscode.Terminal): string {
  // vscode.Terminal has a `name` but no stable id; use the map entry if present
  const entry = terminalMap.get(terminal);
  return entry ? entry.id : generateId();
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function workspaceName(): string {
  return vscode.workspace.name ?? 'unknown';
}

function send(payload: object): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function registerTerminal(terminal: vscode.Terminal): TermEntry {
  let entry = terminalMap.get(terminal);
  if (!entry) {
    entry = {
      id: generateId(),
      name: terminal.name,
      workspace: workspaceName(),
      buffer: '',
    };
    terminalMap.set(terminal, entry);
  }
  return entry;
}

function appendToBuffer(entry: TermEntry, data: string): void {
  entry.buffer += data;
  if (entry.buffer.length > MAX_BUFFER_SIZE) {
    entry.buffer = entry.buffer.slice(entry.buffer.length - MAX_BUFFER_SIZE);
  }
}

function findTerminalById(id: string): vscode.Terminal | undefined {
  for (const [terminal, entry] of terminalMap.entries()) {
    if (entry.id === id) {
      return terminal;
    }
  }
  return undefined;
}

function onMessage(raw: string): void {
  let msg: { type: string; terminalId?: string; data?: string };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (!msg.type) {
    return;
  }

  if (msg.type === 'input' && msg.terminalId && msg.data !== undefined) {
    const terminal = findTerminalById(msg.terminalId);
    if (terminal) {
      terminal.sendText(msg.data, false);
    }
    return;
  }

  if (msg.type === 'subscribe' && msg.terminalId) {
    const terminal = findTerminalById(msg.terminalId);
    if (terminal) {
      const entry = terminalMap.get(terminal);
      if (entry && entry.buffer.length > 0) {
        send({ type: 'data', terminalId: entry.id, data: entry.buffer });
      }
    }
    return;
  }
}

function connect(ctx: vscode.ExtensionContext): void {
  if (isDeactivating) {
    return;
  }

  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    ws.removeAllListeners();
    ws.terminate();
    ws = null;
  }

  const { serverUrl, secret } = getConfig();

  const headers: Record<string, string> = {};
  if (secret) {
    headers['x-bridge-secret'] = secret;
  }

  let socket: WebSocket;
  try {
    socket = new WebSocket(serverUrl, { headers });
  } catch (err) {
    scheduleReconnect(ctx);
    return;
  }

  ws = socket;

  socket.on('open', () => {
    // Register all currently known terminals
    for (const [terminal, entry] of terminalMap.entries()) {
      send({
        type: 'opened',
        terminalId: entry.id,
        name: terminal.name,
        workspace: entry.workspace,
      });
    }

    // Also register any open terminals not yet tracked
    for (const terminal of vscode.window.terminals) {
      if (!terminalMap.has(terminal)) {
        const entry = registerTerminal(terminal);
        send({
          type: 'opened',
          terminalId: entry.id,
          name: terminal.name,
          workspace: entry.workspace,
        });
      }
    }
  });

  socket.on('message', (data) => {
    onMessage(data.toString());
  });

  socket.on('close', () => {
    ws = null;
    scheduleReconnect(ctx);
  });

  socket.on('error', () => {
    // The 'close' event will fire after an error and trigger reconnect
  });
}

function scheduleReconnect(ctx: vscode.ExtensionContext): void {
  if (isDeactivating) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(ctx);
  }, 5000);
}

export function activate(ctx: vscode.ExtensionContext): void {
  isDeactivating = false;

  // Seed the terminal map with already-open terminals
  for (const terminal of vscode.window.terminals) {
    registerTerminal(terminal);
  }

  // Terminal opened
  ctx.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      const entry = registerTerminal(terminal);
      send({
        type: 'opened',
        terminalId: entry.id,
        name: terminal.name,
        workspace: entry.workspace,
      });
    })
  );

  // Terminal closed
  ctx.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      const entry = terminalMap.get(terminal);
      if (entry) {
        send({ type: 'closed', terminalId: entry.id });
        terminalMap.delete(terminal);
      }
    })
  );

  // Terminal data written (output)
  ctx.subscriptions.push(
    (vscode.window as any).onDidWriteTerminalData(
      (event: { terminal: vscode.Terminal; data: string }) => {
        let entry = terminalMap.get(event.terminal);
        if (!entry) {
          entry = registerTerminal(event.terminal);
        }
        appendToBuffer(entry, event.data);
        send({ type: 'data', terminalId: entry.id, data: event.data });
      }
    )
  );

  // Manual reconnect command
  ctx.subscriptions.push(
    vscode.commands.registerCommand('wterm-bridge.connect', () => {
      connect(ctx);
    })
  );

  // React to configuration changes
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('wtermBridge.serverUrl') ||
        e.affectsConfiguration('wtermBridge.secret')
      ) {
        connect(ctx);
      }
    })
  );

  connect(ctx);
}

export function deactivate(): void {
  isDeactivating = true;

  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    ws.removeAllListeners();
    ws.terminate();
    ws = null;
  }

  terminalMap.clear();
}
