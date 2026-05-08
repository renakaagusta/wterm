import { useEffect, useMemo, useState } from "react";
import { X, FileText, AlertCircle, Code2, BookOpen, FileDown } from "lucide-react";
import { marked } from "marked";

type ViewMode = "text" | "markdown" | "pdf";

interface FileViewerProps {
  path: string;
  onClose: () => void;
}

function getAvailableModes(ext: string): ViewMode[] {
  if (ext === ".pdf") return ["pdf"];
  if (ext === ".md" || ext === ".mdx" || ext === ".markdown") return ["markdown", "text"];
  return ["text"];
}

function getDefaultMode(ext: string): ViewMode {
  if (ext === ".pdf") return "pdf";
  if (ext === ".md" || ext === ".mdx" || ext === ".markdown") return "markdown";
  return "text";
}

const MODE_META: Record<ViewMode, { icon: React.ReactNode; label: string }> = {
  text:     { icon: <Code2 size={12} />,    label: "Text" },
  markdown: { icon: <BookOpen size={12} />, label: "Preview" },
  pdf:      { icon: <FileDown size={12} />, label: "PDF" },
};

export function FileViewer({ path, onClose }: FileViewerProps) {
  const ext = useMemo(() => {
    const dot = path.lastIndexOf(".");
    return dot >= 0 ? path.slice(dot).toLowerCase() : "";
  }, [path]);

  const modes = useMemo(() => getAvailableModes(ext), [ext]);
  const [mode, setMode] = useState<ViewMode>(() => getDefaultMode(ext));
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Reset mode when file changes
  useEffect(() => {
    setMode(getDefaultMode(ext));
  }, [path, ext]);

  // Fetch text content (skip for pdf-only)
  useEffect(() => {
    if (ext === ".pdf") { setLoading(false); return; }
    setLoading(true);
    setContent(null);
    setError(null);
    fetch(`/api/file?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setContent(data.content ?? "");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [path, ext]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fileName = path.split("/").at(-1) ?? path;
  const dirPart = path.slice(0, path.lastIndexOf("/") + 1)
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/root/, "~");

  const renderedMd = useMemo(() => {
    if (mode !== "markdown" || !content) return "";
    return marked.parse(content) as string;
  }, [mode, content]);

  const rawUrl = `/api/file-raw?path=${encodeURIComponent(path)}`;

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-xs">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <FileText size={13} className="shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1 truncate font-mono">
          <span className="text-zinc-500">{dirPart}</span>
          <span className="font-semibold text-zinc-200">{fileName}</span>
        </span>

        {/* Mode toggle — only show when >1 mode available */}
        {modes.length > 1 && (
          <div className="flex shrink-0 items-center gap-0.5 rounded bg-zinc-800 p-0.5">
            {modes.map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                title={MODE_META[m].label}
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                  mode === m
                    ? "bg-zinc-600 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {MODE_META[m].icon}
                <span>{MODE_META[m].label}</span>
              </button>
            ))}
          </div>
        )}

        <button
          onClick={onClose}
          title="Close file (Esc)"
          className="shrink-0 rounded p-0.5 text-zinc-600 hover:text-zinc-300"
        >
          <X size={13} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading && <div className="p-4 text-zinc-600">Loading…</div>}

        {error && (
          <div className="flex items-start gap-2 p-4 text-red-400">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Text mode */}
        {!loading && !error && mode === "text" && content !== null && (
          <table className="w-full border-collapse font-mono">
            <tbody>
              {content.split("\n").map((line, i) => (
                <tr key={i} className="hover:bg-zinc-900/60">
                  <td className="w-12 select-none border-r border-zinc-800/60 px-2 py-0 text-right text-zinc-700">
                    {i + 1}
                  </td>
                  <td className="whitespace-pre px-3 py-0 text-zinc-300">{line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Markdown preview mode */}
        {!loading && !error && mode === "markdown" && (
          <div
            className="prose prose-invert prose-sm max-w-none p-6 prose-headings:text-zinc-200 prose-p:text-zinc-300 prose-a:text-blue-400 prose-code:text-zinc-300 prose-pre:bg-zinc-800 prose-blockquote:border-zinc-600 prose-blockquote:text-zinc-400 prose-li:text-zinc-300 prose-strong:text-zinc-200"
            dangerouslySetInnerHTML={{ __html: renderedMd }}
          />
        )}

        {/* PDF preview mode */}
        {mode === "pdf" && (
          <iframe
            src={rawUrl}
            className="h-full w-full border-0"
            title={fileName}
          />
        )}
      </div>
    </div>
  );
}
