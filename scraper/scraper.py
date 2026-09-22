#!/usr/bin/env python3
"""
News Pulse — RSS ingestion + keyword-overlap topic clustering.

Usage:
    python scraper.py

Env vars (see .env.example):
    DB_PATH                     path to sqlite db (default: ../data/newspulse.db)
    CLUSTER_OVERLAP_THRESHOLD   min shared significant words to link two articles (default: 3)
    CLUSTER_RELATION_THRESHOLD  min Jaccard similarity between two clusters' word sets to flag
                                 them as the same underlying story across sources (default: 0.25)
"""

import os
import re
import html
import sqlite3
import hashlib
import logging
from datetime import datetime, timezone
from collections import Counter

import feedparser
import requests
from bs4 import BeautifulSoup
from dateutil import parser as dateparser

try:
    import trafilatura
except ImportError:
    trafilatura = None

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("news-pulse")

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "..", "data", "newspulse.db"))
OVERLAP_THRESHOLD = int(os.environ.get("CLUSTER_OVERLAP_THRESHOLD", "3"))
RELATION_THRESHOLD = float(os.environ.get("CLUSTER_RELATION_THRESHOLD", "0.25"))
REQUEST_TIMEOUT = 10

FEEDS = [
    {"source": "BBC News", "url": "http://feeds.bbci.co.uk/news/rss.xml"},
    {"source": "NPR", "url": "https://feeds.npr.org/1001/rss.xml"},
    {"source": "Al Jazeera", "url": "https://www.aljazeera.com/xml/rss/all.xml"},
]

STOPWORDS = set("""
a about above after again against all am an and any are aren't as at be because been before
being below between both but by can't cannot could couldn't did didn't do does doesn't doing
don't down during each few for from further had hadn't has hasn't have haven't having he he'd
he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into
is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only
or other ought our ours ourselves out over own same shan't she she'd she'll she's should
shouldn't so some such than that that's the their theirs them themselves then there there's
these they they'd they'll they're they've this those through to too under until up very was
wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while
who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours
yourself yourselves says said say new one two three us after before amid after could would also
""".split())


# --------------------------------------------------------------------------
# DB setup
# --------------------------------------------------------------------------

def get_conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
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
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS clusters (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ingest_jobs (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            message TEXT
        )
    """)
    # Cross-source story merging (stretch goal): clusters that likely cover the same
    # real-world event but stayed separate (different outlets phrase headlines differently,
    # so per-article word overlap fell short of OVERLAP_THRESHOLD). Stored as a relation
    # between two cluster IDs rather than forcibly merging them, since forcing a merge risks
    # collapsing genuinely distinct stories that just share a topic (e.g. two different
    # "election" stories).
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cluster_relations (
            cluster_id TEXT NOT NULL,
            related_cluster_id TEXT NOT NULL,
            score REAL NOT NULL,
            PRIMARY KEY (cluster_id, related_cluster_id)
        )
    """)
    return conn


# --------------------------------------------------------------------------
# Ingestion
# --------------------------------------------------------------------------

