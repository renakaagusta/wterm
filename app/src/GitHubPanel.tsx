import { useEffect, useState } from "react";
import { X, GitBranch, GitPullRequest, GitCommit, Zap, ExternalLink, RefreshCw } from "lucide-react";

type Tab = "commits" | "pulls" | "runs" | "branches";

interface Commit { sha: string; message: string; author: string; date: string; url: string }
interface Branch { name: string; protected: boolean; sha: string }
interface Pull { number: number; title: string; state: "open" | "closed" | "merged"; author: string; draft: boolean; createdAt: string; updatedAt: string; url: string; branch: string }
interface Run { id: number; name: string; status: string; conclusion: string | null; branch: string; event: string; createdAt: string; url: string }
interface GithubData { repo: string; commits: Commit[]; branches: Branch[]; pulls: Pull[]; runs: Run[] }

interface GitHubPanelProps {
  sessionId: string;
  onClose: () => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function PullBadge({ state, draft }: { state: Pull["state"]; draft: boolean }) {
  if (draft) return <span className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-zinc-700 text-zinc-400">draft</span>;
  if (state === "merged") return <span className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-purple-900/60 text-purple-300">merged</span>;
  if (state === "open") return <span className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-green-900/60 text-green-300">open</span>;
  return <span className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-zinc-700 text-zinc-400">closed</span>;
}

function CIBadge({ status, conclusion }: { status: string; conclusion: string | null }) {
  if (status === "in_progress" || status === "queued") return <span className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-yellow-900/60 text-yellow-300">{status === "queued" ? "queued" : "running"}</span>;
  if (conclusion === "success") return <span className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-green-900/60 text-green-300">passed</span>;
  if (conclusion === "failure") return <span className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-red-900/60 text-red-300">failed</span>;
  if (conclusion === "cancelled") return <span className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-zinc-700 text-zinc-400">cancelled</span>;
  if (conclusion === "skipped") return <span className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-zinc-700 text-zinc-500">skipped</span>;
  return <span className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-zinc-700 text-zinc-400">{conclusion ?? status}</span>;
}

export function GitHubPanel({ sessionId, onClose }: GitHubPanelProps) {
  const [tab, setTab] = useState<Tab>("commits");
  const [data, setData] = useState<GithubData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    fetch(`/api/github?sessionId=${sessionId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [sessionId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tabs: { id: Tab; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: "commits",  label: "Commits",  icon: <GitCommit size={11} />,     count: data?.commits.length },
    { id: "pulls",    label: "PRs",      icon: <GitPullRequest size={11} />, count: data?.pulls.length },
    { id: "runs",     label: "CI",       icon: <Zap size={11} />,           count: data?.runs.length },
    { id: "branches", label: "Branches", icon: <GitBranch size={11} />,     count: data?.branches.length },
  ];

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed bottom-0 right-0 top-8 z-50 flex w-96 flex-col border-l border-zinc-700 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" className="shrink-0 text-zinc-400">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300">
            {loading ? "loading…" : (data?.repo ?? "—")}
          </span>
          <button
            onClick={load}
            title="Refresh"
            className="shrink-0 rounded p-0.5 text-zinc-600 hover:text-zinc-300"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} className="shrink-0 rounded p-0.5 text-zinc-600 hover:text-zinc-300">
            <X size={13} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 border-b border-zinc-800 px-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[10px] transition-colors ${
                tab === t.id
                  ? "border-blue-500 text-zinc-200"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t.icon}
              {t.label}
              {t.count !== undefined && !loading && (
                <span className="rounded bg-zinc-800 px-1 text-[9px] text-zinc-500">{t.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-12 text-xs text-zinc-600">Loading…</div>
          )}
          {error && (
            <div className="p-4 text-xs text-red-400">{error}</div>
          )}

          {!loading && !error && data && (
            <>
              {/* Commits */}
              {tab === "commits" && (
                <div className="divide-y divide-zinc-800/60">
                  {data.commits.map((c) => (
                    <a
                      key={c.sha}
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex items-start gap-2.5 px-3 py-2.5 hover:bg-zinc-900/60"
                    >
                      <span className="mt-0.5 shrink-0 font-mono text-[10px] text-zinc-600">{c.sha}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs text-zinc-300 group-hover:text-zinc-100">{c.message}</p>
                        <p className="mt-0.5 text-[10px] text-zinc-600">{c.author} · {relativeTime(c.date)}</p>
                      </div>
                      <ExternalLink size={10} className="mt-0.5 shrink-0 text-zinc-700 opacity-0 group-hover:opacity-100" />
                    </a>
                  ))}
                </div>
              )}

              {/* PRs */}
              {tab === "pulls" && (
                <div className="divide-y divide-zinc-800/60">
                  {data.pulls.map((p) => (
                    <a
                      key={p.number}
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex items-start gap-2.5 px-3 py-2.5 hover:bg-zinc-900/60"
                    >
                      <span className="mt-0.5 shrink-0 text-[10px] text-zinc-600">#{p.number}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs text-zinc-300 group-hover:text-zinc-100">{p.title}</p>
                        <div className="mt-1 flex items-center gap-1.5">
                          <PullBadge state={p.state} draft={p.draft} />
                          <span className="text-[10px] text-zinc-600">{p.author} · {relativeTime(p.updatedAt)}</span>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-700">{p.branch}</p>
                      </div>
                      <ExternalLink size={10} className="mt-0.5 shrink-0 text-zinc-700 opacity-0 group-hover:opacity-100" />
                    </a>
                  ))}
                </div>
              )}

              {/* CI Runs */}
              {tab === "runs" && (
                <div className="divide-y divide-zinc-800/60">
                  {data.runs.map((r) => (
                    <a
                      key={r.id}
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex items-start gap-2.5 px-3 py-2.5 hover:bg-zinc-900/60"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs text-zinc-300 group-hover:text-zinc-100">{r.name}</p>
                        <div className="mt-1 flex items-center gap-1.5">
                          <CIBadge status={r.status} conclusion={r.conclusion} />
                          <span className="font-mono text-[10px] text-zinc-600">{r.branch}</span>
                          <span className="text-[10px] text-zinc-700">· {relativeTime(r.createdAt)}</span>
                        </div>
                        <p className="mt-0.5 text-[10px] text-zinc-700">triggered by {r.event}</p>
                      </div>
                      <ExternalLink size={10} className="mt-0.5 shrink-0 text-zinc-700 opacity-0 group-hover:opacity-100" />
                    </a>
                  ))}
                </div>
              )}

              {/* Branches */}
              {tab === "branches" && (
                <div className="divide-y divide-zinc-800/60">
                  {data.branches.map((b) => (
                    <div key={b.name} className="flex items-center gap-2.5 px-3 py-2.5">
                      <GitBranch size={11} className="shrink-0 text-zinc-600" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300">{b.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-zinc-700">{b.sha}</span>
                      {b.protected && (
                        <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] bg-zinc-800 text-zinc-500">protected</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
