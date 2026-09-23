# News Pulse — Topic-Clustered News Timeline

A small system that pulls live articles from RSS feeds, groups related articles into topic
clusters, and displays them as a visual timeline.

## Live Demo

- Frontend: https://news-pulse-pearl.vercel.app
- Backend API: https://news-pulse-g6u5.onrender.com

```
/scraper   Python — RSS ingestion, article extraction, keyword-overlap clustering
/backend   Node.js/Express — REST API over the shared SQLite DB (node:sqlite, Node's built-in driver)
/frontend  Next.js — timeline visualization + cluster explorer
/data      shared SQLite database file (created on first run)
```

## Architecture

The Python scraper and the Node API share a single SQLite file (`data/newspulse.db`).
The scraper is the only writer of article/cluster data; the Node API reads it and also
owns an `ingest_jobs` table it uses to track pipeline runs it triggers as a subprocess.
The frontend talks only to the Node API, never to the DB or scraper directly.

```
RSS feeds → scraper.py → SQLite (articles, clusters) ← Express API ← Next.js frontend
                                        ↑
                            POST /ingest/trigger spawns scraper.py
```

## Setup

**Requires Node.js ≥ 22.5** (the backend uses Node's built-in `node:sqlite` — no
native compilation, no build tools needed). Node 22.13+/23.4+/24+ work with no
extra flag; the `npm start`/`npm run dev` scripts already pass
`--experimental-sqlite` for compatibility with earlier 22.x point releases.

### 1. Scraper
```bash
cd scraper
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python scraper.py          # populates ../data/newspulse.db
```

### 2. Backend
```bash
cd backend
cp .env.example .env
npm install
npm start                  # http://localhost:4000
```

### 3. Frontend
```bash
cd frontend
cp .env.example .env
npm install
npm run dev                 # http://localhost:3000
```

Run the scraper once manually before starting the backend so there's data to serve, then
use the "Refresh data" button in the UI to re-trigger it going forward.

## News sources used

- BBC News — `http://feeds.bbci.co.uk/news/rss.xml`
- NPR — `https://feeds.npr.org/1001/rss.xml`
- Al Jazeera — `https://www.aljazeera.com/xml/rss/all.xml`

## Topic grouping approach

**Keyword / word-overlap grouping (Option A)**, chosen over TF-IDF because the assessment
explicitly treats both as equally valid and a threshold-based overlap approach is easier to
verify by hand and explain clearly — which matters more here than raw accuracy at this scale.

- Tokenize `title + summary`, lowercase, strip punctuation, drop a ~150-word stopword list
  and any token ≤2 characters.
- Two articles are linked if they share **≥ 3** significant words (configurable via
  `CLUSTER_OVERLAP_THRESHOLD`). The spec's own example used 4+, but headlines/summaries are
  short (often 8–15 significant words total), so 4 was too strict in testing and left
  obviously-related articles unlinked. 3 struck a better balance between precision and recall
  for this text length.
- Linked articles are grouped transitively via union-find (so A–B and B–C linked implies one
  cluster of A/B/C, not two separate pairs).
- A cluster's label is its 3 most frequent shared words across all member articles.
- Articles with no sufficiently-overlapping match stay unclustered (singletons) rather than
  being forced into a cluster of one — the timeline only ever shows real, multi-article
  clusters.

**Limitation:** clusters are fully recomputed on every run (simplest correct approach for
this scale), which means cluster IDs are not stable across runs — a cluster from run 1 may
merge into a larger one in run 2 and get a new ID. A production version would need stable
cluster identity (e.g. by carrying forward the majority-membership match) so the frontend
doesn't lose "which cluster was this" between refreshes.

## API

| Endpoint | Purpose |
|---|---|
| `GET /clusters` | label, article count, time range per cluster |
| `GET /clusters/:id` | full cluster detail, articles sorted chronologically, `relatedClusters` |
| `GET /timeline` | chart-ready shape: label, start/end, count, intensity (0–1) |
| `POST /ingest/trigger` | runs the scraper as a subprocess, returns `{ jobId }` |
| `GET /ingest/status/:jobId` | poll job status: `running` / `completed` / `failed` |

## Scheduled ingestion (optional)

`.github/workflows/scheduled-ingest.yml` calls `POST /ingest/trigger` on the deployed
backend every 30 minutes via GitHub Actions cron, then polls `/ingest/status/:jobId` until
it completes or fails — so the timeline stays current without anyone clicking "Refresh data"
manually. This is separate from, and doesn't replace, the manual refresh button.