def article_id(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def normalize_date(entry) -> str:
    """Normalize whatever date field a feed gives us into ISO 8601 UTC."""
    for field in ("published", "updated", "pubDate"):
        raw = entry.get(field)
        if raw:
            try:
                dt = dateparser.parse(raw)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.astimezone(timezone.utc).isoformat()
            except (ValueError, TypeError):
                continue
    # some feeds only give parsed struct_time
    for field in ("published_parsed", "updated_parsed"):
        parsed = entry.get(field)
        if parsed:
            try:
                dt = datetime(*parsed[:6], tzinfo=timezone.utc)
                return dt.isoformat()
            except (ValueError, TypeError):
                continue
    return datetime.now(timezone.utc).isoformat()


def extract_summary(entry) -> str:
    # different feeds use summary / description / content:encoded
    if entry.get("summary"):
        text = entry["summary"]
    elif entry.get("description"):
        text = entry["description"]
    elif entry.get("content"):
        text = entry["content"][0].get("value", "")
    else:
        text = ""
    if not text:
        return ""
    # Only run it through BeautifulSoup if it actually looks like markup — a plain
    # string with no tags makes BeautifulSoup emit a spurious "looks like a filename"
    # warning even though nothing is wrong.
    if "<" in text:
        return BeautifulSoup(text, "html.parser").get_text(" ", strip=True)
    # No tags, but the text can still contain raw HTML entities (e.g. Al Jazeera's
    # "&#039;s" for an apostrophe) — decode those even on the no-BeautifulSoup path.
    return html.unescape(text).strip()


def fetch_full_body(url: str) -> str:
    """Fetch the article page and extract main body text. Never raises.

    trafilatura and the requests/BeautifulSoup fallback are tried in *separate*
    try/except blocks on purpose — if trafilatura fails for any reason (network
    error, or an API mismatch like a removed kwarg on a newer/older version), we
    still want the fallback to actually run instead of the whole function bailing out.
    """
    if trafilatura is not None:
        try:
            downloaded = trafilatura.fetch_url(url)
            if downloaded:
                extracted = trafilatura.extract(downloaded)
                if extracted:
                    return extracted
        except Exception as e:
            log.debug(f"trafilatura failed for {url}, falling back to requests: {e}")

    try:
        resp = requests.get(url, timeout=REQUEST_TIMEOUT, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        paragraphs = [p.get_text(" ", strip=True) for p in soup.find_all("p")]
        return " ".join(paragraphs)
    except Exception as e:  # noqa: broad-except — a single bad page must not kill the run
        log.warning(f"body extraction failed for {url}: {e}")
        return ""


def ingest_feeds(conn) -> int:
    cur = conn.cursor()
    existing_ids = {row[0] for row in cur.execute("SELECT id FROM articles")}
    new_count = 0

    for feed in FEEDS:
        log.info(f"fetching feed: {feed['source']}")
        try:
            parsed = feedparser.parse(feed["url"])
        except Exception as e:
            log.warning(f"failed to parse feed {feed['source']}: {e}")
            continue

        for entry in parsed.entries:
            url = entry.get("link")
            if not url:
                continue
            aid = article_id(url)
            if aid in existing_ids:
                continue  # already ingested — keeps re-runs cheap and dedup'd

            title = html.unescape(entry.get("title", "(untitled)"))
            summary = extract_summary(entry)
            published_at = normalize_date(entry)
            body = fetch_full_body(url)

            cur.execute(
                """INSERT OR IGNORE INTO articles
                   (id, title, summary, body, source, url, published_at, fetched_at, cluster_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)""",
                (aid, title, summary, body, feed["source"], url,
                 published_at, datetime.now(timezone.utc).isoformat()),
            )
            existing_ids.add(aid)
            new_count += 1

        conn.commit()

    log.info(f"ingested {new_count} new articles")
    return new_count


# --------------------------------------------------------------------------
# Clustering (Option A — keyword / word-overlap)
# --------------------------------------------------------------------------

def significant_words(text: str) -> set:
    words = re.findall(r"[a-z']+", text.lower())
    return {w for w in words if len(w) > 2 and w not in STOPWORDS}


class UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def cluster_articles(conn):
    cur = conn.cursor()
    rows = cur.execute("SELECT id, title, summary FROM articles").fetchall()
    if not rows:
        log.info("no articles to cluster")
        return

    ids = [r[0] for r in rows]
    word_sets = [significant_words(f"{r[1]} {r[2] or ''}") for r in rows]

    uf = UnionFind(len(rows))
    for i in range(len(rows)):
        if not word_sets[i]:
            continue
        for j in range(i + 1, len(rows)):
            if not word_sets[j]:
                continue
            if len(word_sets[i] & word_sets[j]) >= OVERLAP_THRESHOLD:
                uf.union(i, j)

    groups = {}
    for i in range(len(rows)):
        root = uf.find(i)
        groups.setdefault(root, []).append(i)

    # wipe and rewrite clusters each run — simplest correct approach for this scale.
    # limitation: cluster IDs are not stable across runs (see README).
    cur.execute("DELETE FROM clusters")
    cur.execute("DELETE FROM cluster_relations")
    cur.execute("UPDATE articles SET cluster_id = NULL")

    cluster_num = 0
    cluster_word_sets = {}  # cluster_id -> combined significant words, used for relation pass below
    for root, member_idxs in groups.items():
        if len(member_idxs) < 2:
            continue  # singleton articles stay unclustered until a related story appears
        cluster_num += 1
        cluster_id = f"c{cluster_num}"

        combined_words = Counter()
        for idx in member_idxs:
            combined_words.update(word_sets[idx])
        label_words = [w for w, _ in combined_words.most_common(3)]
        label = " / ".join(label_words) if label_words else "misc"

        cur.execute(
            "INSERT INTO clusters (id, label, created_at) VALUES (?, ?, ?)",
            (cluster_id, label, datetime.now(timezone.utc).isoformat()),
        )
        for idx in member_idxs:
            cur.execute("UPDATE articles SET cluster_id = ? WHERE id = ?", (cluster_id, ids[idx]))

        cluster_word_sets[cluster_id] = set(combined_words.keys())

    link_related_clusters(cur, cluster_word_sets)

    conn.commit()
    log.info(f"formed {cluster_num} clusters from {len(rows)} articles "
              f"({sum(1 for m in groups.values() if len(m) < 2)} unclustered singletons)")


def link_related_clusters(cur, cluster_word_sets: dict):
    """Cross-source story merging (stretch goal).

    Two clusters stayed separate because no single *article* pair crossed
    OVERLAP_THRESHOLD, but if the clusters *as a whole* share a large fraction of their
    vocabulary (Jaccard similarity over combined word sets), they're likely the same
    real-world story covered with different phrasing across outlets. We flag that
    relationship instead of merging the clusters outright, since a forced merge could
    wrongly combine two distinct stories that merely share a topic.
    """
    cluster_ids = list(cluster_word_sets.keys())
    for i in range(len(cluster_ids)):
        for j in range(i + 1, len(cluster_ids)):
            a, b = cluster_ids[i], cluster_ids[j]
            wa, wb = cluster_word_sets[a], cluster_word_sets[b]
            if not wa or not wb:
                continue
            union = wa | wb
            score = len(wa & wb) / len(union) if union else 0
            if score >= RELATION_THRESHOLD:
                cur.execute(
                    "INSERT OR REPLACE INTO cluster_relations (cluster_id, related_cluster_id, score) "
                    "VALUES (?, ?, ?)", (a, b, score),
                )
                cur.execute(
                    "INSERT OR REPLACE INTO cluster_relations (cluster_id, related_cluster_id, score) "
                    "VALUES (?, ?, ?)", (b, a, score),
                )


def run():
    conn = get_conn()
    try:
        ingest_feeds(conn)
        cluster_articles(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    run()