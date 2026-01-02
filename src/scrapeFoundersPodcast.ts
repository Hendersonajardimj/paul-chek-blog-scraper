import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod/v3";
import fs from "fs-extra";
import path from "path";
import { initDb, upsertPost, PostRecord, getExistingPostUrls } from "./db";

const OUTPUT_ROOT = path.join(process.cwd(), "data", "founders-podcast");
const BASE_URL = "https://podscripts.co/podcasts/founders/";
const SOURCE = "founders-podcast";

// Schema for listing page - this is the ONLY LLM extraction we do
const EpisodeSummarySchema = z.object({
  url: z.string(),
  title: z.string(),
  episodeNumber: z.number().optional(),
  date: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
});

const EpisodeListSchema = z.object({
  episodes: z.array(EpisodeSummarySchema),
  nextPageUrl: z.string().nullable().optional(),
});

type EpisodeListResult = z.infer<typeof EpisodeListSchema>;
type EpisodeSummary = z.infer<typeof EpisodeSummarySchema>;

type EpisodeDetail = EpisodeSummary & {
  slug: string;
  transcript: string;
};

type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
};

type RunStats = {
  pagesVisited: number;
  episodesDiscovered: number;
  episodesSaved: number;
  episodesFailed: number;
  llmCalls: number;
};

type RunStatus = "run-start" | "run-complete" | "run-aborted";

type RunReport = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  stagehandSessionId?: string;
  status?: RunStatus;
  source: string;
  config: {
    maxPages: number;
    stagehandModel: string;
  };
  totals: RunStats;
  tokenUsage: TokenUsage;
  errors: Record<string, number>;
};

function getEnvConfig() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  const model = process.env.STAGEHAND_MODEL || "google/gemini-2.5-flash";

  if (!apiKey || !projectId) {
    throw new Error(
      "Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID in environment. Please configure .env first."
    );
  }

  const maxPagesRaw = process.env.MAX_PAGES_FOUNDERS ?? "25";
  const maxPages = Number.parseInt(maxPagesRaw, 10);
  const maxPagesPerRun = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 25;

  return { apiKey, projectId, model, maxPages: maxPagesPerRun };
}

