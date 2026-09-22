"use client";

export default function SourceFilter({ allSources, selected, onToggle }) {
  return (
    <div className="flex flex-wrap gap-2">
      {allSources.map((source) => {
        const active = selected.has(source);
        return (
          <button
            key={source}
            onClick={() => onToggle(source)}
            className={`px-3 py-1 rounded-full text-sm border transition ${
              active
                ? "bg-indigo-500 border-indigo-400 text-white"
                : "bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500"
            }`}
          >
            {source}
          </button>
        );
      })}
    </div>
  );
}
