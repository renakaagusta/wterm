import { useState, useEffect, useRef } from "react";
import { X, Folder, FileText, FolderOpen, Search, ChevronUp } from "lucide-react";

interface FsEntry { name: string; isDir: boolean }

interface VscodeConfig { vscodeUrl: string; vscodePathFrom: string; vscodePathTo: string }

interface FileBrowserProps {
  sessionId: string;
  initialPath: string;
  vscodeConfig: VscodeConfig;
  onSend: (cmd: string) => void;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}

export function FileBrowser({ sessionId, initialPath, vscodeConfig, onSend, onClose, onOpenFile }: FileBrowserProps) {
  const [browsePath, setBrowsePath] = useState(initialPath || "/");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    setLoading(true);
    setSearch("");
    fetch(`/api/ls?sessionId=${sessionId}&path=${encodeURIComponent(browsePath)}`)
      .then((r) => r.json())
      .then((data) => setEntries(data.items ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [browsePath, sessionId]);

  function goUp() {
    const parts = browsePath.split("/").filter(Boolean);
    if (!parts.length) return;
    const parent = "/" + parts.slice(0, -1).join("/");
    const newPath = parent || "/";
    setBrowsePath(newPath);
    onSend(`cd '${shellEscape(newPath)}'\r`);
  }

  function handleDirClick(name: string) {
    const newPath = browsePath === "/" ? `/${name}` : `${browsePath}/${name}`;
    setBrowsePath(newPath);
    onSend(`cd '${shellEscape(newPath)}'\r`);
  }

  function handleFileClick(name: string) {
    const path = browsePath === "/" ? `/${name}` : `${browsePath}/${name}`;
    onOpenFile(path);
    onClose();
  }

  const filtered = entries.filter(
    (e) => !search || e.name.toLowerCase().includes(search.toLowerCase()),
  );

  const displayPath = browsePath
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/root/, "~");

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Panel */}
      <div
        className="fixed bottom-0 left-64 top-8 z-50 flex w-72 flex-col border-x border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
          <FolderOpen size={13} className="shrink-0 text-zinc-500" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300">{displayPath}</span>
          <button onClick={onClose} className="shrink-0 rounded p-0.5 text-zinc-600 hover:text-zinc-300">
            <X size={12} />
          </button>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
          <Search size={11} className="shrink-0 text-zinc-600" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            placeholder="Search files…"
            className="min-w-0 flex-1 bg-transparent text-xs text-zinc-300 placeholder-zinc-600 outline-none"
          />
        </div>

        {/* Entries */}
        <div className="flex-1 overflow-y-auto py-1">
          {loading ? (
            <div className="px-3 py-4 text-xs text-zinc-600">Loading…</div>
          ) : (
            <>
              {browsePath !== "/" && !search && (
                <div
                  className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700/60"
                  onClick={goUp}
                >
                  <ChevronUp size={12} className="shrink-0 text-zinc-600" />
                  <span>.. (Parent Directory)</span>
                </div>
              )}

              {filtered.map((entry) => (
                <div
                  key={entry.name}
                  className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-xs hover:bg-zinc-700/60"
                  onClick={() => entry.isDir ? handleDirClick(entry.name) : handleFileClick(entry.name)}
                >
                  {entry.isDir
                    ? <Folder size={12} className="shrink-0 text-zinc-500" />
                    : <FileText size={12} className="shrink-0 text-zinc-700" />
                  }
                  <span className={`truncate ${entry.isDir ? "text-zinc-300" : "text-zinc-500"}`}>
                    {entry.name}
                  </span>
                </div>
              ))}

              {filtered.length === 0 && !loading && (
                <div className="px-3 py-4 text-xs text-zinc-600">No results</div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function shellEscape(path: string): string {
  return path.replace(/'/g, "'\\''");
}
