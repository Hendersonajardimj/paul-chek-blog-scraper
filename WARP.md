# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Commands

### Install dependencies

```bash path=null start=null
npm install
```

### Environment configuration

The scraper depends on Browserbase, Gemini, and (optionally) Postgres. Configure them via `.env`:

```bash path=null start=null
cp .env.example .env
# Then edit .env and set at least:
# BROWSERBASE_API_KEY=bu_...
# BROWSERBASE_PROJECT_ID=...
# GOOGLE_GENERATIVE_AI_API_KEY=...
# STAGEHAND_MODEL=google/gemini-2.5-flash   # or another Gemini model string
# DATABASE_URL=postgresql://user:password@host:5432/paul_chek_blog
```

Notes for agents:
- If `DATABASE_URL` is **unset**, the scraper will still run and write Markdown files, but DB writes are skipped (see `src/db.ts`).
- If `DATABASE_URL` is set, the first run will auto-create a `posts` table if it does not exist.

### Run the main scraper

The primary entrypoint is `src/scrapePaulChekBlog.ts`, exposed via the `scrape` npm script:

```bash path=null start=null
npm run scrape
```

This will:
- Use Stagehand v3 with `env: "BROWSERBASE"` to drive a Browserbase-hosted Playwright session.
- Iterate through the four Doctor sections (Diet, Quiet, Movement, Happiness).
- Paginate category pages and extract post metadata.
- Visit each new post and extract a detailed Markdown body.
- Write posts to Postgres (if configured) and to local Markdown under `data/`.

### Quick/cheap smoke run

Limit pagination to a single page per Doctor section for a cheaper test run:

```bash path=null start=null
MAX_PAGES_PER_SECTION=1 npm run scrape
```

This is useful when validating environment setup or after code changes, since it only touches the first page in each section.

### Type checking

There is no dedicated `npm run build` or `npm test` script. To perform a TypeScript-type check over `src/**/*.ts` using the existing `tsconfig.json`:

```bash path=null start=null
npx tsc --noEmit
```

Use this before larger refactors or when modifying types in `src/db.ts` or the Zod schemas in `src/scrapePaulChekBlog.ts`.

## High-level architecture

### Overview

This repository is a small TypeScript CLI whose sole responsibility is to scrape Paul Chek’s blog into structured Markdown files and (optionally) a Postgres table. It is built around:
- **Stagehand v3 + Browserbase** for browser automation and LLM-backed extraction.
- **Zod v3** schemas to validate and normalize data coming back from Stagehand.
- **Postgres** as an optional persistence layer for posts.
- **Filesystem outputs** under `data/` and `reports/` for downstream tooling and debugging.

The core logic lives in two files:
- `src/scrapePaulChekBlog.ts` – the main orchestrator and CLI entrypoint.
- `src/db.ts` – minimal Postgres integration for the `posts` table.

### Data flow

