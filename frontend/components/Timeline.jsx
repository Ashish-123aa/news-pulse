"use client";

function fmt(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export default function Timeline({ clusters, selectedId, onSelect }) {
  if (clusters.length === 0) {
    return (
      <div className="text-slate-500 text-sm py-12 text-center border border-dashed border-slate-800 rounded-lg">
        No clusters yet — trigger a refresh to pull articles and build the timeline.
      </div>
    );
  }

  const allTimes = clusters.flatMap((c) => [new Date(c.start).getTime(), new Date(c.end).getTime()]);
  const min = Math.min(...allTimes);
  const max = Math.max(...allTimes);
  const span = Math.max(max - min, 1000 * 60 * 60); // at least 1hr span to avoid div-by-zero

  return (
    <div className="space-y-2">
      {clusters.map((c) => {
        const startPct = ((new Date(c.start).getTime() - min) / span) * 100;
        const rawWidth = ((new Date(c.end).getTime() - new Date(c.start).getTime()) / span) * 100;
        const widthPct = Math.max(rawWidth, 1.5); // minimum visible width
        const isSelected = selectedId === c.id;
        // Visual cluster sizing (stretch goal): bigger cluster = taller, bolder marker
        const barHeight = 6 + Math.round(c.intensity * 22); // 6-28px
        const barOpacity = 0.55 + c.intensity * 0.45; // 0.55-1.0

        return (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={`w-full text-left group rounded-md px-2 py-1.5 transition ${
              isSelected ? "bg-slate-800" : "hover:bg-slate-900"
            }`}
          >
            <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
              <span className="truncate font-medium text-slate-200">{c.label}</span>
              <span className="shrink-0 ml-2">{c.articleCount} articles</span>
            </div>
            <div className="relative w-full bg-slate-900 rounded" style={{ height: 26 }}>
              <div
                className={`absolute rounded ${isSelected ? "bg-indigo-400" : "bg-indigo-600 group-hover:bg-indigo-500"}`}
                style={{
                  left: `${startPct}%`,
                  width: `${widthPct}%`,
                  height: barHeight,
                  top: "50%",
                  transform: "translateY(-50%)",
                  opacity: barOpacity,
                }}
                title={`${fmt(c.start)} → ${fmt(c.end)}`}
              />
            </div>
          </button>
        );
      })}
      <div className="flex justify-between text-[11px] text-slate-500 pt-1">
        <span>{fmt(new Date(min).toISOString())}</span>
        <span>{fmt(new Date(max).toISOString())}</span>
      </div>
    </div>
  );
}
