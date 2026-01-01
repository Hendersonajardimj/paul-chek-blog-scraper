# Paul Chek Blog Scraper

A TypeScript CLI that uses [Browserbase Stagehand](https://github.com/browserbase/stagehand) to scrape Paul Chek's blog into a PostgreSQL database and local Markdown files. It focuses on the four Doctor sections where full pagination is exposed:

- Dr. Diet
- Dr. Quiet
- Dr. Movement
- Dr. Happiness

For each section, the scraper:

- Paginates through `/category/{doctor}/` pages using `/page/N/` URLs.
- Uses Stagehand to open the category page in a browser, visit each post listed there, and extract structured data via Zod.
- Writes one Markdown file per unique post with YAML front-matter and the article body as Markdown.

## Requirements

- Node.js 18+
- Browserbase account with:
  - `BROWSERBASE_API_KEY`
  - `BROWSERBASE_PROJECT_ID`
- Gemini API key for Stagehand’s model (e.g. Gemini 2.5 Flash or Gemini 3 Flash):
  - `GOOGLE_GENERATIVE_AI_API_KEY`
- Postgres database (local or Railway) with `DATABASE_URL` connection string.

Stagehand runs in `env: "BROWSERBASE"`, so it uses Browserbase-hosted browsers. The underlying LLM model is configured via the `STAGEHAND_MODEL` setting (default `google/gemini-2.5-flash`, but you can set a Gemini 3 Flash model string once supported).

## Setup

1. Clone or create the project directory (already handled if you're using Warp Agent):

   ```bash path=null start=null
   cd ~/projects
   # directory: paul-chek-blog-scraper
   ```

2. Install dependencies:

   ```bash path=null start=null
   npm install
   ```

3. Create your `.env` file from the example and fill in your credentials:

   ```bash path=null start=null
   cp .env.example .env
   # Then edit .env and set at least:
   # BROWSERBASE_API_KEY=bu_...
   # BROWSERBASE_PROJECT_ID=...
   # GOOGLE_GENERATIVE_AI_API_KEY=...   # Gemini API key
   # STAGEHAND_MODEL=google/gemini-2.5-flash  # or a Gemini 3 Flash model string when supported
   # DATABASE_URL=postgresql://user:password@host:5432/paul_chek_blog
   ```

4. (Optional) Configure the **Browserbase MCP server** in your MCP client (e.g. Claude Desktop or Cursor) using the official Browserbase docs. This lets your AI assistant use the same Browserbase project for interactive browsing while you run the CLI locally.

## Running the scraper

The main entrypoint is `src/scrapePaulChekBlog.ts`, wired to the `scrape` npm script:

```bash path=null start=null
npm run scrape
```

By default, the scraper:

- Reads `MAX_PAGES_PER_SECTION` from the environment (default `2`).
- Visits each of the four Doctor sections.
- For each category page, asks Stagehand to:
  - Navigate to the category page URL.
  - Identify all posts listed in the main content for that page.
  - Return a structured list of post summaries and an optional `nextPageUrl`.
- For each new post URL, asks Stagehand to:
  - Navigate to the post page.
  - Extract a structured object with title, URL, date, doctor section, categories, tags, and Markdown body.
- Writes the extracted posts into Postgres (via `DATABASE_URL`) and also to local Markdown files under `data/`.

### Quick, cheap test run

For a conservative first run, limit to one page per section:

```bash path=null start=null
MAX_PAGES_PER_SECTION=1 npm run scrape
```

This will visit page 1 of each Doctor category and save a handful of posts locally.

### Output format

Files are written under:

- `data/paul-chek-blog/{doctor-slug}/{slug}.md`

For example:

- `data/paul-chek-blog/dr-quiet/the-chakra-system-part-3-the-solar-plexus-chakra.md`

Each file has YAML front matter like:

```markdown path=null start=null
---
title: "The Chakra System Part 3: The Solar Plexus Chakra"
url: "https://www.paulcheksblog.com/the-chakra-system-part-3-the-solar-plexus-chakra/"
date: "2019-07-30"
doctor_section: "dr-quiet"
categories:
  - "Dr. Quiet"
  - "Dr. Happiness"
tags:
  - "chakra"
  - "Solar Plexus Chakra"
---

# Markdown article body...
```

The body after the front matter is the Markdown returned by Stagehand (`post.markdown`).

## Implementation notes

This project is wired to Stagehand **v3** using the Browserbase integration:

- For each run, the scraper creates **one Stagehand instance per Doctor section** with `env: "BROWSERBASE"` and a Gemini model (default `google/gemini-2.5-flash`).
- Each section uses the Playwright context that Stagehand exposes:
  - `await stagehand.init()` to start a Browserbase session for that section.
  - `const page = stagehand.context?.pages?.()[0]` and `context.newPage(...)` to drive navigation within that section.
- All AI-powered operations go through `stagehand.extract(...)` rather than `page.extract`:
  - Category pages:
    - `await stagehand.extract(instruction, CategoryPageSchema, { page })` to get `posts[]` and `nextPageUrl`.
  - Post pages:
    - `await stagehand.extract(instruction, PostDetailSchema, { page })` to get a single `PostDetail` object.
- Schemas are defined with `zod/v3` to match the official Stagehand docs, and we use `safeParse` + fallback logic so minor schema mismatches don’t cause us to lose posts.

### Telemetry and reports

Every `npm run scrape` emits machine-readable telemetry under `reports/`:

- `reports/runs.log` – JSONL timeline of each run, including:
  - `runId`, timestamps, config (model, `MAX_PAGES_PER_SECTION`), totals, and aggregated error counts.
  - Per-section checkpoints with `sectionStatus` (`section-complete` or `session-failed`) and basic stats.
- `reports/summary/run-<runId>.json` – final `RunReport` snapshot for a run.
- `reports/summary/run-<runId>-progress.json` – best-effort progress snapshot, overwritten after each section.
- `reports/latest-summary.json` – pointer to the latest run’s summary.
- `reports/raw/stagehand-<runId>.json` – combined Stagehand metrics/history by section.
- `reports/raw/stagehand-metrics-<runId>.json` / `stagehand-history-<runId>.json` – metrics and history separated out.
- `reports/raw/category-debug-<runId>-<section-slug>-p<page>.json` – schema-less debug payloads for category pages that returned 0 posts.

The stdout logs also include structured markers that are easy to grep:

- `SECTION_SUMMARY runId=... section=... pagesVisited=... postsDiscovered=... postsSaved=... postsFailed=...`
- `RUN_SUMMARY runId=... status=... sectionsVisited=... categoryPagesVisited=... postsDiscovered=... postsSaved=... postsFailed=...`
- `CATEGORY_DEBUG_ERROR ...` when a schema-less debug extract fails.
- `CATEGORY_COVERAGE runId=... section=... page=... debugPosts=... structuredPosts=...` when a debug extract runs for a category page with 0 structured posts.
- `EXTRACT_METRIC runId=... section=... kind=category|post|debug url=... durationMs=... status=ok|error ...` around each Stagehand `extract` call.

### Date normalization for Postgres

Stagehand returns human-readable dates from the blog (e.g. `"December 26th, 2025"`), but the `posts.date_published` column is a `TIMESTAMPTZ`. Before inserting into Postgres, the scraper normalizes these strings into an ISO-like format that Postgres can parse (e.g. `"2025-12-26"`). This happens when constructing the `PostRecord` in `src/scrapePaulChekBlog.ts`, so the rest of the pipeline can work with a clean `datePublished` field.

### Schema-less debug extraction

This project leans into Stagehand's **agentic** design: category pages are discovered via natural-language instructions and a **lightweight schema**, and when that fails we fall back to a schema-less diagnostic mode.

- Normal category extraction uses a small Zod schema (`CategoryPageSchema`) for `posts[]` and `nextPageUrl`.
- If a category page returns `0` posts for a section, the scraper runs a second `stagehand.extract` with a **permissive schema** (`z.any()`) and a debug-only instruction.
- The raw debug payload is written to:
  - `reports/raw/category-debug-<runId>-<section-slug>-p<page>.json`

This allows you (or an AI assistant) to inspect what Stagehand "saw" on the page without being bound to the stricter Zod schema, and then adjust the instruction or schema accordingly.

## Error handling and logging

- The script logs which section and page it is working on, how many posts were extracted from each page, and where files are written.
- If a particular Stagehand task (section/page) fails, it logs the error and continues with the next page/section instead of crashing the entire run.
- At the end, it prints a summary of total unique posts saved and the output directory.

## Current state

As of January 2026, the scraper has collected **838 unique posts** across all four Doctor sections:

| Section | Pages | Posts |
|---------|-------|-------|
| Dr. Diet | 29 | ~250 |
| Dr. Quiet | 13 | ~100 |
| Dr. Movement | 35 | ~315 |
| Dr. Happiness | 35 | ~315 |

The scraper is **incremental** - it loads existing post URLs from the database at startup and skips them, so subsequent runs only process new content.

## Database schema

Posts are stored in PostgreSQL with the following schema:

```sql
CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  date_published TIMESTAMPTZ NULL,
  doctor_section TEXT NOT NULL,
  categories TEXT[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  markdown TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The `url` column has a UNIQUE constraint. The `upsertPost()` function uses `ON CONFLICT DO UPDATE`, so:
- Duplicate URLs update existing records
- Multiple concurrent sessions won't create duplicates
- Re-running the scraper is safe and idempotent

## Efficiency features

### Skip already-scraped posts

At startup, the scraper loads all existing URLs from the database:

```typescript
const existingUrls = await getExistingPostUrls();
const seenUrls = new Set<string>(existingUrls);
```

Posts with URLs in `seenUrls` are skipped entirely - no navigation, no extraction, no API calls. This makes incremental runs fast and cheap.

### Extended session timeout

Browserbase sessions are configured with a 30-minute timeout (default is 5 minutes):

```typescript
browserbaseSessionCreateParams: {
  timeout: 30 * 60, // 30 minutes in seconds (max is 21600 = 6 hours)
  keepAlive: true,
}
```

This prevents session timeouts when scraping deep pagination (pages 25-35 take significant time).

### Pagination fallback

If the LLM returns an invalid `nextPageUrl` (like an element ID `"0-35378"` instead of a real URL), the scraper falls back to the next sequential page number:

```typescript
const fallbackUrl = `${section.baseUrl}page/${nextPageNum}/`;
```

This ensures pagination continues even when extraction is imperfect.

## Troubleshooting

### 429 errors (concurrent session limit)

```
429 You've exceeded your max concurrent sessions limit
```

**Cause:** Browserbase limits concurrent sessions per plan. Killed scrapes may leave lingering sessions.

**Solutions:**
1. Wait 2-5 minutes for old sessions to timeout
2. Kill lingering sessions via Browserbase dashboard
3. Upgrade your plan for more concurrent sessions

### 400 errors (timeout value)

```
400 body/timeout must be <= 21600
```

**Cause:** Session timeout was specified in milliseconds instead of seconds.

**Solution:** The timeout is now correctly set to `30 * 60` (1800 seconds), not `30 * 60 * 1000`.

### Session timeouts on deep pages

If the scraper times out before reaching the end of a section's archive:

1. Increase `MAX_PAGES_PER_SECTION` in `.env`
2. Consider increasing `browserbaseSessionCreateParams.timeout` (max 21600 seconds = 6 hours)
3. Run multiple times - the incremental logic will pick up where it left off

### Posts with element IDs instead of URLs

The LLM sometimes returns element IDs (like `"0-346"`) instead of actual URLs. The scraper validates URLs and logs warnings:

```
Skipping invalid URL (likely element ID): 0-346
```

These posts will be retried on subsequent runs when the LLM extraction succeeds.

## Architecture

```
src/
├── scrapePaulChekBlog.ts  # Main scraper logic
└── db.ts                   # PostgreSQL operations

data/paul-chek-blog/       # Local markdown files
├── dr-diet/
├── dr-quiet/
├── dr-movement/
└── dr-happiness/

reports/                   # Telemetry and debug artifacts
├── runs.log              # JSONL timeline of all runs
├── summary/              # Per-run JSON summaries
├── latest-summary.json   # Pointer to most recent run
└── raw/                  # Stagehand metrics/history
```

## Next steps

Once you have a local corpus of Markdown posts, you can:

- Feed them into a RAG pipeline (e.g. using pgvector, OpenAI File Search, or your own embeddings store).
- Combine this scraper with your other ingestion tools (YouTube transcripts, notes) for a unified knowledge base.
