"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import Timeline from "../components/Timeline";
import SourceFilter from "../components/SourceFilter";
import ClusterDetail from "../components/ClusterDetail";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export default function Page() {
  const [clusters, setClusters] = useState([]);
  const [selectedSources, setSelectedSources] = useState(new Set());
  const [selectedId, setSelectedId] = useState(null);
  const [clusterDetail, setClusterDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const loadTimeline = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/timeline`);
      if (!res.ok) throw new Error(`timeline fetch failed (${res.status})`);
      const data = await res.json();
      setClusters(data);
      setSelectedSources((prev) => {
        if (prev.size > 0) return prev; // keep user's existing filter
        return new Set(data.flatMap((c) => c.sources));
      });
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  // Auto-refresh (stretch goal): quietly re-poll /timeline in the background so new
  // clusters/articles show up without the user clicking anything. Does not touch the
  // "Refresh data" button's own ingest-trigger flow.
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(loadTimeline, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadTimeline]);

  useEffect(() => {
    if (!selectedId) {
      setClusterDetail(null);
      return;
    }
    setDetailLoading(true);
    fetch(`${API_URL}/clusters/${selectedId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("not found"))))
      .then(setClusterDetail)
      .catch(() => setClusterDetail(null))
      .finally(() => setDetailLoading(false));
  }, [selectedId]);

  const allSources = useMemo(
    () => [...new Set(clusters.flatMap((c) => c.sources))].sort(),
    [clusters]
  );

  const visibleClusters = useMemo(
    () => clusters.filter((c) => c.sources.some((s) => selectedSources.has(s))),
    [clusters, selectedSources]
  );

  function toggleSource(source) {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      next.has(source) ? next.delete(source) : next.add(source);
      return next;
    });
  }

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/ingest/trigger`, { method: "POST" });
      if (!res.ok) throw new Error("failed to trigger ingest");
      const { jobId } = await res.json();

      const poll = async () => {
        const statusRes = await fetch(`${API_URL}/ingest/status/${jobId}`);
        const status = await statusRes.json();
        if (status.status === "running") {
          setTimeout(poll, 2000);
        } else {
          setRefreshing(false);
          if (status.status === "completed") loadTimeline();
          else setError(`ingest job failed: ${status.message || "unknown error"}`);
        }
      };
      poll();
    } catch (e) {
      setError(e.message);
      setRefreshing(false);
    }
  }

  return (
    <main className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">News Pulse</h1>
          <p className="text-slate-400 text-sm">Topic-clustered news timeline</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-indigo-500"
            />
            Live updates
          </label>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-4 py-2 rounded-md bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
          >
            {refreshing ? "Refreshing…" : "Refresh data"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {allSources.length > 0 && (
        <div className="mb-6">
          <SourceFilter allSources={allSources} selected={selectedSources} onToggle={toggleSource} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <section>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">Timeline</h2>
          <Timeline clusters={visibleClusters} selectedId={selectedId} onSelect={setSelectedId} />
        </section>
        <section>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">Cluster detail</h2>
          <ClusterDetail cluster={clusterDetail} loading={detailLoading} onSelectRelated={setSelectedId} />
        </section>
      </div>
    </main>
  );
}
