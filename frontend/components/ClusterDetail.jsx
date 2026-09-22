"use client";

function fmt(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export default function ClusterDetail({ cluster, loading, onSelectRelated }) {
  if (loading) {
    return <div className="text-slate-500 text-sm">Loading cluster…</div>;
  }
  if (!cluster) {
    return (
      <div className="text-slate-500 text-sm py-12 text-center border border-dashed border-slate-800 rounded-lg">
        Select a cluster on the timeline to see its articles.
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-lg font-semibold text-slate-100 mb-3">{cluster.label}</h3>

      {cluster.relatedClusters?.length > 0 && (
        <div className="mb-4 p-3 rounded-md bg-slate-900 border border-slate-800">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
            Possibly the same story
          </div>
          <div className="flex flex-wrap gap-2">
            {cluster.relatedClusters.map((r) => (
              <button
                key={r.id}
                onClick={() => onSelectRelated?.(r.id)}
                className="text-xs px-2 py-1 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300"
                title={`similarity ${(r.score * 100).toFixed(0)}%`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <ul className="space-y-3">
        {cluster.articles.map((a) => (
          <li key={a.id} className="border-b border-slate-800 pb-3 last:border-0">
            <a
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300 font-medium"
            >
              {a.title}
            </a>
            <div className="text-xs text-slate-500 mt-1">
              {a.source} · {fmt(a.published_at)}
            </div>
            {a.summary && <p className="text-sm text-slate-400 mt-1 line-clamp-2">{a.summary}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
