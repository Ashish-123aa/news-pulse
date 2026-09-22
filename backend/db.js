const path = require("path");
const fs = require("fs");
// Node's built-in SQLite (stable as of Node 24) — no native compilation, no
// node-gyp, no Visual Studio Build Tools needed. Requires Node >= 22.5; on
// Node 22.x it still needs the --experimental-sqlite flag (see package.json's
// "start" script), on Node 24+ it's on by default.
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "newspulse.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");

// Mirrors the schema created by scraper/scraper.py — the backend only ever reads
// articles/clusters and writes to ingest_jobs.
db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT,
    body TEXT,
    source TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at TEXT,
    fetched_at TEXT NOT NULL,
    cluster_id TEXT
  );
  CREATE TABLE IF NOT EXISTS clusters (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ingest_jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    message TEXT
  );
  CREATE TABLE IF NOT EXISTS cluster_relations (
    cluster_id TEXT NOT NULL,
    related_cluster_id TEXT NOT NULL,
    score REAL NOT NULL,
    PRIMARY KEY (cluster_id, related_cluster_id)
  );
`);

module.exports = db;
