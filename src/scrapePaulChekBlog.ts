import './sentry'
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod/v3";
import fs from "fs-extra";
import path from "path";
import { initDb, upsertPost, PostRecord, getExistingPostUrls } from "./db";

const OUTPUT_ROOT = path.join(process.cwd(), "data", "paul-chek-blog");

const CategoryPostSummarySchema = z.object({
  url: z.string(),
  title: z.string(),
  date: z.string().optional(),
  categories: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

const CategoryPageSchema = z.object({
  posts: z.array(CategoryPostSummarySchema),
  // Allow any string (absolute or relative) or null; we'll normalize later.
  nextPageUrl: z.string().nullable().optional(),
});

const PostDetailSchema = z.object({
  slug: z.string(),
  title: z.string(),
  url: z.string(),
  date: z.string().optional(),
  doctorSection: z.string(),
  categories: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  markdown: z.string(),
});

type CategoryPageResult = z.infer<typeof CategoryPageSchema>;
type PostDetail = z.infer<typeof PostDetailSchema>;

type Section = {
  name: string;
  slug: string;
  baseUrl: string;
};

type SectionRunStats = {
  pagesVisited: number;
  postsDiscovered: number;
  postsSaved: number;
  postsFailed: number;
};

type RunStatus = "run-start" | "run-complete" | "run-aborted";

type SectionStatus = "pending" | "section-complete" | "session-failed";

type RunReport = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  stagehandSessionId?: string;
  status?: RunStatus;
  config: {
    maxPagesPerSection: number;
    stagehandModel: string;
  };
  totals: {
    sectionsVisited: number;
    categoryPagesVisited: number;
    postsDiscovered: number;
    postsSaved: number;
    postsFailed: number;
  };
  sections: Record<string, SectionRunStats>;
  sectionStatus: Record<string, SectionStatus>;
  errors: Record<string, number>;
};

const SECTIONS: Section[] = [
  {
    name: "Dr. Diet",
    slug: "dr-diet",
    baseUrl: "https://www.paulcheksblog.com/category/diet/",
  },
  {
    name: "Dr. Quiet",
    slug: "dr-quiet",
    baseUrl: "https://www.paulcheksblog.com/category/quiet/",
  },
  {
    name: "Dr. Movement",
    slug: "dr-movement",
    baseUrl: "https://www.paulcheksblog.com/category/movement/",
  },
  {
    name: "Dr. Happiness",
    slug: "dr-happiness",
    baseUrl: "https://www.paulcheksblog.com/category/happiness/",
  },
];

function getEnvConfig() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  const model = process.env.STAGEHAND_MODEL || "google/gemini-2.5-flash";

  if (!apiKey || !projectId) {
    throw new Error(
      "Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID in environment. Please configure .env first."
    );
  }

  const maxPagesRaw = process.env.MAX_PAGES_PER_SECTION ?? "10";
  const maxPages = Number.parseInt(maxPagesRaw, 10);
  const maxPagesPerSection = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 10;

  return { apiKey, projectId, model, maxPagesPerSection };
}

function buildPageUrl(section: Section, page: number): string {
  if (page <= 1) return section.baseUrl;
  return `${section.baseUrl}page/${page}/`;
}

function yamlEscape(value: string): string {
  const trimmed = value.replace(/\r?\n/g, " ").trim();
  if (trimmed === "") return "\"\"";
  if (/[:"'-]/.test(trimmed)) {
    // Prefer double quotes and escape existing ones
    const escaped = trimmed.replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return trimmed;
}

async function writePostMarkdown(section: Section, post: PostDetail): Promise<string> {
  const sectionDir = path.join(OUTPUT_ROOT, section.slug);
  await fs.ensureDir(sectionDir);

  const safeSlug = post.slug || slugFromUrl(post.url) || "untitled";
  const filePath = path.join(sectionDir, `${safeSlug}.md`);

  const categories = post.categories ?? [];
  const tags = post.tags ?? [];

  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: ${yamlEscape(post.title)}`);
  lines.push(`url: ${yamlEscape(post.url)}`);
  if (post.date) {
    lines.push(`date: ${yamlEscape(post.date)}`);
  }
  lines.push(`doctor_section: ${yamlEscape(section.slug)}`);

  lines.push("categories:");
  if (categories.length === 0) {
    // still emit an empty array for clarity
    // YAML empty list representation
  }
  for (const c of categories) {
    lines.push(`  - ${yamlEscape(c)}`);
  }

  lines.push("tags:");
  for (const t of tags) {
    lines.push(`  - ${yamlEscape(t)}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(post.markdown);

  await fs.writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}

function slugFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last) return null;
    return last.toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
  } catch {
    return null;
  }
}

