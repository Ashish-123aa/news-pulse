# News Pulse backend + scraper runtime
#
# Bundles Node (the Express API) and Python (the scraper) in one image because
# POST /ingest/trigger spawns scraper.py as a subprocess from inside the Node
# process — both runtimes must exist in the same container.
#
# Build context must be the REPO ROOT (news-pulse/), not backend/, since this
# needs to COPY both backend/ and scraper/.
#   docker build -t news-pulse-backend -f Dockerfile .

FROM node:22-slim

# System Python for the scraper subprocess
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Node deps (separate layer for caching) ---
# No native compilation needed — the backend uses Node's built-in node:sqlite
# instead of better-sqlite3, so this is a plain JS install.
COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm install --omit=dev

# --- Python deps ---
COPY scraper/requirements.txt ./scraper/requirements.txt
RUN pip3 install --break-system-packages --no-cache-dir -r scraper/requirements.txt

# --- App source ---
COPY backend ./backend
COPY scraper ./scraper

ENV PORT=4000 \
    DB_PATH=/data/newspulse.db \
    PYTHON_BIN=python3 \
    SCRAPER_PATH=/app/scraper/scraper.py

EXPOSE 4000
WORKDIR /app/backend
CMD ["npm", "start"]
