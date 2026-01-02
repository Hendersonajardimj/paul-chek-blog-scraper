import { Pool } from "pg";

export type PostRecord = {
  url: string;
  slug: string;
  title: string;
  datePublished: string | null;
  doctorSection: string;
  categories: string[];
  tags: string[];
  markdown: string;
  source?: string; // 'paul-chek-blog' | 'founders-podcast'
};

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    "DATABASE_URL is not set. Database persistence will be disabled until it is configured."
  );
}

const pool = connectionString
  ? new Pool({ connectionString })
  : null;

export async function initDb() {
  if (!pool) return;

  await pool.query(`
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
      source TEXT NOT NULL DEFAULT 'paul-chek-blog',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Migration: add source column if it doesn't exist (for existing databases)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'posts' AND column_name = 'source'
      ) THEN
        ALTER TABLE posts ADD COLUMN source TEXT NOT NULL DEFAULT 'paul-chek-blog';
      END IF;
    END $$;
  `);
}

/**
 * Get all existing post URLs from the database.
 * Used to skip already-scraped posts for efficiency.
 * Optionally filter by source.
 */
export async function getExistingPostUrls(source?: string): Promise<Set<string>> {
  if (!pool) {
    return new Set();
  }

  if (source) {
    const result = await pool.query<{ url: string }>(
      `SELECT url FROM posts WHERE source = $1`,
      [source]
    );
    return new Set(result.rows.map((row) => row.url));
  }

  const result = await pool.query<{ url: string }>(`SELECT url FROM posts`);
  return new Set(result.rows.map((row) => row.url));
}

export async function upsertPost(post: PostRecord) {
  if (!pool) {
    return;
  }

  const {
    url,
    slug,
    title,
    datePublished,
    doctorSection,
    categories,
    tags,
    markdown,
    source = "paul-chek-blog",
  } = post;

  await pool.query(
    `
    INSERT INTO posts (
      url, slug, title, date_published, doctor_section, categories, tags, markdown, source
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (url) DO UPDATE SET
      slug = EXCLUDED.slug,
      title = EXCLUDED.title,
      date_published = EXCLUDED.date_published,
      doctor_section = EXCLUDED.doctor_section,
      categories = EXCLUDED.categories,
      tags = EXCLUDED.tags,
      markdown = EXCLUDED.markdown,
      source = EXCLUDED.source,
      updated_at = NOW();
  `,
    [
      url,
      slug,
      title,
      datePublished,
      doctorSection,
      categories,
      tags,
      markdown,
      source,
    ]
  );
}