/**
 * Validates that a URL is an actual web URL, not an element ID.
 * Returns true for:
 *   - Absolute URLs (http:// or https://)
 *   - Relative paths starting with /
 * Returns false for:
 *   - Element IDs like "0-346"
 *   - Empty strings
 *   - Other non-URL strings
 */
function isValidPostUrl(url: string | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;

  // Absolute URL
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return true;
  }

  // Relative path (must start with /)
  if (trimmed.startsWith("/")) {
    return true;
  }

  return false;
}

/**
 * Normalizes a URL to absolute form using the blog's base domain.
 */
function normalizePostUrl(url: string, baseUrl: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  // Relative URL - combine with base
  try {
    const base = new URL(baseUrl);
    return new URL(url, base.origin).href;
  } catch {
    return url;
  }
}

/**
 * Checks if a pagination URL looks like an element ID instead of a real URL.
 * Element IDs from the LLM extraction often look like: "0-35378", "5", "2-9", etc.
 * Real pagination URLs should contain "/page/" or be proper paths.
 */
function isValidPaginationUrl(url: string | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;

  // Check for element ID patterns (digits with optional hyphen-digits)
  // These look like: "0-35378", "5", "2-9", etc.
  if (/^\d+(-\d+)?$/.test(trimmed)) {
    return false;
  }

  // Must be absolute URL or start with /
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("/")
  ) {
    return true;
  }

  return false;
}

/**
 * Normalize a human-readable blog date (e.g. "December 26th, 2025") into
 * an ISO-compatible string Postgres can parse (YYYY-MM-DD).
 *
 * If the input already looks like an ISO date (YYYY-MM-DD or
 * YYYY-MM-DDTHH:MM:SSZ), it is returned as-is.
 *
 * Returns null if the date cannot be parsed.
 */
function normalizeDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  // If it's already ISO-like, trust it.
  if (/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(raw)) {
    return raw;
  }

  // Strip ordinal suffixes from the day portion: 1st -> 1, 2nd -> 2, etc.
  const withoutOrdinals = raw.replace(/(\d+)(st|nd|rd|th)/gi, "$1");

  // Try to parse formats like "December 26, 2025".
  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
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

  // Fallback: rely on Date parsing as a last resort.
  const asDate = new Date(withoutOrdinals);
  if (!Number.isNaN(asDate.getTime())) {
    const year = asDate.getUTCFullYear();
    const month = String(asDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(asDate.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  console.warn("  Warning: could not normalize date:", input);
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

function logExtractMetric(params: {
  runId: string;
  sectionSlug: string;
  kind: "category" | "post" | "debug";
  url: string;
  durationMs: number;
  status: "ok" | "error";
  errorType?: string;
  sessionError?: boolean;
}): void {
  const { runId, sectionSlug, kind, url, durationMs, status, errorType, sessionError } = params;
  const parts = [
    "EXTRACT_METRIC",
    `runId=${runId}`,
    `section=${sectionSlug}`,
    `kind=${kind}`,
    `url=${url}`,
    `durationMs=${durationMs}`,
    `status=${status}`,
  ];
  if (errorType) parts.push(`errorType=${errorType}`);
  if (typeof sessionError === "boolean") parts.push(`sessionError=${sessionError}`);
  console.log(parts.join(" "));
}

async function extractCategoryPage(
  stagehand: Stagehand,
  page: any,
  section: Section,
  pageUrl: string,
  runId: string
): Promise<CategoryPageResult> {
  const instruction = `You are on a Paul Chek blog category page for the '${section.name}' Doctor section (URL: ${pageUrl}).
On THIS PAGE ONLY (do not click through to other category pages or archives):
- Identify every item that looks like a blog entry, article, or podcast episode in the main content area.
- The layout and visual treatment may differ between Doctor sections (Dr. Diet, Dr. Quiet, Dr. Movement, Dr. Happiness). Do NOT rely on specific CSS classes or grid positions. Instead, use the page semantics: post-like cards or list items with a title that links to a detail page.

CRITICAL: For each post, you MUST extract the ACTUAL href attribute from the link element, NOT an internal element ID.
- The URL must be a real web URL starting with "http://" or "https://" or a path starting with "/".
- Example of a CORRECT url: "https://www.paulcheksblog.com/water-as-medicine-with-isabel-friend/"
- Example of an INCORRECT url: "0-346" (this is an element ID, NOT a URL)

For each post-like item on this category page, return:
  - url: The href attribute of the link to the post detail page. This MUST be an actual URL (absolute like "https://..." or relative like "/post-slug/"), NOT an element identifier.
  - title: The post title text.
  - date: (optional) The published date as a string, if visible.
  - categories: (optional) Array of category names.
  - tags: (optional) Array of tag names.

CRITICAL - Pagination Detection:
- Look at the BOTTOM of the main content area for pagination controls.
- The pagination typically shows: "Previous", page numbers (1, 2, 3...), and "Next" links.
- If you see a "Next" link OR a page number higher than the current page, there ARE more pages.
- Extract the href from the "Next" link as nextPageUrl.
- The Next link URL typically looks like: /category/diet/page/2/ or https://www.paulcheksblog.com/category/diet/page/2/
- ONLY return null for nextPageUrl if there is definitively NO "Next" link and NO higher page numbers visible.
- When in doubt, extract the next sequential page URL.

Return a single JSON object with:
- posts: an array of post summary objects as described above
- nextPageUrl: a string URL (absolute or relative) for the next page, or null ONLY if this is definitively the last page.`;

  console.log(`  Extracting category page data for ${pageUrl} ...`);

  const start = Date.now();
  let extraction: unknown;
  try {
    extraction = await stagehand.extract(
      instruction,
      CategoryPageSchema,
      { page }
    );
    const durationMs = Date.now() - start;
    logExtractMetric({
      runId,
      sectionSlug: section.slug,
      kind: "category",
      url: pageUrl,
      durationMs,
      status: "ok",
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    const sessionError = isStagehandSessionError(err);
    const errorType = err instanceof Error ? err.name || "Error" : "UnknownError";
    logExtractMetric({
      runId,
      sectionSlug: section.slug,
      kind: "category",
      url: pageUrl,
      durationMs,
      status: "error",
      errorType,
      sessionError,
    });
    throw err;
  }

  const parsed = CategoryPageSchema.safeParse(extraction);
  if (parsed.success) {
    return parsed.data;
  }

  console.warn(
    "  CategoryPageSchema validation failed for",
    pageUrl,
    "issues:",
    parsed.error.issues
  );

  // Best-effort fallback to avoid losing all posts due to minor schema mismatches
  // (e.g., relative nextPageUrl).
  const obj: any = extraction ?? {};

  const postsRaw = Array.isArray(obj.posts) ? obj.posts : [];
  const posts = postsRaw
    .map((p: any) => {
      if (!p || typeof p !== "object") return null;
      if (typeof p.url !== "string" || typeof p.title !== "string") {
        return null;
      }
      return {
        url: p.url,
        title: p.title,
        date: typeof p.date === "string" ? p.date : undefined,
        categories: Array.isArray(p.categories)
          ? p.categories.filter((c: unknown) => typeof c === "string")
          : undefined,
        tags: Array.isArray(p.tags)
          ? p.tags.filter((t: unknown) => typeof t === "string")
          : undefined,
      };
    })
    .filter((p): p is CategoryPageResult["posts"][number] => p !== null);

  let nextPageUrl: string | null = null;
  if (typeof obj.nextPageUrl === "string") {
    nextPageUrl = obj.nextPageUrl;
  } else if (typeof obj.next === "string") {
    // Some models might pick a slightly different property name.
    nextPageUrl = obj.next;
  }

  const fallback: CategoryPageResult = {
    posts,
    nextPageUrl,
  };

  console.warn("  Using fallback CategoryPageResult for", pageUrl);
  return fallback;
}

async function extractPostDetail(
  stagehand: Stagehand,
  page: any,
  postUrl: string,
  section: Section,
  runId: string
): Promise<PostDetail> {
  const instruction = `You are on a single Paul Chek blog post page (URL: ${postUrl}).
Extract exactly one object for the main blog post on this page with:
- slug: a URL-safe slug based on the post URL path (use the last non-empty path segment)
- title: the blog post title
- url: the absolute URL of this post
- date: the published date if visible, as a string
- doctorSection: the doctor section identifier (use "${section.slug}")
- categories: a list of category names shown for this post (if any)
- tags: a list of tag names shown for this post (if any)
- markdown: the main article content converted to Markdown, excluding global headers, footers, sidebars, and subscription boxes.

Return only this JSON object matching the schema.`;

  console.log(`  Extracting post detail with Stagehand from ${postUrl} ...`);

  let raw: unknown;
  const start = Date.now();
  try {
    raw = await stagehand.extract(
      instruction,
      PostDetailSchema,
      { page }
    );
    const durationMs = Date.now() - start;
    logExtractMetric({
      runId,
      sectionSlug: section.slug,
      kind: "post",
      url: postUrl,
      durationMs,
      status: "ok",
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    const sessionError = isStagehandSessionError(err);
    const errorType = err instanceof Error ? err.name || "Error" : "UnknownError";
    logExtractMetric({
      runId,
      sectionSlug: section.slug,
      kind: "post",
      url: postUrl,
      durationMs,
      status: "error",
      errorType,
      sessionError,
    });
    console.error("  Stagehand.extract error for post:", postUrl);
    console.error("    Error object:", err);
    throw err;
  }

  const parsed = PostDetailSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn("  PostDetailSchema validation failed for post:", postUrl);
    console.warn("    Issues:", parsed.error.issues);

    const obj: any = raw ?? {};
    const fallback: PostDetail = {
      slug:
        typeof obj.slug === "string"
          ? obj.slug
          : slugFromUrl(obj.url ?? postUrl) ?? slugFromUrl(postUrl) ?? "untitled",
      title:
        typeof obj.title === "string"
          ? obj.title
          : slugFromUrl(postUrl) ?? postUrl,
      url: typeof obj.url === "string" ? obj.url : postUrl,
      date: typeof obj.date === "string" ? obj.date : undefined,
      doctorSection:
        typeof obj.doctorSection === "string"
          ? obj.doctorSection
          : section.slug,
      categories: Array.isArray(obj.categories)
        ? obj.categories.filter((c: unknown) => typeof c === "string")
        : [],
      tags: Array.isArray(obj.tags)
        ? obj.tags.filter((t: unknown) => typeof t === "string")
        : [],
      markdown: typeof obj.markdown === "string" ? obj.markdown : "",
    };

    console.warn("  Using fallback PostDetail for post:", postUrl);
    return fallback;
  }

  return parsed.data;
}

async function scrapeSection(
  stagehand: Stagehand,
  page: any,
  section: Section,
  maxPagesPerSection: number,
  seenUrls: Set<string>,
  runReport: RunReport,
  runId: string
): Promise<number> {
  let totalNew = 0;
  let pageNum = 1;
  let currentUrl: string | null = section.baseUrl;
  let sessionHealthy = true;
  let consecutiveSessionErrors = 0;
  const SESSION_ERROR_POST_THRESHOLD = 3;

  const sectionStats = runReport.sections[section.slug];
  const context = stagehand.context;

  // Create a new page for this section and navigate to the first category page
  const pageInstance = await context.newPage(currentUrl);
  // Give the page time to fully load before extraction
  await new Promise((resolve) => setTimeout(resolve, 3000));

  while (currentUrl && pageNum <= maxPagesPerSection && sessionHealthy) {
    console.log(`\n[${section.name}] Page ${pageNum} -> ${currentUrl}`);

    if (pageNum > 1) {
      await pageInstance.goto(currentUrl);
      // Give the page time to fully load before extraction
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    runReport.totals.categoryPagesVisited += 1;
    sectionStats.pagesVisited += 1;

    try {
      const result = await extractCategoryPage(
        stagehand,
        pageInstance,
        section,
        currentUrl,
        runId
      );
      console.log(`  Extracted ${result.posts.length} post summaries`);

      if (result.posts.length === 0) {
        console.warn(
          `  WARNING: 0 posts extracted for section ${section.slug} on ${currentUrl}. Full extraction result:`,
          JSON.stringify(result, null, 2)
        );

        // Schema-less debug extraction to understand what Stagehand "sees" on
        // this page when no posts are returned. This uses a permissive schema
        // (z.any()) so we can inspect the raw structure without throwing it
        // away due to validation mismatches.
        try {
          const debugInstruction = `DEBUG ONLY: Without enforcing a strict schema, inspect this Paul Chek blog category page (URL: ${currentUrl}).
Return a JSON object describing all blog-like or post-like items you see in the main content area. For each item, include the title text, any link URL, and any nearby date text. Also include a short note on why you considered it post-like.`;

          const debugStart = Date.now();
          const debugPayload = await stagehand.extract(
            debugInstruction,
            z.any(),
            { page: pageInstance }
          );
          const debugDurationMs = Date.now() - debugStart;
          logExtractMetric({
            runId,
            sectionSlug: section.slug,
            kind: "debug",
            url: currentUrl,
            durationMs: debugDurationMs,
            status: "ok",
          });

          const reportsRoot = path.join(process.cwd(), "reports");
          const rawDir = path.join(reportsRoot, "raw");
          await fs.ensureDir(rawDir);
          const debugPath = path.join(
            rawDir,
            `category-debug-${runId}-${section.slug}-p${pageNum}.json`
          );
          await fs.writeFile(
            debugPath,
            JSON.stringify(
              {
                runId,
                section: section.slug,
                pageUrl: currentUrl,
                timestamp: new Date().toISOString(),
                debug: debugPayload,
              },
              null,
              2
            ),
            "utf8"
          );
          console.warn("  Wrote schema-less debug extract to:", debugPath);

          const debugArray = Array.isArray((debugPayload as any))
            ? (debugPayload as any[])
            : Array.isArray((debugPayload as any)?.items)
            ? ((debugPayload as any).items as any[])
            : [];
          const debugPostsCount = debugArray.length;
          console.log(
            `CATEGORY_COVERAGE runId=${runId} section=${section.slug} page=${pageNum} debugPosts=${debugPostsCount} structuredPosts=${result.posts.length}`
          );
        } catch (debugErr) {
          console.warn(
            `CATEGORY_DEBUG_ERROR runId=${runId} section=${section.slug} page=${pageNum} error=${debugErr instanceof Error ? debugErr.message : String(debugErr)}`
          );
        }
      }

      sectionStats.postsDiscovered += result.posts.length;
      runReport.totals.postsDiscovered += result.posts.length;

      let newThisPage = 0;
      let invalidUrlCount = 0;

      for (const summary of result.posts) {
        if (!sessionHealthy) {
          console.warn(
            `    Session marked unhealthy; skipping remaining posts in section ${section.slug}.`
          );
          break;
        }

        // Validate URL before processing
        if (!isValidPostUrl(summary.url)) {
          console.warn(
            `    Skipping invalid URL (likely element ID): ${summary.url}`
          );
          invalidUrlCount++;
          continue;
        }

        // Normalize relative URLs to absolute
        const normalizedUrl = normalizePostUrl(summary.url, section.baseUrl);

        if (seenUrls.has(normalizedUrl)) {
          console.log(`    Skipping already-seen post: ${normalizedUrl}`);
          continue;
        }
        seenUrls.add(normalizedUrl);

        console.log(`    Processing post URL: ${normalizedUrl}`);

        let detail: PostDetail | null = null;
        const maxAttempts = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            console.log(
              `    [Attempt ${attempt}/${maxAttempts}] Extracting post detail with Stagehand...`
            );
            detail = await extractPostDetail(
              stagehand,
              pageInstance,
              normalizedUrl,
              section,
              runId
            );
            // success: reset consecutive session error counter
            consecutiveSessionErrors = 0;
            break;
          } catch (err) {
            const isSessionError = isStagehandSessionError(err);
            const errorType =
              err instanceof Error
                ? err.name || (isSessionError ? "StagehandSessionError" : "Error")
                : "UnknownError";

            runReport.errors[errorType] =
              (runReport.errors[errorType] ?? 0) + 1;

            console.error(
              `    Error on attempt ${attempt} for ${normalizedUrl}:`,
              err instanceof Error ? err.message : err
            );
            console.error("    Full error object:", err);

            if (isSessionError && attempt === maxAttempts) {
              consecutiveSessionErrors += 1;
              console.error(
                `    Stagehand session error persisted for ${normalizedUrl} after ${maxAttempts} attempts. consecutiveSessionErrors=${consecutiveSessionErrors}`
              );
              if (consecutiveSessionErrors >= SESSION_ERROR_POST_THRESHOLD) {
                console.error(
                  `    Detected ${consecutiveSessionErrors} consecutive Stagehand session errors; marking session unhealthy and bailing out of section ${section.slug}.`
                );
                runReport.sectionStatus[section.slug] = "session-failed";
                sessionHealthy = false;
                break;
              }
            }

            if (!isSessionError || attempt === maxAttempts) {
              console.error(
                `    Giving up on post after ${attempt} attempts: ${normalizedUrl}`
              );
              detail = null;
              break;
            }

            const backoffMs = attempt * 1000;
            console.log(
              `    Stagehand session error detected, retrying in ${backoffMs}ms...`
            );
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }
        }

        if (!sessionHealthy) {
          // Stop processing further posts on this page/section.
          break;
        }

        if (!detail) {
          sectionStats.postsFailed += 1;
          runReport.totals.postsFailed += 1;
          continue;
        }

        const normalizedDate = normalizeDate(detail.date ?? null);
        const effectiveDate = normalizedDate ?? detail.date ?? null;
        if (!normalizedDate && detail.date) {
          console.warn(
            `    Warning: using unnormalized date for ${detail.url}:`,
            detail.date
          );
        }

        const postRecord: PostRecord = {
          url: detail.url,
          slug: detail.slug,
          title: detail.title,
          datePublished: effectiveDate,
          doctorSection: detail.doctorSection,
          categories: detail.categories ?? [],
          tags: detail.tags ?? [],
          markdown: detail.markdown,
        };

        await upsertPost(postRecord);
        const filePath = await writePostMarkdown(
          section,
          { ...detail, date: effectiveDate ?? undefined }
        );
        newThisPage++;
        sectionStats.postsSaved += 1;
        runReport.totals.postsSaved += 1;
        console.log(`    Saved: ${filePath}`);
      }

      totalNew += newThisPage;
      console.log(`  New posts this page: ${newThisPage}`);
      if (invalidUrlCount > 0) {
        console.warn(
          `  WARNING: ${invalidUrlCount} posts had invalid URLs (element IDs) and were skipped`
        );
      }

      // Normalize relative pagination URLs to absolute
      // If nextPageUrl is null/invalid but we got posts, try fallback to next sequential page
      const hasValidNextUrl = isValidPaginationUrl(result.nextPageUrl);
      if (result.nextPageUrl && hasValidNextUrl) {
        currentUrl = normalizePostUrl(result.nextPageUrl, section.baseUrl);
      } else if (result.posts.length > 0) {
        // Fallback: try next sequential page number
        const nextPageNum = pageNum + 1;
        const fallbackUrl = `${section.baseUrl}page/${nextPageNum}/`;
        if (result.nextPageUrl && !hasValidNextUrl) {
          console.log(
            `  nextPageUrl "${result.nextPageUrl}" looks like element ID, trying fallback: ${fallbackUrl}`
          );
        } else {
          console.log(`  nextPageUrl was null, trying fallback: ${fallbackUrl}`);
        }
        currentUrl = fallbackUrl;
      } else {
        // No posts and no next page - we're done
        currentUrl = null;
      }
      pageNum += 1;
    } catch (err) {
      console.error(
        `  Error scraping ${section.name} page ${pageNum}:`,
        err instanceof Error ? err.message : err
      );
      console.error("  Full error object:", err);
      if (isStagehandSessionError(err)) {
        console.error(
          `  Detected Stagehand session error while scraping category page; marking session failed for section ${section.slug}.`
        );
        runReport.sectionStatus[section.slug] = "session-failed";
        sessionHealthy = false;
      }
      break;
    }
  }

  return totalNew;
}

function createRunId(maxPagesPerSection: number): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `${y}${m}${d}-${hh}${mm}${ss}-p${maxPagesPerSection}`;
}

async function appendRunLogEntry(
  reportsRoot: string,
  runReport: RunReport,
  status: string,
  sectionSlug?: string
): Promise<void> {
  try {
    const runsLogPath = path.join(reportsRoot, "runs.log");
    const entry: any = {
      runId: runReport.runId,
      timestamp: new Date().toISOString(),
      stagehandSessionId: runReport.stagehandSessionId,
      section: sectionSlug ?? "ALL",
      status,
      config: runReport.config,
      totals: runReport.totals,
      errors: runReport.errors,
    };

    if (sectionSlug) {
      entry.sectionStats = runReport.sections[sectionSlug];
      entry.sectionStatus = runReport.sectionStatus[sectionSlug];
    }

    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(runsLogPath, line, "utf8");
    console.log("Appended runs.log entry:", runsLogPath);
  } catch (err) {
    console.warn("Failed to append runs.log entry:", err);
  }
}

async function writeRunProgressSnapshot(
  reportsRoot: string,
  runReport: RunReport
): Promise<void> {
  try {
    const summaryDir = path.join(reportsRoot, "summary");
    await fs.ensureDir(summaryDir);
    const progressPath = path.join(
      summaryDir,
      `run-${runReport.runId}-progress.json`
    );
    await fs.writeFile(
      progressPath,
      JSON.stringify(runReport, null, 2),
      "utf8"
    );
    console.log("Wrote progress snapshot:", progressPath);
  } catch (err) {
    console.warn("Failed to write progress snapshot:", err);
  }
}

async function writeJsonArtifactWithFallback(
  filePath: string,
  payload: unknown,
  stub: { runId: string; description: string }
): Promise<void> {
  try {
    const json = JSON.stringify(payload, null, 2);
    await fs.writeFile(filePath, json, "utf8");
    console.log("Wrote JSON artifact:", filePath);
  } catch (err) {
    console.warn(
      `Failed to write JSON artifact ${filePath}, attempting stub:`,
      err
    );
    const fallback = {
      runId: stub.runId,
      error: stub.description,
      originalError:
        err instanceof Error ? err.message : typeof err === "string" ? err : String(err),
      type: typeof payload,
    };
    try {
      await fs.writeFile(
        filePath,
        JSON.stringify(fallback, null, 2),
        "utf8"
      );
      console.log("Wrote fallback stub for artifact:", filePath);
    } catch (stubErr) {
      console.warn(
        `Failed to write fallback stub for artifact ${filePath}:`,
        stubErr
      );
    }
  }
}

async function main() {
  const { apiKey, projectId, model, maxPagesPerSection } = getEnvConfig();

  console.log("Starting Paul Chek blog scrape...");
  console.log(`Max pages per section: ${maxPagesPerSection}`);

  await initDb();

  const runId = createRunId(maxPagesPerSection);
  const startedAt = new Date().toISOString();

  const runReport: RunReport = {
    runId,
    startedAt,
    stagehandSessionId: undefined,
    status: "run-start",
    config: {
      maxPagesPerSection,
      stagehandModel: model,
    },
    totals: {
      sectionsVisited: 0,
      categoryPagesVisited: 0,
      postsDiscovered: 0,
      postsSaved: 0,
      postsFailed: 0,
    },
    sections: {},
    sectionStatus: {},
    errors: {},
  };

  for (const section of SECTIONS) {
    runReport.sections[section.slug] = {
      pagesVisited: 0,
      postsDiscovered: 0,
      postsSaved: 0,
      postsFailed: 0,
    };
    runReport.sectionStatus[section.slug] = "pending";
  }

  const reportsRoot = path.join(process.cwd(), "reports");
  const rawDir = path.join(reportsRoot, "raw");
  await fs.ensureDir(rawDir);

  const metricsBySection: Record<string, unknown> = {};
  const historyBySection: Record<string, unknown> = {};

  // Early runs.log entry so we have a durable record even if the first
  // Stagehand session fails to initialize.
  await appendRunLogEntry(reportsRoot, runReport, "run-start");

  // Load existing post URLs from database to skip already-scraped posts.
  // This is a major efficiency improvement - we don't need to navigate to
  // and re-extract posts we already have.
  const existingUrls = await getExistingPostUrls();
  console.log(`Loaded ${existingUrls.size} existing post URLs from database - will skip these.`);

  const seenUrls = new Set<string>(existingUrls);
  let totalNew = 0;
  let scrapeError: unknown = null;

  try {
    for (const section of SECTIONS) {
      console.log(`\n=== Scraping section: ${section.name} ===`);
      runReport.totals.sectionsVisited += 1;

      const stagehand = new Stagehand({
        env: "BROWSERBASE",
        apiKey,
        projectId,
        model,
        verbose: 2, // maximum verbosity for debugging Stagehand behavior
        browserbaseSessionCreateParams: {
          // Extend session timeout to 30 minutes (default is 5 min)
          // This helps prevent session timeouts during long scraping runs
          // Note: Browserbase expects seconds, max is 21600 (6 hours)
          timeout: 30 * 60, // 30 minutes in seconds
          keepAlive: true,
        },
      });

      let newInSection = 0;

      try {
        await stagehand.init();
        console.log("Stagehand session ID:", stagehand.sessionId);
        if (stagehand.sessionId) {
          // For now, record the latest session ID for reference.
          runReport.stagehandSessionId = stagehand.sessionId;
        }

        // With env: "BROWSERBASE", Stagehand v3 exposes a Playwright context
        // per session. We grab the first page from that context and reuse it
        // for this section.
        const page = stagehand.context?.pages?.()[0];
        if (!page) {
          throw new Error("Stagehand did not initialize a browser page");
        }

        newInSection = await scrapeSection(
          stagehand,
          page,
          section,
          maxPagesPerSection,
          seenUrls,
          runReport,
          runId
        );

        // If scrapeSection didn't already mark a special status, treat as
        // section-complete.
        if (runReport.sectionStatus[section.slug] === "pending") {
          runReport.sectionStatus[section.slug] = "section-complete";
        }
      } catch (err) {
        console.error(
          `Error while scraping section ${section.name}:`,
          err instanceof Error ? err.message : err
        );
        console.error("Full section error object:", err);

        if (runReport.sectionStatus[section.slug] === "pending") {
          runReport.sectionStatus[section.slug] = "session-failed";
        }
      } finally {
        // Capture per-section Stagehand metrics/history best-effort.
        try {
          let metrics: unknown = null;
          let history: unknown = null;
          try {
            metrics = await stagehand.metrics;
            history = await stagehand.history;
          } catch (metricsErr) {
            console.warn(
              `Failed to read Stagehand metrics/history for section ${section.slug}:`,
              metricsErr
            );
          }
          metricsBySection[section.slug] = metrics;
          historyBySection[section.slug] = history;
        } catch (aggErr) {
          console.warn(
            `Failed to aggregate Stagehand metrics/history for section ${section.slug}:`,
            aggErr
          );
        }

        try {
          await stagehand.close();
        } catch {
          // ignore close errors
        }
      }

      const stats = runReport.sections[section.slug];
      console.log(
        `Finished section ${section.name}. New posts saved: ${newInSection}`
      );
      console.log(
        `SECTION_SUMMARY runId=${runId} section=${section.slug} pagesVisited=${stats.pagesVisited} postsDiscovered=${stats.postsDiscovered} postsSaved=${stats.postsSaved} postsFailed=${stats.postsFailed}`
      );
      totalNew += newInSection;

      // Per-section progress snapshot and runs.log checkpoint.
      await writeRunProgressSnapshot(reportsRoot, runReport);
      const sectionStatus = runReport.sectionStatus[section.slug];
      const checkpointStatus =
        sectionStatus === "session-failed" ? "session-failed" : "section-complete";
      await appendRunLogEntry(
        reportsRoot,
        runReport,
        checkpointStatus,
        section.slug
      );
    }

    runReport.status = "run-complete";
  } catch (err) {
    scrapeError = err;
    runReport.status = "run-aborted";
    console.error("Fatal error during scrape:", err);
  } finally {
    runReport.finishedAt = new Date().toISOString();

    // Print a structured stdout run summary that is easy to grep.
    console.log("\n=== Run summary (stdout) ===");
    console.log(
      `RUN_SUMMARY runId=${runId} status=${runReport.status} sectionsVisited=${runReport.totals.sectionsVisited} categoryPagesVisited=${runReport.totals.categoryPagesVisited} postsDiscovered=${runReport.totals.postsDiscovered} postsSaved=${runReport.totals.postsSaved} postsFailed=${runReport.totals.postsFailed}`
    );
    console.log("Config:", JSON.stringify(runReport.config));
    console.log("Sections:", JSON.stringify(runReport.sections));

    // Ensure summary directory exists for progress/final snapshots.
    const summaryDir = path.join(reportsRoot, "summary");
    await fs.ensureDir(summaryDir);

    // Final RunReport summary per runId.
    const summaryPath = path.join(summaryDir, `run-${runId}.json`);
    try {
      await fs.writeFile(summaryPath, JSON.stringify(runReport, null, 2), "utf8");
      console.log("Wrote run summary:", summaryPath);
    } catch (err) {
      console.warn("Failed to write run summary:", err);
    }

    // Best-effort progress snapshot reflecting the final state.
    await writeRunProgressSnapshot(reportsRoot, runReport);

    // Latest summary pointer.
    try {
      await fs.writeFile(
        path.join(reportsRoot, "latest-summary.json"),
        JSON.stringify(runReport, null, 2),
        "utf8"
      );
      console.log("Updated latest-summary.json");
    } catch (err) {
      console.warn("Failed to write latest-summary.json:", err);
    }

    // Append-only runs.log final entry for the run.
    await appendRunLogEntry(
      reportsRoot,
      runReport,
      runReport.status ?? "run-complete"
    );

    // Stagehand raw artifacts are nice-to-have; failures here must not
    // interfere with the summaries or runs.log above.
    const combinedPath = path.join(rawDir, `stagehand-${runId}.json`);
    await writeJsonArtifactWithFallback(
      combinedPath,
      { runId, metricsBySection, historyBySection },
      {
        runId,
        description:
          "Failed to serialize combined Stagehand metrics/history by section",
      }
    );

    const metricsPath = path.join(rawDir, `stagehand-metrics-${runId}.json`);
    await writeJsonArtifactWithFallback(
      metricsPath,
      { runId, metricsBySection },
      {
        runId,
        description: "Failed to serialize Stagehand metrics payload by section",
      }
    );

    const historyPath = path.join(rawDir, `stagehand-history-${runId}.json`);
    await writeJsonArtifactWithFallback(
      historyPath,
      { runId, historyBySection },
      {
        runId,
        description: "Failed to serialize Stagehand history payload by section",
      }
    );

    console.log("\nScrape complete.");
    console.log(`Total unique posts saved: ${totalNew}`);
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