1. **Configuration & env loading**
   - `dotenv` is loaded via the `scrape` script (`tsx -r dotenv/config ...`).
   - `getEnvConfig()` in `src/scrapePaulChekBlog.ts` reads `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `STAGEHAND_MODEL`, and `MAX_PAGES_PER_SECTION`.
   - A missing Browserbase API key or project ID is treated as a hard error; the process exits early.

2. **Database initialization** (`src/db.ts`)
   - `initDb()` uses `pg.Pool` when `DATABASE_URL` is present and creates a `posts` table if needed, with fields for URL, slug, title, normalized date, doctor section, categories, tags, and markdown.
   - If `DATABASE_URL` is absent, a warning is logged and all DB functions become no-ops; the rest of the pipeline still executes, relying solely on Markdown output.

3. **Run-scoped reporting
   and telemetry**
   - Each execution constructs a `runId` like `YYYYMMDD-HHMMSS-p<maxPages>` via `createRunId()`.
   - A `RunReport` struct tracks per-run and per-section counts (pages visited, posts discovered/saved/failed, error counts, section status) and configuration (model, max pages).
   - JSON and JSONL artifacts are written under `reports/`:
     - `reports/runs.log` – append-only JSONL of run checkpoints and per-section summaries.
     - `reports/summary/run-<runId>.json` and `run-<runId>-progress.json` – full snapshots of `RunReport` as the run progresses and completes.
     - `reports/latest-summary.json` – always points to the latest run’s final `RunReport`.
     - `reports/raw/stagehand-*.json`, `stagehand-metrics-*.json`, `stagehand-history-*.json` – aggregated Stagehand metrics/history captured per section.
     - `reports/raw/category-debug-<runId>-<section-slug>-p<page>.json` – schema-less debug extracts for problematic category pages.

4. **Stagehand session lifecycle**
   - For each Doctor section in `SECTIONS`, `main()` creates a new `Stagehand` instance with:
     - `env: "BROWSERBASE"` (Browserbase-backed browser session).
     - Browserbase API key and project ID.
     - A Gemini model identifier (`STAGEHAND_MODEL`).
   - `stagehand.init()` starts the remote browser session and Playwright context; `stagehand.context?.pages()?.[0]` is used as the base page for that section.
   - After scraping a section:
     - Stagehand metrics and history are read (best-effort) into in-memory maps.
     - The Stagehand session is closed in a `finally` block to avoid leaks.

5. **Category-page scraping loop** (`scrapeSection()`)
   - Responsible for paginating `/category/{doctor}/page/N/` and extracting post summaries.
   - For each page URL:
     - Navigates via the shared `pageInstance`.
     - Calls `extractCategoryPage()` which:
       - Issues a detailed natural-language instruction to Stagehand describing how to identify post-like items and `nextPageUrl`.
       - Validates the result against `CategoryPageSchema` (Zod) and logs an `EXTRACT_METRIC` line with duration and status.
       - On validation failure, falls back to a tolerant transformation of the raw payload into a `CategoryPageResult`.
     - If `posts.length === 0`, it triggers a **schema-less debug extraction** (Zod `z.any()`) and writes a category-debug artifact to `reports/raw/`, plus a `CATEGORY_COVERAGE` log line.
   - Pagination continues until `nextPageUrl` is null, `maxPagesPerSection` is reached, or a Stagehand session is considered unhealthy.

6. **Post-detail extraction and persistence**
   - For each new post URL on a category page (deduplicated via a shared `seenUrls` set across all sections), `scrapeSection()` calls `extractPostDetail()`:
     - Sends a focused instruction to Stagehand to extract one `PostDetail` object (slug, title, URL, date, doctor section, categories, tags, and Markdown body).
     - Validates against `PostDetailSchema` and logs `EXTRACT_METRIC kind=post` with timing and status.
     - On validation failure, constructs a best-effort `PostDetail` from the raw payload and URL.
     - Implements up to three retry attempts for recoverable Stagehand session errors, with backoff and a `consecutiveSessionErrors` threshold; once exceeded, the section is marked `session-failed` and the loop aborts early.
   - For each successful `PostDetail`:
     - `normalizeDate()` converts human-readable blog dates to `YYYY-MM-DD` strings suitable for Postgres; unparseable dates are logged and stored as-is when necessary.
     - A `PostRecord` is built and passed to `upsertPost()` to insert/update the DB row.
     - `writePostMarkdown()` renders the post into a Markdown file with YAML front matter under `data/paul-chek-blog/{doctor-slug}/{slug}.md`.

7. **Run finalization and artifacts**
   - After all sections complete (or a fatal error occurs):
     - `RunReport.status` is set to `run-complete` or `run-aborted`.
     - A final stdout `RUN_SUMMARY` line is emitted with counts and status.
     - Summary JSON files under `reports/summary/` are written or updated.
     - `reports/latest-summary.json` is updated to mirror the final `RunReport`.
     - Stagehand metrics/history artifacts are written individually and in a combined structure under `reports/raw/` using `writeJsonArtifactWithFallback()` to tolerate serialization failures.

### Error handling strategy

The scraper is designed to be resilient to partial failures:
- **Environment errors** (missing Browserbase env vars) fail fast before any Stagehand or DB work occurs.
- **Database configuration issues** (missing `DATABASE_URL`) only disable DB writes; Markdown outputs continue to be written.
- **Per-section failures**:
  - Stagehand session errors during post extraction are retried with backoff and tracked; repeated session errors flip `sessionHealthy` to false and mark the section as `session-failed`.
  - Unexpected exceptions inside a section are logged clearly and recorded in `RunReport.sectionStatus`.
- **Artifact writing failures** are caught and downgraded to warnings; a minimal stub JSON is written instead when possible so that downstream tools are not blocked by one bad file.

### Where to look when debugging

- **Scrape behavior and progress**: search stdout for `SECTION_SUMMARY`, `RUN_SUMMARY`, `CATEGORY_COVERAGE`, `EXTRACT_METRIC`, and `CATEGORY_DEBUG_ERROR` markers.
- **Run-level telemetry**: inspect `reports/runs.log` and the corresponding `reports/summary/run-<runId>.json` file.
- **Stagehand behavior**: inspect `reports/raw/stagehand-*.json`, `stagehand-metrics-*.json`, and `stagehand-history-*.json` for per-section metrics/history.
- **Category-page edge cases**: open `reports/raw/category-debug-<runId>-<section-slug>-p<page>.json` to see what Stagehand "saw" on pages where structured extraction returned 0 posts.
- **Output corpus**: Markdown posts live under `data/paul-chek-blog/{doctor-slug}/`, each with YAML front matter suitable for ingestion into RAG or other indexing pipelines.