function yamlEscape(value: string): string {
  const trimmed = value.replace(/\r?\n/g, " ").trim();
  if (trimmed === "") return '""';
  if (/[:"'-]/.test(trimmed)) {
    const escaped = trimmed.replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return trimmed;
}

async function writeEpisodeMarkdown(episode: EpisodeDetail): Promise<string> {
  await fs.ensureDir(OUTPUT_ROOT);

  const safeSlug = episode.slug || "untitled";
  const filePath = path.join(OUTPUT_ROOT, `${safeSlug}.md`);

  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: ${yamlEscape(episode.title)}`);
  lines.push(`url: ${yamlEscape(episode.url)}`);
  if (episode.episodeNumber !== undefined) {
    lines.push(`episode_number: ${episode.episodeNumber}`);
  }
  if (episode.date) {
    lines.push(`date: ${yamlEscape(episode.date)}`);
  }
  if (episode.category) {
    lines.push(`category: ${yamlEscape(episode.category)}`);
  }
  if (episode.description) {
    lines.push(`description: ${yamlEscape(episode.description)}`);
  }
  lines.push(`source: ${SOURCE}`);
  lines.push("---");
  lines.push("");
  lines.push(episode.transcript);

  await fs.writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}

function slugFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, "https://podscripts.co");
    const segments = u.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last) return null;
    return last.toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
  } catch {
    return null;
  }
}

function isValidUrl(url: string | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/^\d+(-\d+)?$/.test(trimmed)) return false; // Element ID, not URL
  return trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("/");
}

function normalizeUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  try {
    const base = new URL(BASE_URL);
    return new URL(url, base.origin).href;
  } catch {
    return url;
  }
}

function normalizeDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(raw)) {
    return raw;
  }

  const withoutOrdinals = raw.replace(/(\d+)(st|nd|rd|th)/gi, "$1");

  const monthNames = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];

  const match = withoutOrdinals.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i
  );

  if (match) {
    const monthName = match[1].toLowerCase();
    const day = Number.parseInt(match[2], 10);
    const year = Number.parseInt(match[3], 10);

    const monthIndex = monthNames.indexOf(monthName);
    if (monthIndex !== -1 && day >= 1 && day <= 31) {
      const month = String(monthIndex + 1).padStart(2, "0");
      const dayStr = String(day).padStart(2, "0");
      return `${year}-${month}-${dayStr}`;
    }
  }

  const asDate = new Date(withoutOrdinals);
  if (!Number.isNaN(asDate.getTime())) {
    const year = asDate.getUTCFullYear();
    const month = String(asDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(asDate.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return null;
}

function isStagehandSessionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "StagehandServerError") {
    if (
      /session has completed or timed out/i.test(err.message) ||
      /Cannot connect to session/i.test(err.message)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Log token usage from Stagehand metrics
 */
async function logTokenUsage(stagehand: Stagehand, runReport: RunReport, context: string): Promise<void> {
  try {
    const metrics = await stagehand.metrics;
    if (metrics) {
      const usage = (metrics as any).usage || (metrics as any).tokenUsage || {};
      const prompt = usage.prompt_tokens || usage.promptTokens || usage.input_tokens || 0;
      const completion = usage.completion_tokens || usage.completionTokens || usage.output_tokens || 0;
      const cached = usage.cached_input_tokens || usage.cachedInputTokens || 0;

      runReport.tokenUsage.promptTokens += prompt;
      runReport.tokenUsage.completionTokens += completion;
      runReport.tokenUsage.totalTokens += (prompt + completion);
      if (cached > 0) {
        runReport.tokenUsage.cachedInputTokens = (runReport.tokenUsage.cachedInputTokens || 0) + cached;
      }

      console.log(`  TOKEN_USAGE context=${context} prompt=${prompt} completion=${completion} cached=${cached} runningTotal=${runReport.tokenUsage.totalTokens}`);
    }
  } catch (err) {
    // Metrics may not always be available
  }
}

/**
 * Extract episode list using DOM - no LLM needed!
 * This is the primary method to avoid LLM returning element IDs instead of URLs.
 */
async function extractEpisodeListFromDOM(page: any): Promise<EpisodeListResult> {
  console.log(`  [DOM] Extracting episode list directly from page...`);
  const start = Date.now();

  try {
    const result = await page.evaluate(() => {
      const episodes: Array<{
        url: string;
        title: string;
        episodeNumber?: number;
        date?: string;
        description?: string;
        category?: string;
      }> = [];

      // Find all episode links - they follow pattern /podcasts/founders/{slug}
      const links = document.querySelectorAll('a[href*="/podcasts/founders/"]');
      const seenUrls = new Set<string>();

      for (const link of links) {
        const href = link.getAttribute('href');
        if (!href) continue;

        // Skip pagination links and the main listing page
        if (href === '/podcasts/founders/' || href === '/podcasts/founders') continue;
        if (href.includes('?page=')) continue;

        // Must be an episode link
        if (!href.match(/\/podcasts\/founders\/[a-z0-9-]+/i)) continue;

        // Dedupe
        if (seenUrls.has(href)) continue;
        seenUrls.add(href);

        // Get title from link text or nearby heading
        let title = link.textContent?.trim() || '';

        // If title is empty or too short, look for nearby title element
        if (title.length < 5) {
          const parent = link.closest('article, div, li');
          if (parent) {
            const heading = parent.querySelector('h1, h2, h3, h4, h5');
            if (heading) {
              title = heading.textContent?.trim() || title;
            }
          }
        }

        // Extract episode number from title
        let episodeNumber: number | undefined;
        const numMatch = title.match(/^#?(\d+)/);
        if (numMatch) {
          episodeNumber = parseInt(numMatch[1], 10);
        }

        // Try to find date
        let date: string | undefined;
        const parent = link.closest('article, div, li');
        if (parent) {
          // Look for date patterns in text
          const text = parent.textContent || '';
          const dateMatch = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i);
          if (dateMatch) {
            date = dateMatch[0];
          }
        }

        // Try to find description
        let description: string | undefined;
        if (parent) {
          const descEl = parent.querySelector('p, .description, [class*="desc"]');
          if (descEl) {
            description = descEl.textContent?.trim().slice(0, 200);
          }
        }

        // Try to find category
        let category: string | undefined;
        if (parent) {
          const catEl = parent.querySelector('.category, [class*="category"], .tag, [class*="tag"]');
          if (catEl) {
            category = catEl.textContent?.trim();
          }
        }

        if (title) {
          episodes.push({
            url: href,
            title,
            episodeNumber,
            date,
            description,
            category,
          });
        }
      }

      // Check for next page link
      let nextPageUrl: string | null = null;
      const paginationLinks = document.querySelectorAll('a[href*="?page="]');
      for (const link of paginationLinks) {
        const href = link.getAttribute('href');
        const text = link.textContent?.toLowerCase() || '';
        if (href && (text.includes('next') || text.includes('›') || text.includes('>'))) {
          nextPageUrl = href;
          break;
        }
      }

      return { episodes, nextPageUrl };
    });

    const durationMs = Date.now() - start;
    console.log(`  [DOM] Extracted ${result.episodes.length} episodes in ${durationMs}ms (NO LLM tokens used!)`);

    return result;
  } catch (err) {
    console.error(`  [DOM] Error extracting episode list:`, err instanceof Error ? err.message : err);
    return { episodes: [], nextPageUrl: null };
  }
}

/**
 * Extract episode list using LLM - fallback if DOM extraction fails
 * One LLM call per page (not per episode!)
 */
async function extractEpisodeListWithLLM(
  stagehand: Stagehand,
  page: any,
  pageUrl: string,
  runReport: RunReport
): Promise<EpisodeListResult> {
  // Explicit instruction to prevent element ID extraction
  const instruction = `Extract all podcast episodes from this listing page.

CRITICAL: For each episode, you MUST extract the ACTUAL href attribute from the link element, NOT an internal element ID or node number.
- The URL must be a real web URL starting with "/" or "http"
- Example of a CORRECT url: "/podcasts/founders/408-how-to-make-a-few-more-billion-dollars-brad-jacobs"
- Example of an INCORRECT url: "343" or "4-1332" (these are element IDs, NOT URLs - DO NOT return these!)

For each episode, extract:
- url: The actual href attribute from the <a> link element. MUST start with "/" or "http".
- title: Episode title text
- episodeNumber: Number from title if present (optional)
- date: Episode date string (optional)
- description: Short description text (optional)
- category: Category tag like "Business" (optional)

Also extract nextPageUrl: The href of the "next page" or pagination link, or null if this is the last page.`;

  console.log(`  [LLM] Extracting episode list from ${pageUrl} ...`);
  runReport.totals.llmCalls += 1;

  const start = Date.now();
  try {
    const extraction = await stagehand.extract(instruction, EpisodeListSchema, { page });
    const durationMs = Date.now() - start;
    console.log(`  [LLM] Extraction completed in ${durationMs}ms`);

    await logTokenUsage(stagehand, runReport, `list:${pageUrl}`);

    const parsed = EpisodeListSchema.safeParse(extraction);
    if (parsed.success) {
      return parsed.data;
    }

    // Fallback parsing
    const obj: any = extraction ?? {};
    const episodesRaw = Array.isArray(obj.episodes) ? obj.episodes : [];
    const episodes = episodesRaw
      .map((e: any) => {
        if (!e || typeof e !== "object") return null;
        if (typeof e.url !== "string" || typeof e.title !== "string") return null;
        return {
          url: e.url,
          title: e.title,
          episodeNumber: typeof e.episodeNumber === "number" ? e.episodeNumber : undefined,
          date: typeof e.date === "string" ? e.date : undefined,
          description: typeof e.description === "string" ? e.description : undefined,
          category: typeof e.category === "string" ? e.category : undefined,
        };
      })
      .filter((e): e is EpisodeSummary => e !== null);

    return {
      episodes,
      nextPageUrl: typeof obj.nextPageUrl === "string" ? obj.nextPageUrl : null
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    console.error(`  [LLM] Extraction failed after ${durationMs}ms:`, err instanceof Error ? err.message : err);
    throw err;
  }
}

/**
 * Main extraction function: tries DOM first, falls back to LLM if needed.
 * DOM extraction is more reliable (no element ID issues) and uses zero LLM tokens.
 */
async function extractEpisodeList(
  stagehand: Stagehand,
  page: any,
  pageUrl: string,
  runReport: RunReport
): Promise<EpisodeListResult> {
  // Try DOM extraction first - it's more reliable and uses no LLM tokens
  const domResult = await extractEpisodeListFromDOM(page);

  // If DOM extraction found episodes, use it
  if (domResult.episodes.length > 0) {
    // Validate that URLs look correct
    const validEpisodes = domResult.episodes.filter(ep => isValidUrl(ep.url));
    if (validEpisodes.length > 0) {
      console.log(`  [DOM] Using DOM extraction result (${validEpisodes.length} valid episodes)`);
      return { episodes: validEpisodes, nextPageUrl: domResult.nextPageUrl };
    }
  }

  // Fallback to LLM extraction if DOM failed
  console.log(`  [DOM] DOM extraction found 0 episodes, falling back to LLM...`);
  return extractEpisodeListWithLLM(stagehand, page, pageUrl, runReport);
}

/**
 * Extract transcript directly from DOM using page.evaluate() - NO LLM!
 * This is the key optimization: transcripts are already plain text on the page.
 */
async function extractTranscriptFromDOM(page: any, episodeUrl: string): Promise<string> {
  console.log(`  [DOM] Extracting transcript directly from page...`);
  const start = Date.now();

  try {
    // Use page.evaluate to run JavaScript directly in the browser
    // This extracts transcript text without any LLM calls
    const transcript = await page.evaluate(() => {
      // Strategy 1: Look for transcript container by common patterns
      const transcriptSelectors = [
        '[class*="transcript"]',
        '[id*="transcript"]',
        '[data-transcript]',
        '.episode-transcript',
        '.podcast-transcript',
        '#transcript',
      ];

      for (const selector of transcriptSelectors) {
        const el = document.querySelector(selector);
        if (el && el.textContent && el.textContent.length > 1000) {
          return el.textContent.trim();
        }
      }

      // Strategy 2: Look for content with "Starting point is" timestamps
      const allText = document.body.innerText;
      const startMatch = allText.indexOf("Starting point is");
      if (startMatch !== -1) {
        // Find the transcript section
        const transcriptStart = allText.lastIndexOf("\n", startMatch);
        const mainContent = allText.slice(transcriptStart !== -1 ? transcriptStart : startMatch);

        // Remove common footer/nav patterns
        const footerPatterns = [
          /Related Episodes/i,
          /Subscribe to/i,
          /Follow us/i,
          /© \d{4}/,
          /Privacy Policy/i,
          /Terms of Service/i,
        ];

        let cleanedContent = mainContent;
        for (const pattern of footerPatterns) {
          const match = cleanedContent.search(pattern);
          if (match !== -1 && match > cleanedContent.length * 0.7) {
            cleanedContent = cleanedContent.slice(0, match);
          }
        }

        return cleanedContent.trim();
      }

      // Strategy 3: Get main content area
      const mainSelectors = ['main', 'article', '[role="main"]', '.content', '#content'];
      for (const selector of mainSelectors) {
        const el = document.querySelector(selector);
        if (el && el.textContent && el.textContent.length > 2000) {
          return el.textContent.trim();
        }
      }

      // Fallback: return body text (will be cleaned up)
      return document.body.innerText || "";
    });

    const durationMs = Date.now() - start;
    const charCount = transcript?.length || 0;
    console.log(`  [DOM] Extracted ${charCount} chars in ${durationMs}ms (NO LLM tokens used!)`);

    return transcript || "";
  } catch (err) {
    console.error(`  [DOM] Error extracting transcript:`, err instanceof Error ? err.message : err);
    return "";
  }
}

/**
 * Clean up extracted transcript text
 */
function cleanTranscript(raw: string): string {
  if (!raw) return "";

  // Remove excessive whitespace
  let cleaned = raw.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.replace(/[ \t]+/g, " ");

  // Remove common header/nav text
  const headerPatterns = [
    /^.*?(TRANSCRIPT|Starting point is)/is,
  ];

  for (const pattern of headerPatterns) {
    const match = cleaned.match(pattern);
    if (match && match.index !== undefined) {
      const startIdx = cleaned.indexOf("Starting point is");
      if (startIdx !== -1) {
        cleaned = cleaned.slice(startIdx);
      }
    }
  }

  return cleaned.trim();
}

async function scrapeAllPages(
  stagehand: Stagehand,
  maxPages: number,
  seenUrls: Set<string>,
  runReport: RunReport,
  runId: string
): Promise<number> {
  let totalNew = 0;
  let pageNum = 1;
  let currentUrl: string | null = BASE_URL;
  let sessionHealthy = true;

  const context = stagehand.context;
  const pageInstance = await context.newPage(currentUrl);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  while (currentUrl && pageNum <= maxPages && sessionHealthy) {
    console.log(`\n[Founders Podcast] Page ${pageNum} -> ${currentUrl}`);

    if (pageNum > 1) {
      await pageInstance.goto(currentUrl);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    runReport.totals.pagesVisited += 1;

    try {
      // ONE LLM call per page to get episode list
      const result = await extractEpisodeList(stagehand, pageInstance, currentUrl, runReport);
      console.log(`  Found ${result.episodes.length} episodes on page`);

      runReport.totals.episodesDiscovered += result.episodes.length;

      let newThisPage = 0;

      for (const summary of result.episodes) {
        if (!sessionHealthy) break;

        if (!isValidUrl(summary.url)) {
          console.log(`    Skipping invalid URL: ${summary.url}`);
          continue;
        }

        const normalizedUrl = normalizeUrl(summary.url);
        const slug = slugFromUrl(normalizedUrl);

        if (seenUrls.has(normalizedUrl)) {
          console.log(`    Skipping already-seen: ${slug}`);
          continue;
        }
        seenUrls.add(normalizedUrl);

        console.log(`    Processing: ${slug}`);

        try {
          // Navigate to episode page
          await pageInstance.goto(normalizedUrl);
          await new Promise((resolve) => setTimeout(resolve, 1500));

          // Extract transcript using DOM - NO LLM CALL!
          const rawTranscript = await extractTranscriptFromDOM(pageInstance, normalizedUrl);
          const transcript = cleanTranscript(rawTranscript);

          if (!transcript || transcript.length < 500) {
            console.warn(`    Warning: Short/empty transcript (${transcript.length} chars)`);
            runReport.totals.episodesFailed += 1;
            continue;
          }

          // Build episode detail using metadata from listing + DOM transcript
          const normalizedDate = normalizeDate(summary.date ?? null);

          // Extract episode number from title if not present
          let episodeNumber = summary.episodeNumber;
          if (episodeNumber === undefined) {
            const numMatch = summary.title.match(/^#?(\d+)/);
            if (numMatch) {
              episodeNumber = parseInt(numMatch[1], 10);
            }
          }

          const detail: EpisodeDetail = {
            slug: slug || "untitled",
            url: normalizedUrl,
            title: summary.title,
            episodeNumber,
            date: normalizedDate ?? summary.date,
            description: summary.description,
            category: summary.category,
            transcript,
          };

          // Save to database
          const postRecord: PostRecord = {
            url: detail.url,
            slug: detail.slug,
            title: detail.title,
            datePublished: detail.date ?? null,
            doctorSection: detail.category ?? "founders-podcast",
            categories: detail.category ? [detail.category] : [],
            tags: episodeNumber !== undefined ? [`episode-${episodeNumber}`] : [],
            markdown: detail.transcript,
            source: SOURCE,
          };

          await upsertPost(postRecord);
          const filePath = await writeEpisodeMarkdown(detail);
          newThisPage++;
          runReport.totals.episodesSaved += 1;
          console.log(`    Saved: ${filePath} (${transcript.length} chars)`);

        } catch (err) {
          if (isStagehandSessionError(err)) {
            console.error(`    Session error, stopping: ${err instanceof Error ? err.message : err}`);
            sessionHealthy = false;
            break;
          }
          console.error(`    Error processing ${slug}:`, err instanceof Error ? err.message : err);
          runReport.totals.episodesFailed += 1;
          runReport.errors[err instanceof Error ? err.name : "UnknownError"] =
            (runReport.errors[err instanceof Error ? err.name : "UnknownError"] ?? 0) + 1;
        }
      }

      totalNew += newThisPage;
      console.log(`  Page ${pageNum} complete: ${newThisPage} new episodes saved`);

      // Always use sequential pagination - LLM nextPageUrl is unreliable
      // Stop if we found no episodes on this page (likely past the last page)
      if (result.episodes.length === 0) {
        console.log(`  No episodes found on page ${pageNum}, stopping pagination`);
        break;
      }

      pageNum += 1;
      currentUrl = `${BASE_URL}?page=${pageNum}`;

    } catch (err) {
      console.error(`  Error on page ${pageNum}:`, err instanceof Error ? err.message : err);
      if (isStagehandSessionError(err)) {
        sessionHealthy = false;
      }
      runReport.errors[err instanceof Error ? err.name : "UnknownError"] =
        (runReport.errors[err instanceof Error ? err.name : "UnknownError"] ?? 0) + 1;
      break;
    }
  }

  return totalNew;
}

function createRunId(maxPages: number): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `founders-${y}${m}${d}-${hh}${mm}${ss}-p${maxPages}`;
}

async function appendRunLogEntry(
  reportsRoot: string,
  runReport: RunReport,
  status: string
): Promise<void> {
  try {
    const runsLogPath = path.join(reportsRoot, "runs.log");
    const entry = {
      runId: runReport.runId,
      timestamp: new Date().toISOString(),
      stagehandSessionId: runReport.stagehandSessionId,
      source: runReport.source,
      status,
      config: runReport.config,
      totals: runReport.totals,
      tokenUsage: runReport.tokenUsage,
      errors: runReport.errors,
    };

    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(runsLogPath, line, "utf8");
    console.log("Appended runs.log entry:", runsLogPath);
  } catch (err) {
    console.warn("Failed to append runs.log entry:", err);
  }
}

async function main() {
  const { apiKey, projectId, model, maxPages } = getEnvConfig();

  console.log("=".repeat(60));
  console.log("OPTIMIZED Founders Podcast Scraper");
  console.log("=".repeat(60));
  console.log(`Max pages: ${maxPages}`);
  console.log(`Model: ${model} (fallback only)`);
  console.log("");
  console.log("OPTIMIZATION: Using direct DOM extraction for BOTH:");
  console.log("              - Listing pages (episode URLs)");
  console.log("              - Episode pages (transcripts)");
  console.log("              LLM only used as fallback if DOM extraction fails");
  console.log("              Expected: ZERO LLM calls in most cases!");
  console.log("=".repeat(60));

  await initDb();

  const runId = createRunId(maxPages);
  const startedAt = new Date().toISOString();

  const runReport: RunReport = {
    runId,
    startedAt,
    stagehandSessionId: undefined,
    status: "run-start",
    source: SOURCE,
    config: {
      maxPages,
      stagehandModel: model,
    },
    totals: {
      pagesVisited: 0,
      episodesDiscovered: 0,
      episodesSaved: 0,
      episodesFailed: 0,
      llmCalls: 0,
    },
    tokenUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    errors: {},
  };

  const reportsRoot = path.join(process.cwd(), "reports");
  await fs.ensureDir(reportsRoot);

  await appendRunLogEntry(reportsRoot, runReport, "run-start");

  const existingUrls = await getExistingPostUrls(SOURCE);
  console.log(`Loaded ${existingUrls.size} existing episode URLs from database - will skip these.`);

  const seenUrls = new Set<string>(existingUrls);
  let totalNew = 0;
  let scrapeError: unknown = null;

  try {
    const stagehand = new Stagehand({
      env: "BROWSERBASE",
      apiKey,
      projectId,
      model,
      verbose: 1, // Reduced verbosity
      browserbaseSessionCreateParams: {
        timeout: 30 * 60,
        keepAlive: true,
      },
    });

    try {
      await stagehand.init();
      console.log("Stagehand session ID:", stagehand.sessionId);
      if (stagehand.sessionId) {
        runReport.stagehandSessionId = stagehand.sessionId;
      }

      totalNew = await scrapeAllPages(stagehand, maxPages, seenUrls, runReport, runId);

      // Final token usage log
      await logTokenUsage(stagehand, runReport, "final");

      runReport.status = "run-complete";
    } catch (err) {
      console.error("Error during scraping:", err instanceof Error ? err.message : err);
      runReport.status = "run-aborted";
      scrapeError = err;
    } finally {
      try {
        await stagehand.close();
      } catch {
        // ignore close errors
      }
    }
  } catch (err) {
    scrapeError = err;
    runReport.status = "run-aborted";
    console.error("Fatal error during scrape:", err);
  } finally {
    runReport.finishedAt = new Date().toISOString();

    console.log("\n" + "=".repeat(60));
    console.log("RUN SUMMARY");
    console.log("=".repeat(60));
    console.log(`Status: ${runReport.status}`);
    console.log(`Pages visited: ${runReport.totals.pagesVisited}`);
    console.log(`Episodes discovered: ${runReport.totals.episodesDiscovered}`);
    console.log(`Episodes saved: ${runReport.totals.episodesSaved}`);
    console.log(`Episodes failed: ${runReport.totals.episodesFailed}`);
    console.log(`LLM calls: ${runReport.totals.llmCalls}`);
    console.log(`Total tokens: ${runReport.tokenUsage.totalTokens}`);
    console.log(`  Prompt tokens: ${runReport.tokenUsage.promptTokens}`);
    console.log(`  Completion tokens: ${runReport.tokenUsage.completionTokens}`);
    if (runReport.tokenUsage.cachedInputTokens) {
      console.log(`  Cached input tokens: ${runReport.tokenUsage.cachedInputTokens}`);
    }
    console.log("=".repeat(60));

    console.log(
      `RUN_SUMMARY runId=${runId} status=${runReport.status} source=${SOURCE} ` +
      `pagesVisited=${runReport.totals.pagesVisited} episodesSaved=${runReport.totals.episodesSaved} ` +
      `llmCalls=${runReport.totals.llmCalls} totalTokens=${runReport.tokenUsage.totalTokens}`
    );

    const summaryDir = path.join(reportsRoot, "summary");
    await fs.ensureDir(summaryDir);

    const summaryPath = path.join(summaryDir, `run-${runId}.json`);
    try {
      await fs.writeFile(summaryPath, JSON.stringify(runReport, null, 2), "utf8");
      console.log("Wrote run summary:", summaryPath);
    } catch (err) {
      console.warn("Failed to write run summary:", err);
    }

    await appendRunLogEntry(reportsRoot, runReport, runReport.status ?? "run-complete");

    console.log(`\nTotal unique episodes saved: ${totalNew}`);
    console.log(`Output directory: ${OUTPUT_ROOT}`);
  }

  if (scrapeError) {
    throw scrapeError;
  }
}

main().catch((err) => {
  console.error("Fatal error in scraper:", err);
  process.exit(1);
});