**Setup** (only needed once the backend is deployed):
1. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**
2. Name: `BACKEND_URL`, value: your deployed backend URL with no trailing slash
   (e.g. `https://news-pulse-g6u5.onrender.com`)
3. That's it — the workflow runs automatically on schedule. To test it immediately instead
   of waiting up to 30 minutes: **Actions tab → Scheduled news ingest → Run workflow**.

**Note on Render's free tier:** if the backend spins down from inactivity, this scheduled
job effectively also keeps it warm every 30 minutes (each cron run wakes it via the
ingest-trigger request). On a paid tier this isn't a concern either way.

## Stretch goals implemented

- **Auto-refresh** — the frontend re-polls `/timeline` every 30s in the background (toggle:
  "Live updates" checkbox in the header). Independent of the manual "Refresh data" button,
  which triggers the actual ingest pipeline.
- **Visual cluster sizing** — a cluster's timeline marker height and opacity scale with its
  `intensity` (article count relative to the largest cluster in the current view).
- **Cross-source story merging** — after clustering, `link_related_clusters()` computes
  Jaccard similarity between *clusters'* combined vocabularies (not just individual article
  pairs) and stores a link in `cluster_relations` when two clusters share ≥25% of their
  significant words (`CLUSTER_RELATION_THRESHOLD`). This catches cases where, say, a BBC
  cluster and an Al Jazeera cluster cover the same event but phrase headlines differently
  enough that no single article pair crossed the clustering threshold. Related clusters are
  surfaced as "Possibly the same story" chips in the cluster detail panel rather than force-
  merged — merging outright risks collapsing two genuinely distinct stories that just share a
  topic (e.g. two unrelated "election" stories).

## Deployment

| Component | Platform | Notes |
|---|---|---|
| Frontend | Vercel | set `NEXT_PUBLIC_API_URL` to the deployed backend URL |
| Backend + scraper | Render/Railway, **Docker deploy** using the root `Dockerfile` | bundles Node + Python in one image so `/ingest/trigger` can spawn the scraper subprocess reliably |
| Database | SQLite file inside the container (see note below on Render's free tier) |

**Note on storage persistence:** Render's free-tier web services don't support persistent
disks (that's a paid-tier feature). The live deployment above therefore uses ephemeral
storage — the SQLite file resets on redeploy or when the free instance spins down from
inactivity. This is a deliberate tradeoff for this assessment (correctness and a working
live demo over production-grade persistence on a 3-day deadline), not an oversight. For a
real deployment, the fix is either a Render paid tier with a persistent disk, or swapping to
Render's free Postgres tier — the schema translates directly, it would just need the DB
driver swapped in both `scraper/` and `backend/`.

### Backend (Docker deploy — Render example)
1. Push the repo to GitHub.
2. Render → **New → Web Service** → connect the repo.
3. Set **Runtime** to **Docker**. Leave **Root Directory** blank (repo root) and
   **Dockerfile Path** as `Dockerfile` — the build needs access to both `backend/` and
   `scraper/`, so the build context must be the repo root, not `backend/`.
4. Environment variables (the Dockerfile already sets sane defaults, override only if needed):
```
   DB_PATH=/app/data/newspulse.db
```
5. Deploy. Test `POST /ingest/trigger` on the live URL early — this is the step most likely
   to break if Python/Node aren't both present, and the Docker image is what guarantees they
   are.

Railway: same idea — "Deploy from Dockerfile", root repo as build context, same env var. If
using a paid tier with a persistent volume, mount it at `/data` and set `DB_PATH` to match.

### Frontend (Vercel)
1. Vercel → **New Project** → import the repo → set **Root Directory** to `frontend`.
2. Framework preset: Next.js (auto-detected).
3. Environment variable: `NEXT_PUBLIC_API_URL=<your deployed backend URL>`.
4. Deploy.

All secrets/URLs are read from environment variables (`.env.example` in `backend/` and
`frontend/`) — nothing is hardcoded in source.

## Assumptions made

- SQLite chosen over Postgres/Mongo for zero external setup during development; schema is
  simple enough to port if needed. The backend uses Node's built-in `node:sqlite` driver
  rather than `better-sqlite3` specifically to avoid native-module compilation (which
  requires platform build tools like Visual Studio Build Tools on Windows) — a pure-JS
  dependency footprint was a deliberate choice for reviewer setup friction, not just
  personal preference.
- "Full article body" extraction uses `trafilatura` first (best accuracy on news sites) with
  a raw `<p>`-tag BeautifulSoup fallback if that fails; if both fail, the article is still
  stored with just its RSS summary rather than dropped.
- Re-runs skip any article URL already in the DB, so only genuinely new articles are fetched
  and processed each run.