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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
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
  } = post;

  await pool.query(
    `
    INSERT INTO posts (
      url, slug, title, date_published, doctor_section, categories, tags, markdown
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (url) DO UPDATE SET
      slug = EXCLUDED.slug,
      title = EXCLUDED.title,
      date_published = EXCLUDED.date_published,
      doctor_section = EXCLUDED.doctor_section,
      categories = EXCLUDED.categories,
      tags = EXCLUDED.tags,
      markdown = EXCLUDED.markdown,
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
    ]
  );
}
