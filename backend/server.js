require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const db = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const SCRAPER_PATH = process.env.SCRAPER_PATH || path.join(__dirname, "..", "scraper", "scraper.py");

// ---------------------------------------------------------------------------
// GET /clusters — label, article count, time range per cluster
// ---------------------------------------------------------------------------
app.get("/clusters", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.label,
             COUNT(a.id) AS article_count,
             MIN(a.published_at) AS start_time,
             MAX(a.published_at) AS end_time
      FROM clusters c
      JOIN articles a ON a.cluster_id = c.id
      GROUP BY c.id
      ORDER BY end_time DESC
    `).all();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load clusters" });
  }
});

// ---------------------------------------------------------------------------
// GET /clusters/:id — full detail, articles sorted chronologically
// ---------------------------------------------------------------------------
const ID_PATTERN = /^[a-zA-Z0-9-]+$/; // cluster ids ("c12"), job ids (uuid) — reject anything else early

app.get("/clusters/:id", (req, res) => {
  if (!ID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: "invalid cluster id format" });
  }
  try {
    const cluster = db.prepare("SELECT id, label, created_at FROM clusters WHERE id = ?")
      .get(req.params.id);
    if (!cluster) return res.status(404).json({ error: "cluster not found" });

    const articles = db.prepare(`
      SELECT id, title, summary, source, url, published_at
      FROM articles WHERE cluster_id = ?
      ORDER BY published_at ASC
    `).all(req.params.id);

    // cross-source story merging (stretch goal): other clusters likely covering the
    // same real-world event, surfaced as "related" rather than force-merged
    const related = db.prepare(`
      SELECT r.related_cluster_id AS id, c.label, r.score
      FROM cluster_relations r
      JOIN clusters c ON c.id = r.related_cluster_id
      WHERE r.cluster_id = ?
      ORDER BY r.score DESC
    `).all(req.params.id);

    res.json({ ...cluster, articles, relatedClusters: related });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load cluster" });
  }
});

// ---------------------------------------------------------------------------
// GET /timeline — chart-ready shape: label, start/end, count, intensity
// ---------------------------------------------------------------------------
app.get("/timeline", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.label,
             COUNT(a.id) AS article_count,
             MIN(a.published_at) AS start_time,
             MAX(a.published_at) AS end_time,
             GROUP_CONCAT(DISTINCT a.source) AS sources
      FROM clusters c
      JOIN articles a ON a.cluster_id = c.id
      GROUP BY c.id
      ORDER BY start_time ASC
    `).all();

    const maxCount = Math.max(1, ...rows.map(r => r.article_count));

    const timeline = rows.map(r => ({
      id: r.id,
      label: r.label,
      start: r.start_time,
      end: r.end_time,
      articleCount: r.article_count,
      intensity: r.article_count / maxCount, // 0..1, for marker sizing on the frontend
      sources: r.sources ? r.sources.split(",") : [],
    }));

    res.json(timeline);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load timeline" });
  }
});

// ---------------------------------------------------------------------------
// POST /ingest/trigger — run the python pipeline as a subprocess
// ---------------------------------------------------------------------------
app.post("/ingest/trigger", (req, res) => {
  const jobId = uuidv4();
  const startedAt = new Date().toISOString();

  db.prepare("INSERT INTO ingest_jobs (id, status, started_at) VALUES (?, ?, ?)")
    .run(jobId, "running", startedAt);

  const child = spawn(PYTHON_BIN, [SCRAPER_PATH], {
    env: { ...process.env, DB_PATH: process.env.DB_PATH || path.join(__dirname, "..", "data", "newspulse.db") },
  });

  let stderrBuf = "";
  // Python's logging module writes to stderr by default, so the scraper's
  // INFO/WARNING lines land here. Stream them live to the backend's own
  // console (in addition to buffering, for the failure message) so you can
  // actually see ingest progress while it runs, not just after the fact.
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    process.stderr.write(`[scraper ${jobId.slice(0, 8)}] ${chunk}`);
  });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[scraper ${jobId.slice(0, 8)}] ${chunk}`);
  });

  child.on("close", (code) => {
    const finishedAt = new Date().toISOString();
    if (code === 0) {
      db.prepare("UPDATE ingest_jobs SET status = ?, finished_at = ?, message = ? WHERE id = ?")
        .run("completed", finishedAt, "ok", jobId);
    } else {
      db.prepare("UPDATE ingest_jobs SET status = ?, finished_at = ?, message = ? WHERE id = ?")
        .run("failed", finishedAt, stderrBuf.slice(-2000), jobId);
    }
  });

  child.on("error", (err) => {
    db.prepare("UPDATE ingest_jobs SET status = ?, finished_at = ?, message = ? WHERE id = ?")
      .run("failed", new Date().toISOString(), `spawn error: ${err.message}`, jobId);
  });

  res.status(202).json({ jobId, status: "running" });
});

// ---------------------------------------------------------------------------
// GET /ingest/status/:jobId
// ---------------------------------------------------------------------------
app.get("/ingest/status/:jobId", (req, res) => {
  if (!ID_PATTERN.test(req.params.jobId)) {
    return res.status(400).json({ error: "invalid job id format" });
  }
  const job = db.prepare("SELECT id, status, started_at, finished_at, message FROM ingest_jobs WHERE id = ?")
    .get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(job);
});

app.use((req, res) => res.status(404).json({ error: "not found" }));

app.listen(PORT, () => console.log(`news-pulse backend listening on :${PORT}`));
